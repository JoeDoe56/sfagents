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

#include "DdaInterop.h"

#include <dxgi1_2.h>

#include <algorithm>

using Microsoft::WRL::ComPtr;

namespace mw::native::d3d12 {

const char* toString(DdaSync sync)
{
    switch (sync) {
    case DdaSync::None: return "none";
    case DdaSync::Gpu: return "gpu";
    case DdaSync::Cpu: return "cpu";
    }
    return "unknown";
}

DdaInterop::~DdaInterop()
{
    unbind();
}

void DdaInterop::unbind()
{
    m_Surfaces.clear();
    m_NoHandle.clear();
    for (Slot& slot : m_Slots)
        slot = Slot{};
    m_NextSlot = 0;
    m_Copied = 0;
    m_FenceB11.Reset();
    m_FenceB.reset();
    m_FenceA.reset();
    m_FenceA11.Reset();
    m_Device11.Reset();
    m_Device.reset();
}

bool DdaInterop::bind(ID3D11Device* captureDevice, const std::shared_ptr<D3d12Device>& device,
                      std::string& refusal)
{
    unbind();
    if (!captureDevice || !device || !device->device()) {
        refusal = "no capture or D3D12 device";
        return false;
    }

    // The same VRAM is the whole point: a surface of one adapter cannot be
    // opened by another's device (the cross-GPU bridge is D3D11's business).
    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IDXGIAdapter> adapter;
    DXGI_ADAPTER_DESC desc = {};
    if (FAILED(captureDevice->QueryInterface(IID_PPV_ARGS(&dxgi))) ||
        FAILED(dxgi->GetAdapter(&adapter)) || FAILED(adapter->GetDesc(&desc))) {
        refusal = "the capture's adapter is unknown";
        return false;
    }
    if (luidValue(desc.AdapterLuid) != device->luid()) {
        refusal = "the capture and the D3D12 device are on different adapters";
        return false;
    }

    ComPtr<ID3D11Device5> device5;
    HRESULT hr = captureDevice->QueryInterface(IID_PPV_ARGS(&device5));
    if (FAILED(hr)) {
        refusal = "the capture device has no D3D11 fences (ID3D11Device5, Windows 10 1703) (" +
                  hresultText(hr) + ")";
        return false;
    }

    // A: made by D3D11, opened in D3D12.
    ComPtr<ID3D11Fence> fenceA11;
    hr = device5->CreateFence(0, D3D11_FENCE_FLAG_SHARED, IID_PPV_ARGS(&fenceA11));
    if (FAILED(hr)) {
        refusal = "the D3D11 fence cannot be created shared (" + hresultText(hr) + ")";
        return false;
    }
    HANDLE handle = nullptr;
    hr = fenceA11->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &handle);
    if (FAILED(hr)) {
        refusal = "the D3D11 fence cannot be shared (" + hresultText(hr) + ")";
        return false;
    }
    ComPtr<ID3D12Fence> fenceA12;
    hr = device->device()->OpenSharedHandle(handle, IID_PPV_ARGS(&fenceA12));
    ::CloseHandle(handle);
    std::string error;
    if (FAILED(hr)) {
        refusal = "D3D12 cannot open the D3D11 fence (" + hresultText(hr) + ")";
        return false;
    }
    if (!m_FenceA.adopt(device->device(), fenceA12, 0, error)) {
        refusal = error;
        return false;
    }

    // B: made by D3D12, opened in D3D11.
    if (!m_FenceB.create(device->device(), true, error)) {
        refusal = error;
        m_FenceA.reset();
        return false;
    }
    handle = m_FenceB.sharedHandle(error);
    if (!handle) {
        refusal = error;
        m_FenceB.reset();
        m_FenceA.reset();
        return false;
    }
    ComPtr<ID3D11Fence> fenceB11;
    hr = device5->OpenSharedFence(handle, IID_PPV_ARGS(&fenceB11));
    ::CloseHandle(handle);
    if (FAILED(hr)) {
        refusal = "D3D11 cannot open the D3D12 fence (" + hresultText(hr) + ")";
        m_FenceB.reset();
        m_FenceA.reset();
        return false;
    }

    m_Device = device;
    m_Device11 = device5;
    m_FenceA11 = fenceA11;
    m_FenceB11 = fenceB11;
    return true;
}

ID3D12Resource* DdaInterop::open(ID3D11Texture2D* captured, std::string& error)
{
    if (!m_Device || !captured) {
        error = "the interop is not bound";
        return nullptr;
    }
    for (const Surface& surface : m_Surfaces)
        if (surface.d3d11.Get() == captured) return surface.d3d12.Get();

    ComPtr<IDXGIResource1> shareable;
    HANDLE handle = nullptr;
    HRESULT hr = captured->QueryInterface(IID_PPV_ARGS(&shareable));
    if (SUCCEEDED(hr))
        hr = shareable->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ, nullptr, &handle);
    if (FAILED(hr)) {
        error = "the captured surface has no shared handle (" + hresultText(hr) + ")";
        return nullptr;
    }
    ComPtr<ID3D12Resource> opened;
    hr = m_Device->device()->OpenSharedHandle(handle, IID_PPV_ARGS(&opened));
    ::CloseHandle(handle);
    if (FAILED(hr)) {
        error = "D3D12 cannot open the captured surface (" + hresultText(hr) + ")";
        return nullptr;
    }

    // Past this many, the duplication was rebuilt under us without a rebind
    // (it should not be): what is kept is dead weight, and only pins VRAM.
    if (m_Surfaces.size() >= kMaxSurfaces) m_Surfaces.clear();
    Surface surface;
    surface.d3d11 = captured;
    surface.d3d12 = opened;
    m_Surfaces.push_back(std::move(surface));
    return m_Surfaces.back().d3d12.Get();
}

