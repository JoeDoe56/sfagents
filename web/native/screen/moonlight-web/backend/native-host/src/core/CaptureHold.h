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
#include <string>

namespace mw::native {

/// Whether the capture held its display, for `vddmatch` (plan glissade,
/// section V): the server puts the virtual display at a whole multiple of the
/// client's own rate, 288 Hz for a 144 Hz screen, 330 for a 165, and keeps it
/// there only on a host whose capture holds it. One that does not gets the
/// client's own rate (×1) from its next stream on — never a mode changed under
/// a stream that runs.
///
/// Judged over the seconds of dense content alone: a desktop at rest says
/// nothing of a capture, nor a page that loads. A second is dense when the
/// display presented at least kDenseRatio times per frame of the stream. The
/// verdict needs kMinDenseSeconds of them, and is the server's to apply only
/// above the 240 Hz every host has run since 30/09/2026
/// (VirtualDisplay::kRateMax): 2 × 119.872 Hz is no more work than 240.
///
/// V2's bench (15/10/2026, DualRTX's RTX, CoD's dense band, the client
/// tearing) held 330 Hz with this margin on each threshold:
///   - the lattice locked on 97 % of the gate's calls (kMinLocked: 90 %);
///   - 99.9 % of the stream's frames carried (kMinCarried: 97 %);
///   - 0.06 % of the presents folded between two acquires (kMaxFolded: 1 %);
///   - the loop busy 29 % of the time, mostly encoding (kMaxBusy: 70 %).
/// The band presented 1.8 times per frame of the stream at 240, 288 and 330:
/// the content's pace, not the capture's.
///
/// The capture itself costs little at twice the rate (one acquire more per
/// frame of the stream, ~1 % of the loop); what a modest host may not hold is
/// the compositor at that rate, seen here as a lattice that no longer locks
/// and presents folded. Not measured on such a host (V2.3): the thresholds
/// are the bench's margins, to revisit with one.
///
/// Pure; the capture thread's alone.
class CaptureHold
{
public:
    static constexpr double kMinLocked = 0.90;
    static constexpr double kMinCarried = 0.97;
    static constexpr double kMaxFolded = 0.01;
    static constexpr double kMaxBusy = 0.70;
    static constexpr double kDenseRatio = 1.5;
    static constexpr int kMinDenseSeconds = 20;
    static constexpr int64_t kSecondUs = 1000000;

    struct Verdict
    {
        /// Enough dense seconds to say anything.
        bool judged = false;
        /// Within every threshold; true when not judged.
        bool held = true;
        int denseSeconds = 0;
        /// Of the gate's calls, 0..1; -1 when the gate was never called.
        double locked = -1;
        /// Frames carried per frame of the stream's rate.
        double carried = 0;
        /// Of the presents.
        double folded = 0;
        /// Of the time.
        double busy = 0;
        /// The first threshold missed; empty when held.
        std::string why;
    };

    /// The count starts at @p nowUs, for a stream of @p fps.
    void start(int64_t nowUs, double fps)
    {
        *this = CaptureHold{};
        m_Fps = fps;
        m_SecondStartUs = nowUs;
        m_Started = true;
    }

    /// The gate's rate moved (a step of "Auto", a client screen changed): the
    /// second that closes next is judged on it.
    void setFps(double fps) { m_Fps = fps; }

    /// The loop waited @p us for the display (an acquire, a timed sleep).
    void waited(int64_t us)
    {
        if (us > 0) m_Second.waitUs += us;
    }

    /// One acquire's presents, @p folded of them merged into it.
    void presents(int64_t count, int64_t folded)
    {
        m_Second.presents += count;
        m_Second.folded += folded;
    }

    /// One call of the stream's gate on the display's lattice; @p lockable
    /// when it could decide locked.
    void gateCall(bool lockable)
    {
        m_Second.gateCalls++;
        if (lockable) m_Second.lockable++;
    }

    /// A frame went to the encoder.
    void carried() { m_Second.carried++; }

    /// Closes the second once a whole one went by since it opened.
    void tick(int64_t nowUs)
    {
        if (!m_Started) return;
        const int64_t spanUs = nowUs - m_SecondStartUs;
        if (spanUs < kSecondUs) return;
        const double seconds = static_cast<double>(spanUs) / kSecondUs;
        if (m_Fps > 0 && static_cast<double>(m_Second.presents) >= kDenseRatio * m_Fps * seconds) {
            m_Dense.add(m_Second);
            m_Dense.spanUs += spanUs;
            m_Dense.expected += m_Fps * seconds;
            m_DenseSeconds++;
        }
        m_Second = Count{};
        m_SecondStartUs = nowUs;
    }

    Verdict verdict() const
    {
        Verdict v;
        v.denseSeconds = m_DenseSeconds;
        if (m_DenseSeconds < kMinDenseSeconds || m_Dense.spanUs <= 0) return v;
        v.judged = true;
        if (m_Dense.gateCalls > 0)
            v.locked =
                static_cast<double>(m_Dense.lockable) / static_cast<double>(m_Dense.gateCalls);
        v.carried =
            m_Dense.expected > 0 ? static_cast<double>(m_Dense.carried) / m_Dense.expected : 0;
        v.folded = m_Dense.presents > 0
                       ? static_cast<double>(m_Dense.folded) / static_cast<double>(m_Dense.presents)
                       : 0;
        v.busy = 1.0 - static_cast<double>(m_Dense.waitUs) / static_cast<double>(m_Dense.spanUs);
        if (v.busy < 0) v.busy = 0;
        if (v.folded > kMaxFolded)
            v.why = "presents folded";
        else if (v.busy > kMaxBusy)
            v.why = "loop busy";
        else if (v.carried < kMinCarried)
            v.why = "frames not carried";
        else if (v.locked >= 0 && v.locked < kMinLocked)
            v.why = "lattice not locked";
        v.held = v.why.empty();
        return v;
    }

private:
    struct Count
    {
        int64_t presents = 0;
        int64_t folded = 0;
        int64_t waitUs = 0;
        int64_t gateCalls = 0;
        int64_t lockable = 0;
        int64_t carried = 0;
        int64_t spanUs = 0;
        double expected = 0;

        void add(const Count& o)
        {
            presents += o.presents;
            folded += o.folded;
            waitUs += o.waitUs;
            gateCalls += o.gateCalls;
            lockable += o.lockable;
            carried += o.carried;
        }
    };

    bool m_Started = false;
    double m_Fps = 0;
    int64_t m_SecondStartUs = 0;
    int m_DenseSeconds = 0;
    Count m_Second;
    Count m_Dense;
};

} // namespace mw::native
