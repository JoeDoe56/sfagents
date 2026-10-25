/*
 * MoonlightWeb — self-hosted web client for Moonlight game streaming.
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

#include <cstdint>
#include <limits>

// The host's own share of the delay the receiver reports as the link's.
//
// ── Why the link report needed it ───────────────────────────────────────────
//
// The receiver measures how much later frames arrive than at the best of the
// session, against the timestamp each frame carries — its capture time. So
// every millisecond the host spends between capture and the wire is in that
// rise too. Measured on DualRTX (22/09/2026): a game-like load on the Arc took
// the encode from ~5 to ~18 ms, and the receiver reported a 14-15 ms "link
// queue" on a loopback link. The rate governor read it as the link filling
// (under its 30 ms threshold that day, but a heavier load would have cut the
// bitrate of a link that had nothing wrong with it), and the stats showed the
// host's time twice, once as HOST and once as LINK QUEUE.
//
// The same bookkeeping as the receiver's (StreamView._noteLinkArrival), on the
// capture-to-send lag of the frames as they are handed to the sender: the
// lowest lag since the last report, against the lowest of the session, with
// the same 30 s roll-over. What the host added is taken back out of what the
// receiver saw; the link keeps everything past the hand-off, the sender's own
// queue included.
//
// Fed by the video path and read by the link-report handler, both under the
// relay's video lock.
class HostLagTracker
{
public:
    static constexpr int64_t kRolloverMs = 30000;

    /// One frame handed to the sender @p lagMs after its capture, at @p nowMs.
    void note(int64_t lagMs, int64_t nowMs)
    {
        if (lagMs < 0) return;
        if (m_RecentSince < 0) m_RecentSince = nowMs;
        if (lagMs < m_WindowMin) m_WindowMin = lagMs;
        if (lagMs < m_SessionMin) m_SessionMin = lagMs;
        if (lagMs < m_RecentMin) m_RecentMin = lagMs;
    }

    /// How much the host's lag has risen since the best of the session, over
    /// the frames since the previous call; 0 when there were none. Closes the
    /// window.
    int64_t takeRise(int64_t nowMs)
    {
        int64_t rise = 0;
        if (m_WindowMin != kNone && m_SessionMin != kNone) rise = m_WindowMin - m_SessionMin;
        m_WindowMin = kNone;
        if (m_RecentSince >= 0 && nowMs - m_RecentSince > kRolloverMs) {
            if (m_RecentMin != kNone) m_SessionMin = m_RecentMin;
            m_RecentMin = kNone;
            m_RecentSince = nowMs;
        }
        return rise > 0 ? rise : 0;
    }

private:
    static constexpr int64_t kNone = std::numeric_limits<int64_t>::max();
    int64_t m_WindowMin = kNone;
    int64_t m_SessionMin = kNone;
    int64_t m_RecentMin = kNone;
    int64_t m_RecentSince = -1; // before the first frame
};
