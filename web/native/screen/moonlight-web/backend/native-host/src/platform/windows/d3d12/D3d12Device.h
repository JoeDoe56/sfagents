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

#ifndef NOMINMAX
#define NOMINMAX // <windows.h>'s min/max macros break std::min/std::max
#endif

#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#include <array>
#include <cstdint>
#include <memory>
#include <string>

namespace mw::native {
struct EncoderTuning;
}

namespace mw::native::d3d12 {

/// "0x887A0005", the way every D3D12 failure of this directory is logged.
std::string hresultText(HRESULT hr);

/// The adapter LUID as the rest of the engine carries it (SessionConfig,
/// CrossGpuBridge): one 64-bit number.
uint64_t luidValue(const LUID& luid);

/// What a queue asks for. Auto follows the GPU scheduling class the process
/// was granted (StreamPriority::queuePriority); the others are bench keys.
enum class QueuePriority
{
    Auto,
    Normal,
    High,
    GlobalRealtime,
};

const char* toString(D3D12_COMMAND_LIST_TYPE type);
const char* toString(D3D12_COMMAND_QUEUE_PRIORITY priority);

struct QueueRequest
{
    D3D12_COMMAND_LIST_TYPE type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    QueuePriority priority = QueuePriority::Auto;
    /// A CreatorID of its own (ID3D12Device9::CreateCommandQueue1). Under
    /// hardware scheduling the queues created without one share the runtime's
    /// default group, whose priority the scheduler does not honour per queue.
    bool ownCreator = true;
    /// For PIX and the debug layer's messages.
    const wchar_t* name = nullptr;
};

/// What a queue of the D3D12 chain asks for under the bench's knobs
/// (EncoderTuning::prio12, ownCreator12), whose defaults are the engine's
/// own: the priority the GPU class gives (Auto) and a CreatorID of its own.
QueueRequest queueRequestFor(D3D12_COMMAND_LIST_TYPE type, const EncoderTuning& tuning,
                             const wchar_t* name);

/// A queue as it was obtained, which is not always as it was asked for: a
/// priority the token cannot have is stepped down, never fatal.
struct Queue
{
    Microsoft::WRL::ComPtr<ID3D12CommandQueue> queue;
    D3D12_COMMAND_LIST_TYPE type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    D3D12_COMMAND_QUEUE_PRIORITY priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
    bool ownCreator = false;
    /// "DIRECT queue HIGH (GLOBAL_REALTIME refused 0x887A002B), own CreatorID":
    /// what the session log says, and what a bench row is read against.
    std::string description;
};

/// The D3D12 device of one adapter, shared by everything of the process that
/// runs on that adapter, and the one place its queues are made.
///
/// ── Why a device of its own, and why shared ─────────────────────────────────
///
/// D3D12 already hands back the same device for the same adapter; what is kept
/// here is what goes with it: the debug layer's relay, the name for the log,
/// and the rule by which queues are asked for. A capture restart rebuilds the
/// D3D11 side from nothing (a new duplication, a new device); this one stays,
/// and so do the queues the pipeline made on it.
///
/// ── MW_D3D12_DEBUG=1 ────────────────────────────────────────────────────────
///
/// The validation layer (it ships with Windows' "Graphics Tools" optional
/// feature), its messages relayed to the log by relayMessages(). Switched on
/// before the process's first D3D12 device and never off again — enabling it
/// under a live device removes that device — so it takes effect only when it
/// is in the environment from the start. A driver that dislikes a barrier says
/// nothing otherwise: it returns E_INVALIDARG from Close(), or crashes.
class D3d12Device
{
public:
    ~D3d12Device();

    D3d12Device(const D3d12Device&) = delete;
    D3d12Device& operator=(const D3d12Device&) = delete;

    /// The device on the adapter with LUID @p luid, created on first use and
    /// shared while anyone holds it. Null, with the reason, on an adapter with
    /// no D3D12 (feature level 11_0) or a LUID no adapter answers to.
    static std::shared_ptr<D3d12Device> forAdapter(uint64_t luid, std::string& error);

