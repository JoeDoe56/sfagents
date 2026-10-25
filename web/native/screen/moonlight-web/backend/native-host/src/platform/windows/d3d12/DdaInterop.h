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

#include "D3d12Device.h"

#include <d3d11_4.h>

#include <memory>
#include <vector>

namespace mw::native::d3d12 {

/// How the D3D12 side is ordered against Desktop Duplication's surface. Gpu is
/// the pipeline's; the other two exist for the bench (key `ddasync`).
enum class DdaSync
{
    /// Nothing: D3D12 reads the surface as soon as it is submitted, and the
    /// capture releases it as soon as the CPU is done. Unsafe in principle
    /// (see DdaInterop), measured to know what the handshake costs.
    None,
    /// Both ways on the GPU, no CPU wait: §3.1 of the plan.
    Gpu,
    /// The CPU waits for the conversion before ReleaseFrame — the first
    /// attempt's way (21/09), which holds the capture thread for the whole
    /// conversion.
    Cpu,
};

const char* toString(DdaSync sync);

/// Desktop Duplication's surface, read by D3D12 without a copy and without a
/// race.
///
/// ── Why a handshake at all ───────────────────────────────────────────────────
///
/// Desktop Duplication duplicates onto a D3D11 device, and there is no D3D12
/// equivalent. Its surface is shareable, so D3D12 can open it through an NT
/// handle and read the same VRAM. But the keyed mutex that stands between the
/// surface and the compositor orders the D3D11 context only: a D3D12 read
/// submitted right after AcquireNextFrame may run before the compositor's
/// write has landed, and one still running after ReleaseFrame may see the next
/// frame half written. Two fences shared between the APIs order both edges,
/// on the GPU:
///
///   A  D3D11 → D3D12  the capture context signals after the acquire; the
///                     conversion queue waits for it before reading;
///   B  D3D12 → D3D11  the conversion queue signals once it has read; the
///                     capture context waits for it before ReleaseFrame, so the
///                     keyed mutex is let go after the read — and the CPU does
///                     not wait at all.
///
/// ── Windows.Graphics.Capture ─────────────────────────────────────────────────
///
/// Its pool's textures have no NT handle, so D3D12 cannot open them, and a
/// device of its own does not take them either (a D3D11On12 pool got two
/// frames and nothing after, like the duplication; bench §8y.1). The frame is
/// copied instead, on the capture's context, into a shareable texture of the
/// interop's own, and the two fences order that copy exactly as they order
/// the compositor's write: see open() with a context (plan « Gels du lien »,
/// route B).
///
/// ── Rebinding ────────────────────────────────────────────────────────────────
///
/// A capture restart brings a new D3D11 device: both fences are made again
/// and the opened surfaces forgotten, the copies' textures with them. The
/// D3D12 device and its queues stay.
///
/// Every refusal has a name — the log line that says why a session is on
/// D3D11 is only useful if it says which step said no.
class DdaInterop
{
public:
    static constexpr size_t kMaxSurfaces = 8;

    DdaInterop() = default;
    ~DdaInterop();

    DdaInterop(const DdaInterop&) = delete;
    DdaInterop& operator=(const DdaInterop&) = delete;

    /// Ties the pipeline to @p captureDevice, the duplication's device (a new
    /// one after every capture restart). False, with the reason, when the two
    /// APIs cannot share fences here — the D3D12 route is then refused for this
    /// build only, and reconsidered at the next.
    bool bind(ID3D11Device* captureDevice, const std::shared_ptr<D3d12Device>& device,
              std::string& refusal);

    /// Lets go of the capture device, its fences and the opened surfaces. The
    /// caller has drained the queues first.
    void unbind();

    bool bound() const { return m_Device11 != nullptr; }
    ID3D11Device* captureDevice() const { return m_Device11.Get(); }

    /// @p captured as the D3D12 device sees it, opened once per surface and
    /// kept: the duplication rotates through a few, and opening one costs a
    /// kernel round trip. Null, with the reason, for a surface without an NT
    /// handle (Windows.Graphics.Capture's, or a secure desktop's).
    ID3D12Resource* open(ID3D11Texture2D* captured, std::string& error);

