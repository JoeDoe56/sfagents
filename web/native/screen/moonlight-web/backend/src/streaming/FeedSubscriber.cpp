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

#include "FeedSubscriber.h"

#include <QDateTime>
#include <QDeadlineTimer>
#include <QDebug>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QThread>
#include <QTimer>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <mutex>

namespace feed = mw::native::feed;

namespace {

int64_t steadyNowUs()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

QByteArray controlBytes(const QJsonObject& message)
{
    const QByteArray json = QJsonDocument(message).toJson(QJsonDocument::Compact);
    feed::Header h;
    h.kind = feed::Kind::Control;
    h.publishedUs = steadyNowUs();
    const std::vector<uint8_t> bytes = feed::message(
        h, reinterpret_cast<const uint8_t*>(json.constData()), static_cast<size_t>(json.size()));
    return QByteArray(reinterpret_cast<const char*>(bytes.data()),
                      static_cast<qsizetype>(bytes.size()));
}

} // namespace

// ── The pipe's own thread ───────────────────────────────────────────────────

class FeedSubscriber::Client : public QObject
{
public:
    explicit Client(FeedSubscriber* owner)
        : m_Owner(owner)
    {}

    // ── start()'s wait for `info`, under m_WaitMutex ───────────────────────
    std::mutex m_WaitMutex;
    std::condition_variable m_WaitCv;
    bool m_Settled = false;
    bool m_Ok = false;
    QJsonObject m_Info;
    QString m_Error;
    // What became of the tries before `info`, for a join that times out (§9:
    // a cold guest that never reached the feed, without a word of why).
    int m_Tries = 0;
    int m_Connects = 0;
    QString m_LastFailure;

    /// Connect, and keep trying until @p deadline: the feed may be starting
    /// at this very moment — the first guest's arrival is what launches it.
    void open(QDeadlineTimer deadline)
    {
        m_Deadline = deadline;
        m_Socket = new QLocalSocket(this);
        QObject::connect(m_Socket, &QLocalSocket::connected, this, [this]() {
            {
                std::lock_guard<std::mutex> lock(m_WaitMutex);
                ++m_Connects;
            }
            QJsonObject hello{{QStringLiteral("type"), QStringLiteral("hello")},
                              {QStringLiteral("token"), QString::fromLatin1(m_Owner->m_Token)},
                              {QStringLiteral("slot"), m_Owner->m_Slot}};
            m_Socket->write(controlBytes(hello));
        });
        QObject::connect(m_Socket, &QLocalSocket::readyRead, this, [this]() { read(); });
        QObject::connect(m_Socket, &QLocalSocket::disconnected, this,
                         [this]() { lost(QStringLiteral("the feed closed the pipe")); });
        QObject::connect(m_Socket, &QLocalSocket::errorOccurred, this,
                         [this](QLocalSocket::LocalSocketError) { lost(m_Socket->errorString()); });
        tryConnect();
    }

    void tryConnect()
    {
        {
            std::lock_guard<std::mutex> lock(m_WaitMutex);
            ++m_Tries;
        }
        m_Socket->connectToServer(m_Owner->m_Name);
    }

    /// Why start() is still waiting: how many tries, how many reached the
    /// pipe (then the feed never answered the hello), and the last failure.
    QString waitStory()
    {
        std::lock_guard<std::mutex> lock(m_WaitMutex);
        return QStringLiteral("%1 tries, %2 connected, last failure: %3")
            .arg(m_Tries)
            .arg(m_Connects)
            .arg(m_LastFailure.isEmpty() ? QStringLiteral("none") : m_LastFailure);
    }

    void write(const QByteArray& bytes)
    {
        if (m_Socket && m_Socket->state() == QLocalSocket::ConnectedState) m_Socket->write(bytes);
    }

