/*
 * MoonlightWeb — native capture & encoding engine.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

#include "AmfEncoder12.h"

#include "core/Log.h"

#include <core/D3D12AMF.h>

#include <cstdio>

namespace mw::native::encode {

AmfEncoder12::~AmfEncoder12()
{
    stop();
}

bool AmfEncoder12::init(const std::shared_ptr<d3d12::D3d12Device>& device, Codec codec, int width,
                        int height, int fps, int bitrateKbps, bool hdr, bool intraRefresh,
                        const EncoderTuning& tuning, std::string& error)
{
    stop();

    m_Api = AmfApi::instance();
    if (!m_Api->available()) {
        error = m_Api->unavailableReason();
        return false;
    }
    if (!device || width <= 0 || height <= 0) {
        error = "invalid encoder parameters";
        return false;
    }
    error = amfRefusal(false, hdr);
    if (!error.empty()) return false;

    m_Device = device;
    m_Codec = codec;
    m_Width = width;
    m_Height = height;
    AmfRequest request;
    request.codec = codec;
    request.width = width;
    request.height = height;
    request.fps = fps;
    request.bitrateKbps = bitrateKbps;
    request.intraRefresh = intraRefresh;
    request.tuning = tuning;

    // The bridge, the handoff fence and its event before AMF: a device that
    // refuses them refuses the route as well as AMF would.
    ID3D12Device* d = m_Device->device();
    if (!m_Device->createQueue(d3d12::queueRequestFor(D3D12_COMMAND_LIST_TYPE_DIRECT, tuning,
                                                      L"MoonlightWeb AMF handoff"),
                               m_Bridge, error)) {
        stop();
        return false;
    }
    HRESULT h =
        d->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&m_Allocator));
    if (SUCCEEDED(h))
        h = d->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, m_Allocator.Get(), nullptr,
                                 IID_PPV_ARGS(&m_List));
    if (SUCCEEDED(h)) h = m_List->Close();
    if (SUCCEEDED(h)) h = d->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_Handoff));
    m_Event = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (FAILED(h) || !m_Event) {
        error = "the AMF handoff could not be made (" + d3d12::hresultText(h) + ")";
        stop();
        return false;
    }
    m_HandoffValue = 0;

    AMF_RESULT result = m_Api->factory()->CreateContext(&m_Context);
    if (result != AMF_OK || !m_Context) {
        error = std::string("could not create an AMF context: ") + AmfApi::resultToString(result);
        stop();
        return false;
    }
    m_Context2 = amf::AMFContext2Ptr(m_Context);
    result = m_Context2 ? m_Context2->InitDX12(d, amf::AMF_DX12) : AMF_NO_INTERFACE;
    if (result != AMF_OK) {
        error = std::string("AMF takes no D3D12 device here: ") + AmfApi::resultToString(result);
        stop();
        return false;
    }
    result = m_Api->factory()->CreateComponent(m_Context, amfComponentFor(codec), &m_Encoder);
    if (result != AMF_OK || !m_Encoder) {
        error = std::string("this GPU has no ") + toString(codec) +
                " encoder: " + AmfApi::resultToString(result);
        stop();
        return false;
    }
    configureAmf(m_Encoder, request, m_Setup);
    result = m_Encoder->Init(amf::AMF_SURFACE_NV12, width, height);
    if (result != AMF_OK) {
        error = std::string("the AMD encoder refuses a D3D12 context: ") +
                AmfApi::resultToString(result);
        stop();
        return false;
    }

    m_Frames.reset(codec, amfGrantedSlots(m_Encoder, request, m_Setup));
    m_Fingerprint = amfFingerprint(m_Encoder, codec);
    m_StateLogged = false;
    log::info("[native] AMF (D3D12) ready: " +
              amfReadyDetails(m_Encoder, request, m_Setup, m_Frames.slots(), m_Fingerprint) +
              ", handoff on the " + m_Bridge.description);
    return true;
}

bool AmfEncoder12::waitHandoff(uint64_t value, std::string& error)
{
    if (m_Handoff->GetCompletedValue() >= value) return true;
    if (FAILED(m_Handoff->SetEventOnCompletion(value, m_Event)) ||
        ::WaitForSingleObject(m_Event, d3d12::kGpuGoneMs) != WAIT_OBJECT_0) {
        std::string reason;
        error = "AMF never let go of the picture" +
                (m_Device->removed(reason)
                     ? " (the device is gone: " + reason + ")"
                     : std::string(" within ") + std::to_string(d3d12::kGpuGoneMs) + " ms");
        return false;
    }
    return true;
}

bool AmfEncoder12::restoreCommon(ID3D12Resource* picture, UINT state, uint64_t after,
                                 std::string& error)
{
    // The last restore's list must be done before its allocator is reset: it
    // is, the conversion that followed it having waited for it — the CPU
    // waits here only if a picture went back to the encoder unconverted.
    if (m_LastRestore && !waitHandoff(m_LastRestore, error)) return false;
    HRESULT h = m_Allocator->Reset();
    if (SUCCEEDED(h)) h = m_List->Reset(m_Allocator.Get(), nullptr);
    if (FAILED(h)) {
        error = "the handoff's list could not be reset (" + d3d12::hresultText(h) + ")";
        return false;
    }
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = picture;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    b.Transition.StateBefore = static_cast<D3D12_RESOURCE_STATES>(state);
    b.Transition.StateAfter = D3D12_RESOURCE_STATE_COMMON;
    m_List->ResourceBarrier(1, &b);
    h = m_List->Close();
    if (FAILED(h)) {
        error = "the handoff's list did not close (" + d3d12::hresultText(h) + ")";
        return false;
    }
    // After AMF's own value, on the GPU: nothing on the CPU waits for it.
    h = m_Bridge.queue->Wait(m_Handoff.Get(), after);
    if (FAILED(h)) {
        error = "the wait for AMF's release was refused (" + d3d12::hresultText(h) + ")";
        return false;
    }
    ID3D12CommandList* lists[] = {m_List.Get()};
    m_Bridge.queue->ExecuteCommandLists(1, lists);
    const uint64_t done = ++m_HandoffValue;
    h = m_Bridge.queue->Signal(m_Handoff.Get(), done);
    if (FAILED(h)) {
        error = "the handoff fence was refused (" + d3d12::hresultText(h) + ")";
        return false;
    }
    m_LastRestore = done;
    m_ReleaseValue = done;
    const UINT common = D3D12_RESOURCE_STATE_COMMON;
    picture->SetPrivateData(AMFResourceStateGUID, sizeof(common), &common);
    return true;
}

bool AmfEncoder12::encode(ID3D12Resource* picture, ID3D12Fence* ready, uint64_t readyValue,
                          bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                          std::string& error)
{
    if (!m_Encoder || !m_Context2 || !m_Handoff) {
        error = "the encoder is not initialized";
        return false;
    }
    if (m_Output) {
        error = "the previous frame was not released";
        return false;
    }
    if (!picture) {
        error = "no picture to encode";
        return false;
    }

    // The bridge: our fence moves once the conversion's has, on the GPU.
    HRESULT h = ready ? m_Bridge.queue->Wait(ready, readyValue) : S_OK;
    const uint64_t handed = ++m_HandoffValue;
    if (SUCCEEDED(h)) h = m_Bridge.queue->Signal(m_Handoff.Get(), handed);
    if (FAILED(h)) {
        error = "the handoff to AMF was refused (" + d3d12::hresultText(h) + ")";
        return false;
    }
    // What AMF reads off the resource (core/D3D12AMF.h): its state, the fence,
    // and the value on that fence to wait for.
    const UINT common = D3D12_RESOURCE_STATE_COMMON;
    picture->SetPrivateData(AMFResourceStateGUID, sizeof(common), &common);
    picture->SetPrivateDataInterface(AMFFenceGUID, m_Handoff.Get());
    m_Handoff->SetPrivateData(AMFFenceValueGUID, sizeof(handed), &handed);

    amf::AMFSurfacePtr input;
    AMF_RESULT result = m_Context2->CreateSurfaceFromDX12Native(picture, &input, nullptr);
    if (result != AMF_OK || !input) {
        error = std::string("could not wrap the D3D12 picture: ") + AmfApi::resultToString(result);
        return false;
    }
    if (!m_Frames.encode(m_Encoder, input, forceKeyframe, frameNumber, m_Output, out, error))
        return false;
    input = nullptr;

    // AMF has said, on the fence, the value it signals once done with the
    // picture: the next write of it waits for that, on the GPU.
    UINT64 released = handed;
    UINT size = sizeof(released);
    if (SUCCEEDED(m_Handoff->GetPrivateData(AMFFenceValueGUID, &size, &released)) &&
        released > m_HandoffValue)
        m_HandoffValue = released;
    m_ReleaseValue = m_HandoffValue;
    // And the state it left the picture in: the conversion expects COMMON.
    UINT state = common;
    size = sizeof(state);
    if (SUCCEEDED(picture->GetPrivateData(AMFResourceStateGUID, &size, &state)) &&
        state != common) {
        if (!m_StateLogged) {
            m_StateLogged = true;
            char hex[16];
            std::snprintf(hex, sizeof(hex), "0x%x", state);
            log::info(std::string("[native] AMF (D3D12) leaves the picture in state ") + hex +
                      " — put back in COMMON on the GPU before the next conversion");
        }
        if (!restoreCommon(picture, state, m_ReleaseValue, error)) {
            m_Output = nullptr;
            return false;
        }
    }
    return true;
}

bool AmfEncoder12::invalidateReference(uint32_t frameNumber, std::string& error)
{
    if (!m_Encoder) {
        error = "the encoder is not initialized";
        return false;
    }
    return m_Frames.invalidate(frameNumber, error);
}

bool AmfEncoder12::setBitrate(int bitrateKbps, std::string& error)
{
    if (!m_Encoder || bitrateKbps <= 0) {
        error = "the encoder is not initialized";
        return false;
    }
    retargetAmf(m_Encoder, m_Codec, m_Setup, bitrateKbps);
    return true;
}

void AmfEncoder12::stop()
{
    m_Output = nullptr;
    if (m_Encoder) {
        m_Encoder->Terminate();
        m_Encoder = nullptr;
    }
    m_Context2 = nullptr;
    if (m_Context) {
        m_Context->Terminate();
        m_Context = nullptr;
    }
    // Nothing of the bridge's may still be in flight when its objects go.
    if (m_Bridge.queue && m_Handoff && m_Event) {
        const uint64_t idle = ++m_HandoffValue;
        if (SUCCEEDED(m_Bridge.queue->Signal(m_Handoff.Get(), idle))) {
            std::string ignored;
            waitHandoff(idle, ignored);
        }
    }
    m_List.Reset();
    m_Allocator.Reset();
    m_Handoff.Reset();
    m_Bridge = d3d12::Queue{};
    if (m_Event) {
        ::CloseHandle(m_Event);
        m_Event = nullptr;
    }
    m_HandoffValue = 0;
    m_ReleaseValue = 0;
    m_LastRestore = 0;
    m_Device.reset();
}

} // namespace mw::native::encode
