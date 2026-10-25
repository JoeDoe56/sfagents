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

#include "PresentLattice.h"

#include <cstdint>
#include <string>

namespace mw::native {

/// Holds the capture loop to the stream's frame rate — without ever holding a
/// picture.
///
/// ── Why the loop needs this at all ──────────────────────────────────────────
///
/// Desktop Duplication wakes the loop on every present of the display, and
/// until this existed every one of them was encoded. On a 165 Hz panel with the
/// stream set to 60 that is 165 frames a second through a rate control that was
/// told 60: the constant bitrate is a budget PER FRAME, so the wire carried 2.75
/// times the configured rate on a moving screen — 63 Mbit/s for 20 set, the
/// moment a window was dragged — and the VBV bounded nothing it was meant to.
/// In a LAN nobody notices. Over the Internet the excess sits in the SCTP queue
/// and is felt as the pointer trailing the hand.
///
/// ── Nothing waits: the first present at or after each tick ──────────────────
///
/// The stream's interval is a grid. A present that arrives before the next tick
/// is skipped — converted, so the freshest picture is always in the converter's
/// texture for the still-screen paths, but not encoded. The first present at or
/// after the tick is encoded THE MOMENT IT ARRIVES, and the grid advances by one
/// interval. Nothing is ever kept for a later wake-up.
///
/// The first version of this gate did the opposite: it held the last present of
/// each interval and encoded it when the interval fell due, for a perfectly
/// regular emission. Measured over the Internet, that wait was two thirds of
/// the host's time — 5.4 ms on average, a full 17 ms interval at the p99, for a
/// present that arrived just after a tick and had to sit out the next one. A
/// picture waiting on the host is latency the viewer feels; an emission that is
/// early or late by a present period (6 ms at 165 Hz, nothing when the game
/// itself runs at the stream's rate) is not, and with tearing on the client is
/// invisible altogether. So: latency first, regularity second.
///
/// ── The slack, and how the grid keeps its rate ──────────────────────────────
///
/// A present a little BEFORE the tick — within kSlackFraction of the interval —
/// goes through too, because the next one would arrive a whole present period
/// later for nothing. So each tick owns a window, from a quarter interval
/// before it to a quarter interval before the next, and the first present in
/// that window is the one encoded, however late in it it comes. The grid
/// advances by exactly one interval from where it was, never "now plus one":
/// that is what keeps the rate at the setting when every admitted present is
/// early or late by a few milliseconds (anchoring on the present itself
/// measured 56 fps for 60 on a 165 Hz panel).
///
/// Only a window that closed with nothing in it moves the grid — a present was
/// MISSING where the grid expected one. When the present that ends the gap
/// comes within the next interval — a game at the stream's own rate that
/// drifted, or landed a refresh late, past the window's end; content a little
/// faster than the stream with a longer gap than usual — it is counted for
/// the tick it missed, and the grid moves so that its window ends there: the
/// next window opens at the present. Later than that — two windows with
/// nothing, the screen had been still or the loop had stalled — the grid
/// restarts on it, one interval on. So the loop never catches up with a burst
/// (one missed tick at most is made up, and only while the content keeps
/// coming), a first change after a pause is on the wire at once, and a game at
/// 60 fps under a 60 fps stream locks onto the grid instead of beating against
/// it: its latest present sits at the end of a window, the others inside.
///
/// The grid used to be re-anchored on any present later than one refresh of
/// the display, taken for a missing one. Measured on the Android TV bench (B,
/// 08/10/2026): content at 60 fps on a 144 Hz display streamed at 50 comes
/// every 16.7 ms, so the first present past a tick is often more than a
/// refresh (6.9 ms) late with none missing; each re-anchor threw that lateness
/// away, the next present fell too early and was skipped — 40 fps carried for
/// 50. Replayed on RE9 (77 fps) on the virtual display at 240 Hz, the default
/// since 30/09: 48.4 for 60, 40.7 for 50. The same rule cost a 60 fps test
/// pattern on a 120 Hz screen, streamed at 60, a third of its frames: landing
/// a refresh early or late, it re-anchored on the late ones and skipped the
/// early ones. Moving the grid by whole intervals only, never its phase, gives
/// the rate back to the first case and not to the second: a game at the
/// stream's rate a refresh early or late then beats against the grid, down to
/// 45 fps for 60 in simulation.
///
/// ── A stream at the display's own rate: a ceiling, not a grid ───────────────
///
/// A stream at the display's own rate — the setting "0" resolves to it — was
/// long left without a gate, on the belief that a display presents no faster
/// than it refreshes. Desktop Duplication disagrees. Measured on DualRTX
/// (22/09/2026): a 60 Hz screen driven by the iGPU, 59.95 Hz by its own
/// vblanks, reported 73 to 104 presents a second while a browser on it ticked
/// with the 120 Hz primary — every one encoded, 72 to 91 frames a second for
/// 60 set and 21 to 25 Mbit/s for 20. An uncapped game on a 60 Hz screen is
/// the same case.
///
/// A gate at exactly the display's rate would be wrong the other way: a panel a
/// hair faster than its nominal rate would run early against the grid and lose
/// a present every few seconds. So the gate is a CEILING (ceiling()): the
/// stream's interval shortened by kCeilingHeadroom, which no real refresh ever
/// comes under — every present of a display that keeps to its rate is past due
/// when it arrives and goes straight through — while presents that come faster
/// than the display can show them are held to the stream's rate, give or take
/// that headroom.
///
/// And its slack is a whole interval rather than a quarter. What the loop is
/// handed is not a clean refresh train: on the Arc's 120 Hz screen streamed at
/// 120, one present in twenty-five came less than 6 ms after the one before —
/// the loop had been busy and caught up, or the browser presented twice — and a
/// quarter-interval slack skipped two of them a second, each a picture the
/// viewer then waited a whole content frame for. A ceiling is there to stop a
/// runaway source, not to space frames; over anything longer than a pair it
/// holds the rate all the same.
///
/// ── The grid is kept in nanoseconds ─────────────────────────────────────────
///
/// A cadence aligned on the client's refresh (CadenceAlign.h) is an exact
/// multiple of a measured period — three 165 Hz periods are 18181.8 µs — and a
/// grid that truncated it to whole microseconds would slip a present every two
/// minutes. The interval and the grid are held in nanoseconds; the loop's
/// stamps stay in microseconds, the unit everything else here speaks.
///
/// ── Locked on the display's presents (plan « glissade », 14/10/2026) ───────
///
/// A grid of its own interval slips along the display's presents all the
/// same: one rounded to the microsecond by ~36 µs a second at 60 fps on
/// 240 Hz, an aligned cadence's exact one at the rate its measure of the
/// client's refresh is off. Wherever a window's start lies, it comes to lie
/// on a present once in a while — at 60 fps on 240 Hz every ~2 min for ~30 s,
/// and from the start of every stream — and the presents' own jitter then
/// decides between two neighbours: pictures 12.5 / 20.8 ms apart instead of
/// 16.7 (bench §8w.8), which a client that paints at its vsync shows.
///
/// So, while the display's presents keep to its refresh (PresentLattice is
/// engaged) and the interval is N >= 2 display periods to within 0.2 %
/// (lockRatio()), admit() with a lattice decides on it:
///  - on the picture's own time: a present's, a pointer's wake-up, a
///    re-send's now — one time scale, the display's;
///  - an interval of exactly N periods, whatever the setting rounds to;
///  - each window starting halfway between two presents of the lattice,
///    where none falls. A picture in its window opens the next at the
///    halfway point nearest one interval on, where the lattice's loop
///    corrects it, and never before the one that follows this picture.
///    After a window with nothing in it, the next opens half a period after
///    the picture's place on the lattice (today's gate opens it ON the
///    picture); after a pause, an interval less half a period after it, so
///    that content coming back dense is carried an interval apart and not
///    three periods sooner.
/// Anywhere else — no lattice, not engaged, an interval of no whole number
/// of periods, a ceiling — it is today's gate, exactly, on the caller's now.
/// intervalUs(), nextDueUs() and skipped() keep their meaning: what reads
/// the interval (InputAdmit, the comparison of two gates) reads the one set.
///
/// Replayed on the bench's passes (scripts/bench/clickpath/locksim.py):
/// pictures a refresh off the stream's interval 8.3 % → 1.8 % on dense
/// content, 1.2-34.6 % → 1.0-2.4 % for a client at its vsync, the pictures
/// carried within 0.15 % and the wait for a new one never longer.
///
/// Pure and clocked by the caller, so it can be tested without a display.
/// ⚠️ scripts/bench/clickpath/gatesim.py's Gate is a copy of admit(), the one
/// the bench replays: change both together.
class FrameCadence
{
public:
    /// How early a present may be, as a fraction of the interval, and still go
    /// through: a quarter. A window admits one present at most, whatever the
    /// slack, so the slack costs no rate — it only decides how far the emission
    /// may run ahead of the grid before the next present is preferred.
    static constexpr int kSlackDivisor = 4;

