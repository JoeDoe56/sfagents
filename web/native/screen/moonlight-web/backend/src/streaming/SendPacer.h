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

#include <cstddef>
#include <cstdint>

// How fast the sender hands a frame's chunks to SCTP: a token bucket, for the
// bench (`pace=`; plan « Wi-Fi : la vidéo qui attend dans SCTP », W2 A).
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// A frame went into the DataChannel in one go: every 16 KB chunk back to back,
// and usrsctp put it on the wire as fast as its window allowed — 40 packets of
// a 47 KB frame within a fraction of a millisecond. Wi-Fi then hands such a
// run to the client in a few aggregates, faster than the browser drains its
// UDP socket, and the client's kernel throws the overflow away. On a Mac on
// 03/10/2026, 1,855 to 2,303 datagrams a pass were dropped that way ("dropped
// due to full socket buffers"), against 3,120 to 3,960 SCTP retransmissions;
// a UDP burst into a 64 KB socket buffer lost 1.5 %, into 256 KB nothing. SCTP
// reads each drop as congestion, shrinks its window, and every later frame
// waits inside usrsctp: ~20 ms more on Wi-Fi than on Ethernet.
//
// So the chunks of a frame leave at a rate a little above the stream's own,
// and never more than a burst's worth at once: the frame still goes out within
// a fraction of its interval, but no longer as one run the client cannot hold.
//
// ── What it gave (03/10/2026) ──────────────────────────────────────────────
//
// Not what it was for. On the Mac, two alternated rounds: the kernel's drops
// stayed where they were (2,115 without, 2,540 at pace=4, 2,065 at pace=2)
// and the click got no faster (74.9, 85.0, 79.7 ms). Chrome's socket fills
// when Chrome reads late — at 42 Mbit/s a 64 KB buffer holds ~12 ms — not
// under the host's bursts; only a lower bitrate brought the drops down. pace=2
// did halve the p90 of a frame's age (51 to 24 ms). So it stays a bench key,
// off in the product; the rate governor's retrcut= is the answer being
// measured (plan « Wi-Fi », W2 B).
//
// The bucket starts full, refills at the rate and holds at most a burst. A
// chunk waits until the bucket holds as much as the chunk, or a full burst for
// a chunk bigger than that; sending it may then take the bucket below zero,
// which the next chunk pays for. Nothing here sleeps: the sender asks how long
// to wait and does the waiting itself.
class SendPacer
{
public:
    /// @p bytesPerSecond 0 switches pacing off. @p burstBytes is the most that
    /// leaves back to back.
    void configure(int64_t bytesPerSecond, size_t burstBytes)
    {
        m_Rate = bytesPerSecond > 0 ? bytesPerSecond : 0;
        m_Burst = burstBytes > 0 ? static_cast<int64_t>(burstBytes) : 1;
        m_Tokens = m_Burst;
        m_LastUs = kNever;
    }

    bool active() const { return m_Rate > 0; }
    int64_t bytesPerSecond() const { return m_Rate; }

    /// How long a chunk of @p bytes must wait at @p nowUs before it may go,
    /// in µs; 0 when it may go now (or when pacing is off).
    int64_t waitUs(size_t bytes, int64_t nowUs)
    {
        if (!active()) return 0;
        refill(nowUs);
        const int64_t need =
            static_cast<int64_t>(bytes) < m_Burst ? static_cast<int64_t>(bytes) : m_Burst;
        if (m_Tokens >= need) return 0;
        // Round up: a wait one microsecond short would find the bucket short.
        return ((need - m_Tokens) * 1'000'000 + m_Rate - 1) / m_Rate;
    }

    /// The chunk of @p bytes went at @p nowUs.
    void sent(size_t bytes, int64_t nowUs)
    {
        if (!active()) return;
        refill(nowUs);
        m_Tokens -= static_cast<int64_t>(bytes);
    }

    /// The tokens held at the last refill, for the tests.
    int64_t tokens() const { return m_Tokens; }

private:
    void refill(int64_t nowUs)
    {
        // The first call, or a clock that went back: start counting from now.
        if (m_LastUs == kNever || nowUs < m_LastUs) {
            m_LastUs = nowUs;
            return;
        }
        // A second idle fills the bucket — any rate this serves earns a burst
        // in far less — and no product of microseconds and rate is left to
        // overflow after a long pause.
        if (nowUs - m_LastUs >= 1'000'000) {
            m_Tokens = m_Burst;
            m_LastUs = nowUs;
            return;
        }
        const int64_t add = (nowUs - m_LastUs) * m_Rate / 1'000'000;
        if (add <= 0) return;
        if (m_Tokens + add >= m_Burst) {
            m_Tokens = m_Burst;
            m_LastUs = nowUs;
            return;
        }
        m_Tokens += add;
        // Keep the remainder: advance the clock by what was credited only.
        m_LastUs += add * 1'000'000 / m_Rate;
    }

    static constexpr int64_t kNever = INT64_MIN;
    int64_t m_Rate = 0;
    int64_t m_Burst = 1;
    int64_t m_Tokens = 0;
    int64_t m_LastUs = kNever;
};
