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

#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"
#include "../EncoderOutput.h"
#include "../ReferenceSlots.h"

#include <core/Factory.h>

#include <cstdint>
#include <string>

namespace mw::native::encode {

// AMF's configuration for a live stream and the per-picture half of a session,
// whatever feeds it — a D3D11 texture (AmfEncoder) or a D3D12 resource
// (AmfEncoder12). The two encoders make their context and wrap their pictures
// each its own way, and hand the rest to this module (plan
// pipeline-video-d3d12-v2, C7.3). AmfEncoder.h says why each setting is what it
// is, and how reference invalidation works through long-term references.

/// What a session asks of AMF.
struct AmfRequest
{
    Codec codec = Codec::H264;
    int width = 0;
    int height = 0;
    int fps = 60;
    int bitrateKbps = 20000;
    /// The wave instead of keyframes, only for a receiver that decodes
    /// through the damage (SessionConfig).
    bool intraRefresh = false;
    EncoderTuning tuning;
};

/// What the configuration settled before Init, for what follows it.
struct AmfSetup
{
    int fps = 60;
    int bitrateKbps = 20000;
    /// What the encoder was actually configured with — reported, not wished for.
    bool intraRefresh = false;
    int64_t refreshPeriod = 0;
    int64_t vbvBits = 0;
    /// The bench's VBV override, so setBitrate sizes the buffer by the rule
    /// init used. 0 is the engine's own rule.
    int vbvFrames = 0;
    /// Long-term reference indices asked of the driver (0: none).
    int ltrAsked = 0;
};

/// Why AMF must refuse a session before a context is even made (4:4:4 and
/// HDR, not done on this path), "" when it may go on.
std::string amfRefusal(bool yuv444, bool hdr);

/// The component for @p codec: AMFVideoEncoderVCE_AVC, _HEVC or _AV1.
const wchar_t* amfComponentFor(Codec codec);

/// Every property set before Init, in the order AMF needs them — USAGE
/// first, which resets the rest. Logs what the usage chose before the bench's
/// overrides move it.
void configureAmf(amf::AMFComponent* encoder, const AmfRequest& request, AmfSetup& setup);

/// The long-term reference slots the driver granted, read back after Init.
ReferenceSlots amfGrantedSlots(amf::AMFComponent* encoder, const AmfRequest& request,
                               const AmfSetup& setup);

/// ConfigFingerprint of every property configureAmf() sets, as the encoder
/// holds it once initialized: the D3D11 and D3D12 contexts alike.
uint32_t amfFingerprint(amf::AMFComponent* encoder, Codec codec);

/// The ready line after "<name> ready: ", read back from the encoder.
std::string amfReadyDetails(amf::AMFComponent* encoder, const AmfRequest& request,
                            const AmfSetup& setup, const ReferenceSlots& slots,
                            uint32_t fingerprint);

/// A new target, applied live with the VBV by init's rule.
void retargetAmf(amf::AMFComponent* encoder, Codec codec, AmfSetup& setup, int bitrateKbps);

/// The per-picture half of an AMF session: the forced reference or keyframe
/// asked on the input, the submission and the wait for the output, and what
/// the driver said it did with the long-term slots. Touched only by the
/// capture thread: encode() and invalidate() both run on the session loop.
class AmfFrames
{
public:
    void reset(Codec codec, ReferenceSlots slots);

    bool enabled() const { return m_Ltr.enabled(); }
    const ReferenceSlots& slots() const { return m_Ltr; }
    int invalidations() const { return m_Invalidations; }

    /// The frame numbered @p frameNumber never reached the receiver: the next
    /// picture is forced onto a slot older than it, or the call fails and the
    /// caller forces a keyframe.
    bool invalidate(uint32_t frameNumber, std::string& error);

    /// Submits @p input, the picture numbered @p frameNumber, and collects its
    /// bitstream into @p output — held until the caller releases it — and
    /// @p out.
    bool encode(amf::AMFComponent* encoder, amf::AMFSurface* input, bool forceKeyframe,
                uint32_t frameNumber, amf::AMFBufferPtr& output, EncoderOutput& out,
                std::string& error);

private:
    Codec m_Codec = Codec::H264;
    /// The long-term reference slots as the driver confirmed them (disabled
    /// when it granted none).
    ReferenceSlots m_Ltr;
    /// A loss the receiver named, waiting for the next encode() to force the
    /// reference: every frame from m_LostFrom on is unusable.
    bool m_LostPending = false;
    uint32_t m_LostFrom = 0;
    int m_Invalidations = 0;
    /// A refusal to mark is logged once: the table copes on its own, a loss
    /// simply costs a keyframe until the driver obliges.
    int m_MarkRefusals = 0;
    /// A reference the driver refused UNSAFELY — it predicted from a picture at
    /// or after the loss — costs the next frame as a keyframe. Not logged once
    /// but every time: this is the cost the whole path exists to avoid.
    bool m_ForceKeyframeNext = false;
    int m_HealsLogged = 0;
};

} // namespace mw::native::encode
