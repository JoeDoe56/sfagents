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

namespace mw::native {

/// @p a / @p b rounded down, towards minus infinity, for @p b > 0 — Python's
/// `//`. C++'s `/` rounds towards zero, and the lattice's offsets are signed:
/// the copy the bench replays (gatesim.py) must land on the same nanosecond.
inline int64_t floorDiv(int64_t a, int64_t b)
{
    const int64_t q = a / b;
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q;
}

/// The display's presents, as a lattice of its refresh period whose phase
/// follows them — for the stream's gate to lock its windows on (plan
/// « glissade », 14/10/2026).
///
/// ── Why the gate needs it ───────────────────────────────────────────────────
///
/// FrameCadence admits the first present of each window of its own grid. Its
/// interval is rounded to the microsecond — 16 666 µs for 60 fps — so on the
/// product's virtual display at 240 Hz the grid slips ~36 µs a second along
/// the presents. A window starts a quarter interval before its tick: at 60 fps
/// on 240 Hz, one display period before it, ON a present. Every ~2 min for
/// ~30 s, and at the start of every stream, the presents' own jitter then
/// decides between two neighbours, and the pictures go 12.5 / 20.8 ms apart
/// instead of 16.7 (bench §8w.8). A client that paints at its vsync shows it:
/// 6.8 % of its refreshes at 60 Hz, far from any click (§8w.9). A cadence
/// aligned on such a client (CadenceAlign.h) is exact but slips all the same,
/// at the rate its measure of the client's refresh is off.
///
/// The lattice gives the gate the display's own grid: a period T from the
/// display's mode, and a phase that follows the presents. The gate can then
/// open its windows halfway between two presents, where none falls.
///
/// ── The loop ────────────────────────────────────────────────────────────────
///
/// Fed the time of each real present (note()), skipped by the gate or not,
/// before the gate decides — never a pointer that moved alone, an empty wait
/// nor a re-send, which have no present of their own.
///
///  - e, the present's offset from the lattice's nearest point. The phase
///    follows e/32, e bounded to ±T/4, so a present a refresh off its slot
///    pulls it by a sliver at most. First order: the virtual display's phase
///    wanders by ±50 to 100 µs a second over 10 s, a frequency term brought
///    nothing, and a gain from 1/8 to 1/128 replayed the same.
///  - The sharpness: the mean |e|, plain over the first 64 presents, then
///    running (gain 1/64). Engaged under T/10 once 64 presents are in, let go
///    above T/5. Measured, in periods: 0.045 to 0.06 on the virtual display
///    under dense content, 0.10 to 0.12 for the bench's test clock, 0.16 for
///    the Linux portal and macOS, 0.25 for presents at random.
///  - The phase starts again on the present after a pause of more than 10 s,
///    or of more than 1 s that left it beyond T/4: a resync, not counted in
///    the sharpness.
///  - A present at or before the last one taken, or on the same point of the
///    lattice, leaves no trace.
///
/// Whole nanoseconds, every division rounded down. ⚠️
/// scripts/bench/clickpath/gatesim.py's Lattice is a copy, the one the bench
/// replays, and its golden train holds both to the same counts
/// (test_cadence_lock.cpp): change them together.
///
/// Pure and clocked by the caller; the capture thread's alone.
class PresentLattice
{
public:
    /// The phase follows 1/kGain of each offset.
    static constexpr int64_t kGain = 32;
    /// Presents averaged before the lattice may engage; the running mean's
    /// gain after that is 1/kSamples.
    static constexpr int64_t kSamples = 64;
    /// A pause after which the phase starts again on the next present.
    static constexpr int64_t kPauseNs = 10'000'000'000LL;
    /// A shorter pause after which it does if the present is beyond T/4.
    static constexpr int64_t kShortPauseNs = 1'000'000'000LL;

    /// What one present changed.
    enum class Change
    {
        None,
        Engaged,
        Released,
        Resynced,
    };

