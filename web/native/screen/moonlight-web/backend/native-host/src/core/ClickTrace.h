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

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

// The click's way through the host, for the bench (MW_NATIVE_TUNING
// clicktrace=1, plan "attente" A0).
//
// The click → flag on the client measured 13 to 15 ms between the host
// receiving the click and the present of the picture that shows the flag, at
// 120 Hz, and nothing said where. Two kinds of rows, all on the engine's
// steady clock, which every process of the machine shares, so they line up
// with the relay's stamps and the latency flag's log (QueryPerformanceCounter
// on Windows; on macOS the monotonic clock, which ticks with mach time):
//
//  - press: a mouse button press handed to the OS. `startUs` and `us` frame
//    the call (SendInput, CGEventPost; on Linux the write to the uinput device,
//    or libei's button and frame into gamescope), `queuedUs` is when it was
//    queued for the thread that follows the desktop (a SYSTEM worker), 0 when
//    injected directly.
//  - capture: one wake-up of the capture. `startUs` is when it began to wait,
//    `us` when it returned, `status` what it brought. For a frame: `presentUs`
//    as the session stamps it, `presentRawUs` the OS's own stamp before any
//    clamp (WGC's runs ahead), `mouseUs` the pointer's last update (DDA),
//    `accumulated` the presents folded into it (DDA; on macOS the frames
//    ScreenCaptureKit handed over since the last one taken, this one
//    included), `deliveredUs` when the OS handed it to the engine, ahead of
//    the capture's thread taking it (ScreenCaptureKit's callback). Then the
//    compositor's timing read right after: its last vblank, its refresh
//    period, its last composition and its frame count (DWM; on macOS the
//    captured display's CVDisplayLink, which knows no composition).
//    On Linux: the PipeWire buffer header's pts for the present, its seq in
//    `composedFrames` (Mutter leaves it 0), the buffers folded into the one
//    taken in `accumulated`, the process callback that handed it over in
//    `deliveredUs`; with KMS, the vblank the scanout was read after and its
//    sequence. No compositor timing beside them.
//  - admit (Windows host): the admission window after a press
//    (core/InputAdmit.h). `status` "press" for each press it was told of, at
//    `us`; "grid" or "window" for each present encoded, the gate's or the
//    window's, at the moment the loop decided, with its `presentUs`. The
//    gate's own on every pass, the window's with inputadmit=1: the bench
//    tells the pictures the window added from the stream's. For a present,
//    `locked` 1 when the gate decided on it locked on the display's presents
//    (plan « glissade », FrameCadence.h), 0 when not, and `latticeUs` the
//    point of the presents' lattice nearest it (core/PresentLattice.h),
//    empty before the lattice has a present.
//  - frame (Windows host, the chain that encodes one picture at a time): a
//    picture's way from the converter to the bitstream, for the steps of the
//    D3D12 chain's conversion that a busy GPU stretches (plan « Gels du
//    lien », the N95's lags of 21/10). `startUs` is when the picture was
//    handed to the converter, `us` when its bitstream was ready, `presentUs`
//    its present, `frame` its number on the wire. Then, in order, when the
//    capture context had signalled fence A and flushed (`signalledUs`; empty
//    for a held picture converted again, which signals nothing), the list
//    was ready to record (`listUs`: after the wait for a conversion the
//    cadence skipped), recorded (`recordedUs`), executed and the fences
//    signalled (`executedUs`), the capture context had queued its wait for
//    the read (`heldUs`) and the frame was given back (`releasedUs`);
//    `encodeUs` when the encoder was asked. With gputiming=1, when the GPU
//    started and finished the conversion (`gpuStartUs`, `gpuEndUs`, on the
//    engine's clock) and the encode's GPU time (`gpuEncodeUs`). The D3D11
//    chain fills only the session's own stamps.
//
// A field the platform cannot tell is left empty. Only the first kMaxRows rows
// are kept: minutes of a bench pass, not a session left running.
namespace mw::native {

class ClickTrace
{
public:
    enum class Kind : uint8_t
    {
        Press,
        Capture,
        Admit,
        Frame,
    };

