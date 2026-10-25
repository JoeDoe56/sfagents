/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#include "FeedPublisher.h"

#include "mw/native/FeedWire.h"

#include <QDebug>
#include <QJsonDocument>
#include <QLocalServer>
#include <QLocalSocket>
#include <QPointer>
#include <QRandomGenerator>
#include <QThread>
#include <QTimer>

#include <chrono>
#include <map>
#include <mutex>
#include <vector>

namespace feed = mw::native::feed;

namespace {

int64_t steadyNowUs()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

std::vector<uint8_t> controlBytes(const QJsonObject& message)
{
    const QByteArray json = QJsonDocument(message).toJson(QJsonDocument::Compact);
    feed::Header h;
    h.kind = feed::Kind::Control;
    h.publishedUs = steadyNowUs();
    return feed::message(h, reinterpret_cast<const uint8_t*>(json.constData()),
                         static_cast<size_t>(json.size()));
}

} // namespace

namespace feedpipe {

QString newName(const QString& edition)
{
    QString tag;
    for (const QChar c : edition)
        tag += c.isLetterOrNumber() ? c : QLatin1Char('-');
    const quint64 nonce = QRandomGenerator::system()->generate64();
    return QStringLiteral("mw-feed-%1-%2").arg(tag).arg(nonce, 16, 16, QLatin1Char('0'));
}

QByteArray newToken()
{
    quint32 words[4];
    QRandomGenerator::system()->fillRange(words);
    return QByteArray(reinterpret_cast<const char*>(words), sizeof(words)).toHex();
}

bool sameToken(const QByteArray& a, const QByteArray& b)
{
    // The length is not the secret (every token is 32 hex characters); the
    // bytes are, and every one of them is looked at.
    if (a.isEmpty() || a.size() != b.size()) return false;
    unsigned char diff = 0;
    for (qsizetype i = 0; i < a.size(); ++i)
        diff |= static_cast<unsigned char>(a[i] ^ b[i]);
    return diff == 0;
}

} // namespace feedpipe

// ── The pipe's own thread ───────────────────────────────────────────────────

class FeedPublisher::Server : public QObject
{
public:
    explicit Server(FeedPublisher* owner)
        : m_Owner(owner)
    {}

    // ── Shared with the publishing threads, under m_Mutex ──────────────────
    std::mutex m_Mutex;
    /// One queue per subscriber that is in, by id.
    std::map<int, feed::FreshestQueue> m_Queues;
    QJsonObject m_Info;
    std::atomic<bool> m_FlushPending{false};

    /// From any thread: have the pipe's thread write what waits.
    void scheduleFlush()
    {
        if (m_FlushPending.exchange(true, std::memory_order_acq_rel)) return;
        QMetaObject::invokeMethod(this, [this]() { flush(); }, Qt::QueuedConnection);
    }

    // ── The pipe's thread only ─────────────────────────────────────────────

    bool listen(const QString& name, QString* error)
    {
        m_Server = new QLocalServer(this);
        // This user only: the subscribers run as the feed does, by design.
        m_Server->setSocketOptions(QLocalServer::UserAccessOption);
        // A socket file left by a feed that died (Unix); a no-op on Windows.
        QLocalServer::removeServer(name);
        // Before listen(): on Windows, a guest that reaches the pipe while it
        // opens is announced from inside listen(), and never again (the cold
        // join of 21/10: its hello sat unread until it gave up).
        QObject::connect(m_Server, &QLocalServer::newConnection, this, [this]() { accept(); });
        if (!m_Server->listen(name)) {
            if (error) *error = m_Server->errorString();
            delete m_Server;
            m_Server = nullptr;
            return false;
        }
        // Whatever came in before the signal was wired, all the same.
        accept();
        return true;
    }

    void close()
    {
        for (auto& [id, sub] : m_Subs) {
            if (sub.socket) {
                QObject::disconnect(sub.socket, nullptr, this, nullptr);
                sub.socket->abort();
                sub.socket->deleteLater();
            }
        }
        m_Subs.clear();
        {
            std::lock_guard<std::mutex> lock(m_Mutex);
            m_Queues.clear();
        }
        m_Owner->m_Subscribers.store(0, std::memory_order_release);
        if (m_Server) {
            m_Server->close();
            delete m_Server;
            m_Server = nullptr;
        }
    }

private:
    struct Sub
    {
        QPointer<QLocalSocket> socket;
        bool in = false;
        int slot = -1;
        QByteArray inbox;
    };

