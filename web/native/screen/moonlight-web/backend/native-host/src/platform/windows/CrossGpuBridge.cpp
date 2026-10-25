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

#include "CrossGpuBridge.h"

#include "../../core/Log.h"

#include <dxgi1_6.h>

#include <chrono>
#include <cstdio>
#include <cstring>

using Microsoft::WRL::ComPtr;

namespace mw::native {
namespace {

int64_t steadyNowUs()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

std::string hresultToString(HRESULT hr)
{
    char buffer[32] = {};
    std::snprintf(buffer, sizeof(buffer), "0x%08lX", static_cast<unsigned long>(hr));
    return buffer;
}

/// Bytes per pixel of the formats Desktop Duplication hands out. Anything else
/// is refused rather than guessed: a wrong stride here is a sheared picture.
size_t bytesPerPixel(DXGI_FORMAT format)
{
    switch (format) {
    case DXGI_FORMAT_B8G8R8A8_UNORM:
    case DXGI_FORMAT_R8G8B8A8_UNORM: return 4;
    case DXGI_FORMAT_R16G16B16A16_FLOAT: return 8;
    default: return 0;
    }
}

} // namespace

CrossGpuBridge::CrossGpuBridge(uint64_t encodeAdapterLuid)
    : m_AdapterLuid(encodeAdapterLuid)
{}

CrossGpuBridge::~CrossGpuBridge()
{
    closeDma();
}

bool CrossGpuBridge::open(std::string& error)
{
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(::CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
        error = "DXGI is unavailable";
        return false;
    }

    ComPtr<IDXGIAdapter1> adapter;
    ComPtr<IDXGIAdapter1> candidate;
    for (UINT i = 0;
         factory->EnumAdapters1(i, candidate.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND;
         ++i) {
        DXGI_ADAPTER_DESC1 desc = {};
        if (FAILED(candidate->GetDesc1(&desc))) continue;
        const uint64_t luid =
            (static_cast<uint64_t>(static_cast<uint32_t>(desc.AdapterLuid.HighPart)) << 32) |
            static_cast<uint64_t>(desc.AdapterLuid.LowPart);
        if (luid == m_AdapterLuid) {
            adapter = candidate;
            break;
        }
    }
    if (!adapter) {
        error = "the GPU chosen to encode is no longer present";
        return false;
    }

    // UNKNOWN is required when an adapter is named — see DxgiDuplication.
    const D3D_FEATURE_LEVEL wanted[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL obtained = {};
    const HRESULT hr = ::D3D11CreateDevice(
        adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, wanted,
        static_cast<UINT>(std::size(wanted)), D3D11_SDK_VERSION, m_Device.ReleaseAndGetAddressOf(),
        &obtained, m_Context.ReleaseAndGetAddressOf());
    if (FAILED(hr)) {
        error = "could not create a D3D11 device on the encoding GPU (" + hresultToString(hr) + ")";
        return false;
    }
    return true;
}

bool CrossGpuBridge::ensureBuffers(ID3D11Device* sourceDevice, const D3D11_TEXTURE2D_DESC& desc,
                                   std::string& error)
{
    const bool same = m_Staging && m_Upload && m_StagingDevice == sourceDevice &&
                      m_Width == desc.Width && m_Height == desc.Height && m_Format == desc.Format;
    if (same) return true;

    const size_t bpp = bytesPerPixel(desc.Format);
    if (bpp == 0) {
        error = "cross-GPU copy: unsupported capture format " +
                std::to_string(static_cast<int>(desc.Format));
        return false;
    }

    // Readback on the source: nothing bound, CPU-readable, the GPU writes it
    // with CopyResource and Map waits for that write.
    D3D11_TEXTURE2D_DESC staging = desc;
    staging.Usage = D3D11_USAGE_STAGING;
    staging.BindFlags = 0;
    staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging.MiscFlags = 0;
    staging.MipLevels = 1;
    staging.ArraySize = 1;
    if (FAILED(
            sourceDevice->CreateTexture2D(&staging, nullptr, m_Staging.ReleaseAndGetAddressOf()))) {
        error = "cross-GPU copy: the display's GPU refused a readback texture";
        m_Staging.Reset();
        return false;
    }

    // Upload on the destination: dynamic, so Map(WRITE_DISCARD) hands out a
    // fresh allocation each frame and the converter's read of the previous one
    // never has to be waited for.
    D3D11_TEXTURE2D_DESC upload = desc;
    upload.Usage = D3D11_USAGE_DYNAMIC;
    upload.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    upload.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    upload.MiscFlags = 0;
    upload.MipLevels = 1;
    upload.ArraySize = 1;
    if (FAILED(m_Device->CreateTexture2D(&upload, nullptr, m_Upload.ReleaseAndGetAddressOf()))) {
        error = "cross-GPU copy: the encoding GPU refused an upload texture";
        m_Staging.Reset();
        m_Upload.Reset();
        return false;
    }

    m_StagingDevice = sourceDevice;
    m_Width = desc.Width;
    m_Height = desc.Height;
    m_Format = desc.Format;
    m_BytesPerPixel = bpp;
    m_BytesPerFrame = static_cast<size_t>(desc.Width) * desc.Height * bpp;
    log::info("[native] cross-GPU copy: " + std::to_string(desc.Width) + "x" +
              std::to_string(desc.Height) + ", " + std::to_string(m_BytesPerFrame / (1024 * 1024)) +
              " MB per frame through system memory");
    return true;
}

ID3D11Texture2D* CrossGpuBridge::transfer(ID3D11Device* sourceDevice,
                                          ID3D11DeviceContext* sourceContext,
                                          ID3D11Texture2D* source, std::string& error)
{
    if (!m_Device || !sourceDevice || !sourceContext || !source) {
        error = "cross-GPU copy: nothing to copy from";
        return nullptr;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    source->GetDesc(&desc);
    if (!ensureBuffers(sourceDevice, desc, error)) return nullptr;

    const int64_t startUs = steadyNowUs();

    // The copy engine first (see the class comment); the 3D queue when this
    // source or this GPU cannot take it.
    UINT inPitch = 0;
    const uint8_t* src = readBackDma(sourceDevice, source, inPitch);
    const bool dma = src != nullptr;
    D3D11_MAPPED_SUBRESOURCE in = {};
    if (!dma) {
        sourceContext->CopyResource(m_Staging.Get(), source);

        // Map blocks until the copy above has landed: this is where the wait
        // for the source GPU happens, and it is the first of the two real
        // costs.
        const HRESULT hr = sourceContext->Map(m_Staging.Get(), 0, D3D11_MAP_READ, 0, &in);
        if (FAILED(hr)) {
            error = "cross-GPU copy: could not read the frame back (" + hresultToString(hr) + ")";
            return nullptr;
        }
        src = static_cast<const uint8_t*>(in.pData);
        inPitch = in.RowPitch;
    }

    D3D11_MAPPED_SUBRESOURCE out = {};
    const HRESULT hr = m_Context->Map(m_Upload.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &out);
    if (FAILED(hr)) {
        if (!dma) sourceContext->Unmap(m_Staging.Get(), 0);
        error = "cross-GPU copy: could not write the frame to the encoding GPU (" +
                hresultToString(hr) + ")";
        return nullptr;
    }

    // Row by row: the two pitches are each GPU's own and rarely agree. The
    // second real cost — a memcpy of the whole frame.
    const size_t rowBytes = static_cast<size_t>(m_Width) * m_BytesPerPixel;
    uint8_t* dst = static_cast<uint8_t*>(out.pData);
    if (inPitch == out.RowPitch && inPitch == rowBytes) {
        std::memcpy(dst, src, rowBytes * m_Height);
    } else {
        for (UINT y = 0; y < m_Height; ++y)
            std::memcpy(dst + static_cast<size_t>(y) * out.RowPitch,
                        src + static_cast<size_t>(y) * inPitch, rowBytes);
    }

    m_Context->Unmap(m_Upload.Get(), 0);
    if (!dma) sourceContext->Unmap(m_Staging.Get(), 0);
    if (dma) m_DmaTransfers++;

    const int64_t tookUs = steadyNowUs() - startUs;
    m_Transfers++;
    m_TotalUs += tookUs;
    if (tookUs > m_MaxUs) m_MaxUs = tookUs;
    return m_Upload.Get();
}

bool CrossGpuBridge::openDma(ID3D11Device* sourceDevice)
{
    char value[8] = {};
    const DWORD n = ::GetEnvironmentVariableA("MW_BRIDGE_DMA", value, sizeof(value));
    if (n > 0 && n < sizeof(value) && _stricmp(value, "off") == 0) {
        log::info("[native] cross-GPU copy: MW_BRIDGE_DMA=off — readback through the 3D queue");
        return false;
    }

    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IDXGIAdapter> adapter;
    if (FAILED(sourceDevice->QueryInterface(IID_PPV_ARGS(&dxgi))) ||
        FAILED(dxgi->GetAdapter(&adapter))) {
        log::info("[native] cross-GPU copy: the capture's adapter is unknown — readback through "
                  "the 3D queue");
        return false;
    }

    HRESULT hr = ::D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&m_D12));
    if (FAILED(hr)) {
        log::info("[native] cross-GPU copy: no D3D12 on the display's GPU (" + hresultToString(hr) +
                  ") — readback through the 3D queue");
        return false;
    }

    D3D12_COMMAND_QUEUE_DESC queue = {};
    queue.Type = D3D12_COMMAND_LIST_TYPE_COPY;
    // HIGH, not GLOBAL_REALTIME: the DMA engine is not contended the way 3D
    // is, and HIGH asks nothing of the token. GLOBAL_REALTIME takes the same
    // base-priority privilege as the REALTIME scheduling class — the SYSTEM or
    // elevated worker has it, a limited token is refused with
    // DXGI_ERROR_ACCESS_DENIED (d3d12-lab caps, 26/09/2026). The D3D12
    // pipeline's queues follow the class instead (StreamPriority::queuePriority).
    queue.Priority = D3D12_COMMAND_QUEUE_PRIORITY_HIGH;
    hr = m_D12->CreateCommandQueue(&queue, IID_PPV_ARGS(&m_CopyQueue));
    if (SUCCEEDED(hr))
        hr = m_D12->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_COPY,
                                           IID_PPV_ARGS(&m_CopyAllocator));
    if (SUCCEEDED(hr))
        hr = m_D12->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_COPY, m_CopyAllocator.Get(),
                                      nullptr, IID_PPV_ARGS(&m_CopyList));
    if (SUCCEEDED(hr)) hr = m_CopyList->Close();
    if (SUCCEEDED(hr))
        hr = m_D12->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_CopyFence));
    if (SUCCEEDED(hr)) {
        m_CopyEvent = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!m_CopyEvent) hr = HRESULT_FROM_WIN32(::GetLastError());
    }
    if (FAILED(hr)) {
        log::info("[native] cross-GPU copy: no D3D12 copy queue on the display's GPU (" +
                  hresultToString(hr) + ") — readback through the 3D queue");
        closeDma();
        return false;
    }

    DXGI_ADAPTER_DESC desc = {};
    adapter->GetDesc(&desc);
    char name[128] = {};
    ::WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name, sizeof(name) - 1, nullptr,
                          nullptr);
    log::info(std::string("[native] cross-GPU copy: readback on the copy engine of '") + name +
              "' (D3D12), out of the 3D queue's way");
    return true;
}