    /// The same on an adapter already in hand: WARP, in the tests.
    static std::shared_ptr<D3d12Device> forAdapter(IDXGIAdapter1* adapter, std::string& error);

    ID3D12Device* device() const { return m_Device.Get(); }
    uint64_t luid() const { return m_Luid; }
    const std::string& name() const { return m_Name; }
    bool debugLayer() const { return m_Debug; }
    /// The adapter's PCI vendor id.
    uint32_t vendorId() const { return m_VendorId; }
    /// Whether the GPU works in the CPU's memory (an iGPU; WARP), as D3D12
    /// says it (D3D12_FEATURE_ARCHITECTURE, UMA).
    bool unifiedMemory() const { return m_UnifiedMemory; }

    /// A queue by @p request; see QueueRequest and Queue. The priority steps
    /// down GLOBAL_REALTIME → HIGH → NORMAL until one is accepted, and the
    /// CreatorID falls back to the default group where CreateCommandQueue1 is
    /// missing (before Windows 10 20H1) — both said in Queue::description.
    bool createQueue(const QueueRequest& request, Queue& out, std::string& error);

    /// Whether the device is gone (reset, driver update, TDR), and why.
    bool removed(std::string& reason) const;

    /// MW_D3D12_DEBUG=1: the validation layer's stored messages, to the log,
    /// then cleared. Free without the layer.
    void relayMessages();

private:
    D3d12Device() = default;
    bool open(IDXGIAdapter1* adapter, std::string& error);

    Microsoft::WRL::ComPtr<ID3D12Device> m_Device;
    Microsoft::WRL::ComPtr<ID3D12InfoQueue> m_InfoQueue;
    uint64_t m_Luid = 0;
    std::string m_Name;
    bool m_Debug = false;
    uint32_t m_VendorId = 0;
    bool m_UnifiedMemory = false;
};

/// How long the chain's CPU waits on its own GPU work before it calls the GPU
/// gone. A session waiting for ever on it is a stream that freezes with no
/// line in the log; one that gives up on a GPU that is merely busy leaves
/// D3D12 for nothing. Under a game that fills the Arc, the D3D11 chain waits
/// up to 1.5 s on a picture, 47 times in 30 min, and goes on (G2 soak,
/// 27/09/2026): half a second, the first limit, took one such wait for a
/// dead GPU. Windows resets a GPU whose work runs 2 s (TDR, TdrDelay's
/// default) and the device is then removed, which the wait reports as such;
/// past that, a fence that has not moved will not.
constexpr uint32_t kGpuGoneMs = 3000;

/// A D3D12 fence and the value this side last asked of it, with a CPU wait
/// that gives up (kGpuGoneMs, for the chain's own waits).
class GpuFence
{
public:
    enum class Wait
    {
        Done,
        TimedOut,
        DeviceRemoved,
        Failed,
    };

    GpuFence() = default;
    ~GpuFence();

    GpuFence(const GpuFence&) = delete;
    GpuFence& operator=(const GpuFence&) = delete;

    /// A new fence at 0. @p shared makes it openable by another device or API
    /// (D3D11's OpenSharedFence) through sharedHandle().
    bool create(ID3D12Device* device, bool shared, std::string& error);

    /// A fence made elsewhere and opened here (DdaInterop's fence A, signalled
    /// by the D3D11 capture context). @p value is where its counter stands.
    bool adopt(ID3D12Device* device, Microsoft::WRL::ComPtr<ID3D12Fence> fence, uint64_t value,
               std::string& error);

    void reset();

    ID3D12Fence* fence() const { return m_Fence.Get(); }
    explicit operator bool() const { return m_Fence != nullptr; }

    /// An NT handle to the fence, for the other side to open; the caller
    /// closes it. Null, with the reason, for a fence not created shared.
    HANDLE sharedHandle(std::string& error) const;

