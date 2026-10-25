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

#include "D3d12Device.h"

#include "mw/native/EncoderTuning.h"
#include "../../../core/Log.h"
#include "../StreamPriority.h"

#include <d3d12sdklayers.h>
#include <objbase.h>

#include <cstdio>
#include <map>
#include <mutex>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace mw::native::d3d12 {

namespace {

bool envIs(const char* name, const char* value)
{
    char buf[16] = {};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return n > 0 && n < sizeof(buf) && _stricmp(buf, value) == 0;
}

std::string narrow(const wchar_t* text)
{
    const int n = ::WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string out(static_cast<size_t>(n - 1), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), n, nullptr, nullptr);
    return out;
}

/// Once per process, before the first device: see D3d12Device.h.
bool debugLayerOnce()
{
    static std::once_flag once;
    static bool enabled = false;
    std::call_once(once, [] {
        if (!envIs("MW_D3D12_DEBUG", "1")) return;
        ComPtr<ID3D12Debug> debug;
        if (SUCCEEDED(::D3D12GetDebugInterface(IID_PPV_ARGS(&debug)))) {
            debug->EnableDebugLayer();
            enabled = true;
            log::info("[native] D3D12: MW_D3D12_DEBUG=1 — validation layer on");
        } else {
            log::warning("[native] D3D12: MW_D3D12_DEBUG=1 but no validation layer (Windows' "
                         "\"Graphics Tools\" optional feature is not installed)");
        }
    });
    return enabled;
}

D3D12_COMMAND_QUEUE_PRIORITY wanted(QueuePriority priority)
{
    switch (priority) {
    case QueuePriority::Normal: return D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
    case QueuePriority::High: return D3D12_COMMAND_QUEUE_PRIORITY_HIGH;
    case QueuePriority::GlobalRealtime: return D3D12_COMMAND_QUEUE_PRIORITY_GLOBAL_REALTIME;
    case QueuePriority::Auto: break;
    }
    return StreamPriority::queuePriority();
}

D3D12_COMMAND_QUEUE_PRIORITY stepDown(D3D12_COMMAND_QUEUE_PRIORITY priority)
{
    return priority == D3D12_COMMAND_QUEUE_PRIORITY_GLOBAL_REALTIME
               ? D3D12_COMMAND_QUEUE_PRIORITY_HIGH
               : D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
}

// The devices of the process, by adapter. Weak: the last session to let go of
// an adapter's device releases it, as it did before this directory existed.
std::mutex g_DevicesLock;
std::map<uint64_t, std::weak_ptr<D3d12Device>>& devices()
{
    static std::map<uint64_t, std::weak_ptr<D3d12Device>> map;
    return map;
}

std::shared_ptr<D3d12Device> cached(uint64_t luid)
{
    auto& map = devices();
    const auto found = map.find(luid);
    if (found == map.end()) return nullptr;
    std::shared_ptr<D3d12Device> alive = found->second.lock();
    if (!alive) map.erase(found);
    return alive;
}

} // namespace

std::string hresultText(HRESULT hr)
{
    char text[16];
    std::snprintf(text, sizeof(text), "0x%08lX", static_cast<unsigned long>(hr));
    return text;
}

uint64_t luidValue(const LUID& luid)
{
    return (static_cast<uint64_t>(static_cast<uint32_t>(luid.HighPart)) << 32) |
           static_cast<uint64_t>(luid.LowPart);
}

const char* toString(D3D12_COMMAND_LIST_TYPE type)
{
    switch (type) {
    case D3D12_COMMAND_LIST_TYPE_DIRECT: return "DIRECT";
    case D3D12_COMMAND_LIST_TYPE_BUNDLE: return "BUNDLE";
    case D3D12_COMMAND_LIST_TYPE_COMPUTE: return "COMPUTE";
    case D3D12_COMMAND_LIST_TYPE_COPY: return "COPY";
    case D3D12_COMMAND_LIST_TYPE_VIDEO_DECODE: return "VIDEO_DECODE";
    case D3D12_COMMAND_LIST_TYPE_VIDEO_PROCESS: return "VIDEO_PROCESS";
    case D3D12_COMMAND_LIST_TYPE_VIDEO_ENCODE: return "VIDEO_ENCODE";
    default: break;
    }
    return "unknown";
}

