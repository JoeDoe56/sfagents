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

#include "CadenceAlign.h"
#include "FrameCadence.h"
#include "mw/native/EncoderTuning.h"

#include <string>

namespace mw::native {

/// What the stream's cadence is chosen from — at start, and again whenever
/// the client's screen or its decoder's cap changes.
struct CadenceInputs
{
    /// SessionConfig::fps: the rate asked for. The Selector has already
    /// resolved "0, the display's own" to the display's rounded refresh, so
    /// it is a number unless a config bypassed it.
    int settingFps = 0;
    /// SessionConfig::maxFps: the ceiling "Auto" states, 0 for none.
    int maxFps = 0;
    /// What the client's decoder asked not to exceed (a `clientfpscap`), 0
    /// for nothing.
    int clientCapFps = 0;
    int displayMilliHz = 0;
    int clientMilliHz = 0;
    bool clientVsync = false;
    /// The bench key (EncoderTuning::cadence): whose rate the stream runs at.
    EncoderTuning::Cadence mode = EncoderTuning::Cadence::Default;
    /// "Auto" with detection (CadenceStep.h): a rate above the stream's own
    /// that the client asked for and the host granted, 0 for none.
    int stepFps = 0;
};

/// The rate the encoder's budget answers to, the loop's gate, and the log line
/// that says why.
struct CadenceChoice
{
    int fps = 0;
    FrameCadence gate{0};
    std::string line;
};

namespace cadence_detail {

/// "165", "144", "60" — the refresh rate as a person would say it.
inline std::string hz(int milliHz)
{
    return std::to_string((milliHz + 500) / 1000);
}

/// What the gate does, for the cadence line.
inline const char* gateText(const FrameCadence& gate)
{
    if (gate.isCeiling())
        return " — every refresh is encoded, presents beyond it no faster than the stream";
    return gate.enabled() ? " — the first present of each interval is encoded, at once"
                          : " — every present is encoded";
}

/// The host's own rate (plan framerate-hote, design §33.2). The client's
/// ceilings are named in the line and left out of the choice: the trial is
/// what the stream is like WITHOUT them.
inline CadenceChoice hostCadence(const CadenceInputs& in)
{
    using Mode = EncoderTuning::Cadence;
    CadenceChoice out;
    const int displayHz = (in.displayMilliHz + 500) / 1000;
    out.fps = displayHz > 0 ? displayHz : in.settingFps > 0 ? in.settingFps : 60;
    if (in.mode == Mode::HostCeiling && displayHz > 0)
        out.gate = FrameCadence::ceiling(1000000000LL / out.fps, displayHz);

    out.line = std::string("[native] cadence: the host's rate (") +
               (in.mode == Mode::HostCeiling   ? "cadence=host-ceiling"
                : in.mode == Mode::HostGuarded ? "cadence=host-guarded"
                                               : "cadence=host") +
               ") — " + std::to_string(out.fps) + " fps stream on a " + hz(in.displayMilliHz) +
               " Hz display" + gateText(out.gate);
    if (in.mode == Mode::HostGuarded)
        out.line += ", skipped while the client's decode queue holds more than a frame";
    if (in.clientMilliHz > 0)
        out.line += std::string("; client at ") + hz(in.clientMilliHz) + " Hz, " +
                    (in.clientVsync ? "on vsync" : "tearing");

    // Received, not applied: said so the log shows what the product would
    // have done with them.
    std::string ignored;
    const auto add = [&ignored](const std::string& s) {
        ignored += ignored.empty() ? s : ", " + s;
    };
    if (in.settingFps > 0 && in.settingFps != out.fps) add(std::to_string(in.settingFps) + " set");
    if (in.maxFps > 0) add("no more than " + std::to_string(in.maxFps) + " chosen for this client");
    if (in.clientCapFps > 0)
        add("no more than " + std::to_string(in.clientCapFps) + " asked by its decoder");
    if (!ignored.empty()) out.line += " (not applied: " + ignored + ")";
    return out;
}

} // namespace cadence_detail

/// Choose the loop's gate for the viewer's setting against the client's
/// screen.
///
/// When the display is FASTER than the stream, the gate is the stream's
/// grid. At or below the display's own rate it is only a ceiling
/// (FrameCadence::ceiling): every refresh is encoded as it comes, and what
/// Desktop Duplication reports beyond the refresh — a browser or a game
/// presenting faster than the screen shows — is held to the stream's rate.
/// A client presenting on vsync gets a cadence that is a divisor of its
/// refresh (CadenceAlign.h); a client that tears gets the setting as it is.
///
/// A bench key (EncoderTuning::Cadence) may set all of that aside for the
/// host display's own rate — see cadence_detail::hostCadence.
///
/// A step (CadenceStep.h) runs the stream above the client's rate, up to the
/// display's: Auto's detection asked for it, so the ceiling Auto states
/// (maxFps) does not hold it down. A client whose decoder asked for fewer
/// frames, or that paints on its vsync, is never stepped: the step is then
/// set aside and the cadence is today's.
///
/// Pure, so the choice and its log line can be tested without a display.
inline CadenceChoice chooseCadence(const CadenceInputs& in)
{
    using cadence_detail::gateText;
    using cadence_detail::hz;
    if (in.mode == EncoderTuning::Cadence::Deadline) {
        // The engine's own cadence, until the client says when its screen
        // refreshes; the loop then aims at those refreshes over the gate
        // (DeadlineCadence.h), and comes back to it when they go stale.
        CadenceInputs own = in;
        own.mode = EncoderTuning::Cadence::Default;
        CadenceChoice out = chooseCadence(own);
        out.line += "; one picture per refresh of the client once it says when they are "
                    "(cadence=deadline)";
        return out;
    }
    if (in.mode != EncoderTuning::Cadence::Default) return cadence_detail::hostCadence(in);

    CadenceChoice out;
    const int displayHz = (in.displayMilliHz + 500) / 1000;
    int fps = in.settingFps > 0 ? in.settingFps : displayHz;
    if (fps <= 0) fps = 60;

    if (in.stepFps > 0 && in.clientCapFps <= 0 && !in.clientVsync) {
        // What the stream runs at without the step: the setting under the
        // ceiling Auto states.
        const int own = in.maxFps > 0 && in.maxFps < fps ? in.maxFps : fps;
        const int stepped = displayHz > 0 && in.stepFps > displayHz ? displayHz : in.stepFps;
        if (stepped > own) {
            out.fps = stepped;
            out.gate = stepped < displayHz
                           ? FrameCadence(stepped, displayHz)
                           : FrameCadence::ceiling(1000000000LL / stepped, displayHz);
            out.line = "[native] cadence: " + std::to_string(stepped) + " fps stream on a " +
                       hz(in.displayMilliHz) + " Hz display" + gateText(out.gate) +
                       "; a step above the client's " + std::to_string(own) +
                       " fps, asked by its detection";
            if (in.clientMilliHz > 0) out.line += "; client at " + hz(in.clientMilliHz) + " Hz";
            return out;
        }
    }
    // A client whose decoder cannot keep up asks for fewer frames than the
    // viewer set (clientCapFps), and a rate chosen FOR the viewer comes with a
    // ceiling of its own (maxFps — the rate the browser's pixel budget was
    // sized at). Both only ever lower the rate; the smaller of the two is the
    // one the cadence answers to.
    const int asked = in.clientCapFps;
    const int cap = in.maxFps > 0 && (asked <= 0 || in.maxFps < asked) ? in.maxFps : asked;
    const bool capped = cap > 0 && cap < fps;
    if (capped) fps = cap;
    const int wanted = capped ? cap : in.settingFps;
    const std::string capText = capped ? " (no more than " + std::to_string(cap) + " fps: " +
                                             (cap == in.maxFps ? "the rate chosen for this client"
                                                               : "what its decoder keeps up with") +
                                             ")"
                                       : std::string();

    AlignedCadence aligned;
    if (wanted > 0 && in.clientVsync)
        aligned = alignCadence(wanted, in.clientMilliHz, displayHz, cap);

    if (aligned.aligned) {
        out.fps = aligned.fps;
        out.gate = out.fps < displayHz ? FrameCadence::fromIntervalNs(aligned.intervalNs, displayHz)
                                       : FrameCadence::ceiling(aligned.intervalNs, displayHz);
        const std::string every = aligned.divisor == 1   ? std::string("every refresh")
                                  : aligned.divisor == 2 ? std::string("every 2nd refresh")
                                  : aligned.divisor == 3
                                      ? std::string("every 3rd refresh")
                                      : "every " + std::to_string(aligned.divisor) + "th refresh";
        out.line = "[native] cadence: " + std::to_string(out.fps) + " fps stream for a " +
                   hz(in.clientMilliHz) + " Hz client presenting on vsync (" +
                   std::to_string(in.settingFps) + " set, " + every + ") on a " +
                   hz(in.displayMilliHz) + " Hz display" + gateText(out.gate) + capText;
        return out;
    }

    out.fps = fps;
    out.gate = fps < displayHz ? FrameCadence(fps, displayHz)
                               : FrameCadence::ceiling(1000000000LL / fps, displayHz);
    out.line = "[native] cadence: " + std::to_string(fps) + " fps stream on a " +
               hz(in.displayMilliHz) + " Hz display" + gateText(out.gate);
    if (in.clientMilliHz > 0) {
        out.line += "; client at " + hz(in.clientMilliHz) + " Hz";
        if (!in.clientVsync)
            out.line += ", tearing — nothing to align on";
        else if (in.settingFps <= 0)
            out.line += ", the host's own rate — nothing to align";
        else
            out.line += ", no divisor within a fifth of the setting";
    }
    out.line += capText;
    return out;
}

} // namespace mw::native