    /// How much faster than the stream a ceiling lets frames through: one
    /// fiftieth, 61.2 fps for 60. Far above how far a display's clock strays
    /// from its nominal rate (a few hundredths of a hertz), far below what a
    /// runaway source produces.
    static constexpr int kCeilingHeadroom = 50;

    /// How close to N display periods the interval must be for the gate to
    /// lock on them: within 1/kLockTolerance, 0.2 %. 59.94 fps on a display
    /// at 239.76 Hz is 4 periods; 60 on a display at 239.76 Hz is too.
    static constexpr int64_t kLockTolerance = 500;

    /// How a call was decided: skipped, or admitted by today's rule, or by
    /// one of the locked gate's — in its window, after a window with nothing
    /// in it, after a pause.
    enum class Rule : uint8_t
    {
        Skip,
        Today,
        Window,
        Empty,
        Pause,
    };

    /// @p fps 0 (or negative) disables the gate. @p displayHz is the display's
    /// refresh, which sets how late a ceiling's present may be before it is
    /// re-anchored on (see admit()); 0 falls back to half an interval.
    explicit FrameCadence(int fps, int displayHz = 0)
        : m_IntervalNs(fps > 0 ? static_cast<int64_t>(1000000 / fps) * 1000 : 0)
        , m_ReanchorNs(displayHz > 0 ? static_cast<int64_t>(1000000 / displayHz) * 1000
                                     : m_IntervalNs / 2)
    {}