    /// The same, for a capture whose surfaces may have no NT handle
    /// (Windows.Graphics.Capture's pool; plan « Gels du lien », route B,
    /// 22/10/2026): one that has is opened as above; one that has not is
    /// copied on @p context — the capture's, so the copy lands behind the
    /// compositor's write and in front of fence A's signal — into a
    /// shareable texture of the interop's own, which D3D12 reads as it reads
    /// the duplication's surface, behind the same two fences. Two such
    /// textures take turns, and a surface found without a handle is
    /// remembered as such, so the pool's few buffers cost one refused handle
    /// each and a copy per frame. Measured on the RTX and the N95 (bench
    /// §8y.1): the read matched the frame delivered every time.
    ID3D12Resource* open(ID3D11Texture2D* captured, ID3D11DeviceContext* context,
                         std::string& error);

    /// Surfaces opened so far (the tests read it).
    size_t openedSurfaces() const { return m_Surfaces.size(); }
    /// Frames copied so far for want of a handle (the tests read it).
    size_t copiedFrames() const { return m_Copied; }

    /// Fence A: the capture context signals it right after the acquire and
    /// flushes, so the signal reaches the GPU. The value the conversion queue
    /// waits for; 0 with @p sync None, or on failure (with the reason).
    uint64_t signalAcquired(ID3D11DeviceContext* context, DdaSync sync, std::string& error);

    /// The conversion queue waits, on the GPU, for fence A to reach @p value.
    /// Nothing with a value of 0.
    bool conversionWaits(ID3D12CommandQueue* queue, uint64_t value, std::string& error);

    /// Fence B: the conversion queue signals it once its list is submitted.
    /// The value the capture context and the encode queue wait for.
    uint64_t conversionSignals(ID3D12CommandQueue* queue, std::string& error);

    /// Before ReleaseFrame: the capture context waits for fence B to reach
    /// @p value — on the GPU (Gpu), with the CPU for at most @p timeoutMs (Cpu),
    /// or not at all (None).
    bool beforeRelease(ID3D11DeviceContext* context, uint64_t value, DdaSync sync,
                       uint32_t timeoutMs, std::string& error);

    /// Fence B on the D3D12 side, for the encode queue's wait.
    GpuFence& converted() { return m_FenceB; }

private:
    struct Surface
    {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> d3d11;
        Microsoft::WRL::ComPtr<ID3D12Resource> d3d12;
    };
    /// One of the interop's own textures, for the surfaces without a handle:
    /// made on the capture device at the captured surface's size and format,
    /// opened by D3D12 once.
    struct Slot
    {
        Surface surface;
        UINT width = 0;
        UINT height = 0;
        DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
    };
    static constexpr size_t kSlots = 2;

    /// @p slot made (again) for a surface of @p desc.
    bool makeSlot(Slot& slot, const D3D11_TEXTURE2D_DESC& desc, std::string& error);

    std::shared_ptr<D3d12Device> m_Device;
    Microsoft::WRL::ComPtr<ID3D11Device5> m_Device11;
    Microsoft::WRL::ComPtr<ID3D11Fence> m_FenceA11; // made by D3D11, signalled by it
    GpuFence m_FenceA;                              // the same, opened in D3D12
    GpuFence m_FenceB;                              // made by D3D12, signalled by it
    Microsoft::WRL::ComPtr<ID3D11Fence> m_FenceB11; // the same, opened in D3D11
    std::vector<Surface> m_Surfaces;
    /// The surfaces found without a handle (by pointer, as m_Surfaces), the
    /// textures they are copied into, which of them takes the next copy, and
    /// how many copies were made.
    std::vector<ID3D11Texture2D*> m_NoHandle;
    Slot m_Slots[kSlots];
    size_t m_NextSlot = 0;
    size_t m_Copied = 0;
};

} // namespace mw::native::d3d12