    /// What the gate reads of the lattice, by value: its phase, its period,
    /// and whether it is engaged.
    struct View
    {
        int64_t phaseNs = 0;
        int64_t periodNs = 0;
        bool engaged = false;

        /// The lattice's point nearest @p tNs; a tie goes to the later one.
        int64_t slotNs(int64_t tNs) const
        {
            return phaseNs + floorDiv(tNs - phaseNs + periodNs / 2, periodNs) * periodNs;
        }

        /// The halfway point between two of the lattice's points nearest
        /// @p xNs; a tie goes to the later one.
        int64_t midNs(int64_t xNs) const
        {
            const int64_t first = phaseNs + periodNs / 2;
            return first + floorDiv(xNs - first + periodNs / 2, periodNs) * periodNs;
        }
    };

    /// 1e12 / @p milliHz: 4166666 ns for 240000. 0 for none.
    static int64_t periodNsFromMilliHz(int64_t milliHz)
    {
        return milliHz > 0 ? 1'000'000'000'000LL / milliHz : 0;
    }

    /// A DXGI mode's RefreshRate, @p numerator / @p denominator hertz. 0 for
    /// none: DXGI says 0/0 or 0/1 when it does not know.
    static int64_t periodNsFromRational(int64_t numerator, int64_t denominator)
    {
        return numerator > 0 && denominator > 0 ? 1'000'000'000LL * denominator / numerator : 0;
    }

    PresentLattice() = default;
    explicit PresentLattice(int64_t periodNs)
        : m_PeriodNs(periodNs > 0 ? periodNs : 0)
    {}

    /// A new lattice of @p periodNs, for a capture opened again — another
    /// mode, HDR, the D3D12 chain lost, Desktop Duplication and WGC trading
    /// places: the presents' phase, and even their period, are another
    /// display's. The counters and the first present's times are the
    /// session's and stay.
    void restart(int64_t periodNs)
    {
        if (m_Started) m_Restarts++;
        m_PeriodNs = periodNs > 0 ? periodNs : 0;
        m_Started = false;
        m_PhaseNs = 0;
        m_LastNs = 0;
        m_Samples = 0;
        m_Acc = 0;
        m_Engaged = false;
    }

    /// One real present's time, @p presentNs; what it changed.
    Change note(int64_t presentNs)
    {
        const int64_t t = m_PeriodNs;
        if (t <= 0) return Change::None;
        if (!m_Started) {
            m_Started = true;
            m_PhaseNs = presentNs;
            m_LastNs = presentNs;
            if (!m_HaveFirst) {
                m_HaveFirst = true;
                m_FirstNs = presentNs;
            }
            m_Taken++;
            return Change::None;
        }
        if (presentNs <= m_LastNs) {
            m_Ignored++;
            return Change::None;
        }
        const int64_t k = floorDiv(presentNs - m_PhaseNs + t / 2, t);
        if (k <= 0) {
            m_Ignored++;
            return Change::None;
        }
        const int64_t predicted = m_PhaseNs + k * t;
        const int64_t e = presentNs - predicted;
        const int64_t absE = e < 0 ? -e : e;
        const int64_t gap = presentNs - m_LastNs;
        m_Taken++;
        if (gap > kPauseNs || (gap > kShortPauseNs && 4 * absE > t)) {
            m_PhaseNs = presentNs;
            m_LastNs = presentNs;
            m_Resyncs++;
            return Change::Resynced;
        }
        const int64_t bound = t / 4;
        const int64_t bounded = e < -bound ? -bound : e > bound ? bound : e;
        m_PhaseNs = predicted + floorDiv(bounded, kGain);
        m_LastNs = presentNs;
        if (m_Samples < kSamples) {
            m_Acc += absE;
            m_Samples++;
            if (m_Samples < kSamples) return Change::None;
        } else {
            m_Acc += absE - m_Acc / kSamples;
        }
        if (!m_Engaged && 10 * m_Acc < kSamples * t) {
            m_Engaged = true;
            m_Engagements++;
            if (!m_HaveEngaged) {
                m_HaveEngaged = true;
                m_FirstEngagedNs = presentNs;
            }
            return Change::Engaged;
        }
        if (m_Engaged && 5 * m_Acc > kSamples * t) {
            m_Engaged = false;
            m_Releases++;
            return Change::Released;
        }
        return Change::None;
    }

