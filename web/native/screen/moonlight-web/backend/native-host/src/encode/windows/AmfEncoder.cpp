/*
 * MoonlightWeb — native capture & encoding engine.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

#include "AmfEncoder.h"

#include "../../core/Log.h"

namespace mw::native::encode {

AmfEncoder::~AmfEncoder()
{
    stop();
}

bool AmfEncoder::init(ID3D11Device* device, Codec codec, int width, int height, int fps,
                      int bitrateKbps, bool yuv444, bool hdr, bool intraRefresh,
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
    error = amfRefusal(yuv444, hdr);
    if (!error.empty()) return false;

    m_Codec = codec;
    AmfRequest request;
    request.codec = codec;
    request.width = width;
    request.height = height;
    request.fps = fps;
    request.bitrateKbps = bitrateKbps;
    request.intraRefresh = intraRefresh;
    request.tuning = tuning;

    AMF_RESULT result = m_Api->factory()->CreateContext(&m_Context);
    if (result != AMF_OK || !m_Context) {
        error = std::string("could not create an AMF context: ") + AmfApi::resultToString(result);
        return false;
    }

    // Bind to the caller's device, which is the adapter that captured the
    // frame. This is what makes the surface hand-off below a zero-copy one.
    result = m_Context->InitDX11(device);
    if (result != AMF_OK) {
        error = std::string("AMF could not use this GPU: ") + AmfApi::resultToString(result);
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
        error =
            std::string("could not initialize the AMD encoder: ") + AmfApi::resultToString(result);
        stop();
        return false;
    }

    m_Frames.reset(codec, amfGrantedSlots(m_Encoder, request, m_Setup));
    m_Fingerprint = amfFingerprint(m_Encoder, codec);
    log::info("[native] AMF ready: " +
              amfReadyDetails(m_Encoder, request, m_Setup, m_Frames.slots(), m_Fingerprint));
    return true;
}

bool AmfEncoder::invalidateReference(uint32_t frameNumber, std::string& error)
{
    if (!m_Encoder) {
        error = "the encoder is not initialized";
        return false;
    }
    return m_Frames.invalidate(frameNumber, error);
}

bool AmfEncoder::encode(ID3D11Texture2D* surface, bool forceKeyframe, uint32_t frameNumber,
                        EncoderOutput& out, std::string& error)
{
    if (!m_Encoder || !m_Context) {
        error = "the encoder is not initialized";
        return false;
    }
    if (m_Output) {
        error = "the previous frame was not released";
        return false;
    }

    // The zero-copy step: AMF wraps the very texture the conversion pass wrote,
    // on the same adapter, with no staging buffer.
    amf::AMFSurfacePtr input;
    const AMF_RESULT result = m_Context->CreateSurfaceFromDX11Native(surface, &input, nullptr);
    if (result != AMF_OK || !input) {
        error = std::string("could not wrap the input surface: ") + AmfApi::resultToString(result);
        return false;
    }
    return m_Frames.encode(m_Encoder, input, forceKeyframe, frameNumber, m_Output, out, error);
}

void AmfEncoder::releaseOutput()
{
    m_Output = nullptr;
}

bool AmfEncoder::setBitrate(int bitrateKbps, std::string& error)
{
    if (!m_Encoder || bitrateKbps <= 0) {
        error = "the encoder is not initialized";
        return false;
    }
    retargetAmf(m_Encoder, m_Codec, m_Setup, bitrateKbps);
    return true;
}

void AmfEncoder::stop()
{
    releaseOutput();
    if (m_Encoder) {
        m_Encoder->Terminate();
        m_Encoder = nullptr;
    }
    if (m_Context) {
        m_Context->Terminate();
        m_Context = nullptr;
    }
}

} // namespace mw::native::encode