void CrossGpuBridge::closeDma()
{
    if (m_Readback && m_ReadbackData) {
        const D3D12_RANGE none = {0, 0};
        m_Readback->Unmap(0, &none);
    }
    m_ReadbackData = nullptr;
    m_Readback.Reset();
    m_DmaSources.clear();
    m_CopyList.Reset();
    m_CopyAllocator.Reset();
    m_CopyQueue.Reset();
    m_CopyFence.Reset();
    m_CopyFenceValue = 0;
    if (m_CopyEvent) ::CloseHandle(m_CopyEvent);
    m_CopyEvent = nullptr;
    m_D12.Reset();
    m_DmaDevice = nullptr;
    m_DmaOff = false;
}

ID3D12Resource* CrossGpuBridge::dmaSourceFor(ID3D11Texture2D* source)
{
    for (const DmaSource& known : m_DmaSources)
        if (known.d3d11.Get() == source) return known.d3d12.Get();

    // Desktop Duplication's surfaces carry an NT handle; a surface that does
    // not (WGC's, say) is one for the 3D queue, and so will the next be.
    ComPtr<IDXGIResource1> shareable;
    HANDLE handle = nullptr;
    HRESULT hr = source->QueryInterface(IID_PPV_ARGS(&shareable));
    if (SUCCEEDED(hr))
        hr = shareable->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ, nullptr, &handle);
    ComPtr<ID3D12Resource> opened;
    if (SUCCEEDED(hr)) {
        hr = m_D12->OpenSharedHandle(handle, IID_PPV_ARGS(&opened));
        ::CloseHandle(handle);
    }
    if (FAILED(hr)) {
        log::info("[native] cross-GPU copy: the captured surface cannot be opened in D3D12 (" +
                  hresultToString(hr) + ") — readback through the 3D queue");
        m_DmaOff = true;
        return nullptr;
    }

    // A rotation is a handful; more means the capture is allocating afresh,
    // and holding on to old surfaces would only pin their memory.
    if (m_DmaSources.size() >= 8) m_DmaSources.clear();
    m_DmaSources.push_back({source, opened});
    return opened.Get();
}

