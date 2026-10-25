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

#include <d3d11.h>
#include <d3d12.h>
#include <windows.h>

namespace mw::native {

/// What a streaming host asks of Windows so that power management does not
/// sit between the desktop and the viewer. Everything here is best effort,
/// works without elevation, and is logged once whether it took or not — a
/// refusal leaves the session exactly as it was before this existed.
///
/// ── Why each one ─────────────────────────────────────────────────────────────
///
/// EcoQoS. This process has no window. Windows 11 reads that as background
/// work and, on a hybrid CPU or under "Best power efficiency", runs it on the
/// efficiency cores at a lowered clock and ignores its timer requests. The
/// capture thread's MMCSS standing does not lift that: it is a process-wide
/// classification. Opting out is one call. MW_ECOQOS=keep leaves it in place,
/// for a bench that wants the before and after.
///
/// GPU scheduling. The converter's shaders share the GPU's queue with the
/// game being streamed; a game that keeps it full makes every capture wait
/// its turn, and that is a frame late or a frame dropped. The process is put
/// in the REALTIME scheduling class where the token can have it — the SYSTEM
/// or elevated worker, whose SeIncreaseBasePriorityPrivilege is switched on
/// for it — and HIGH otherwise or when refused, which is what Sunshine asks;
/// each of its devices goes to the top thread priority. Under a real game on
/// the encoder's GPU, REALTIME took the encode p99 from 10-16 ms to 3 ms and
/// no desktop stall was seen. The encoder is fixed-function and has its own
/// engine; this is about the shaders in front of it. MW_GPU_PRIORITY=normal
/// skips all of it; MW_GPU_PRIORITY=high (a bench switch) stops at HIGH.
/// Whether the GPU schedules itself (HAGS) is logged per device,
/// since it decides what a class means. MW_CPU_PRIORITY=high (a bench switch
/// too) raises the process's CPU class.
///
/// Staying awake. A viewer watching without touching anything sends no input,
/// and the machine would sleep or blank its screen under the stream — which
/// the viewer sees as the picture going black. Held for the session only.
class StreamPriority
{
public:
    StreamPriority() = default;
    ~StreamPriority() { release(); }
    StreamPriority(const StreamPriority&) = delete;
    StreamPriority& operator=(const StreamPriority&) = delete;

    /// The process-wide part, once per process and harmless when idle: out of
    /// EcoQoS, the GPU scheduling class. Before the session makes any D3D12
    /// queue: a queue asks its priority from the class (queuePriority) when
    /// it is made, and keeps it.
    static void engageProcess();

    /// For the session's life: engageProcess() and the power request.
    void engage();

    /// Drops the power request. Idempotent.
    void release();

    /// Each device the pipeline draws on, as it is (re)built.
    static void raiseDevice(ID3D11Device* device, const char* role);

    /// The GPU scheduling class engage() obtained for the process. Unknown
    /// before the first engage(); LeftAlone under MW_GPU_PRIORITY=normal.
    enum class GpuClass
    {
        Unknown,
        LeftAlone,
        Normal,
        AboveNormal,
        High,
        Realtime,
    };
    static GpuClass grantedClass();
    static const char* toString(GpuClass gpuClass);

    /// What a D3D12 queue of the pipeline asks for under that class:
    /// GLOBAL_REALTIME where the process has REALTIME (the same privilege
    /// grants both), NORMAL where scheduling was left alone on purpose, and
    /// HIGH otherwise — HIGH asks nothing of the token. A D3D11 device has no
    /// queue to give a priority to; SetGPUThreadPriority is its equivalent.
    static D3D12_COMMAND_QUEUE_PRIORITY queuePriority();

private:
    HANDLE m_PowerRequest = nullptr;
};

} // namespace mw::native
