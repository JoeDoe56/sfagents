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

namespace mw::native {

/// "Auto" with detection (design §33.10): the client may ask a native host to
/// run the stream above the client's own rate — twice it, then the captured
/// display's refresh — while it measures whether what it shows gets younger,
/// and to come back to its own rate the moment it does not.
///
/// What the host answered to one such request. The answer is given at once,
/// from what the session already knows; the loop applies it between two
/// frames.
struct FpsStep
{
    enum class Verdict
    {
        /// Back at the stream's own rate: the client asked for no step.
        Base,
        /// The rate asked for is the stream's rate from now on.
        Applied,
        /// Above the captured display's refresh: the stream runs at that
        /// refresh instead — the host has no frames beyond it.
        Capped,
        /// Not taken; the step in force before, if any, stays. `why` says why.
        Refused
    };

    Verdict verdict = Verdict::Refused;
    /// The stream's rate from now on, above the client's own: the rate asked,
    /// or the display's refresh when the step is above it. 0 when the stream
    /// is at its own rate. Refused: the step still in force, 0 for none — a
    /// client that kept 120 and asks for 240 in vain keeps its 120.
    int fps = 0;
    /// What the client asked for.
    int askedFps = 0;
    /// Why it was capped or refused, a few words for the log and the reply;
    /// empty otherwise. Always a string literal.
    const char* why = "";
};

/// What a session tells the client's detection about its cadence, once a
/// second with the stats.
struct CadenceStatus
{
    /// Presents of the captured display over the last whole second, acquired
    /// or folded into an acquire: how fast what is on screen changes. A
    /// client asks for no step unless this is clearly above its own rate.
    int presentsPerSecond = 0;
    /// The stream's rate without any step — the setting, Auto's choice, what
    /// a decoder cap left of it. 0 before the loop runs.
    int baseFps = 0;
    /// The step in force, 0 for none.
    int stepFps = 0;
    /// The captured display's refresh, rounded; 0 when unknown.
    int displayHz = 0;
};

} // namespace mw::native
