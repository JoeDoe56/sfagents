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

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace mw::native::convert {

/// What the Lanczos-2 resample costs THIS GPU, measured on the stream's own
/// frames rather than assumed from its tier.
///
/// ── Why a measurement ───────────────────────────────────────────────────────
///
/// The resample runs on the 3D queue before the encoder may read the picture,
/// so every microsecond of it is latency on every frame. What it costs depends
/// on the GPU and on nothing a session can name: 1440p → 1080p, measured on
/// 22/09/2026 by A/B against the bilinear fetch, ~0 ms on an RTX 5060 Ti,
/// 0.8 ms on an Arc A380, 4.5 ms on the two-CU iGPU of a Ryzen 7000, 12 ms on
/// an N95; and 1080p → 720p, 0.95 ms on a Radeon 780M under Linux.
/// "Integrated" was the obvious proxy, but it names a class, not a cost:
/// integrated GPUs run from two compute units to forty, and a small discrete
/// card can be slower than a large iGPU. So the pass is timed with GPU
/// timestamps and kept only where it is cheap — latency comes before
/// sharpness.
///
/// ── The rule ────────────────────────────────────────────────────────────────
///
/// The first kWarmupFrames frames are not timed: a GPU that was idle a moment
/// ago is still climbing out of its lowest clock (the AMD iGPU took ~1.5 s to
/// settle). Then the median of kSamples frames — a median, so a frame that
/// shared the GPU with a burst of desktop work does not decide it. Above
/// kBudgetUs the stream goes on the bilinear fetch, which costs nothing.
///
/// Pure bookkeeping, so it is tested without a GPU; the platform converter
/// does the timing.
class ResampleCost
{
public:
    static constexpr int kWarmupFrames = 10;
    static constexpr size_t kSamples = 30;
    /// Twice what the Arc pays, a third of what the smallest AMD iGPU pays.
    static constexpr int64_t kBudgetUs = 1500;

    /// Called once for every frame that runs the pass, with the number of
    /// timings still in flight: true when this frame should be timed.
    bool timeThisFrame(size_t inFlight)
    {
        if (done()) return false;
        if (m_Frames < kWarmupFrames) {
            ++m_Frames;
            return false;
        }
        return m_Samples.size() + inFlight < kSamples;
    }

    /// One frame's GPU time for the pass. Ignored once the answer is in.
    void add(int64_t us)
    {
        if (!done() && us >= 0) m_Samples.push_back(us);
    }

    bool done() const { return m_Samples.size() >= kSamples; }

    /// The median of the samples, or -1 until there are enough.
    int64_t medianUs() const
    {
        if (!done()) return -1;
        std::vector<int64_t> sorted = m_Samples;
        std::nth_element(sorted.begin(), sorted.begin() + sorted.size() / 2, sorted.end());
        return sorted[sorted.size() / 2];
    }

    static bool affordable(int64_t us) { return us >= 0 && us <= kBudgetUs; }

    void reset()
    {
        m_Frames = 0;
        m_Samples.clear();
    }

private:
    int m_Frames = 0;
    std::vector<int64_t> m_Samples;
};

} // namespace mw::native::convert
