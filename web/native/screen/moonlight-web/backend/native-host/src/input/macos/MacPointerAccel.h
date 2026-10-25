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

// The pointer speed macOS keeps to itself.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The three hosts do not agree on what a mouse count is worth, and only macOS
// is the odd one out:
//
//   Windows  SendInput(MOUSEEVENTF_MOVE) — the delta goes through the host's
//            pointer speed and "enhance pointer precision", exactly as a local
//            mouse would.
//   Linux    EV_REL on a uinput device — libinput accelerates it, same story.
//   macOS    CGEventPost of a mouse event at a position WE computed. The HID
//            driver, which is where every bit of Apple's acceleration lives,
//            is never consulted. One count moved the pointer one point, full
//            stop.
//
// So a viewer streaming a Mac was aiming with a mouse that had none of the
// host's speed and none of its acceleration, while the Mac's own mouse had
// both — a flick that crossed the screen locally barely turned the camera
// through the stream. This puts the missing half back: the host's tracking
// speed and a curve of the same shape as Apple's, applied to the counts before
// the event is built.
//
// ── What it can and cannot be ──────────────────────────────────────────────
//
// Apple's curve lives in IOHIDFamily as a per-device table, and there is no
// API that runs it for us and no device behind an injected event to read a
// table from. So the shape is reproduced, not copied: a low-speed gain taken
// from the tracking-speed slider (which IS read from the system, not guessed)
// and a saturating ramp over it whose three constants are measured on a Mac
// rather than derived. They are overridable at run time so a bench run tunes
// them without a rebuild — see the environment variables in the .mm.
//
// A game that reads RAW motion is out of reach either way: on macOS that means
// IOHIDManager, i.e. a real device, and an injected Quartz event is not one.
// Such a game sees nothing from us accelerated or not, which is why nothing
// here tries to serve it.

namespace mw::native::input {

class MacPointerAccel
{
public:
    enum class Mode
    {
        Off,    ///< one count, one point — what this host did before
        Linear, ///< the tracking-speed gain only, no speed-dependent part
        Curve,  ///< tracking speed and the ramp: what a local mouse gets
    };

    /// Read the host's pointer settings and the bench overrides, and say in
    /// the log what was settled on. Cheap; safe to call again.
    void start();

    /// Forget the speed learnt so far. For a session boundary, so the first
    /// flick of a new stream is not read against the last one's.
    void reset();

    /// Turn @p rawX / @p rawY mouse counts into points of pointer travel.
    /// The rounding error is carried to the next call, so a slow drag adds up
    /// instead of rounding away to nothing.
    void apply(int rawX, int rawY, int& outX, int& outY);

private:
    /// The gain a local mouse would get at @p countsPerSecond of desk speed.
    double gainFor(double countsPerSecond) const;

    /// Re-read the tracking-speed slider if it has been a while. The setting
    /// is the user's and can move mid-stream.
    void refresh(int64_t nowUs);

    Mode m_Mode = Mode::Curve;

    /// The tracking-speed slider, normalised so the factory setting is 1.0.
    /// Read from IOHIDSystem, not from a preference file.
    double m_Scale = 1.0;
    /// Shape of the ramp over the tracking speed, all three measurable.
    double m_GainMax = 6.0;  ///< the gain a full-speed flick ends up at
    double m_HalfIps = 12.0; ///< desk speed, in inches/s, at half the ramp
    double m_Power = 1.6;    ///< how abruptly the ramp comes in
    /// The resolution macOS assumes for a mouse whose driver does not say
    /// (kIOHIDPointerResolutionKey's own default). Only ever a unit for the
    /// speed the curve is read at — never a claim about the viewer's mouse.
    double m_Cpi = 400.0;

    double m_CarryX = 0; ///< sub-point remainder, kept for the next count
    double m_CarryY = 0;

    /// Desk speed in counts per second, smoothed: one event is too short a
    /// look, and the arrival times are a network's as much as a hand's.
    double m_Speed = 0;
    int64_t m_LastEventUs = 0;

    int64_t m_NextRefreshUs = 0;
    uint64_t m_Logged = 0;
    bool m_Started = false;
};

} // namespace mw::native::input