    void close()
    {
        if (!m_Socket) return;
        QObject::disconnect(m_Socket, nullptr, this, nullptr);
        m_Socket->abort();
        delete m_Socket;
        m_Socket = nullptr;
        m_Owner->m_Connected.store(false, std::memory_order_release);
    }

private:
    void read()
    {
        m_Inbox.append(m_Socket->readAll());
        qsizetype at = 0;
        int framesThisRead = 0;
        while (!m_Ended) {
            feed::Header h;
            std::string why;
            const auto* bytes = reinterpret_cast<const uint8_t*>(m_Inbox.constData()) + at;
            const size_t left = static_cast<size_t>(m_Inbox.size() - at);
            const feed::Parse p = feed::decodeHeader(bytes, left, h, &why);
            if (p == feed::Parse::NeedMore) break;
            if (p == feed::Parse::Bad) {
                end(QStringLiteral("unreadable message from the feed: ") +
                    QString::fromStdString(why));
                return;
            }
            const size_t whole = feed::kHeaderSize + h.payloadSize;
            if (left < whole) break;
            const uint8_t* payload = bytes + feed::kHeaderSize;
            at += static_cast<qsizetype>(whole);
            if (h.kind == feed::Kind::Frame) {
                // Only once the feed said what it is: a picture before `info`
                // would be one the worker cannot yet describe to its browser.
                if (!m_GotInfo) continue;
                m_Owner->m_Frames.fetch_add(1, std::memory_order_relaxed);
                ++framesThisRead;
                if (m_Owner->m_OnFrame) m_Owner->m_OnFrame(h, payload, h.payloadSize);
                continue;
            }
            const QJsonObject msg =
                QJsonDocument::fromJson(
                    QByteArray::fromRawData(reinterpret_cast<const char*>(payload),
                                            static_cast<qsizetype>(h.payloadSize)))
                    .object();
            if (!m_GotInfo) {
                if (msg.value(QStringLiteral("type")).toString() != QLatin1String("info")) continue;
                m_GotInfo = true;
                m_Owner->m_Connected.store(true, std::memory_order_release);
                if (m_EverIn) {
                    // A feed that came back (relaunched under the same name):
                    // the stream goes on, from its next keyframe.
                    qInfo() << "[FeedSubscriber] back on the feed" << m_Owner->m_Name;
                    m_Rejoining = false;
                    emit m_Owner->rejoined(msg);
                } else {
                    m_EverIn = true;
                    settle(true, msg, QString());
                }
                continue;
            }
            emit m_Owner->controlReceived(msg);
        }
        // The frames handed out above pointed into the buffer: it is trimmed
        // only once they are all delivered.
        if (at > 0) m_Inbox.remove(0, at);
        if (framesThisRead > 0) notePictures(framesThisRead);
    }

    /// How the pictures come out of the pipe: one read handing over several is
    /// a burst the guest's sender has to hold (DataChannelRelay keeps three
    /// deltas for it), and a long pause before it is where the burst came
    /// from. Told once a minute, when there was any.
    void notePictures(int frames)
    {
        const int64_t nowMs = QDateTime::currentMSecsSinceEpoch();
        if (m_LastPictureMs > 0)
            m_LongestPauseMs = std::max(m_LongestPauseMs, nowMs - m_LastPictureMs);
        m_LastPictureMs = nowMs;
        if (frames > 1) {
            ++m_Bursts;
            m_BiggestBurst = std::max(m_BiggestBurst, frames);
        }
        if (m_WindowStartMs == 0) m_WindowStartMs = nowMs;
        if (nowMs - m_WindowStartMs < 60000) return;
        if (m_Bursts > 0)
            qInfo() << "[FeedSubscriber] pipe: in the last minute," << m_Bursts
                    << "reads handed over several pictures (at most" << m_BiggestBurst
                    << "), longest pause between two" << m_LongestPauseMs << "ms";
        m_WindowStartMs = nowMs;
        m_Bursts = 0;
        m_BiggestBurst = 0;
        m_LongestPauseMs = 0;
    }

    /// The pipe closed, or never opened. Before the first `info`: tried again
    /// until start()'s deadline. After it: the feed died, and is relaunched
    /// under the same name by the server — tried again for kRejoinMs, the
    /// guest's own stream to its browser staying up meanwhile.
    void lost(const QString& why)
    {
        if (m_Ended || m_RetryPending) return;
        if (!m_EverIn) {
            std::lock_guard<std::mutex> lock(m_WaitMutex);
            m_LastFailure = why;
        }
        m_GotInfo = false;
        m_Inbox.clear();
        m_Owner->m_Connected.store(false, std::memory_order_release);
        if (m_EverIn && !m_Rejoining) {
            m_Rejoining = true;
            m_Deadline = QDeadlineTimer(kRejoinMs);
            qWarning() << "[FeedSubscriber] the feed went away (" << why
                       << ") — waiting for it to come back";
        }
        if (m_Deadline.hasExpired()) {
            end(why);
            return;
        }
        m_RetryPending = true;
        QTimer::singleShot(m_EverIn ? 250 : 100, this, [this]() {
            m_RetryPending = false;
            if (m_Ended || !m_Socket) return;
            m_Socket->abort();
            tryConnect();
        });
    }