    void accept()
    {
        while (QLocalSocket* socket = m_Server->nextPendingConnection()) {
            const int id = m_NextId++;
            Sub& sub = m_Subs[id];
            sub.socket = socket;
            socket->setParent(this);
            QObject::connect(socket, &QLocalSocket::readyRead, this, [this, id]() { read(id); });
            QObject::connect(socket, &QLocalSocket::bytesWritten, this, [this]() { flush(); });
            QObject::connect(socket, &QLocalSocket::disconnected, this,
                             [this, id]() { drop(id, QStringLiteral("disconnected")); });
            // Nothing is said to it before it has proven it was invited.
            QTimer::singleShot(kHelloTimeoutMs, this, [this, id]() {
                auto it = m_Subs.find(id);
                if (it != m_Subs.end() && !it->second.in)
                    drop(id, QStringLiteral("no hello in time"));
            });
        }
    }

    void read(int id)
    {
        {
            auto it = m_Subs.find(id);
            if (it == m_Subs.end() || !it->second.socket) return;
            it->second.inbox.append(it->second.socket->readAll());
        }
        for (;;) {
            // Looked up again at every message: handling one may drop it.
            auto it = m_Subs.find(id);
            if (it == m_Subs.end()) return;
            QByteArray& inbox = it->second.inbox;
            feed::Header h;
            std::string why;
            const auto* bytes = reinterpret_cast<const uint8_t*>(inbox.constData());
            const feed::Parse p =
                feed::decodeHeader(bytes, static_cast<size_t>(inbox.size()), h, &why);
            if (p == feed::Parse::NeedMore) return;
            if (p == feed::Parse::Bad) {
                drop(id, QStringLiteral("unreadable message: ") + QString::fromStdString(why));
                return;
            }
            const qsizetype whole = static_cast<qsizetype>(feed::kHeaderSize + h.payloadSize);
            if (inbox.size() < whole) return;
            // Pictures only ever go the other way.
            if (h.kind != feed::Kind::Control) {
                drop(id, QStringLiteral("a subscriber sent a picture"));
                return;
            }
            const QJsonObject msg =
                QJsonDocument::fromJson(inbox.mid(static_cast<qsizetype>(feed::kHeaderSize),
                                                  static_cast<qsizetype>(h.payloadSize)))
                    .object();
            inbox.remove(0, whole);
            if (!handle(id, msg)) return;
        }
    }

    /// False when the subscriber was dropped for it.
    bool handle(int id, const QJsonObject& msg)
    {
        Sub& sub = m_Subs[id];
        const QString type = msg.value(QStringLiteral("type")).toString();
        if (!sub.in) {
            if (type != QLatin1String("hello") ||
                !feedpipe::sameToken(msg.value(QStringLiteral("token")).toString().toLatin1(),
                                     m_Owner->m_Token)) {
                drop(id, QStringLiteral("refused: no valid hello"));
                return false;
            }
            sub.in = true;
            sub.slot = msg.value(QStringLiteral("slot")).toInt(-1);
            {
                std::lock_guard<std::mutex> lock(m_Mutex);
                feed::FreshestQueue& q = m_Queues[id];
                // What it joins, before any picture.
                if (!m_Info.isEmpty()) q.pushControl(controlBytes(m_Info));
            }
            m_Owner->m_Subscribers.fetch_add(1, std::memory_order_acq_rel);
            qInfo() << "[FeedPublisher] subscriber" << id << "in (slot" << sub.slot << ")";
            emit m_Owner->subscriberJoined(id, sub.slot);
            flush();
            return true;
        }
        emit m_Owner->controlReceived(id, msg);
        return true;
    }

    void drop(int id, const QString& why)
    {
        auto it = m_Subs.find(id);
        if (it == m_Subs.end()) return;
        Sub sub = std::move(it->second);
        m_Subs.erase(it);
        int64_t lost = 0;
        {
            std::lock_guard<std::mutex> lock(m_Mutex);
            auto q = m_Queues.find(id);
            if (q != m_Queues.end()) {
                lost = q->second.dropped();
                m_Queues.erase(q);
            }
        }
        if (sub.socket) {
            QObject::disconnect(sub.socket, nullptr, this, nullptr);
            sub.socket->abort();
            sub.socket->deleteLater();
        }
        if (sub.in) {
            m_Owner->m_Subscribers.fetch_sub(1, std::memory_order_acq_rel);
            qInfo() << "[FeedPublisher] subscriber" << id << "(slot" << sub.slot << ") gone:" << why
                    << "— pictures it could not take in time:" << lost;
            emit m_Owner->subscriberLeft(id, sub.slot);
        } else {
            qWarning() << "[FeedPublisher] connection" << id << "closed:" << why;
        }
    }

