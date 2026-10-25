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

#include "NvencEncoder12.h"

#include "core/Log.h"

#include <algorithm>
#include <cstring>

namespace mw::native::encode {

struct NvencEncoder12::Structures
{
    NV_ENC_CONFIG config;
    NV_ENC_INITIALIZE_PARAMS init;
    NV_ENC_PIC_PARAMS pic;
    NV_ENC_INPUT_RESOURCE_D3D12 input;
    NV_ENC_OUTPUT_RESOURCE_D3D12 output;
    NV_ENC_LOCK_BITSTREAM lock;
};

NvencEncoder12::NvencEncoder12()
    : m_S(std::make_unique<Structures>())
{}

NvencEncoder12::~NvencEncoder12()
{
    stop();
}

bool NvencEncoder12::init(const std::shared_ptr<d3d12::D3d12Device>& device, Codec codec, int width,
                          int height, int fps, int bitrateKbps, bool hdr, bool intraRefresh,
                          const EncoderTuning& tuning, std::string& error)
{
    stop();

    m_Api = NvencApi::instance();
    if (!m_Api->available()) {
        error = m_Api->unavailableReason();
        return false;
    }
    if (!device || width <= 0 || height <= 0) {
        error = "invalid encoder parameters";
        return false;
    }
    NvencRequest request;
    request.codec = codec;
    request.width = width;
    request.height = height;
    request.fps = fps;
    request.bitrateKbps = bitrateKbps;
    request.hdr = hdr;
    request.intraRefresh = intraRefresh;
    request.tuning = tuning;
    error = nvencRefusal(request);
    if (!error.empty()) return false;

    m_Device = device;
    m_Width = width;
    m_Height = height;
    std::memset(m_S.get(), 0, sizeof(Structures));

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    open.device = m_Device->device();
    open.apiVersion = NVENCAPI_VERSION;
    NVENCSTATUS status = m_Api->fn().nvEncOpenEncodeSessionEx(&open, &m_Encoder);
    if (status != NV_ENC_SUCCESS || !m_Encoder) {
        error = std::string("could not open an encode session on the D3D12 device: ") +
                NvencApi::statusToString(status);
        m_Encoder = nullptr;
        stop();
        return false;
    }

    // The same preset as the D3D11 encoder, fetched the same way (NvencConfig).
    const NvencPreset preset = nvencPresetFor(tuning);
    auto shipped = std::make_unique<NV_ENC_PRESET_CONFIG>();
    shipped->version = NV_ENC_PRESET_CONFIG_VER;
    shipped->presetCfg.version = NV_ENC_CONFIG_VER;
    status = m_Api->fn().nvEncGetEncodePresetConfigEx(m_Encoder, nvencCodecGuid(codec), preset.guid,
                                                      preset.tuningInfo, shipped.get());
    if (status != NV_ENC_SUCCESS) {
        error =
            std::string("could not read the encoder preset: ") + NvencApi::statusToString(status);
        stop();
        return false;
    }
    m_S->config = shipped->presetCfg;
    log::info(nvencPresetLine(preset, m_S->config));

    m_RefInvalidation = false;
    {
        NV_ENC_CAPS_PARAM capParam = {};
        capParam.version = NV_ENC_CAPS_PARAM_VER;
        capParam.capsToQuery = NV_ENC_CAPS_SUPPORT_REF_PIC_INVALIDATION;
        int capValue = 0;
        if (m_Api->fn().nvEncGetEncodeCaps(m_Encoder, nvencCodecGuid(codec), &capParam,
                                           &capValue) == NV_ENC_SUCCESS &&
            capValue != 0)
            m_RefInvalidation = true;
    }

    if (!buildNvencConfig(request, preset, m_S->config, m_S->init, m_Plan, error)) {
        stop();
        return false;
    }
    m_Fingerprint = nvencFingerprint(m_S->init, m_S->config);
    // The D3D12 interface is told the input's format once, at init; the D3D11
    // one reads it from each registered surface.
    m_S->init.bufferFormat = m_Plan.bufferFormat;

    status = m_Api->fn().nvEncInitializeEncoder(m_Encoder, &m_S->init);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not initialize the encoder on D3D12: ") +
                NvencApi::statusToString(status);
        stop();
        return false;
    }
    if (!createOutput(error) || !m_Written.create(m_Device->device(), false, error)) {
        stop();
        return false;
    }