    /// The last value signalled or announced from this side.
    uint64_t value() const { return m_Value; }

    /// What the GPU has reached. UINT64_MAX on a removed device.
    uint64_t completed() const;

    /// The next value, signalled from @p queue once the work before it is
    /// done. 0 on failure, with the reason.
    uint64_t signal(ID3D12CommandQueue* queue, std::string& error);

    /// The next value, for the other side to signal (a shared fence written by
    /// D3D11): only the counter moves here.
    uint64_t announce() { return ++m_Value; }

    /// @p queue waits, on the GPU, until the fence reaches @p value. The CPU
    /// does not.
    bool gpuWait(ID3D12CommandQueue* queue, uint64_t value, std::string& error);

    /// The CPU waits until the fence reaches @p value, @p timeoutMs at most.
    /// TimedOut and DeviceRemoved come with the device's removal reason.
    Wait wait(uint64_t value, uint32_t timeoutMs, std::string& error);

private:
    Microsoft::WRL::ComPtr<ID3D12Device> m_Device;
    Microsoft::WRL::ComPtr<ID3D12Fence> m_Fence;
    HANDLE m_Event = nullptr;
    uint64_t m_Value = 0;
    bool m_Shared = false;
};

/// The GPU time of stretches of command lists on one queue, read back after
/// the work is known to be done — never waited for on its own account.
///
/// Timestamps are what separate the two halves of a slow frame: the work
/// itself, and the queue it waited in behind a game. The first is what a
/// stretch of timestamps measures; the second is the difference with the wall
/// time. GetClockCalibration puts the GPU's ticks on the CPU's QPC clock, so a
/// stretch can also be placed against FrameStamps (when did the GPU start on
/// the conversion the CPU submitted?).
///
/// DIRECT and COMPUTE queues; COPY where the device says its copy queues can
/// be timed. A video-encode list cannot resolve into a readback buffer; its
/// timing comes with the encoder (Phase 4).
class QueueTimer
{
public:
    static constexpr int kSlots = 8;

    struct Sample
    {
        int64_t gpuUs = 0;
        /// On the QPC clock, in QPC ticks; 0 when the queue gave no
        /// calibration.
        int64_t startQpc = 0;
        int64_t endQpc = 0;
    };

    bool init(ID3D12Device* device, ID3D12CommandQueue* queue, D3D12_COMMAND_LIST_TYPE type,
              std::string& error);
    void reset();
    bool ready() const { return m_Readback != nullptr; }

    /// Stamps the start of a stretch into @p list. The slot to end it with, or
    /// -1 when every slot is still waiting to be read (this one goes untimed).
    int begin(ID3D12GraphicsCommandList* list);

    /// Stamps the end of the stretch and resolves both stamps for reading.
    void end(ID3D12GraphicsCommandList* list, int slot);

    /// The stretch in @p slot, once the caller knows the list that timed it
    /// has completed (its fence passed). False for a slot not pending, or
    /// stamps the GPU did not write in order (a disjoint clock).
    bool read(int slot, Sample& out);

    /// Frees @p slot unread: the list that held it was never submitted.
    void cancel(int slot);

private:
    void calibrate();

    Microsoft::WRL::ComPtr<ID3D12QueryHeap> m_Heap;
    Microsoft::WRL::ComPtr<ID3D12Resource> m_Readback;
    Microsoft::WRL::ComPtr<ID3D12CommandQueue> m_Queue;
    uint64_t m_Frequency = 0;
    std::array<bool, kSlots> m_Pending = {};
    int m_Next = 0;
    // The calibration pair and when it was taken; refreshed every few seconds
    // since the two clocks drift apart by a few parts per million.
    uint64_t m_CalibrationGpu = 0;
    uint64_t m_CalibrationQpc = 0;
    int64_t m_QpcFrequency = 0;
    bool m_Calibrated = false;
};

} // namespace mw::native::d3d12