ID3D12Resource* DdaInterop::open(ID3D11Texture2D* captured, ID3D11DeviceContext* context,
                                 std::string& error)
{
    if (!m_Device || !captured) {
        error = "the interop is not bound";
        return nullptr;
    }
    // By its handle when it has one — the duplication's surfaces, opened once
    // and kept — unless this surface was already refused one.
    if (std::find(m_NoHandle.begin(), m_NoHandle.end(), captured) == m_NoHandle.end()) {
        std::string refused;
        if (ID3D12Resource* opened = open(captured, refused)) return opened;
        // Like m_Surfaces: past this many the pool was made again under us.
        if (m_NoHandle.size() >= kMaxSurfaces) m_NoHandle.clear();
        m_NoHandle.push_back(captured);
    }
    if (!context) {
        error = "no context to copy the captured surface on";
        return nullptr;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    captured->GetDesc(&desc);
    Slot& slot = m_Slots[m_NextSlot];
    m_NextSlot = (m_NextSlot + 1) % kSlots;
    if (!slot.surface.d3d11 || slot.width != desc.Width || slot.height != desc.Height ||
        slot.format != desc.Format) {
        if (!makeSlot(slot, desc, error)) return nullptr;
    }
    // Queued on the capture's context: behind whatever put the picture there,
    // in front of the signal of fence A that follows. The slot is written
    // again two frames on, behind the wait for fence B queued before the
    // release of the frame it held (beforeRelease), so D3D12 has read it.
    context->CopyResource(slot.surface.d3d11.Get(), captured);
    ++m_Copied;
    return slot.surface.d3d12.Get();
}

bool DdaInterop::makeSlot(Slot& slot, const D3D11_TEXTURE2D_DESC& desc, std::string& error)
{
    slot = Slot{};
    D3D11_TEXTURE2D_DESC own = {};
    own.Width = desc.Width;
    own.Height = desc.Height;
    own.MipLevels = 1;
    own.ArraySize = 1;
    own.Format = desc.Format;
    own.SampleDesc.Count = 1;
    own.Usage = D3D11_USAGE_DEFAULT;
    own.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    own.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    ComPtr<ID3D11Texture2D> texture;
    HRESULT hr = m_Device11->CreateTexture2D(&own, nullptr, &texture);
    if (FAILED(hr)) {
        error =
            "the copy of the captured surface cannot be made shareable (" + hresultText(hr) + ")";
        return false;
    }
    ComPtr<IDXGIResource1> shareable;
    HANDLE handle = nullptr;
    hr = texture.As(&shareable);
    if (SUCCEEDED(hr))
        hr = shareable->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ, nullptr, &handle);
    if (FAILED(hr)) {
        error = "the copy of the captured surface has no shared handle (" + hresultText(hr) + ")";
        return false;
    }
    ComPtr<ID3D12Resource> opened;
    hr = m_Device->device()->OpenSharedHandle(handle, IID_PPV_ARGS(&opened));
    ::CloseHandle(handle);
    if (FAILED(hr)) {
        error = "D3D12 cannot open the copy of the captured surface (" + hresultText(hr) + ")";
        return false;
    }
    slot.surface.d3d11 = texture;
    slot.surface.d3d12 = opened;
    slot.width = desc.Width;
    slot.height = desc.Height;
    slot.format = desc.Format;
    return true;
}

uint64_t DdaInterop::signalAcquired(ID3D11DeviceContext* context, DdaSync sync, std::string& error)
{
    if (sync == DdaSync::None) return 0;
    ComPtr<ID3D11DeviceContext4> context4;
    HRESULT hr = context ? context->QueryInterface(IID_PPV_ARGS(&context4)) : E_POINTER;
    if (FAILED(hr) || !m_FenceA11) {
        error = "the capture context cannot signal (" + hresultText(hr) + ")";
        return 0;
    }
    const uint64_t value = m_FenceA.value() + 1;
    hr = context4->Signal(m_FenceA11.Get(), value);
    if (FAILED(hr)) {
        error = "the capture context could not signal fence A (" + hresultText(hr) + ")";
        return 0;
    }
    // The signal only exists for the GPU once it has left the D3D11 runtime.
    context->Flush();
    m_FenceA.announce();
    return value;
}

bool DdaInterop::conversionWaits(ID3D12CommandQueue* queue, uint64_t value, std::string& error)
{
    if (value == 0) return true;
    return m_FenceA.gpuWait(queue, value, error);
}

uint64_t DdaInterop::conversionSignals(ID3D12CommandQueue* queue, std::string& error)
{
    return m_FenceB.signal(queue, error);
}

bool DdaInterop::beforeRelease(ID3D11DeviceContext* context, uint64_t value, DdaSync sync,
                               uint32_t timeoutMs, std::string& error)
{
    if (sync == DdaSync::None || value == 0) return true;
    if (sync == DdaSync::Cpu) return m_FenceB.wait(value, timeoutMs, error) == GpuFence::Wait::Done;

    ComPtr<ID3D11DeviceContext4> context4;
    HRESULT hr = context ? context->QueryInterface(IID_PPV_ARGS(&context4)) : E_POINTER;
    if (FAILED(hr) || !m_FenceB11) {
        error = "the capture context cannot wait (" + hresultText(hr) + ")";
        return false;
    }
    // Queued, not waited: ReleaseFrame's keyed-mutex release lands behind it
    // in the same context, so the compositor writes the surface again only
    // once the conversion has read it.
    hr = context4->Wait(m_FenceB11.Get(), value);
    if (FAILED(hr)) {
        error = "the capture context could not wait for fence B (" + hresultText(hr) + ")";
        return false;
    }
    return true;
}

} // namespace mw::native::d3d12
