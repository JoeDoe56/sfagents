/*
 * MoonlightWeb — native capture & encoding engine.
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

namespace mw::native {

/// The client's word on its decode queue, for cadence=host-guarded (plan
/// framerate-hote, design §33).
///
/// ── Why the host holds back, and not the client ─────────────────────────────
///
/// A host streaming every present of a 240 or 500 Hz display can send frames
/// faster than a phone decodes them, and a decoder that falls behind does not
/// fail: it queues, and every frame in the queue is latency nobody owns. The
/// client cannot drop what it already has — an HEVC delta dropped costs a
/// keyframe for the ones after it. The host can: a present it does not encode
/// costs nothing, the next one is a delta against the last one it did.
///
/// ── The signal ──────────────────────────────────────────────────────────────
///
/// The client (frontend DecodeQueueSignal.js) says its queue's depth the
/// moment a second frame waits at its decoder, and again when it is back to
/// one. The credit is MISSING while the last word is "two or more", and the
/// host skips presents until it is back — within one trip across the link,
/// against the three seconds of the decode-rate governor's standing queue.
///
/// While the queue stays full the client says so again every 50 ms. A "full"
/// not heard again within kStaleUs is not believed: a "clear" that never came,
/// or a page gone, must not stop the stream. (The plan first had "fresh for
/// one round trip"; a client re-signals only when it looks — at a decode
/// output, a few milliseconds apart at best — so a credit that lapsed after a
/// LAN round trip would let the host run between every two outputs.)
///
/// Pure and clocked by the caller; note() from the thread that reads the
/// control channel, missing() from the capture loop.
class DecodeCredit
{
public:
    /// Frames waiting at the decoder that take the credit away.
    static constexpr int kFullAt = 2;
    /// How long a "full" is believed without being said again: five times
    /// the client's refresh (REFRESH_MS, 50 ms).
    static constexpr int64_t kStaleUs = 250 * 1000;

    /// The client's queue is @p depth frames deep, heard at @p nowUs.
    void note(int depth, int64_t nowUs)
    {
        // Bounded like everything that crosses the network from a page.
        if (depth < 0) depth = 0;
        if (depth > 1000) depth = 1000;
        m_AtUs.store(nowUs, std::memory_order_relaxed);
        m_Depth.store(depth, std::memory_order_release);
        m_Signals.fetch_add(1, std::memory_order_relaxed);
    }

    /// True while the last word is a full queue, heard less than kStaleUs
    /// before @p nowUs: the present at hand is skipped.
    bool missing(int64_t nowUs) const
    {
        if (m_Depth.load(std::memory_order_acquire) < kFullAt) return false;
        return nowUs - m_AtUs.load(std::memory_order_relaxed) < kStaleUs;
    }

    /// How many times the client spoke, for the log.
    int64_t signals() const { return m_Signals.load(std::memory_order_relaxed); }

private:
    std::atomic<int> m_Depth{0};
    std::atomic<int64_t> m_AtUs{0};
    std::atomic<int64_t> m_Signals{0};
};

} // namespace mw::native