    /// The same gate on an exact interval rather than a whole number of frames
    /// per second — for a cadence aligned on the client's refresh, where the
    /// interval is a multiple of a measured period and rarely a round number.
    static FrameCadence fromIntervalNs(int64_t intervalNs, int displayHz)
    {
        FrameCadence c(0, displayHz);
        c.m_IntervalNs = intervalNs > 0 ? intervalNs : 0;
        if (displayHz <= 0) c.m_ReanchorNs = c.m_IntervalNs / 2;
        return c;
    }

    /// The gate for a stream at or above the display's own rate, whose interval
    /// is @p intervalNs: a real refresh always goes through, anything faster is
    /// held to the stream's rate (see above).
    static FrameCadence ceiling(int64_t intervalNs, int displayHz)
    {
        FrameCadence c =
            fromIntervalNs(intervalNs * kCeilingHeadroom / (kCeilingHeadroom + 1), displayHz);
        c.m_Ceiling = c.enabled();
        return c;
    }

    bool enabled() const { return m_IntervalNs > 0; }
    /// True for a ceiling(): every refresh of the display is encoded.
    bool isCeiling() const { return m_Ceiling; }
    int64_t intervalUs() const { return m_IntervalNs / 1000; }
    /// The interval as the gate holds it — exact for a cadence aligned on the
    /// client's refresh, which intervalUs() rounds.
    int64_t intervalNs() const { return m_IntervalNs; }
    /// A ceiling's slack is a whole interval: it lets a pair of presents
    /// through back to back as long as the grid is not ahead of the clock,
    /// and still holds the rate over any stretch longer than two frames.
    int64_t slackUs() const { return m_Ceiling ? intervalUs() : intervalUs() / kSlackDivisor; }
    int64_t reanchorUs() const { return m_ReanchorNs / 1000; }

    /// A new picture is ready at @p nowUs. True: encode it now. False: skip it
    /// — the next present is the one that will carry the interval.
    bool admit(int64_t nowUs)
    {
        m_Calls++;
        m_LastLocked = false;
        return admitToday(nowUs);
    }

