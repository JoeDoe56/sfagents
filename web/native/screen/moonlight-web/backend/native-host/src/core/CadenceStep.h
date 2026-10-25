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

#include "mw/native/FpsStep.h"

#include <algorithm>
#include <array>
#include <cstdint>

namespace mw::native {

/// The host's half of "Auto" with detection (design §33.10).
///
/// ── Why the stream may go faster than the client's screen ──────────────────
///
/// "Auto" streams at the client's refresh rate, and the gate (FrameCadence)
/// encodes the first present of each interval. When the content changes faster
/// than that — a page scrolling at 240 Hz on the virtual display, a game at 80
/// frames a second for a 60 Hz client — what a skipped present showed waits
/// for the next admitted one. A client that tears paints every frame the moment
/// it is decoded, so a faster stream shows it younger pictures: 3 to 6 ms on
/// the bench, where the client keeps up (framerate-hote §12). Where it does not
/// — a weak decoder, Wi-Fi — the faster stream queues and costs far more than
/// it gains. Only the client can tell which, by measuring; so the client asks,
/// and the host answers at once and applies the answer between two frames.
///
/// ── What the host decides ───────────────────────────────────────────────────
///
/// - Nothing above the captured display's refresh: Desktop Duplication has no
///   frames beyond it. A step above is capped there; a display no faster than
///   the stream leaves nothing to step to.
/// - Nothing its encoder cannot hold: a step is refused when the encoder's p95
///   over its last window is longer than two frames at that rate — one for
///   the CPU encoder, which takes one picture at a time.
/// - Nothing under a bench cadence (EncoderTuning::Cadence), which owns the
///   rate, nor for a client whose decoder asked for fewer frames
///   (`clientfpscap`) or that paints on its vsync — one frame per refresh, and
///   none of the rest would ever be seen.
/// - The bitrate does not move: the encoder's per-frame budget follows the
///   rate through EffectiveCadence::retarget, the same road a client screen
///   that changed takes, so the wire carries the setting's bitrate in smaller
///   frames.
///
/// Pure, so the answer and its reasons are testable without a display.
struct StepInputs
{
    /// The rate asked; 0, or anything at or under the stream's own rate,
    /// takes the step away.
    int askedFps = 0;
    /// The stream's own rate — what the cadence is without a step. 0 before
    /// the loop has chosen one.
    int baseFps = 0;
    int displayMilliHz = 0;
    /// The encoder's p95 over its last window of new pictures, µs (EncodeTail);
    /// 0 when not known yet.
    int64_t encodeP95Us = 0;
    /// The encoder takes one picture at a time (the CPU encoder, OpenH264):
    /// no second frame is ever in flight.
    bool encoderOnePicture = false;
    /// A bench cadence is in force (MW_NATIVE_TUNING=cadence=…).
    bool benchCadence = false;
    /// The client's decoder asked for no more than this (`clientfpscap`).
    int clientCapFps = 0;
    /// The client paints on its vsync.
    bool clientVsync = false;
};

inline FpsStep decideStep(const StepInputs& in)
{
    FpsStep out;
    out.askedFps = in.askedFps;
    if (in.askedFps <= 0 || (in.baseFps > 0 && in.askedFps <= in.baseFps)) {
        out.verdict = FpsStep::Verdict::Base;
        return out;
    }
    const auto refuse = [&out](const char* why) {
        out.verdict = FpsStep::Verdict::Refused;
        out.fps = 0;
        out.why = why;
        return out;
    };
    if (in.benchCadence) return refuse("a bench cadence is set");
    if (in.baseFps <= 0) return refuse("the stream has no rate yet");
    if (in.clientCapFps > 0) return refuse("the client's decoder asked for fewer frames");
    if (in.clientVsync) return refuse("the client paints on its vsync");

    const int displayHz = (in.displayMilliHz + 500) / 1000;
    int fps = in.askedFps;
    const bool capped = displayHz > 0 && fps > displayHz;
    if (capped) fps = displayHz;
    if (fps <= in.baseFps) return refuse("the display refreshes no faster than the stream");
    // p95 longer than two frames at that rate: even with two frames in flight
    // the loop could not take one present per interval, and the step would
    // only load the GPU. One frame was the bound until the UA.3 bench
    // (01/10/2026): the Arc's 4.4 to 6.9 ms refused 240, while
    // cadence=host-guarded streamed 238 frames a second through it to the Mac.
    if (in.encodeP95Us > 0 && in.encodeP95Us * fps > 2 * 1000000)
        return refuse("the encoder takes longer than two frames at that rate");
    // The CPU encoder holds nothing in flight: past one frame, the loop drops
    // the presents of the step, and the encode time it adds to each picture
    // costs more than the frames it gains (a VM without a GPU).
    if (in.encoderOnePicture && in.encodeP95Us > 0 && in.encodeP95Us * fps > 1000000)
        return refuse("the CPU encoder takes longer than a frame at that rate");

    out.verdict = capped ? FpsStep::Verdict::Capped : FpsStep::Verdict::Applied;
    out.fps = fps;
    out.why = capped ? "the display refreshes no faster" : "";
    return out;
}

/// The captured display's presents per second, over whole one-second windows:
/// what the host tells the client so that it never tries a step for content no
/// faster than its own screen (a game at 50 frames a second on a 60 Hz client).
///
/// Counted at the capture: the present an acquire returns, plus those Desktop
/// Duplication folded into it while the loop was converting or encoding — the
/// rate the content changes at, whatever the gate let through. A turn of the
/// loop with nothing new (a timeout, the pointer alone) ticks the clock, so a
/// still screen reads 0 a window later. Capture thread only.
class PresentRate
{
public:
    static constexpr int64_t kWindowUs = 1000 * 1000;

