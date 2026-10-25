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

#include "NvencEncoder.h"

#include "../../core/Log.h"

#include <memory>

namespace mw::native::encode {

NvencEncoder::~NvencEncoder()
{
    stop();
}

bool NvencEncoder::init(ID3D11Device* device, Codec codec, int width, int height, int fps,
                        int bitrateKbps, bool yuv444, bool hdr, bool intraRefresh,
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
    request.yuv444 = yuv444;
    request.hdr = hdr;
    request.intraRefresh = intraRefresh;
    request.tuning = tuning;
    error = nvencRefusal(request);
    if (!error.empty()) return false;

    m_Width = width;
    m_Height = height;

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    open.device = device;
    open.apiVersion = NVENCAPI_VERSION;

    NVENCSTATUS status = m_Api->fn().nvEncOpenEncodeSessionEx(&open, &m_Encoder);
    if (status != NV_ENC_SUCCESS || !m_Encoder) {
        error =
            std::string("could not open an encode session: ") + NvencApi::statusToString(status);
        m_Encoder = nullptr;
        return false;
    }

    // The driver's own preset first (NvencConfig says why), on the heap: the
    // structure is five kilobytes.
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
    m_Config = shipped->presetCfg;
    log::info(nvencPresetLine(preset, m_Config));

    // Whether the driver can drop a frame from the DPB when the receiver
    // names it lost — the DPB the configuration sizes for it (NvencConfig).
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

    if (!buildNvencConfig(request, preset, m_Config, m_InitParams, m_Plan, error)) {
        stop();
        return false;
    }
    m_Fingerprint = nvencFingerprint(m_InitParams, m_Config);

    status = m_Api->fn().nvEncInitializeEncoder(m_Encoder, &m_InitParams);
    if (status != NV_ENC_SUCCESS) {
        error =
            std::string("could not initialize the encoder: ") + NvencApi::statusToString(status);
        stop();
        return false;
    }

    NV_ENC_CREATE_BITSTREAM_BUFFER buffer = {};
    buffer.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    status = m_Api->fn().nvEncCreateBitstreamBuffer(m_Encoder, &buffer);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not create the bitstream buffer: ") +
                NvencApi::statusToString(status);
        stop();
        return false;
    }
    m_Bitstream = buffer.bitstreamBuffer;

    log::info("[native] NVENC ready: " + nvencReadyDetails(request, preset, m_Config, m_Plan,
                                                           m_RefInvalidation, m_Fingerprint));
    return true;
}

bool NvencEncoder::invalidateReference(uint32_t frameNumber, std::string& error)
{
    if (!m_Encoder) {
        error = "the encoder is not initialized";
        return false;
    }
    if (!m_RefInvalidation) {
        error = "this NVENC does not support reference invalidation";
        return false;
    }
    // The picture was stamped with its frame number at encode(); that stamp is
    // how the driver finds it in the DPB. A frame already out of the DPB is
    // not an error: nothing references it any more.
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

bool NvencEncoder::registerInput(ID3D11Texture2D* texture, std::string& error)
{
    if (m_Registered && m_RegisteredFor == texture) return true;

    if (m_Registered) {
        m_Api->fn().nvEncUnregisterResource(m_Encoder, m_Registered);
        m_Registered = nullptr;
        m_RegisteredFor = nullptr;
    }

    NV_ENC_REGISTER_RESOURCE resource = {};
    resource.version = NV_ENC_REGISTER_RESOURCE_VER;
    resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    resource.width = static_cast<uint32_t>(m_Width);
    resource.height = static_cast<uint32_t>(m_Height);
    resource.resourceToRegister = texture;
    resource.bufferFormat = m_Plan.bufferFormat;
    resource.bufferUsage = NV_ENC_INPUT_IMAGE;

    // This is the zero-copy step: NVENC takes the D3D11 texture the conversion
    // pass wrote, on the same adapter, with no staging buffer and no trip
    // through system memory.
    const NVENCSTATUS status = m_Api->fn().nvEncRegisterResource(m_Encoder, &resource);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not register the input surface: ") +
                NvencApi::statusToString(status);
        return false;
    }

    m_Registered = resource.registeredResource;
    m_RegisteredFor = texture;
    return true;
}

