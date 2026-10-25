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

#include "encode/windows/NvencApi.h"
#include "encode/windows/NvencConfig.h"
#include "encode/windows/d3d12/IVideoEncoder12.h"
#include "platform/windows/d3d12/D3d12Device.h"

#include <wrl/client.h>

#include <memory>
#include <string>

namespace mw::native::encode {

/// NVENC fed D3D12 pictures (plan pipeline-video-d3d12-v2, C7.2): the RTX's
/// D3D12 route since G1, where D3D12 Video Encode ran three times slower than
/// NVENC on the same silicon.
///
/// The session is configured by NvencConfig, as NvencEncoder's is — the same
/// preset, CBR, floor, wave and DPB, down to the byte (the encoder_configs
/// test holds the two to the same fingerprint). What changes is the handoff:
///
///  - the conversion's output is registered once per resource and mapped per
///    picture; NVENC waits for the conversion's fence ON THE GPU (the D3D12
///    interface synchronises nothing on its own: fences are the contract);
///  - the bitstream lands in a buffer of ours, in system memory, registered as
///    NVENC's output; NVENC signals a fence of ours when it is written, and the
///    CPU waits for that — the picture's one CPU wait, as on the D3D12 chain
///    everywhere, with the chain's deadline (d3d12::kGpuGoneMs): beyond it, the
///    GPU is gone rather than slow, and the chain goes back to D3D11.
///
/// NVENC's own queue has no priority a caller can set; the process's GPU class
/// is what it runs under, as on D3D11. 4:4:4 is not taken: the D3D12
/// conversion writes no AYUV.
class NvencEncoder12 final : public IVideoEncoder12
{
public:
    NvencEncoder12();
    ~NvencEncoder12() override;

    bool init(const std::shared_ptr<d3d12::D3d12Device>& device, Codec codec, int width, int height,
              int fps, int bitrateKbps, bool hdr, bool intraRefresh, const EncoderTuning& tuning,
              std::string& error) override;

    /// The picture's own size, rounded to even: NVENC pads to its blocks
    /// itself, and NV12 wants no odd edge.
    int codedWidth() const override { return (m_Width + 1) & ~1; }
    int codedHeight() const override { return (m_Height + 1) & ~1; }

    bool encode(ID3D12Resource* picture, ID3D12Fence* ready, uint64_t readyValue,
                bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                std::string& error) override;

    bool supportsReferenceInvalidation() const override { return m_RefInvalidation; }
    bool invalidateReference(uint32_t frameNumber, std::string& error) override;

    void releaseOutput() override;
    void stop() override;
    bool setBitrate(int bitrateKbps, std::string& error) override;
    bool intraRefreshEnabled() const override;
    int intraRefreshHorizonFrames() const override;
    std::string describe() const override { return "NVENC (D3D12)"; }

    /// The configuration handed to the driver at init (ConfigFingerprint): the
    /// same value as NvencEncoder's for the same request.
    uint32_t configFingerprint() const { return m_Fingerprint; }

private:
    /// The NVENC structures, kilobytes each, on the heap: a stack frame on
    /// ARM64 stays under four (plan §7), and the picture's input and output
    /// descriptions must outlive the call that locks the bitstream.
    struct Structures;

    bool registerInput(ID3D12Resource* picture, std::string& error);
    bool createOutput(std::string& error);
    void unmapInput();

    const NvencApi* m_Api = nullptr;
    void* m_Encoder = nullptr;
    std::shared_ptr<d3d12::D3d12Device> m_Device;
    std::unique_ptr<Structures> m_S;
    NvencPlan m_Plan;
    uint32_t m_Fingerprint = 0;
    bool m_RefInvalidation = false;
    int m_Invalidations = 0;
    int m_Width = 0;
    int m_Height = 0;

    /// The conversion's output as registered, and its mapping for the picture
    /// being encoded (unmapped once the bitstream is locked, as NVENC asks).
    NV_ENC_REGISTERED_PTR m_Input = nullptr;
    ID3D12Resource* m_InputFor = nullptr;
    NV_ENC_INPUT_PTR m_InputMapped = nullptr;

    /// The bitstream buffer: ours, in system memory, registered and mapped as
    /// NVENC's output for the picture being encoded, until it is released.
    Microsoft::WRL::ComPtr<ID3D12Resource> m_Output;
    uint64_t m_OutputSize = 0;
    NV_ENC_REGISTERED_PTR m_OutputRegistered = nullptr;
    NV_ENC_INPUT_PTR m_OutputMapped = nullptr;
    /// The bitstream read through our own Map, when the lock hands no pointer.
    bool m_OutputCpuMapped = false;
    bool m_OutputLocked = false;
    /// Signalled by NVENC once the bitstream is written.
    d3d12::GpuFence m_Written;
};

} // namespace mw::native::encode
