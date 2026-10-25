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

#include "LinkFeedback.h"

#include <algorithm>
#include <cstdint>
#include <map>

namespace mw::native {

/// What the guests of a shared feed ask of the one encoder they share (plan
/// « flux commun des invités », S6).
///
/// Every guest's worker speaks for its own browser: a keyframe when it joins or
/// lost a picture its wave did not repair, and a link report twice a second.
/// Handed on one by one, three guests would ask for three keyframes on three
/// joins — each a burst of the whole picture on every guest's link — and the
/// governor would read three reports per period as three times the evidence.
/// So:
///
///  - **Keyframes**: the first request opens a window of kGatherMs, and every
///    request inside it is served by the one keyframe that closes it; and no
///    two keyframes come closer than kMinGapMs, whoever asks. Where the feed's
///    encoder refreshes by intra-refresh, a guest that lost a frame is
///    repaired by the wave anyway and a keyframe only makes it sooner; where
///    it does not (an Arc's D3D12 Video Encode), the keyframe is the repair.
///    Either way it is everyone's, and so it is rationed.
///  - **Links**: the reports that came in over kLinkPeriodMs fold into one —
///    the worst rise of delay, the most gaps, the most evictions, the fewest
///    frames received — handed to the feed's governor, which then follows the
///    slowest guest down to its floor (60 % of the setting for the feed).
///    Below it, that guest drops frames on its own, repaired by the wave or,
///    without one, by the rationed keyframe.
///    A report that says its page was hidden (`resumed`) is kept only when
///    every report of the period says so: one guest back from the background
///    is not every guest's link recovering.
///
/// Pure and clocked by its caller, like RateGovernor.
class FeedArbiter
{
public:
    static constexpr int64_t kGatherMs = 250;
    static constexpr int64_t kMinGapMs = 1000;
    static constexpr int64_t kLinkPeriodMs = 500;

    /// A guest asks for a keyframe.
    void requestKeyframe(int subscriber, int64_t nowMs)
    {
        (void)subscriber;
        ++m_Asked;
        if (m_PendingSinceMs < 0) m_PendingSinceMs = nowMs;
    }

    /// A guest's link report.
    void report(int subscriber, const LinkFeedback& fb, int64_t nowMs)
    {
        (void)nowMs;
        Pending& p = m_Reports[subscriber];
        if (!p.present) {
            p.fb = fb;
            p.present = true;
            return;
        }
        // Two reports from one guest inside a period: its worse moment.
        p.fb.owdRiseMs = std::max(p.fb.owdRiseMs, fb.owdRiseMs);
        p.fb.gaps += fb.gaps;
        p.fb.evictions += fb.evictions;
        p.fb.receivedFps = std::min(p.fb.receivedFps, fb.receivedFps);
        p.fb.resumed = p.fb.resumed && fb.resumed;
    }

    /// A guest is gone: what it said no longer counts.
    void leave(int subscriber) { m_Reports.erase(subscriber); }

    /// True when a keyframe is to be asked of the encoder now — once for the
    /// whole window, never within kMinGapMs of the last.
    bool keyframeDue(int64_t nowMs)
    {
        if (m_PendingSinceMs < 0) return false;
        if (nowMs - m_PendingSinceMs < kGatherMs) return false;
        if (m_LastKeyframeMs != kNever && nowMs - m_LastKeyframeMs < kMinGapMs) return false;
        m_PendingSinceMs = -1;
        m_LastKeyframeMs = nowMs;
        ++m_Served;
        return true;
    }

    /// The merged report for the feed's governor, once per kLinkPeriodMs when
    /// any guest reported in it.
    bool linkDue(int64_t nowMs, LinkFeedback& out)
    {
        if (m_LastLinkMs != kNever && nowMs - m_LastLinkMs < kLinkPeriodMs) return false;
        bool any = false;
        bool allResumed = true;
        LinkFeedback merged;
        merged.receivedFps = 0;
        for (auto& [id, p] : m_Reports) {
            if (!p.present) continue;
            if (!any) {
                merged = p.fb;
                any = true;
            } else {
                merged.owdRiseMs = std::max(merged.owdRiseMs, p.fb.owdRiseMs);
                merged.gaps = std::max(merged.gaps, p.fb.gaps);
                merged.evictions = std::max(merged.evictions, p.fb.evictions);
                merged.receivedFps = std::min(merged.receivedFps, p.fb.receivedFps);
            }
            allResumed = allResumed && p.fb.resumed;
            p.present = false;
        }
        if (!any) return false;
        merged.resumed = allResumed;
        m_LastLinkMs = nowMs;
        out = merged;
        return true;
    }

    /// Keyframes the guests asked for, and keyframes asked of the encoder.
    int64_t asked() const { return m_Asked; }
    int64_t served() const { return m_Served; }

private:
    static constexpr int64_t kNever = INT64_MIN;

    struct Pending
    {
        LinkFeedback fb;
        bool present = false;
    };

    int64_t m_PendingSinceMs = -1;
    int64_t m_LastKeyframeMs = kNever;
    int64_t m_LastLinkMs = kNever;
    std::map<int, Pending> m_Reports;
    int64_t m_Asked = 0;
    int64_t m_Served = 0;
};

} // namespace mw::native
