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
#include <mutex>
#include <vector>

// The moments the link stopped carrying anything, counted for the viewer.
//
// ── Why the stats needed it ─────────────────────────────────────────────────
//
// Measured on a corporate Wi-Fi (16/09/2026): every 20 to 30 s the link froze
// for 0.3 to 1.2 s in both directions, and the stats card still read a 20 ms
// latency. Nothing it showed could see a freeze: NETWORK is a ping every two
// seconds averaged over five, and FRAMES LOST counts frameId gaps — frames the
// host dropped behind a stuck buffer never got an id. Only the host log said
// it: "link not draining" and "Input link silent", at the same second.
//
// Those two lines are the two directions of one freeze, and this is where they
// meet:
//  - down: the video channel's buffer stayed backed up past SendBacklog's
//    tolerance (the relay sheds a frame and notes the backlog's span);
//  - up: the client went silent long enough for the input watchdog to fire,
//    measured when its next message lands.
// An episode that starts within kMergeMs of the previous one's end is the
// same freeze seen again — the other direction, or the next shed frame — and
// only stretches it.
//
// ── One log line per freeze ─────────────────────────────────────────────────
//
// The card says how many and how long, never which of the three saw it. On
// 19/10/2026 a Mac → DualRTX stream counted two freezes of 1.5 s with one
// retransmission and no backlog in the whole session: only the reports' gap
// could have counted them, and nothing in the log said so. Each episode is now
// handed out once it can no longer stretch (takeClosed), with what saw it and,
// for a gap in the reports, how late the page itself said it sent the report
// that ended it: a page whose timer ran late is not a link frozen upstream.
//
// Fed from the capture thread and the input thread, read by the stats tick.
class LinkFreezeLog
{
public:
    static constexpr int64_t kMergeMs = 1000;
    /// Closed freezes kept for the log until the next stats tick takes them.
    static constexpr size_t kMaxUntold = 16;

    /// What saw the link stop, one bit each: an episode can carry several.
    enum Source : unsigned
    {
        /// The video's send buffer stayed backed up past its tolerance (down).
        Backlog = 1,
        /// The input watchdog fired: nothing came up while something was held.
        InputSilent = 2,
        /// Two of the receiver's link reports missing in a row (up).
        Reports = 4,
    };

    struct Snapshot
    {
        int count = 0;
        int64_t maxMs = 0;
        int64_t lastMs = 0;
    };

    /// One freeze, for the log line.
    struct Episode
    {
        int number = 0; ///< 1 for the session's first
        int64_t startMs = 0;
        int64_t endMs = 0;
        unsigned sources = 0;
        /// The latest the receiver's page said it sent a report that ended a
        /// gap in this episode (linkstats `late`); -1 when none did.
        int64_t pageLateMs = -1;
        /// Told once already, then stretched by a span that reached back
        /// into it.
        bool stretched = false;
    };

    /// The link carried nothing from @p startMs to @p endMs (one clock for
    /// every caller), as @p source saw it. @p pageLateMs: for Reports, how
    /// late the page sent the report that ended the gap, -1 unknown.
    void note(int64_t startMs, int64_t endMs, unsigned source = 0, int64_t pageLateMs = -1)
    {
        if (endMs < startMs) return;
        std::lock_guard<std::mutex> lk(m_Mutex);
        if (m_Count > 0 && startMs <= m_Cur.endMs + kMergeMs) {
            if (startMs < m_Cur.startMs) m_Cur.startMs = startMs;
            if (endMs > m_Cur.endMs) m_Cur.endMs = endMs;
            if (m_Told) {
                m_Told = false;
                m_Cur.stretched = true;
            }
        } else {
            if (m_Count > 0 && !m_Told && m_Untold.size() < kMaxUntold) m_Untold.push_back(m_Cur);
            m_Count++;
            m_Cur = Episode{};
            m_Cur.number = m_Count;
            m_Cur.startMs = startMs;
            m_Cur.endMs = endMs;
            m_Told = false;
        }
        m_Cur.sources |= source;
        if (pageLateMs > m_Cur.pageLateMs) m_Cur.pageLateMs = pageLateMs;
        const int64_t span = m_Cur.endMs - m_Cur.startMs;
        if (span > m_MaxMs) m_MaxMs = span;
    }

    Snapshot snapshot() const
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        return {m_Count, m_MaxMs, m_Count > 0 ? m_Cur.endMs - m_Cur.startMs : 0};
    }

    /// The freezes not told yet that can no longer stretch at @p nowMs — over
    /// for more than kMergeMs — oldest first, each handed out once. @p all
    /// hands out the one still open too: the session is over.
    std::vector<Episode> takeClosed(int64_t nowMs, bool all = false)
    {
        std::lock_guard<std::mutex> lk(m_Mutex);
        std::vector<Episode> out;
        out.swap(m_Untold);
        if (m_Count > 0 && !m_Told && (all || nowMs > m_Cur.endMs + kMergeMs)) {
            out.push_back(m_Cur);
            m_Told = true;
        }
        return out;
    }

private:
    mutable std::mutex m_Mutex;
    int m_Count = 0;
    Episode m_Cur;
    bool m_Told = false;
    std::vector<Episode> m_Untold;
    int64_t m_MaxMs = 0;
};