const char* toString(D3D12_COMMAND_QUEUE_PRIORITY priority)
{
    switch (priority) {
    case D3D12_COMMAND_QUEUE_PRIORITY_NORMAL: return "NORMAL";
    case D3D12_COMMAND_QUEUE_PRIORITY_HIGH: return "HIGH";
    case D3D12_COMMAND_QUEUE_PRIORITY_GLOBAL_REALTIME: return "GLOBAL_REALTIME";
    default: break;
    }
    return "unknown";
}

// ── D3d12Device ─────────────────────────────────────────────────────────────

D3d12Device::~D3d12Device() = default;

std::shared_ptr<D3d12Device> D3d12Device::forAdapter(uint64_t luid, std::string& error)
{
    std::lock_guard<std::mutex> lock(g_DevicesLock);
    if (std::shared_ptr<D3d12Device> alive = cached(luid)) return alive;

    ComPtr<IDXGIFactory4> factory;
    HRESULT hr = ::CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) {
        error = "no DXGI factory (" + hresultText(hr) + ")";
        return nullptr;
    }
    LUID target = {};
    target.LowPart = static_cast<DWORD>(luid & 0xffffffffu);
    target.HighPart = static_cast<LONG>(luid >> 32);
    ComPtr<IDXGIAdapter1> adapter;
    hr = factory->EnumAdapterByLuid(target, IID_PPV_ARGS(&adapter));
    if (FAILED(hr)) {
        error = "no adapter answers to this LUID (" + hresultText(hr) + ")";
        return nullptr;
    }

    std::shared_ptr<D3d12Device> device(new D3d12Device());
    if (!device->open(adapter.Get(), error)) return nullptr;
    devices()[luid] = device;
    return device;
}

std::shared_ptr<D3d12Device> D3d12Device::forAdapter(IDXGIAdapter1* adapter, std::string& error)
{
    DXGI_ADAPTER_DESC1 desc = {};
    const HRESULT hr = adapter ? adapter->GetDesc1(&desc) : E_POINTER;
    if (FAILED(hr)) {
        error = "the adapter does not describe itself (" + hresultText(hr) + ")";
        return nullptr;
    }
    const uint64_t luid = luidValue(desc.AdapterLuid);
    std::lock_guard<std::mutex> lock(g_DevicesLock);
    if (std::shared_ptr<D3d12Device> alive = cached(luid)) return alive;
    std::shared_ptr<D3d12Device> device(new D3d12Device());
    if (!device->open(adapter, error)) return nullptr;
    devices()[luid] = device;
    return device;
}

bool D3d12Device::open(IDXGIAdapter1* adapter, std::string& error)
{
    DXGI_ADAPTER_DESC1 desc = {};
    if (SUCCEEDED(adapter->GetDesc1(&desc))) {
        m_Luid = luidValue(desc.AdapterLuid);
        m_Name = narrow(desc.Description);
        m_VendorId = desc.VendorId;
    }

    m_Debug = debugLayerOnce();
    const HRESULT hr =
        ::D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&m_Device));
    if (FAILED(hr)) {
        error = "no D3D12 on " + (m_Name.empty() ? std::string("this GPU") : m_Name) + " (" +
                hresultText(hr) + ")";
        return false;
    }
    D3D12_FEATURE_DATA_ARCHITECTURE architecture = {};
    if (SUCCEEDED(m_Device->CheckFeatureSupport(D3D12_FEATURE_ARCHITECTURE, &architecture,
                                                sizeof(architecture))))
        m_UnifiedMemory = architecture.UMA != FALSE;
    if (m_Debug && SUCCEEDED(m_Device.As(&m_InfoQueue))) {
        // Stored, not broken on: the layer reports, the log carries it, and a
        // stream keeps going — a debugger break would freeze a worker nobody
        // is attached to.
        m_InfoQueue->SetBreakOnSeverity(D3D12_MESSAGE_SEVERITY_CORRUPTION, FALSE);
        m_InfoQueue->SetBreakOnSeverity(D3D12_MESSAGE_SEVERITY_ERROR, FALSE);
    }
    return true;
}