    struct Row
    {
        Kind kind = Kind::Capture;
        int64_t us = 0;
        int64_t startUs = 0;
        int64_t queuedUs = 0;
        /// Capture: "ok", "pointer", "timeout", "lost" or "failed". Admit:
        /// "press", "grid" or "window".
        const char* status = "";
        int64_t presentUs = 0;
        int64_t presentRawUs = 0;
        int64_t mouseUs = 0;
        int accumulated = -1;
        int64_t vblankUs = 0;
        int64_t periodUs = 0;
        int64_t composeUs = 0;
        int64_t composedFrames = -1;
        int64_t deliveredUs = 0;
        /// Admit: whether the gate decided locked (1) or not (0); -1 empty.
        int locked = -1;
        int64_t latticeUs = 0;
        /// Frame: the picture's number on the wire (-1 empty), the steps of
        /// its conversion and encode (0 empty), the GPU's own times (0 and
        /// -1 empty) — see the frame row above.
        int64_t frame = -1;
        int64_t signalledUs = 0;
        int64_t listUs = 0;
        int64_t recordedUs = 0;
        int64_t executedUs = 0;
        int64_t heldUs = 0;
        int64_t releasedUs = 0;
        int64_t encodeUs = 0;
        int64_t gpuStartUs = 0;
        int64_t gpuEndUs = 0;
        int64_t gpuEncodeUs = -1;
    };

    static constexpr size_t kMaxRows = size_t(1) << 18;

    void add(const Row& row)
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        if (m_Rows.size() >= kMaxRows) {
            ++m_Dropped;
            return;
        }
        if (m_Rows.empty()) m_Rows.reserve(8192);
        m_Rows.push_back(row);
    }

    void press(int64_t queuedUs, int64_t startUs, int64_t doneUs)
    {
        Row row;
        row.kind = Kind::Press;
        row.us = doneUs;
        row.startUs = startUs;
        row.queuedUs = queuedUs;
        add(row);
    }

    /// @p status "press", "grid" or "window", at @p us; @p presentUs the
    /// picture's present, 0 for a press; @p locked and @p latticeUs as the
    /// columns say (-1 and 0: empty). @p status must outlive the trace.
    void admit(const char* status, int64_t us, int64_t presentUs, int locked = -1,
               int64_t latticeUs = 0)
    {
        Row row;
        row.kind = Kind::Admit;
        row.us = us;
        row.status = status;
        row.presentUs = presentUs;
        row.locked = locked;
        row.latticeUs = latticeUs;
        add(row);
    }

    size_t rows() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return m_Rows.size();
    }

    size_t dropped() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        return m_Dropped;
    }

    std::string csv() const
    {
        std::lock_guard<std::mutex> lock(m_Mutex);
        std::string out = "kind,us,startUs,queuedUs,status,presentUs,presentRawUs,mouseUs,"
                          "accumulated,vblankUs,periodUs,composeUs,composedFrames,deliveredUs,"
                          "locked,latticeUs,frame,signalledUs,listUs,recordedUs,executedUs,"
                          "heldUs,releasedUs,encodeUs,gpuStartUs,gpuEndUs,gpuEncodeUs\n";
        out.reserve(out.size() + m_Rows.size() * 128);
        const auto num = [&out](int64_t v, bool known) {
            if (known) out += std::to_string(v);
            out += ',';
        };
        for (const Row& r : m_Rows) {
            out += r.kind == Kind::Press   ? "press,"
                   : r.kind == Kind::Admit ? "admit,"
                   : r.kind == Kind::Frame ? "frame,"
                                           : "capture,";
            num(r.us, true);
            num(r.startUs, r.startUs != 0);
            num(r.queuedUs, r.queuedUs != 0);
            out += r.status;
            out += ',';
            num(r.presentUs, r.presentUs != 0);
            num(r.presentRawUs, r.presentRawUs != 0);
            num(r.mouseUs, r.mouseUs != 0);
            num(r.accumulated, r.accumulated >= 0);
            num(r.vblankUs, r.vblankUs != 0);
            num(r.periodUs, r.periodUs != 0);
            num(r.composeUs, r.composeUs != 0);
            num(r.composedFrames, r.composedFrames >= 0);
            num(r.deliveredUs, r.deliveredUs != 0);
            num(r.locked, r.locked >= 0);
            num(r.latticeUs, r.latticeUs != 0);
            num(r.frame, r.frame >= 0);
            num(r.signalledUs, r.signalledUs != 0);
            num(r.listUs, r.listUs != 0);
            num(r.recordedUs, r.recordedUs != 0);
            num(r.executedUs, r.executedUs != 0);
            num(r.heldUs, r.heldUs != 0);
            num(r.releasedUs, r.releasedUs != 0);
            num(r.encodeUs, r.encodeUs != 0);
            num(r.gpuStartUs, r.gpuStartUs != 0);
            num(r.gpuEndUs, r.gpuEndUs != 0);
            if (r.gpuEncodeUs >= 0) out += std::to_string(r.gpuEncodeUs);
            out += '\n';
        }
        return out;
    }

private:
    mutable std::mutex m_Mutex;
    std::vector<Row> m_Rows;
    size_t m_Dropped = 0;
};

} // namespace mw::native