    void end(const QString& why)
    {
        if (m_Ended) return;
        m_Ended = true;
        m_Owner->m_Connected.store(false, std::memory_order_release);
        if (!m_EverIn) settle(false, QJsonObject(), why);
        qInfo() << "[FeedSubscriber] subscription ended:" << why;
        emit m_Owner->disconnected(why);
    }

    void settle(bool ok, const QJsonObject& info, const QString& error)
    {
        {
            std::lock_guard<std::mutex> lock(m_WaitMutex);
            if (m_Settled) return;
            m_Settled = true;
            m_Ok = ok;
            m_Info = info;
            m_Error = error;
        }
        m_WaitCv.notify_all();
    }

    FeedSubscriber* m_Owner;
    QLocalSocket* m_Socket = nullptr;
    QByteArray m_Inbox;
    /// The current connection has had its `info`.
    bool m_GotInfo = false;
    /// A first `info` came, ever: start() has returned, and a loss from now
    /// on is the feed dying, which is waited out.
    bool m_EverIn = false;
    bool m_Rejoining = false;
    bool m_RetryPending = false;
    bool m_Ended = false;
    QDeadlineTimer m_Deadline;
    // notePictures(), on the client's thread.
    int64_t m_LastPictureMs = 0;
    int64_t m_WindowStartMs = 0;
    int64_t m_LongestPauseMs = 0;
    int m_Bursts = 0;
    int m_BiggestBurst = 0;
};

// ── FeedSubscriber ──────────────────────────────────────────────────────────

FeedSubscriber::FeedSubscriber(QString name, QByteArray token, int slot, QObject* parent)
    : QObject(parent)
    , m_Name(std::move(name))
    , m_Token(std::move(token))
    , m_Slot(slot)
{}

FeedSubscriber::~FeedSubscriber()
{
    stop();
}

void FeedSubscriber::setFrameCallback(FrameCallback callback)
{
    m_OnFrame = std::move(callback);
}

bool FeedSubscriber::start(int timeoutMs, QJsonObject* info, QString* error)
{
    if (m_Thread) return m_Connected.load(std::memory_order_acquire);
    m_Thread = new QThread();
    m_Thread->setObjectName(QStringLiteral("feed-subscriber"));
    m_Client = new Client(this);
    m_Client->moveToThread(m_Thread);
    // The pictures are handed on from this thread: it is on the frame's path.
    m_Thread->start(QThread::HighestPriority);
    const QDeadlineTimer deadline(timeoutMs);
    QMetaObject::invokeMethod(
        m_Client, [this, deadline]() { m_Client->open(deadline); }, Qt::QueuedConnection);

    bool ok = false;
    QString why;
    {
        std::unique_lock<std::mutex> lock(m_Client->m_WaitMutex);
        const bool settled = m_Client->m_WaitCv.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                                                         [this]() { return m_Client->m_Settled; });
        if (!settled) {
            why = QStringLiteral("the feed said nothing in %1 ms").arg(timeoutMs);
        } else {
            ok = m_Client->m_Ok;
            why = m_Client->m_Error;
            if (ok && info) *info = m_Client->m_Info;
        }
    }
    if (!ok) {
        qWarning() << "[FeedSubscriber] cannot join the feed" << m_Name << ":" << why;
        // Outside the wait's lock: the story takes it.
        qWarning().noquote() << "[FeedSubscriber] before giving up:" << m_Client->waitStory();
        if (error) *error = why;
        stop();
        return false;
    }
    qInfo() << "[FeedSubscriber] joined the feed" << m_Name << "(slot" << m_Slot << ")";
    return true;
}

void FeedSubscriber::stop()
{
    if (!m_Thread) return;
    if (m_Client)
        QMetaObject::invokeMethod(
            m_Client, [this]() { m_Client->close(); }, Qt::BlockingQueuedConnection);
    m_Thread->quit();
    m_Thread->wait();
    delete m_Client;
    m_Client = nullptr;
    delete m_Thread;
    m_Thread = nullptr;
    m_Connected.store(false, std::memory_order_release);
}

void FeedSubscriber::sendControl(const QJsonObject& message)
{
    if (!m_Client) return;
    const QByteArray bytes = controlBytes(message);
    Client* client = m_Client;
    QMetaObject::invokeMethod(
        client, [client, bytes]() { client->write(bytes); }, Qt::QueuedConnection);
}
