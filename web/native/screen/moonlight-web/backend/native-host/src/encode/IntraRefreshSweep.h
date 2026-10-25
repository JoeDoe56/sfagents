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

#include <cstdint>

namespace mw::native::encode {

/// Which picture refreshes which part of the picture, for an encoder that is
/// told so picture by picture — Vulkan Video's intra refresh
/// (VK_KHR_video_encode_intra_refresh, plan C13.9). Pure bookkeeping.
///
/// ── A sweep ─────────────────────────────────────────────────────────────────
///
/// `duration` pictures, index 0 to duration − 1, each intra-coding the next
/// region of the picture: after the last one, every region was coded without
/// the past, and a loss from before the sweep has left the picture. The
/// driver splits the picture into the regions; the application only counts.
///
/// ── Between sweeps ──────────────────────────────────────────────────────────
///
/// A sweep starts every `distance` pictures, the first `distance` pictures
/// after an IDR (itself a whole refresh): the engine's gap of four periods
/// (RateControl.h intraRefreshDistanceFrames), where a sweep costs bits a
/// slow link would rather keep. `distance` ≤ `duration` runs them back to back.
///
/// ── What the driver must be told ────────────────────────────────────────────
///
/// A picture in a sweep may predict from the one encoded just before it, whose
/// regions past its own index are still "dirty": `duration − index` of them
/// for the current picture (the reference's own index plus one, from the
/// end). Nothing else is allowed during a sweep but a reference counted
/// wholly dirty — which is what index 0 always has. So a repair that makes a
/// picture predict from an older one (reference invalidation) starts the
/// sweep over from there.
class IntraRefreshSweep
{
public:
    /// What the next picture is.
    struct Step
    {
        bool refresh = false; ///< a picture of a sweep: VK_VIDEO_ENCODE_INTRA_REFRESH_BIT_KHR
        uint32_t duration = 0;
        uint32_t index = 0;
        /// Of its reference: the regions still to be refreshed, from the
        /// current picture's point of view (duration − index).
        uint32_t referenceDirty = 0;
    };

    IntraRefreshSweep() = default;
    IntraRefreshSweep(int duration, int distance)
        : m_Duration(duration > 0 ? static_cast<uint32_t>(duration) : 0)
        , m_Distance(distance > duration ? static_cast<uint32_t>(distance) : m_Duration)
    {}

    bool enabled() const { return m_Duration > 0; }
    uint32_t duration() const { return m_Duration; }
    /// Pictures between the starts of two sweeps.
    uint32_t distance() const { return m_Distance; }
    /// How long a loss may take to heal: the gap plus one sweep, or the sweep
    /// alone back to back — what the receiver's ride-out watchdog waits for.
    uint32_t horizon() const
    {
        return !enabled() ? 0 : m_Distance > m_Duration ? m_Distance + m_Duration : m_Duration;
    }

    /// The next picture: an IDR (@p idr), or a P picture whose reference is
    /// the picture encoded just before it (@p followsPrevious) or an older one
    /// — a repair.
    Step next(bool idr, bool followsPrevious)
    {
        if (!enabled()) return {};
        if (idr) {
            // A whole refresh of its own: the next sweep is due a distance on.
            m_Index = -1;
            m_Since = 0;
            return {};
        }
        ++m_Since;
        if (m_Index >= 0) {
            if (!followsPrevious) {
                // A repair in a sweep: only the previous picture may be partly
                // clean, so the sweep starts over from the older one.
                m_Index = 0;
                m_Since = 0;
            } else if (static_cast<uint32_t>(++m_Index) >= m_Duration) {
                m_Index = -1; // the sweep is complete
            }
        }
        if (m_Index < 0 && m_Since >= m_Distance) {
            m_Index = 0;
            m_Since = 0;
        }
        if (m_Index < 0) return {};
        Step step;
        step.refresh = true;
        step.duration = m_Duration;
        step.index = static_cast<uint32_t>(m_Index);
        step.referenceDirty = m_Duration - step.index;
        return step;
    }

    void reset()
    {
        m_Index = -1;
        m_Since = 0;
    }

private:
    uint32_t m_Duration = 0;
    uint32_t m_Distance = 0;
    /// The index of the picture last planned in a sweep, −1 between sweeps.
    int m_Index = -1;
    /// Pictures since the last sweep started, or the last IDR.
    uint32_t m_Since = 0;
};

} // namespace mw::native::encode