bool NvencEncoder::encode(ID3D11Texture2D* nv12, bool forceKeyframe, uint32_t frameNumber,
                          EncoderOutput& out, std::string& error)
{
    if (!m_Encoder || !m_Bitstream) {
        error = "the encoder is not initialized";
        return false;
    }
    if (m_OutputLocked) {
        // The previous frame's buffer is still handed out. Encoding over it
        // would corrupt what the caller is sending.
        error = "the previous frame was not released";
        return false;
    }
    if (!registerInput(nv12, error)) return false;

    NV_ENC_MAP_INPUT_RESOURCE mapped = {};
    mapped.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mapped.registeredResource = m_Registered;
    NVENCSTATUS status = m_Api->fn().nvEncMapInputResource(m_Encoder, &mapped);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not map the input surface: ") + NvencApi::statusToString(status);
        return false;
    }

    NV_ENC_PIC_PARAMS pic = {};
    pic.version = NV_ENC_PIC_PARAMS_VER;
    pic.inputBuffer = mapped.mappedResource;
    pic.bufferFmt = mapped.mappedBufferFmt;
    pic.inputWidth = static_cast<uint32_t>(m_Width);
    pic.inputHeight = static_cast<uint32_t>(m_Height);
    pic.outputBitstream = m_Bitstream;
    pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    // The frame's own number, not a private counter: it is the name the
    // receiver will use to say "this one never came" (invalidateReference).
    pic.inputTimeStamp = frameNumber;
    if (forceKeyframe)
        pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;

    status = m_Api->fn().nvEncEncodePicture(m_Encoder, &pic);
    // Unmap as soon as the encoder has consumed the surface: holding the map
    // would block the conversion pass from writing the next frame into it.
    m_Api->fn().nvEncUnmapInputResource(m_Encoder, mapped.mappedResource);

    if (status != NV_ENC_SUCCESS) {
        error = std::string("encode failed: ") + NvencApi::statusToString(status);
        return false;
    }

    NV_ENC_LOCK_BITSTREAM lock = {};
    lock.version = NV_ENC_LOCK_BITSTREAM_VER;
    lock.outputBitstream = m_Bitstream;
    // Blocking: in a synchronous session this is where the wait for the encoder
    // happens, and waiting here is exactly right — there is nothing else this
    // thread could usefully do with a frame half-encoded.
    lock.doNotWait = 0;

    status = m_Api->fn().nvEncLockBitstream(m_Encoder, &lock);
    if (status != NV_ENC_SUCCESS) {
        error =
            std::string("could not read the encoded frame: ") + NvencApi::statusToString(status);
        return false;
    }

    m_OutputLocked = true;
    out.data = static_cast<const uint8_t*>(lock.bitstreamBufferPtr);
    out.size = lock.bitstreamSizeInBytes;
    out.keyframe = lock.pictureType == NV_ENC_PIC_TYPE_IDR || lock.pictureType == NV_ENC_PIC_TYPE_I;
    out.avgQp = static_cast<int>(lock.frameAvgQP);
    return true;
}

void NvencEncoder::releaseOutput()
{
    if (!m_OutputLocked) return;
    m_Api->fn().nvEncUnlockBitstream(m_Encoder, m_Bitstream);
    m_OutputLocked = false;
}

bool NvencEncoder::setBitrate(int bitrateKbps, std::string& error)
{
    if (!m_Encoder || bitrateKbps <= 0) {
        error = "the encoder is not initialized";
        return false;
    }

    NV_ENC_RECONFIGURE_PARAMS reconfigure = {};
    reconfigure.version = NV_ENC_RECONFIGURE_PARAMS_VER;

    retargetNvencConfig(m_Config, m_Plan, bitrateKbps);
    reconfigure.reInitEncodeParams = m_InitParams;
    reconfigure.reInitEncodeParams.encodeConfig = &m_Config;

    const NVENCSTATUS status = m_Api->fn().nvEncReconfigureEncoder(m_Encoder, &reconfigure);
    if (status != NV_ENC_SUCCESS) {
        error = std::string("could not change the bitrate: ") + NvencApi::statusToString(status);
        return false;
    }
    return true;
}

void NvencEncoder::stop()
{
    if (!m_Encoder || !m_Api) {
        m_Encoder = nullptr;
        return;
    }

    releaseOutput();

    if (m_Registered) {
        m_Api->fn().nvEncUnregisterResource(m_Encoder, m_Registered);
        m_Registered = nullptr;
        m_RegisteredFor = nullptr;
    }
    if (m_Bitstream) {
        m_Api->fn().nvEncDestroyBitstreamBuffer(m_Encoder, m_Bitstream);
        m_Bitstream = nullptr;
    }

    m_Api->fn().nvEncDestroyEncoder(m_Encoder);
    m_Encoder = nullptr;
    if (m_Invalidations > 0)
        log::info("[native] NVENC: " + std::to_string(m_Invalidations) +
                  " reference invalidation(s) this session");
    m_Invalidations = 0;
}

} // namespace mw::native::encode