    log::info(
        "[native] NVENC (D3D12) ready: " +
        nvencReadyDetails(request, preset, m_S->config, m_Plan, m_RefInvalidation, m_Fingerprint) +
        ", bitstream buffer " + std::to_string(m_OutputSize >> 20) + " MB");
    return true;
}

bool NvencEncoder12::createOutput(std::string& error)
{
    // Room for any picture the session can make: its raw size, which no coded
    // picture comes near, and never under 4 MB.
    const bool tenBit = m_Plan.bufferFormat == NV_ENC_BUFFER_FORMAT_YUV420_10BIT;
    const uint64_t pixels = static_cast<uint64_t>(m_Width) * static_cast<uint64_t>(m_Height);
    m_OutputSize = std::max<uint64_t>(tenBit ? pixels * 3 : pixels * 3 / 2, 4ull << 20);

    D3D12_HEAP_PROPERTIES heap = {};
    heap.Type = D3D12_HEAP_TYPE_READBACK;
    D3D12_RESOURCE_DESC desc = {};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    desc.Width = m_OutputSize;
    desc.Height = 1;
    desc.DepthOrArraySize = 1;
    desc.MipLevels = 1;
    desc.Format = DXGI_FORMAT_UNKNOWN;
    desc.SampleDesc.Count = 1;
    desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    const HRESULT h = m_Device->device()->CreateCommittedResource(
        &heap, D3D12_HEAP_FLAG_NONE, &desc, D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
        IID_PPV_ARGS(&m_Output));
    if (FAILED(h)) {
        error = "the bitstream buffer was refused (" + d3d12::hresultText(h) + ")";
        return false;
    }

    NV_ENC_REGISTER_RESOURCE reg = {};
    reg.version = NV_ENC_REGISTER_RESOURCE_VER;
    reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    reg.width = static_cast<uint32_t>(m_OutputSize);
    reg.height = 1;
    reg.resourceToRegister = m_Output.Get();
    reg.bufferFormat = NV_ENC_BUFFER_FORMAT_U8;
    reg.bufferUsage = NV_ENC_OUTPUT_BITSTREAM;
    const NVENCSTATUS status = m_Api->fn().nvEncRegisterResource(m_Encoder, &reg);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not register the bitstream buffer: ") +
                NvencApi::statusToString(status);
        return false;
    }
    m_OutputRegistered = reg.registeredResource;
    return true;
}

bool NvencEncoder12::registerInput(ID3D12Resource* picture, std::string& error)
{
    // Once per resource: the conversion writes the same one all session.
    if (m_Input && m_InputFor == picture) return true;
    if (m_Input) {
        m_Api->fn().nvEncUnregisterResource(m_Encoder, m_Input);
        m_Input = nullptr;
        m_InputFor = nullptr;
    }
    NV_ENC_REGISTER_RESOURCE reg = {};
    reg.version = NV_ENC_REGISTER_RESOURCE_VER;
    reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    reg.width = static_cast<uint32_t>(m_Width);
    reg.height = static_cast<uint32_t>(m_Height);
    reg.resourceToRegister = picture;
    reg.bufferFormat = m_Plan.bufferFormat;
    reg.bufferUsage = NV_ENC_INPUT_IMAGE;
    const NVENCSTATUS status = m_Api->fn().nvEncRegisterResource(m_Encoder, &reg);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not register the conversion's output: ") +
                NvencApi::statusToString(status);
        return false;
    }
    m_Input = reg.registeredResource;
    m_InputFor = picture;
    return true;
}

void NvencEncoder12::unmapInput()
{
    if (!m_InputMapped) return;
    m_Api->fn().nvEncUnmapInputResource(m_Encoder, m_InputMapped);
    m_InputMapped = nullptr;
}