QueueRequest queueRequestFor(D3D12_COMMAND_LIST_TYPE type, const EncoderTuning& tuning,
                             const wchar_t* name)
{
    QueueRequest request;
    request.type = type;
    request.name = name;
    switch (tuning.prio12) {
    case EncoderTuning::Priority12::Normal: request.priority = QueuePriority::Normal; break;
    case EncoderTuning::Priority12::High: request.priority = QueuePriority::High; break;
    case EncoderTuning::Priority12::GlobalRealtime:
        request.priority = QueuePriority::GlobalRealtime;
        break;
    default: request.priority = QueuePriority::Auto; break;
    }
    request.ownCreator = tuning.ownCreator12 != EncoderTuning::Choice::Off;
    return request;
}

bool D3d12Device::createQueue(const QueueRequest& request, Queue& out, std::string& error)
{
    out = Queue{};
    out.type = request.type;

    ComPtr<ID3D12Device9> device9;
    if (request.ownCreator) m_Device.As(&device9);
    GUID creator = {};
    if (device9 && FAILED(::CoCreateGuid(&creator))) device9.Reset();

    D3D12_COMMAND_QUEUE_DESC desc = {};
    desc.Type = request.type;
    // Never DISABLE_GPU_TIMEOUT: a hung conversion must end in a TDR the
    // session survives (device removed, rebuilt on D3D11), not a frozen GPU.
    desc.Flags = D3D12_COMMAND_QUEUE_FLAG_NONE;

    const D3D12_COMMAND_QUEUE_PRIORITY asked = wanted(request.priority);
    std::string refusals;
    HRESULT hr = E_FAIL;
    for (D3D12_COMMAND_QUEUE_PRIORITY priority = asked;;) {
        desc.Priority = priority;
        hr = device9 ? device9->CreateCommandQueue1(&desc, creator, IID_PPV_ARGS(&out.queue))
                     : m_Device->CreateCommandQueue(&desc, IID_PPV_ARGS(&out.queue));
        if (SUCCEEDED(hr)) {
            out.priority = priority;
            break;
        }
        refusals += std::string(refusals.empty() ? "" : ", ") + toString(priority) + " refused " +
                    hresultText(hr);
        if (priority == D3D12_COMMAND_QUEUE_PRIORITY_NORMAL) break;
        priority = stepDown(priority);
    }
    if (FAILED(hr)) {
        error = std::string("no ") + toString(request.type) + " queue on " + m_Name + " (" +
                refusals + ")";
        return false;
    }

    out.ownCreator = device9 != nullptr;
    if (request.name) out.queue->SetName(request.name);
    out.description = std::string(toString(request.type)) + " queue " + toString(out.priority) +
                      (refusals.empty() ? "" : " (" + refusals + ")") +
                      (out.ownCreator       ? ", own CreatorID"
                       : request.ownCreator ? ", default CreatorID (no CreateCommandQueue1)"
                                            : ", default CreatorID");
    return true;
}

bool D3d12Device::removed(std::string& reason) const
{
    if (!m_Device) return false;
    const HRESULT hr = m_Device->GetDeviceRemovedReason();
    if (SUCCEEDED(hr)) return false;
    reason = "the D3D12 device was removed (" + hresultText(hr) + ")";
    return true;
}