    /// @p presents more presents, seen at @p nowUs.
    void note(int64_t presents, int64_t nowUs)
    {
        tick(nowUs);
        if (presents > 0) m_Count += presents;
    }

    /// The loop woke at @p nowUs; closes the window when it is due.
    void tick(int64_t nowUs)
    {
        if (m_StartUs < 0) {
            m_StartUs = nowUs;
            return;
        }
        const int64_t spanUs = nowUs - m_StartUs;
        if (spanUs < kWindowUs) return;
        m_PerSecond = static_cast<int>((m_Count * 1000000 + spanUs / 2) / spanUs);
        m_Count = 0;
        m_StartUs = nowUs;
    }

    /// The last whole window's rate; 0 before the first one closed.
    int perSecond() const { return m_PerSecond; }

private:
    int64_t m_StartUs = -1;
    int64_t m_Count = 0;
    int m_PerSecond = 0;
};

/// The encoder's 95th percentile over its last window of new pictures, µs —
/// what decideStep() weighs against the frame interval of a step. Exact, from
/// the window's own samples (a few hundred, sorted once per window); a window
/// with too few pictures (a still screen) keeps the previous figure. Capture
/// thread only.
class EncodeTail
{
public:
    static constexpr int64_t kWindowUs = 2000 * 1000;
    static constexpr int kMinSamples = 20;
    /// Enough for a 2 s window at 500 frames a second; past it the window
    /// already says what it has to.
    static constexpr int kMaxSamples = 1024;

    /// A new picture took @p encodeUs to encode, finished at @p nowUs. True
    /// when a window just closed with a new p95.
    bool note(int64_t encodeUs, int64_t nowUs)
    {
        if (m_StartUs < 0) m_StartUs = nowUs;
        if (encodeUs >= 0 && m_Count < kMaxSamples) m_Samples[m_Count++] = encodeUs;
        if (nowUs - m_StartUs < kWindowUs) return false;
        bool moved = false;
        if (m_Count >= kMinSamples) {
            // Nearest rank: the ceil(0.95 n)-th smallest.
            const int k = (m_Count * 95 + 99) / 100 - 1;
            std::nth_element(m_Samples.begin(), m_Samples.begin() + k, m_Samples.begin() + m_Count);
            m_P95Us = m_Samples[static_cast<size_t>(k)];
            moved = true;
        }
        m_Count = 0;
        m_StartUs = nowUs;
        return moved;
    }

    /// The last full window's p95; 0 until one closed.
    int64_t p95Us() const { return m_P95Us; }

private:
    std::array<int64_t, kMaxSamples> m_Samples{};
    int m_Count = 0;
    int64_t m_StartUs = -1;
    int64_t m_P95Us = 0;
};

} // namespace mw::native