    /// The same, the gate locked on @p lattice where it may (see the class):
    /// @p presentUs is the picture's own time — a present's, a pointer's
    /// wake-up, a re-send's now — on which the locked gate decides; @p nowUs
    /// the one today's gate decides on, as admit(nowUs) does.
    bool admit(int64_t nowUs, int64_t presentUs, const PresentLattice::View& lattice)
    {
        m_Calls++;
        m_LastLocked = false;
        if (lattice.engaged) {
            const int64_t n = lockRatio(lattice.periodNs);
            if (n > 0) {
                m_LastLocked = true;
                m_LockedCalls++;
                return admitLocked(presentUs, lattice, n);
            }
        }
        return admitToday(nowUs);
    }

    /// N when the interval is N >= 2 display periods of @p periodNs to within
    /// 1/kLockTolerance; 0 otherwise, and for a ceiling or a gate disabled.
    int64_t lockRatio(int64_t periodNs) const
    {
        if (m_Ceiling || m_IntervalNs <= 0 || periodNs <= 0) return 0;
        const int64_t n = (m_IntervalNs + periodNs / 2) / periodNs;
        const int64_t off = m_IntervalNs - n * periodNs;
        if (n < 2 || kLockTolerance * (off < 0 ? -off : off) > n * periodNs) return 0;
        return n;
    }

    /// When the next present will be admitted. Meaningful only when enabled.
    int64_t nextDueUs() const { return m_NextDueNs / 1000; }

    /// Where the next window starts: the grid's next tick less the slack.
    int64_t windowStartNs() const { return m_NextDueNs - slackUs() * 1000; }

    /// Presents that were not encoded — what the display produced that the
    /// stream did not carry.
    int64_t skipped() const { return m_Skipped; }

    /// How the last call was decided, and whether by the locked gate (a skip
    /// may be).
    Rule lastRule() const { return m_LastRule; }
    bool lastLocked() const { return m_LastLocked; }
    /// Calls, those the locked gate decided, and the pictures each rule
    /// admitted (Rule::Skip: skipped()).
    int64_t calls() const { return m_Calls; }
    int64_t lockedCalls() const { return m_LockedCalls; }
    int64_t admitted(Rule rule) const
    {
        return rule == Rule::Skip ? m_Skipped : m_Admitted[static_cast<int>(rule)];
    }

private:
    bool admitToday(int64_t nowUs)
    {
        if (!enabled()) {
            m_LastRule = Rule::Today;
            m_Admitted[static_cast<int>(Rule::Today)]++;
            return true;
        }
        const int64_t nowNs = nowUs * 1000;
        const int64_t slackNs = slackUs() * 1000;
        if (nowNs + slackNs < m_NextDueNs) {
            m_Skipped++;
            m_LastRule = Rule::Skip;
            return false;
        }
        m_LastRule = Rule::Today;
        m_Admitted[static_cast<int>(Rule::Today)]++;
        const int64_t lateNs = nowNs - m_NextDueNs;
        if (m_Ceiling) {
            // A ceiling keeps its own rule: re-anchored on a present later than
            // one refresh of the display.
            m_NextDueNs = lateNs > m_ReanchorNs ? nowNs + m_IntervalNs : m_NextDueNs + m_IntervalNs;
            return true;
        }
        // How late a present may be and still be in its tick's window.
        const int64_t windowEndNs = m_IntervalNs - slackNs;
        if (lateNs < windowEndNs)
            m_NextDueNs += m_IntervalNs; // in its window: the grid keeps its phase
        else if (lateNs < windowEndNs + m_IntervalNs)
            m_NextDueNs = nowNs + slackNs; // one window empty: the next one opens here
        else
            m_NextDueNs = nowNs + m_IntervalNs; // a pause or a stall: restart on it
        return true;
    }