const uint8_t* CrossGpuBridge::readBackDma(ID3D11Device* sourceDevice, ID3D11Texture2D* source,
                                           UINT& rowPitch)
{
    // A capture restart brings a new device, and with it a new chance.
    if (sourceDevice != m_DmaDevice) {
        closeDma();
        const bool opened = openDma(sourceDevice);
        // After openDma, whose failure path clears the device: a refusal is
        // then remembered for this device rather than retried every frame.
        m_DmaDevice = sourceDevice;
        m_DmaOff = !opened;
    }
    if (m_DmaOff) return nullptr;

    ID3D12Resource* surface = dmaSourceFor(source);
    if (!surface) return nullptr;

    const D3D12_RESOURCE_DESC desc = surface->GetDesc();
    if (!m_Readback || m_Footprint.Footprint.Width != desc.Width ||
        m_Footprint.Footprint.Height != desc.Height ||
        m_Footprint.Footprint.Format != desc.Format) {
        if (m_Readback && m_ReadbackData) {
            const D3D12_RANGE none = {0, 0};
            m_Readback->Unmap(0, &none);
        }
        m_ReadbackData = nullptr;
        m_Readback.Reset();

        UINT64 total = 0;
        m_D12->GetCopyableFootprints(&desc, 0, 1, 0, &m_Footprint, nullptr, nullptr, &total);
        D3D12_HEAP_PROPERTIES heap = {};
        heap.Type = D3D12_HEAP_TYPE_READBACK;
        D3D12_RESOURCE_DESC buffer = {};
        buffer.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        buffer.Width = total;
        buffer.Height = 1;
        buffer.DepthOrArraySize = 1;
        buffer.MipLevels = 1;
        buffer.SampleDesc.Count = 1;
        buffer.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        void* mapped = nullptr;
        HRESULT hr = m_D12->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &buffer,
                                                    D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                                    IID_PPV_ARGS(&m_Readback));
        if (SUCCEEDED(hr)) hr = m_Readback->Map(0, nullptr, &mapped);
        if (FAILED(hr)) {
            log::info("[native] cross-GPU copy: no D3D12 readback buffer (" + hresultToString(hr) +
                      ") — readback through the 3D queue");
            m_Readback.Reset();
            m_DmaOff = true;
            return nullptr;
        }
        m_ReadbackData = static_cast<const uint8_t*>(mapped);
    }

    // One copy, waited for here: the frame is needed before the conversion
    // anyway, and the wait is the copy itself, not a game's frame.
    HRESULT hr = m_CopyAllocator->Reset();
    if (SUCCEEDED(hr)) hr = m_CopyList->Reset(m_CopyAllocator.Get(), nullptr);
    if (SUCCEEDED(hr)) {
        D3D12_TEXTURE_COPY_LOCATION to = {};
        to.pResource = m_Readback.Get();
        to.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        to.PlacedFootprint = m_Footprint;
        D3D12_TEXTURE_COPY_LOCATION from = {};
        from.pResource = surface;
        from.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        from.SubresourceIndex = 0;
        m_CopyList->CopyTextureRegion(&to, 0, 0, 0, &from, nullptr);
        hr = m_CopyList->Close();
    }
    if (SUCCEEDED(hr)) {
        ID3D12CommandList* lists[] = {m_CopyList.Get()};
        m_CopyQueue->ExecuteCommandLists(1, lists);
        hr = m_CopyQueue->Signal(m_CopyFence.Get(), ++m_CopyFenceValue);
    }
    if (SUCCEEDED(hr) && m_CopyFence->GetCompletedValue() < m_CopyFenceValue) {
        hr = m_CopyFence->SetEventOnCompletion(m_CopyFenceValue, m_CopyEvent);
        if (SUCCEEDED(hr) && ::WaitForSingleObject(m_CopyEvent, 1000) != WAIT_OBJECT_0)
            hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    if (FAILED(hr)) {
        log::info("[native] cross-GPU copy: the copy engine failed a readback (" +
                  hresultToString(hr) + ") — readback through the 3D queue from now on");
        m_DmaOff = true;
        return nullptr;
    }

    rowPitch = m_Footprint.Footprint.RowPitch;
    return m_ReadbackData + m_Footprint.Offset;
}

} // namespace mw::native
