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
#include <wrl/client.h>

#include <cstdint>
#include <string>
#include <vector>

namespace mw::native {

/// Carries a captured frame from the GPU that scanned it out to the GPU that
/// will encode it, when those are not the same adapter (design §6).
///
/// ── What this costs, and why it is still worth having ───────────────────────
///
/// D3D11 has no way to hand a texture from one adapter to another: shared
/// handles are per adapter, and a resource created on one device is invisible
/// to the other. The only road is through system memory — the frame is copied
/// into a staging texture on the source GPU, mapped, copied row by row into a
/// dynamic texture on the destination GPU, and unmapped. A 1440p BGRA8 frame is
/// 14.7 MB; at memory speed that is a few milliseconds, which is more than the
/// whole of the rest of the pipeline. Every zero-copy promise of the engine is
/// given up on this path, and the Selector avoids it whenever the display's own
/// GPU can encode at all.
///
/// It exists for two cases:
///
///  - a display driven by a GPU with no encoder — a laptop's panel on an iGPU
///    the driver exposes no encoder for, a virtual adapter — where the
///    alternative to the copy is no stream at all;
///  - the bench, which needs to measure an encoder that drives no display (an
///    iGPU beside a discrete card, here) and forces the GPU on purpose.
///
/// The time it takes is counted inside the frame's `convert` stage — the bridge
/// runs between the acquire and the colour pass — and logged on its own at the
/// end of the session, so a session that paid for it says so in numbers.
///
/// ── The readback runs on the copy engine ─────────────────────────────────────
///
/// A D3D11 CopyResource goes into the source GPU's 3D queue. With a game
/// holding that engine, the readback waits its turn behind the game's frame:
/// 15 ms on average and 64 ms at p99 for a 1440p frame on the Arc A380 under
/// Resident Evil Requiem, where the copy itself takes 1.6 ms (21/09/2026).
/// A D3D12 COPY queue runs on the GPU's DMA engine instead, which the game
/// does not use: the same readback measured 1.6 ms mean, 2.3 ms p99, under the
/// same load. The captured surface is opened in D3D12 through its NT handle
/// (Desktop Duplication hands out a shareable one), and the pixels were
/// checked equal to the D3D11 path's.
///
/// Any step of that refused — a surface without a shared handle, a GPU without
/// D3D12 — and the frame takes the D3D11 path above, said once in the log.
/// MW_BRIDGE_DMA=off forces the D3D11 path, for the before and after.
class CrossGpuBridge
{
public:
    /// @param encodeAdapterLuid the adapter to bring frames TO, packed as in
    ///                          GpuInfo::nativeHandle.
    explicit CrossGpuBridge(uint64_t encodeAdapterLuid);
    ~CrossGpuBridge();

    CrossGpuBridge(const CrossGpuBridge&) = delete;
    CrossGpuBridge& operator=(const CrossGpuBridge&) = delete;

    /// Create the destination device. Once per session; survives capture
    /// restarts, since the encoder's adapter does not change when the
    /// duplication does.
    bool open(std::string& error);

    /// The device the converter and encoder must be built on.
    ID3D11Device* device() const { return m_Device.Get(); }
    ID3D11DeviceContext* context() const { return m_Context.Get(); }

    /// Bring @p source — a texture on @p sourceDevice — onto this bridge's
    /// device. The result is owned here and valid until the next call; it is
    /// recreated when the source changes size, format or device (a capture
    /// restart), never per frame.
    ID3D11Texture2D* transfer(ID3D11Device* sourceDevice, ID3D11DeviceContext* sourceContext,
                              ID3D11Texture2D* source, std::string& error);

    /// How many transfers happened, and how long they took on average and at
    /// most, in microseconds — for the end-of-session log.
    int64_t transfers() const { return m_Transfers; }
    int64_t meanUs() const { return m_Transfers > 0 ? m_TotalUs / m_Transfers : 0; }
    int64_t maxUs() const { return m_MaxUs; }
    /// Bytes one frame costs to move, once the first has been.
    size_t bytesPerFrame() const { return m_BytesPerFrame; }

    /// How many of those went through the copy engine.
    int64_t dmaTransfers() const { return m_DmaTransfers; }

private:
    bool ensureBuffers(ID3D11Device* sourceDevice, const D3D11_TEXTURE2D_DESC& desc,
                       std::string& error);

    /// The copy-engine readback of @p source into system memory. Null when this
    /// source cannot take it; the caller then reads back through D3D11.
    const uint8_t* readBackDma(ID3D11Device* sourceDevice, ID3D11Texture2D* source, UINT& rowPitch);
    bool openDma(ID3D11Device* sourceDevice);
    void closeDma();
    ID3D12Resource* dmaSourceFor(ID3D11Texture2D* source);

    const uint64_t m_AdapterLuid;

    Microsoft::WRL::ComPtr<ID3D11Device> m_Device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> m_Context;

    /// Readback on the SOURCE device, and the device it belongs to — a capture
    /// restart hands out a new device, and a staging texture from the old one
    /// would be silently useless against it.
    Microsoft::WRL::ComPtr<ID3D11Texture2D> m_Staging;
    ID3D11Device* m_StagingDevice = nullptr;
    /// Upload on THIS device: what the converter reads.
    Microsoft::WRL::ComPtr<ID3D11Texture2D> m_Upload;

    UINT m_Width = 0;
    UINT m_Height = 0;
    DXGI_FORMAT m_Format = DXGI_FORMAT_UNKNOWN;
    size_t m_BytesPerPixel = 0;
    size_t m_BytesPerFrame = 0;

    int64_t m_Transfers = 0;
    int64_t m_TotalUs = 0;
    int64_t m_MaxUs = 0;
    int64_t m_DmaTransfers = 0;

    // ── Copy-engine readback, on the SOURCE adapter ──────────────────────────
    /// Off for good once refused (or by MW_BRIDGE_DMA=off); retried only when
    /// the source device changes.
    bool m_DmaOff = false;
    ID3D11Device* m_DmaDevice = nullptr;
    Microsoft::WRL::ComPtr<ID3D12Device> m_D12;
    Microsoft::WRL::ComPtr<ID3D12CommandQueue> m_CopyQueue;
    Microsoft::WRL::ComPtr<ID3D12CommandAllocator> m_CopyAllocator;
    Microsoft::WRL::ComPtr<ID3D12GraphicsCommandList> m_CopyList;
    Microsoft::WRL::ComPtr<ID3D12Fence> m_CopyFence;
    UINT64 m_CopyFenceValue = 0;
    HANDLE m_CopyEvent = nullptr;
    /// Stays mapped: a readback heap may be, and it saves a map per frame.
    Microsoft::WRL::ComPtr<ID3D12Resource> m_Readback;
    const uint8_t* m_ReadbackData = nullptr;
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT m_Footprint = {};

    /// The capture hands out a handful of surfaces in rotation; each is opened
    /// in D3D12 once. The D3D11 reference is held so a pointer cannot be
    /// reused by a different surface while its entry is here.
    struct DmaSource
    {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> d3d11;
        Microsoft::WRL::ComPtr<ID3D12Resource> d3d12;
    };
    std::vector<DmaSource> m_DmaSources;
};

} // namespace mw::native