void D3d12Device::relayMessages()
{
    if (!m_InfoQueue) return;
    const UINT64 count = m_InfoQueue->GetNumStoredMessages();
    for (UINT64 i = 0; i < count; ++i) {
        SIZE_T length = 0;
        if (FAILED(m_InfoQueue->GetMessage(i, nullptr, &length)) || length == 0) continue;
        std::vector<char> bytes(length);
        auto* message = reinterpret_cast<D3D12_MESSAGE*>(bytes.data());
        if (FAILED(m_InfoQueue->GetMessage(i, message, &length))) continue;
        const std::string text = std::string("[native] D3D12 layer: ") + message->pDescription;
        if (message->Severity <= D3D12_MESSAGE_SEVERITY_ERROR)
            log::warning(text);
        else
            log::info(text);
    }
    m_InfoQueue->ClearStoredMessages();
}

// ── GpuFence ────────────────────────────────────────────────────────────────

GpuFence::~GpuFence()
{
    reset();
}

void GpuFence::reset()
{
    m_Fence.Reset();
    m_Device.Reset();
    if (m_Event) {
        ::CloseHandle(m_Event);
        m_Event = nullptr;
    }
    m_Value = 0;
    m_Shared = false;
}

bool GpuFence::create(ID3D12Device* device, bool shared, std::string& error)
{
    reset();
    if (!device) {
        error = "no D3D12 device";
        return false;
    }
    HRESULT hr = device->CreateFence(0, shared ? D3D12_FENCE_FLAG_SHARED : D3D12_FENCE_FLAG_NONE,
                                     IID_PPV_ARGS(&m_Fence));
    if (FAILED(hr)) {
        error = std::string("could not create a ") + (shared ? "shared " : "") + "D3D12 fence (" +
                hresultText(hr) + ")";
        return false;
    }
    m_Device = device;
    m_Shared = shared;
    return true;
}

bool GpuFence::adopt(ID3D12Device* device, ComPtr<ID3D12Fence> fence, uint64_t value,
                     std::string& error)
{
    reset();
    if (!device || !fence) {
        error = "no fence to adopt";
        return false;
    }
    m_Device = device;
    m_Fence = std::move(fence);
    m_Value = value;
    m_Shared = true;
    return true;
}

HANDLE GpuFence::sharedHandle(std::string& error) const
{
    if (!m_Fence || !m_Shared) {
        error = "the fence was not created shared";
        return nullptr;
    }
    HANDLE handle = nullptr;
    const HRESULT hr =
        m_Device->CreateSharedHandle(m_Fence.Get(), nullptr, GENERIC_ALL, nullptr, &handle);
    if (FAILED(hr)) {
        error = "could not share the D3D12 fence (" + hresultText(hr) + ")";
        return nullptr;
    }
    return handle;
}

uint64_t GpuFence::completed() const
{
    return m_Fence ? m_Fence->GetCompletedValue() : 0;
}

uint64_t GpuFence::signal(ID3D12CommandQueue* queue, std::string& error)
{
    if (!m_Fence || !queue) {
        error = "the fence is not ready";
        return 0;
    }
    const HRESULT hr = queue->Signal(m_Fence.Get(), m_Value + 1);
    if (FAILED(hr)) {
        error = "could not signal the fence (" + hresultText(hr) + ")";
        return 0;
    }
    return ++m_Value;
}

bool GpuFence::gpuWait(ID3D12CommandQueue* queue, uint64_t value, std::string& error)
{
    if (!m_Fence || !queue) {
        error = "the fence is not ready";
        return false;
    }
    const HRESULT hr = queue->Wait(m_Fence.Get(), value);
    if (FAILED(hr)) {
        error = "could not queue a wait on the fence (" + hresultText(hr) + ")";
        return false;
    }
    return true;
}