bool NvencEncoder12::encode(ID3D12Resource* picture, ID3D12Fence* ready, uint64_t readyValue,
                            bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                            std::string& error)
{
    if (!m_Encoder || !m_OutputRegistered) {
        error = "the encoder is not initialized";
        return false;
    }
    if (m_OutputLocked) {
        error = "the previous frame was not released";
        return false;
    }
    if (!picture || !registerInput(picture, error)) {
        if (!picture) error = "no picture to encode";
        return false;
    }

    NV_ENC_MAP_INPUT_RESOURCE map = {};
    map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    map.registeredResource = m_Input;
    NVENCSTATUS status = m_Api->fn().nvEncMapInputResource(m_Encoder, &map);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not map the conversion's output: ") +
                NvencApi::statusToString(status);
        return false;
    }
    m_InputMapped = map.mappedResource;
    NV_ENC_MAP_INPUT_RESOURCE mapOut = {};
    mapOut.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mapOut.registeredResource = m_OutputRegistered;
    status = m_Api->fn().nvEncMapInputResource(m_Encoder, &mapOut);
    if (status != NV_ENC_SUCCESS) {
        unmapInput();
        error =
            std::string("could not map the bitstream buffer: ") + NvencApi::statusToString(status);
        return false;
    }
    m_OutputMapped = mapOut.mappedResource;

    Structures& s = *m_S;
    // NVENC waits for the conversion on the GPU, and signals ours once the
    // bitstream is written: the D3D12 interface orders nothing by itself.
    std::memset(&s.input, 0, sizeof(s.input));
    s.input.version = NV_ENC_INPUT_RESOURCE_D3D12_VER;
    s.input.pInputBuffer = m_InputMapped;
    s.input.inputFencePoint.version = NV_ENC_FENCE_POINT_D3D12_VER;
    s.input.inputFencePoint.pFence = ready;
    s.input.inputFencePoint.waitValue = readyValue;
    s.input.inputFencePoint.bWait = ready ? 1u : 0u;
    const uint64_t written = m_Written.announce();
    std::memset(&s.output, 0, sizeof(s.output));
    s.output.version = NV_ENC_OUTPUT_RESOURCE_D3D12_VER;
    s.output.pOutputBuffer = m_OutputMapped;
    s.output.outputFencePoint.version = NV_ENC_FENCE_POINT_D3D12_VER;
    s.output.outputFencePoint.pFence = m_Written.fence();
    s.output.outputFencePoint.signalValue = written;
    s.output.outputFencePoint.bSignal = 1u;

    std::memset(&s.pic, 0, sizeof(s.pic));
    s.pic.version = NV_ENC_PIC_PARAMS_VER;
    s.pic.inputWidth = static_cast<uint32_t>(m_Width);
    s.pic.inputHeight = static_cast<uint32_t>(m_Height);
    s.pic.inputPitch = static_cast<uint32_t>(m_Width);
    s.pic.bufferFmt = m_Plan.bufferFormat;
    s.pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    s.pic.inputBuffer = &s.input;
    s.pic.outputBitstream = &s.output;
    // The frame's own number: the name a receiver gives the one it lost
    // (invalidateReference), as on D3D11.
    s.pic.inputTimeStamp = frameNumber;
    if (forceKeyframe)
        s.pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;

    status = m_Api->fn().nvEncEncodePicture(m_Encoder, &s.pic);
    if (status != NV_ENC_SUCCESS) {
        unmapInput();
        m_Api->fn().nvEncUnmapInputResource(m_Encoder, m_OutputMapped);
        m_OutputMapped = nullptr;
        error = std::string("encode failed: ") + NvencApi::statusToString(status);
        return false;
    }
    // The picture's one CPU wait, with the chain's deadline: past it the GPU
    // is gone, not slow, and the chain goes back to D3D11.
    std::string why;
    if (m_Written.wait(written, d3d12::kGpuGoneMs, why) != d3d12::GpuFence::Wait::Done) {
        error = "NVENC did not write the picture: " + why;
        return false;
    }

    std::memset(&s.lock, 0, sizeof(s.lock));
    s.lock.version = NV_ENC_LOCK_BITSTREAM_VER;
    s.lock.outputBitstream = &s.output;
    s.lock.doNotWait = 0;
    status = m_Api->fn().nvEncLockBitstream(m_Encoder, &s.lock);
    // The input is NVENC's until the bitstream is locked, then ours again.
    unmapInput();
    if (status != NV_ENC_SUCCESS) {
        m_Api->fn().nvEncUnmapInputResource(m_Encoder, m_OutputMapped);
        m_OutputMapped = nullptr;
        error =
            std::string("could not read the encoded frame: ") + NvencApi::statusToString(status);
        return false;
    }
    m_OutputLocked = true;
    const auto* data = static_cast<const uint8_t*>(s.lock.bitstreamBufferPtr);
    if (!data) {
        // A driver that hands no pointer: the buffer is ours, read in place.
        void* cpu = nullptr;
        const D3D12_RANGE range = {0, s.lock.bitstreamSizeInBytes};
        const HRESULT h = m_Output->Map(0, &range, &cpu);
        if (FAILED(h)) {
            releaseOutput();
            error = "the bitstream buffer could not be read (" + d3d12::hresultText(h) + ")";
            return false;
        }
        m_OutputCpuMapped = true;
        data = static_cast<const uint8_t*>(cpu);
    }
    out.data = data;
    out.size = s.lock.bitstreamSizeInBytes;
    out.keyframe =
        s.lock.pictureType == NV_ENC_PIC_TYPE_IDR || s.lock.pictureType == NV_ENC_PIC_TYPE_I;
    out.avgQp = static_cast<int>(s.lock.frameAvgQP);
    return true;
}