    View view() const { return View{m_PhaseNs, m_PeriodNs, m_Engaged}; }

    int64_t periodNs() const { return m_PeriodNs; }
    int64_t phaseNs() const { return m_PhaseNs; }
    bool engaged() const { return m_Engaged; }
    /// A present has been taken since the last (re)start: slotNs() means
    /// something.
    bool started() const { return m_Started; }

    /// The mean |e| in periods: 0.25 for presents at random. -1 before any
    /// sample.
    double sharpness() const
    {
        const int64_t n = m_Samples < kSamples ? m_Samples : kSamples;
        return n > 0 && m_PeriodNs > 0 ? static_cast<double>(m_Acc) / static_cast<double>(n) /
                                             static_cast<double>(m_PeriodNs)
                                       : -1.0;
    }
    /// The mean |e|, ns; -1 before any sample.
    int64_t meanOffsetNs() const
    {
        const int64_t n = m_Samples < kSamples ? m_Samples : kSamples;
        return n > 0 ? m_Acc / n : -1;
    }

    /// The sum of |e| over the first kSamples presents, then kSamples times
    /// the running mean; and how many samples are in it (kSamples at most).
    int64_t acc() const { return m_Acc; }
    int64_t samples() const { return m_Samples; }

    /// Presents that moved the loop (a resync included), and those that left
    /// no trace.
    int64_t taken() const { return m_Taken; }
    int64_t ignored() const { return m_Ignored; }
    int64_t engagements() const { return m_Engagements; }
    int64_t releases() const { return m_Releases; }
    int64_t resyncs() const { return m_Resyncs; }
    /// Lattices started again with the capture (restart()).
    int64_t restarts() const { return m_Restarts; }

    /// The session's first present, and its first engagement; -1 before.
    int64_t firstNs() const { return m_HaveFirst ? m_FirstNs : -1; }
    int64_t firstEngagedNs() const { return m_HaveEngaged ? m_FirstEngagedNs : -1; }

private:
    int64_t m_PeriodNs = 0;
    bool m_Started = false;
    int64_t m_PhaseNs = 0;
    int64_t m_LastNs = 0;
    int64_t m_Samples = 0;
    int64_t m_Acc = 0;
    bool m_Engaged = false;
    int64_t m_Taken = 0;
    int64_t m_Ignored = 0;
    int64_t m_Engagements = 0;
    int64_t m_Releases = 0;
    int64_t m_Resyncs = 0;
    int64_t m_Restarts = 0;
    bool m_HaveFirst = false;
    int64_t m_FirstNs = 0;
    bool m_HaveEngaged = false;
    int64_t m_FirstEngagedNs = 0;
};

/// What EncoderTuning::cadenceLock's -1, the product's, means: on since the
/// bench (plan « glissade », gate G2, 14/10/2026).
inline constexpr bool kCadenceLockProduct = true;

/// Whether the stream's gate may lock on the lattice: the bench's key
/// (@p mode, EncoderTuning::cadenceLock: -1 the product's, 0 off, 1 on); the
/// product's cadence (@p productCadence) — a bench cadence says how the loop
/// takes its pictures, and cadence=deadline falls back on the product's gate
/// whenever the client's grid is stale; Desktop Duplication (@p duplication),
/// whose present stamps the bench replayed — WGC's mix the compositor's
/// targets with its wake-ups; and a display period known (@p periodNs). The
/// gate itself then locks only while the lattice is engaged, on an interval
/// of N >= 2 periods (FrameCadence::lockRatio).
inline bool cadenceLockArmed(int mode, bool productCadence, bool duplication, int64_t periodNs)
{
    const bool on = mode < 0 ? kCadenceLockProduct : mode == 1;
    return on && productCadence && duplication && periodNs > 0;
}

} // namespace mw::native