GpuFence::Wait GpuFence::wait(uint64_t value, uint32_t timeoutMs, std::string& error)
{
    if (!m_Fence) {
        error = "the fence is not ready";
        return Wait::Failed;
    }
    uint64_t reached = m_Fence->GetCompletedValue();
    // A removed device's fences read all ones: nothing more will ever come.
    if (reached == UINT64_MAX) {
        error = "the D3D12 device was removed (" + hresultText(m_Device->GetDeviceRemovedReason()) +
                ")";
        return Wait::DeviceRemoved;
    }
    if (reached >= value) return Wait::Done;

    if (!m_Event) {
        m_Event = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!m_Event) {
            error =
                "could not create a fence event (error " + std::to_string(::GetLastError()) + ")";
            return Wait::Failed;
        }
    }
    const HRESULT hr = m_Fence->SetEventOnCompletion(value, m_Event);
    if (FAILED(hr)) {
        error = "could not wait for the fence (" + hresultText(hr) + ")";
        return Wait::Failed;
    }
    const DWORD waited = ::WaitForSingleObject(m_Event, timeoutMs);
    reached = m_Fence->GetCompletedValue();
    if (reached == UINT64_MAX) {
        error = "the D3D12 device was removed (" + hresultText(m_Device->GetDeviceRemovedReason()) +
                ")";
        return Wait::DeviceRemoved;
    }
    if (waited == WAIT_OBJECT_0 || reached >= value) return Wait::Done;
    const HRESULT removed = m_Device->GetDeviceRemovedReason();
    error = "the GPU did not reach fence value " + std::to_string(value) + " in " +
            std::to_string(timeoutMs) + " ms (at " + std::to_string(reached) + ", device " +
            (FAILED(removed) ? "removed " + hresultText(removed) : std::string("alive")) + ")";
    return FAILED(removed) ? Wait::DeviceRemoved : Wait::TimedOut;
}

// ── QueueTimer ──────────────────────────────────────────────────────────────

bool QueueTimer::init(ID3D12Device* device, ID3D12CommandQueue* queue, D3D12_COMMAND_LIST_TYPE type,
                      std::string& error)
{
    reset();
    if (!device || !queue) {
        error = "no queue to time";
        return false;
    }
    D3D12_QUERY_HEAP_DESC heap = {};
    heap.Count = 2 * kSlots;
    if (type == D3D12_COMMAND_LIST_TYPE_DIRECT || type == D3D12_COMMAND_LIST_TYPE_COMPUTE) {
        heap.Type = D3D12_QUERY_HEAP_TYPE_TIMESTAMP;
    } else if (type == D3D12_COMMAND_LIST_TYPE_COPY) {
        D3D12_FEATURE_DATA_D3D12_OPTIONS3 options = {};
        if (FAILED(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS3, &options,
                                               sizeof(options))) ||
            !options.CopyQueueTimestampQueriesSupported) {
            error = "this GPU's copy queues cannot be timed";
            return false;
        }
        heap.Type = D3D12_QUERY_HEAP_TYPE_COPY_QUEUE_TIMESTAMP;
    } else {
        error = std::string("a ") + toString(type) + " queue is not timed here";
        return false;
    }

    HRESULT hr = queue->GetTimestampFrequency(&m_Frequency);
    if (FAILED(hr) || m_Frequency == 0) {
        error = "the queue gives no timestamp frequency (" + hresultText(hr) + ")";
        return false;
    }
    hr = device->CreateQueryHeap(&heap, IID_PPV_ARGS(&m_Heap));
    if (FAILED(hr)) {
        error = "could not create a timestamp heap (" + hresultText(hr) + ")";
        reset();
        return false;
    }

    D3D12_HEAP_PROPERTIES readback = {};
    readback.Type = D3D12_HEAP_TYPE_READBACK;
    D3D12_RESOURCE_DESC buffer = {};
    buffer.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    buffer.Width = 2 * kSlots * sizeof(uint64_t);
    buffer.Height = 1;
    buffer.DepthOrArraySize = 1;
    buffer.MipLevels = 1;
    buffer.SampleDesc.Count = 1;
    buffer.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    hr = device->CreateCommittedResource(&readback, D3D12_HEAP_FLAG_NONE, &buffer,
                                         D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                         IID_PPV_ARGS(&m_Readback));
    if (FAILED(hr)) {
        error = "could not create the timestamp readback (" + hresultText(hr) + ")";
        reset();
        return false;
    }
    m_Queue = queue;
    LARGE_INTEGER frequency = {};
    ::QueryPerformanceFrequency(&frequency);
    m_QpcFrequency = frequency.QuadPart;
    calibrate();
    return true;
}