    void flush()
    {
        m_FlushPending.store(false, std::memory_order_release);
        // Over a copy of the ids: a write that fails may drop its subscriber.
        std::vector<int> ids;
        ids.reserve(m_Subs.size());
        for (const auto& [id, sub] : m_Subs)
            if (sub.in) ids.push_back(id);
        for (const int id : ids) {
            for (;;) {
                auto it = m_Subs.find(id);
                if (it == m_Subs.end() || !it->second.socket) break;
                QLocalSocket* socket = it->second.socket;
                if (socket->bytesToWrite() >= kHighWaterBytes) break;
                feed::FreshestQueue::Item item;
                {
                    std::lock_guard<std::mutex> lock(m_Mutex);
                    auto q = m_Queues.find(id);
                    if (q == m_Queues.end() || q->second.empty()) break;
                    item = q->second.take();
                }
                socket->write(reinterpret_cast<const char*>(item.bytes.data()),
                              static_cast<qint64>(item.bytes.size()));
            }
        }
    }

    FeedPublisher* m_Owner;
    QLocalServer* m_Server = nullptr;
    std::map<int, Sub> m_Subs;
    int m_NextId = 1;
};

// ── FeedPublisher ───────────────────────────────────────────────────────────

FeedPublisher::FeedPublisher(QString name, QByteArray token, QObject* parent)
    : QObject(parent)
    , m_Name(std::move(name))
    , m_Token(std::move(token))
{}

FeedPublisher::~FeedPublisher()
{
    stop();
}

bool FeedPublisher::start(QString* error)
{
    if (m_Thread) return true;
    m_Thread = new QThread();
    m_Thread->setObjectName(QStringLiteral("feed-publisher"));
    m_Server = new Server(this);
    m_Server->moveToThread(m_Thread);
    m_Thread->start(QThread::HighestPriority);
    bool ok = false;
    QString why;
    QMetaObject::invokeMethod(
        m_Server, [this, &ok, &why]() { ok = m_Server->listen(m_Name, &why); },
        Qt::BlockingQueuedConnection);
    if (!ok) {
        if (error) *error = why;
        qWarning() << "[FeedPublisher] cannot listen on" << m_Name << ":" << why;
        stop();
        return false;
    }
    qInfo() << "[FeedPublisher] feed listening on" << m_Name;
    return true;
}

void FeedPublisher::stop()
{
    if (!m_Thread) return;
    if (m_Server)
        QMetaObject::invokeMethod(
            m_Server, [this]() { m_Server->close(); }, Qt::BlockingQueuedConnection);
    m_Thread->quit();
    m_Thread->wait();
    delete m_Server;
    m_Server = nullptr;
    delete m_Thread;
    m_Thread = nullptr;
}

void FeedPublisher::publishFrame(const uint8_t* data, size_t size, bool keyframe,
                                 const Stamps& stamps)
{
    if (!m_Server || !data || size == 0) return;
    if (m_Subscribers.load(std::memory_order_acquire) == 0) return;
    feed::Header h;
    h.kind = feed::Kind::Frame;
    h.keyframe = keyframe;
    h.frameNumber = stamps.frameNumber;
    h.presentUs = stamps.presentUs;
    h.capturedUs = stamps.capturedUs;
    h.submittedUs = stamps.submittedUs;
    h.convertedUs = stamps.convertedUs;
    h.encodedUs = stamps.encodedUs;
    h.publishedUs = steadyNowUs();
    std::vector<uint8_t> bytes = feed::message(h, data, size);
    {
        std::lock_guard<std::mutex> lock(m_Server->m_Mutex);
        int64_t dropped = 0;
        size_t left = m_Server->m_Queues.size();
        for (auto& [id, q] : m_Server->m_Queues) {
            // The last one takes the bytes themselves; the others a copy.
            dropped += q.pushFrame(--left == 0 ? std::move(bytes) : bytes, keyframe);
        }
        if (dropped) m_Dropped.fetch_add(dropped, std::memory_order_relaxed);
    }
    m_Server->scheduleFlush();
}

void FeedPublisher::publishControl(const QJsonObject& message)
{
    if (!m_Server) return;
    const std::vector<uint8_t> bytes = controlBytes(message);
    {
        std::lock_guard<std::mutex> lock(m_Server->m_Mutex);
        for (auto& [id, q] : m_Server->m_Queues)
            q.pushControl(bytes);
    }
    m_Server->scheduleFlush();
}

void FeedPublisher::setInfo(const QJsonObject& info)
{
    if (!m_Server) return;
    const std::vector<uint8_t> bytes = controlBytes(info);
    {
        std::lock_guard<std::mutex> lock(m_Server->m_Mutex);
        m_Server->m_Info = info;
        for (auto& [id, q] : m_Server->m_Queues)
            q.pushControl(bytes);
    }
    m_Server->scheduleFlush();
}
