/*
 * MoonlightWeb — native capture & encoding engine.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

#pragma once

#include "encode/windows/AmfApi.h"
#include "encode/windows/AmfConfig.h"
#include "encode/windows/d3d12/IVideoEncoder12.h"
#include "platform/windows/d3d12/D3d12Device.h"

#include <wrl/client.h>

#include <memory>
#include <string>

namespace mw::native::encode {

/// AMF fed D3D12 pictures (plan pipeline-video-d3d12-v2, C7.4): the AMD
/// iGPU's candidate for its D3D12 route, which G4 weighs against D3D12 Video
/// Encode (5.65 ms against 9.0 at rest in the probe of 26/09).
///
/// Configured by AmfConfig as AmfEncoder is — the encoder_configs test holds
/// the two to the same fingerprint — and fed per picture by AmfFrames, long-term
/// reference repair included. What differs is the context (InitDX12) and the
/// handoff, which AMF's D3D12 interface asks as private data on the resource
/// (core/D3D12AMF.h): the state it is in, a fence, and the value on that fence
/// to wait for. AMF waits for that value, reads, and signals a later one — on
/// the SAME fence — before saying so in the same private data.
///
/// So AMF is never handed the conversion's fence, whose counter the chain
/// owns: a fence of this class's own carries the handoff, and a small queue on
/// the GPU bridges the two — it waits for the conversion's value and signals
/// the next on ours. Nothing waits on the CPU but for the bitstream
/// (QueryOutput). AMF leaves the picture in COPY_SOURCE (it copies it in,
/// measured on the DualRTX iGPU): the bridge puts it back in the COMMON the
/// conversion expects once AMF's own value is reached, on the GPU, and the
/// next conversion waits for that (inputReleased) — the bitstream goes out
/// without waiting for any of it.
class AmfEncoder12 final : public IVideoEncoder12
{
public:
    AmfEncoder12() = default;
    ~AmfEncoder12() override;

    bool init(const std::shared_ptr<d3d12::D3d12Device>& device, Codec codec, int width, int height,
              int fps, int bitrateKbps, bool hdr, bool intraRefresh, const EncoderTuning& tuning,
              std::string& error) override;

    /// The picture's own size, rounded to even: AMF pads to its blocks itself.
    int codedWidth() const override { return (m_Width + 1) & ~1; }
    int codedHeight() const override { return (m_Height + 1) & ~1; }

    bool encode(ID3D12Resource* picture, ID3D12Fence* ready, uint64_t readyValue,
                bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                std::string& error) override;

    bool supportsReferenceInvalidation() const override { return m_Frames.enabled(); }
    bool invalidateReference(uint32_t frameNumber, std::string& error) override;

    /// Where the next write of the picture waits: AMF done with it, and back
    /// in COMMON.
    ID3D12Fence* inputReleased(uint64_t& value) const override
    {
        value = m_ReleaseValue;
        return m_Handoff.Get();
    }

    void releaseOutput() override { m_Output = nullptr; }
    void stop() override;
    bool setBitrate(int bitrateKbps, std::string& error) override;
    bool intraRefreshEnabled() const override { return m_Setup.intraRefresh; }
    std::string describe() const override { return "AMF (D3D12)"; }

    /// The configuration the encoder holds after Init (ConfigFingerprint): the
    /// same value as AmfEncoder's for the same request.
    uint32_t configFingerprint() const { return m_Fingerprint; }

private:
    /// The CPU waits until the handoff fence reaches @p value, the chain's
    /// deadline at most.
    bool waitHandoff(uint64_t value, std::string& error);
    /// A barrier putting @p picture back in COMMON from @p state, on the
    /// bridge queue once the handoff fence reaches @p after (AMF done with
    /// it); the next write waits for it on the GPU (inputReleased).
    bool restoreCommon(ID3D12Resource* picture, UINT state, uint64_t after, std::string& error);

    const AmfApi* m_Api = nullptr;
    std::shared_ptr<d3d12::D3d12Device> m_Device;
    amf::AMFContextPtr m_Context;
    amf::AMFContext2Ptr m_Context2;
    amf::AMFComponentPtr m_Encoder;
    amf::AMFBufferPtr m_Output;

    Codec m_Codec = Codec::H264;
    int m_Width = 0;
    int m_Height = 0;
    AmfSetup m_Setup;
    AmfFrames m_Frames;
    uint32_t m_Fingerprint = 0;

    /// The bridge: waits for the conversion's fence, signals ours.
    d3d12::Queue m_Bridge;
    Microsoft::WRL::ComPtr<ID3D12CommandAllocator> m_Allocator;
    Microsoft::WRL::ComPtr<ID3D12GraphicsCommandList> m_List;
    /// The handoff fence AMF waits on and signals, and where its counter
    /// stands — ours and AMF's alike.
    Microsoft::WRL::ComPtr<ID3D12Fence> m_Handoff;
    uint64_t m_HandoffValue = 0;
    /// The value the next write of the picture waits for (inputReleased).
    uint64_t m_ReleaseValue = 0;
    /// The last restore's value: its list's allocator is reset past it.
    uint64_t m_LastRestore = 0;
    HANDLE m_Event = nullptr;
    /// The state AMF left a picture in, said once when it is not COMMON.
    bool m_StateLogged = false;
};

} // namespace mw::native::encode
