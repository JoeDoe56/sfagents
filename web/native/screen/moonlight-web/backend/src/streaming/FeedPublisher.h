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

#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QObject>
#include <QString>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>

class QThread;

namespace feedpipe {

/// The pipe's name for this instance: "mw-feed-<edition>-<nonce>", so a
/// --dev instance, the DEV edition and the installed one never meet on one
/// machine, and a feed that is relaunched never reuses a name a stale
/// subscriber might still hold. A named pipe on Windows, a socket beside the
/// temporary files elsewhere (QLocalServer's own rules).
QString newName(const QString& edition);

/// 128 random bits, hex: what a subscriber presents before anything else.
QByteArray newToken();

/// Constant-time comparison of two tokens.
bool sameToken(const QByteArray& a, const QByteArray& b);

} // namespace feedpipe

/**
 * @brief The producer's end of the guests' shared feed (plan « flux commun des
 * invités », S3).
 *
 * A native host's guests watch one stream, encoded once by the `feed` worker;
 * each guest's own worker subscribes to it over a local pipe and carries it to
 * its browser. This class is that pipe's server, in the feed worker.
 *
 * ── Who gets in ─────────────────────────────────────────────────────────────
 *
 * A subscriber's first message must be `hello` with the token the server
 * handed both processes on their configuration line, and nothing is sent to it
 * before. A wrong token, anything else first, or silence past kHelloTimeoutMs:
 * the connection is closed. The pipe is also created for this user only
 * (QLocalServer::UserAccessOption): the subscribers are launched in the same
 * context as the feed — the service's SYSTEM, an elevated task, or a plain
 * child — precisely so that this holds.
 *
 * ── Never waiting for a guest ───────────────────────────────────────────────
 *
 * publishFrame() runs on the encoder's thread and only copies: into one
 * FreshestQueue per subscriber, under a mutex held for the copies. The writes
 * happen on this class's own thread, and only while a subscriber's pipe holds
 * less than kHighWaterBytes: past that, its queue keeps the freshest picture
 * and drops the rest (FeedWire.h), and the capture of every other picture —
 * the owner's too, in its own process — never notices.
 *
 * Every signal is emitted on the feed's own thread.
 */
class FeedPublisher : public QObject
{
    Q_OBJECT

public:
    /// The frame's number and stamps, as EncodedFrame carries them.
    struct Stamps
    {
        uint32_t frameNumber = 0;
        int64_t presentUs = 0;
        int64_t capturedUs = 0;
        int64_t submittedUs = 0;
        int64_t convertedUs = 0;
        int64_t encodedUs = 0;
    };

    /// A subscriber must have said hello this soon after connecting.
    static constexpr int kHelloTimeoutMs = 3000;
    /// Unwritten bytes a subscriber's pipe may hold before its pictures wait
    /// in its queue instead (where the freshest wins).
    static constexpr qint64 kHighWaterBytes = 4 * 1024 * 1024;

    FeedPublisher(QString name, QByteArray token, QObject* parent = nullptr);
    ~FeedPublisher() override;

    /// Listen, on a thread of its own. False, with @p error, when the name
    /// cannot be taken.
    bool start(QString* error = nullptr);
    /// Close every subscriber and the server, and join the thread.
    /// Idempotent.
    void stop();

    QString name() const { return m_Name; }

    /// A picture, from any thread — the encoder's. Copied once per subscriber
    /// that is in; never blocks on a pipe.
    void publishFrame(const uint8_t* data, size_t size, bool keyframe, const Stamps& stamps);

    /// A control message for every subscriber that is in (cursor,
    /// displayFormat, codec, bye). Any thread; never dropped.
    void publishControl(const QJsonObject& message);

    /// What a subscriber is told the moment it is in — the session's
    /// description (`info`). Kept, and sent to each newcomer; a change is sent
    /// to every subscriber already in as well. Any thread.
    void setInfo(const QJsonObject& info);

    /// Subscribers that are in (said hello with the right token).
    int subscribers() const { return m_Subscribers.load(std::memory_order_acquire); }
    /// Pictures dropped for subscribers whose pipe fell behind, since start.
    int64_t dropped() const { return m_Dropped.load(std::memory_order_relaxed); }

signals:
    /// A subscriber is in. @p slot is the one it named in its hello (the
    /// guest's slot on the share board), for the log and the arbitration.
    void subscriberJoined(int id, int slot);
    /// A subscriber that was in has gone.
    void subscriberLeft(int id, int slot);
    /// A control message from a subscriber that is in: idr, link, bye.
    void controlReceived(int id, const QJsonObject& message);

private:
    class Server;
    friend class Server;

    QString m_Name;
    QByteArray m_Token;
    QThread* m_Thread = nullptr;
    Server* m_Server = nullptr; ///< lives on m_Thread
    std::atomic<int> m_Subscribers{0};
    std::atomic<int64_t> m_Dropped{0};
};