    /// The gate locked on @p lattice, whose period @p n times is the
    /// interval; see the class. The window's start is the grid's tick less
    /// today's slack, so nextDueUs() keeps its meaning.
    bool admitLocked(int64_t presentUs, const PresentLattice::View& lattice, int64_t n)
    {
        const int64_t t = lattice.periodNs;
        const int64_t nowNs = presentUs * 1000;
        const int64_t slackNs = slackUs() * 1000;
        const int64_t startNs = m_NextDueNs - slackNs;
        if (nowNs < startNs) {
            m_Skipped++;
            m_LastRule = Rule::Skip;
            return false;
        }
        const int64_t intervalNs = n * t;
        int64_t nextNs = 0;
        if (nowNs < startNs + intervalNs) {
            // In its window: the next one opens at the halfway point nearest
            // one interval on — where the lattice's loop corrects the grid —
            // never before the one that follows this picture. A start left
            // off the halfway points (an engagement, a resync) can put the
            // nearest before it.
            nextNs = lattice.midNs(startNs + intervalNs);
            const int64_t leastNs = lattice.slotNs(nowNs) + t / 2;
            if (nextNs < leastNs) nextNs = leastNs;
            m_LastRule = Rule::Window;
        } else if (nowNs < startNs + 2 * intervalNs) {
            // One window with nothing in it: the next opens half a period
            // after this picture's place on the lattice.
            nextNs = lattice.slotNs(nowNs) + t / 2;
            m_LastRule = Rule::Empty;
        } else {
            // A pause: the next picture of content that comes back dense is
            // the one an interval after this one.
            nextNs = lattice.slotNs(nowNs) + intervalNs - t / 2;
            m_LastRule = Rule::Pause;
        }
        m_Admitted[static_cast<int>(m_LastRule)]++;
        m_NextDueNs = nextNs + slackNs;
        return true;
    }

    int64_t m_IntervalNs = 0;
    int64_t m_ReanchorNs = 0;
    int64_t m_NextDueNs = 0;
    int64_t m_Skipped = 0;
    bool m_Ceiling = false;
    Rule m_LastRule = Rule::Skip;
    bool m_LastLocked = false;
    int64_t m_Calls = 0;
    int64_t m_LockedCalls = 0;
    int64_t m_Admitted[5] = {};
};

/// The head of the session's last line on the lattice, which the bench's
/// replay reads (gatesim.py, lock_line()): the period, and the gate's
/// interval as it holds it — an aligned cadence's exact one, a ceiling's
/// shortened one.
inline std::string cadenceLockHead(int64_t periodNs, const FrameCadence& gate)
{
    return "period " + std::to_string(periodNs) + " ns, interval " +
           std::to_string(gate.intervalNs()) + " ns";
}

/// Whether the gate may lock on the display's presents, in a few words for
/// the log; the arguments are cadenceLockArmed()'s.
inline std::string cadenceLockState(int mode, bool productCadence, bool duplication,
                                    int64_t periodNs)
{
    if (periodNs <= 0) return "off, the display's period is not known";
    if (!productCadence) return "off under a bench cadence";
    if (!duplication) return "off under Windows.Graphics.Capture";
    if (!cadenceLockArmed(mode, productCadence, duplication, periodNs))
        return mode == 0 ? "off (cadencelock=0)" : "off";
    return mode == 1 ? "on (cadencelock=1)" : "on";
}

/// What the gate does with the display's presents, for the line said at the
/// start and at each change of gate or of capture: whether it may lock on
/// them, on how many display periods a picture, or why it does not. The
/// arguments are cadenceLockArmed()'s, and the gate.
inline std::string cadenceLockText(int mode, bool productCadence, bool duplication,
                                   int64_t periodNs, const FrameCadence& gate)
{
    const std::string state = cadenceLockState(mode, productCadence, duplication, periodNs);
    if (periodNs <= 0) return state;
    const bool armed = cadenceLockArmed(mode, productCadence, duplication, periodNs);
    const std::string period = std::to_string(periodNs) + " ns";
    const int64_t n = gate.lockRatio(periodNs);
    std::string what;
    if (!gate.enabled())
        what = "never for this gate, which encodes every present";
    else if (gate.isCeiling())
        what = "never under a ceiling, which encodes every refresh (periods of " + period + ")";
    else if (n == 0)
        what = "never for this gate: an interval of " + std::to_string(gate.intervalNs()) +
               " ns is no whole number of periods of " + period;
    else if (armed)
        return state + " — " + std::to_string(n) + " periods of " + period +
               " a picture, once the display's presents keep to them";
    else
        what = "it would be " + std::to_string(n) + " periods of " + period + " a picture";
    return state + " — " + what + "; the lattice is kept for the log";
}

} // namespace mw::native
