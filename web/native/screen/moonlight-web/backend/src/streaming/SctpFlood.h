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

#include <atomic>
#include <cstdint>
#include <memory>
#include <thread>

namespace rtc {
class DataChannel;
}

/// What SCTP carries, measured with the real receiver (plan Idées Punktfunk,
/// A0.3 and A0.4) — bench only, `flood=` in MW_NATIVE_TUNING / native_tuning.
///
/// The question it answers decides the FEC chapter: with no retransmission at
/// all, does SCTP still hold a lossy link to the few Mbit/s its loss-driven
/// congestion window allows (Mathis), as the video channel is held today? The
/// sender is ours (usrsctp, its congestion module by `sctpcc=`), the receiver
/// the browser's own SCTP stack, which is why this runs inside a stream and
/// not between two copies of libdatachannel.
///
/// Messages of `bytes` bytes on their own channel (id 3, negotiated), paced at
/// `kbps` or, with kbps < 0, as many as SCTP takes. Neither builds a queue the
/// size of the link's patience: a message that would find more than kHoldBytes
/// already waiting in libdatachannel is not sent, and counted as held back.
/// Each one carries its sequence number and the host's steady clock, for the
/// receiver to count losses, reordering and the queue's growth:
///
///     [0..3]  "MWFL"
///     [4..7]  sequence, big-endian
///     [8..15] host steady clock at send, µs, big-endian
///     [16..]  zeros
///
/// The receiver (WebRtcDataChannel.js, localStorage `mw_flood`) logs what it
/// got each second; the sender logs what it sent.
class SctpFlood
{
public:
    static constexpr int kDefaultBytes = 1100;
    static constexpr int kHeaderBytes = 16;
    /// The backlog a message may find in libdatachannel and still be sent.
    static constexpr size_t kHoldBytes = 64 * 1024;

    SctpFlood(std::shared_ptr<rtc::DataChannel> dc, int kbps, int bytes);
    ~SctpFlood();

    SctpFlood(const SctpFlood&) = delete;
    SctpFlood& operator=(const SctpFlood&) = delete;

    /// Begins sending: called once the channel is open. Idempotent.
    void start();
    /// Stops and joins. Idempotent; the destructor calls it.
    void stop();

    /// One message, written into @p out (at least kHeaderBytes long): the
    /// layout above. Exposed for the tests.
    static void writeHeader(uint8_t* out, uint32_t seq, uint64_t sendUs);

private:
    void run();

    std::shared_ptr<rtc::DataChannel> m_Dc;
    const int m_Kbps;
    const int m_Bytes;
    std::atomic<bool> m_Started{false};
    std::atomic<bool> m_Stop{false};
    std::thread m_Thread;
};
