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

#include "mw/native/FeedWire.h"

#include <QByteArray>
#include <QJsonObject>
#include <QObject>
#include <QString>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>

class QThread;

/**
 * @brief A guest worker's end of the shared feed (plan « flux commun des
 * invités », S3) — see FeedPublisher for the other one.
 *
 * Connects to the feed's pipe on a thread of its own, says hello with the
 * token its configuration line carried, and waits for the feed's `info`: the
 * session the guest joins, which the worker's launch reply is made of. From
 * then on every picture is handed to the frame callback on that same thread,
 * straight out of the read buffer — the callback sends it before it returns,
 * as the relay does with the encoder's own buffer on the owner's side — and
 * every control message after `info` comes out as controlReceived().
 *
 * A pipe that closes, or says something unreadable, is the end of this
 * subscription: disconnected() says why, once.
 */
class FeedSubscriber : public QObject
{
    Q_OBJECT

public:
    /// One picture: its header (number, keyframe, the frame's own stamps) and
    /// the bitstream, valid for the duration of the call only.
    using FrameCallback = std::function<void(const mw::native::feed::Header& header,
                                             const uint8_t* data, size_t size)>;

    /// How long a subscriber waits for a feed that went away to come back
    /// (the server relaunches a feed that died, under the same name) before
    /// the subscription ends.
    static constexpr int kRejoinMs = 10000;

    FeedSubscriber(QString name, QByteArray token, int slot, QObject* parent = nullptr);
    ~FeedSubscriber() override;

    /// Before start(): where the pictures go.
    void setFrameCallback(FrameCallback callback);

    /// Connect, present the token, and wait for the feed's `info` — at most
    /// @p timeoutMs, trying again while the feed is not there yet (it may be
    /// starting). True with @p info filled; false with @p error.
    bool start(int timeoutMs, QJsonObject* info, QString* error);

    /// Close the pipe and join the thread. Idempotent; never from inside the
    /// frame callback.
    void stop();

    /// A control message to the feed (idr, link, bye). Any thread.
    void sendControl(const QJsonObject& message);

    bool isConnected() const { return m_Connected.load(std::memory_order_acquire); }
    /// Pictures received since start.
    int64_t frames() const { return m_Frames.load(std::memory_order_relaxed); }

signals:
    /// Every control message after the first `info` — later `info`s included
    /// (the feed rebuilt at a new shape), `cursor`, `displayFormat`, `codec`,
    /// `bye`. Emitted on the subscriber's thread.
    void controlReceived(const QJsonObject& message);
    /// The feed went away and came back within kRejoinMs, and says what it
    /// is now: its pictures follow from its next keyframe. On the
    /// subscriber's thread.
    void rejoined(const QJsonObject& info);
    /// The subscription ended: the feed closed and did not come back, or said
    /// something unreadable. Emitted once, on the subscriber's thread.
    void disconnected(const QString& why);

private:
    class Client;
    friend class Client;

    QString m_Name;
    QByteArray m_Token;
    int m_Slot = -1;
    FrameCallback m_OnFrame;
    QThread* m_Thread = nullptr;
    Client* m_Client = nullptr; ///< lives on m_Thread
    std::atomic<bool> m_Connected{false};
    std::atomic<int64_t> m_Frames{0};
};