void NvencEncoder12::releaseOutput()
{
    if (!m_OutputLocked) return;
    if (m_OutputCpuMapped) {
        const D3D12_RANGE none = {0, 0};
        m_Output->Unmap(0, &none);
        m_OutputCpuMapped = false;
    }
    m_Api->fn().nvEncUnlockBitstream(m_Encoder, &m_S->output);
    if (m_OutputMapped) {
        m_Api->fn().nvEncUnmapInputResource(m_Encoder, m_OutputMapped);
        m_OutputMapped = nullptr;
    }
    m_OutputLocked = false;
}

bool NvencEncoder12::invalidateReference(uint32_t frameNumber, std::string& error)
{
    if (!m_Encoder) {
        error = "the encoder is not initialized";
        return false;
    }
    if (!m_RefInvalidation) {
        error = "this NVENC does not support reference invalidation";
        return false;
    }
    const NVENCSTATUS status =
        m_Api->fn().nvEncInvalidateRefFrames(m_Encoder, static_cast<uint64_t>(frameNumber));
    if (status != NV_ENC_SUCCESS) {
        error =
            std::string("could not invalidate the reference: ") + NvencApi::statusToString(status);
        return false;
    }
    m_Invalidations++;
    return true;
}

bool NvencEncoder12::setBitrate(int bitrateKbps, std::string& error)
{
    if (!m_Encoder || bitrateKbps <= 0) {
        error = "the encoder is not initialized";
        return false;
    }
    NV_ENC_RECONFIGURE_PARAMS reconfigure = {};
    reconfigure.version = NV_ENC_RECONFIGURE_PARAMS_VER;
    retargetNvencConfig(m_S->config, m_Plan, bitrateKbps);
    reconfigure.reInitEncodeParams = m_S->init;
    reconfigure.reInitEncodeParams.encodeConfig = &m_S->config;
    const NVENCSTATUS status = m_Api->fn().nvEncReconfigureEncoder(m_Encoder, &reconfigure);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not change the bitrate: ") + NvencApi::statusToString(status);
        return false;
    }
    return true;
}

bool NvencEncoder12::intraRefreshEnabled() const
{
    return m_Plan.intraRefresh;
}

int NvencEncoder12::intraRefreshHorizonFrames() const
{
    return m_Plan.intraRefresh ? m_Plan.intraRefreshHorizon : 0;
}

void NvencEncoder12::stop()
{
    if (m_Encoder && m_Api) {
        releaseOutput();
        unmapInput();
        if (m_OutputMapped) {
            m_Api->fn().nvEncUnmapInputResource(m_Encoder, m_OutputMapped);
            m_OutputMapped = nullptr;
        }
        if (m_Input) m_Api->fn().nvEncUnregisterResource(m_Encoder, m_Input);
        if (m_OutputRegistered) m_Api->fn().nvEncUnregisterResource(m_Encoder, m_OutputRegistered);
        m_Api->fn().nvEncDestroyEncoder(m_Encoder);
        if (m_Invalidations > 0)
            log::info("[native] NVENC (D3D12): " + std::to_string(m_Invalidations) +
                      " reference invalidation(s) this session");
    }
    m_Encoder = nullptr;
    m_Input = nullptr;
    m_InputFor = nullptr;
    m_InputMapped = nullptr;
    m_OutputRegistered = nullptr;
    m_OutputMapped = nullptr;
    m_OutputCpuMapped = false;
    m_OutputLocked = false;
    m_Output.Reset();
    m_OutputSize = 0;
    m_Written.reset();
    m_Device.reset();
    m_Invalidations = 0;
}

} // namespace mw::native::encode