void QueueTimer::reset()
{
    m_Heap.Reset();
    m_Readback.Reset();
    m_Queue.Reset();
    m_Frequency = 0;
    m_Pending = {};
    m_Next = 0;
    m_Calibrated = false;
}

void QueueTimer::calibrate()
{
    UINT64 gpu = 0, qpc = 0;
    m_Calibrated = m_Queue && SUCCEEDED(m_Queue->GetClockCalibration(&gpu, &qpc));
    m_CalibrationGpu = gpu;
    m_CalibrationQpc = qpc;
}

int QueueTimer::begin(ID3D12GraphicsCommandList* list)
{
    if (!m_Readback || !list || m_Pending[m_Next]) return -1;
    const int slot = m_Next;
    m_Next = (m_Next + 1) % kSlots;
    m_Pending[slot] = true;
    list->EndQuery(m_Heap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, static_cast<UINT>(2 * slot));
    return slot;
}

void QueueTimer::end(ID3D12GraphicsCommandList* list, int slot)
{
    if (slot < 0 || slot >= kSlots || !list) return;
    list->EndQuery(m_Heap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, static_cast<UINT>(2 * slot + 1));
    list->ResolveQueryData(m_Heap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, static_cast<UINT>(2 * slot), 2,
                           m_Readback.Get(), 2 * slot * sizeof(uint64_t));
}

void QueueTimer::cancel(int slot)
{
    if (slot >= 0 && slot < kSlots) m_Pending[slot] = false;
}

bool QueueTimer::read(int slot, Sample& out)
{
    if (slot < 0 || slot >= kSlots || !m_Pending[slot]) return false;
    m_Pending[slot] = false;

    const SIZE_T offset = 2 * slot * sizeof(uint64_t);
    const D3D12_RANGE range = {offset, offset + 2 * sizeof(uint64_t)};
    void* mapped = nullptr;
    if (FAILED(m_Readback->Map(0, &range, &mapped))) return false;
    const auto* stamps =
        reinterpret_cast<const uint64_t*>(static_cast<const char*>(mapped) + offset);
    const uint64_t start = stamps[0];
    const uint64_t end = stamps[1];
    const D3D12_RANGE nothing = {0, 0};
    m_Readback->Unmap(0, &nothing);
    if (end < start || start == 0) return false;

    out = Sample{};
    out.gpuUs = static_cast<int64_t>((end - start) * 1000000 / m_Frequency);

    // The two clocks drift apart by parts per million; a pair older than two
    // seconds would place a stamp a few microseconds off. Fresh enough is
    // cheap: one kernel call every two seconds.
    LARGE_INTEGER now = {};
    ::QueryPerformanceCounter(&now);
    if (!m_Calibrated || now.QuadPart - static_cast<int64_t>(m_CalibrationQpc) > 2 * m_QpcFrequency)
        calibrate();
    if (m_Calibrated && m_QpcFrequency > 0) {
        const auto toQpc = [this](uint64_t gpu) {
            const double seconds =
                (static_cast<double>(gpu) - static_cast<double>(m_CalibrationGpu)) /
                static_cast<double>(m_Frequency);
            return static_cast<int64_t>(m_CalibrationQpc) +
                   static_cast<int64_t>(seconds * static_cast<double>(m_QpcFrequency));
        };
        out.startQpc = toQpc(start);
        out.endQpc = toQpc(end);
    }
    return true;
}

} // namespace mw::native::d3d12
