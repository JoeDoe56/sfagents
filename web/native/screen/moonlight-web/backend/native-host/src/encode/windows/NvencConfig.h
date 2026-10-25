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

#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"

#include <ffnvcodec/nvEncodeAPI.h>

#include <cstdint>
#include <string>

namespace mw::native::encode {

// NVENC's configuration for a live stream, whatever feeds the session — a
// D3D11 texture (NvencEncoder) or a D3D12 resource (NvencEncoder12). Pure: no
// driver call is made here; the two encoders open their sessions, fetch the
// preset from the driver and hand this module the rest (plan
// pipeline-video-d3d12-v2, C7.1). NvencEncoder.h says why each setting is a
// latency decision.

/// What a session asks of NVENC.
struct NvencRequest
{
    Codec codec = Codec::H264;
    int width = 0;
    int height = 0;
    int fps = 60;
    int bitrateKbps = 20000;
    /// 4:4:4 rather than 4:2:0; the caller checked GpuInfo::supports444.
    bool yuv444 = false;
    /// P010 in, a 10-bit profile and BT.2020 PQ out (HEVC, AV1).
    bool hdr = false;
    /// The wave instead of keyframes: only for a receiver that decodes
    /// through the damage (SessionConfig).
    bool intraRefresh = false;
    EncoderTuning tuning;
};

/// The driver's preset a session starts from.
struct NvencPreset
{
    int number = 1;
    GUID guid = {};
    NV_ENC_TUNING_INFO tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
};

/// What the configuration settled beyond the structures: what the encoder
/// reports, and what setBitrate needs again.
struct NvencPlan
{
    NV_ENC_BUFFER_FORMAT bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
    int fps = 60;
    int bitrateKbps = 20000;
    bool intraRefresh = false;
    uint32_t refreshPeriod = 0;
    uint32_t refreshCount = 0;
    /// Frames a loss may take to heal by the refresh: the gap plus a sweep.
    int intraRefreshHorizon = 0;
    uint32_t dpbFrames = 4;
    /// The bench's VBV override, so setBitrate sizes the buffer by the same
    /// rule as init. 0 is the engine's own rule.
    int vbvFrames = 0;
};

const GUID& nvencCodecGuid(Codec codec);

/// The engine's preset — P1, ultra-low latency — unless the bench moved it.
NvencPreset nvencPresetFor(const EncoderTuning& tuning);

/// What the preset itself switched on, before anything here touches it: the
/// part of the configuration nobody wrote, for the log.
std::string nvencPresetLine(const NvencPreset& preset, const NV_ENC_CONFIG& shipped);

/// Why NVENC must refuse @p request before a session is even opened (H.264
/// HDR), "" when it may go on.
std::string nvencRefusal(const NvencRequest& request);

/// The session's configuration: @p config holds the preset's presetCfg on
/// entry and the session's on return; @p init is filled for it, encodeConfig
/// pointing at @p config. False, with @p error, for a request NVENC must
/// refuse (H.264 HDR, AV1 4:4:4).
bool buildNvencConfig(const NvencRequest& request, const NvencPreset& preset, NV_ENC_CONFIG& config,
                      NV_ENC_INITIALIZE_PARAMS& init, NvencPlan& plan, std::string& error);

/// The rate control's fields for a new target, as init sized them.
void retargetNvencConfig(NV_ENC_CONFIG& config, NvencPlan& plan, int bitrateKbps);

/// ConfigFingerprint of what the driver is handed: the config's bytes and the
/// init's, without the one pointer in them and without bufferFormat, which
/// only the D3D12 interface reads — so the D3D11 and D3D12 encoders configured
/// alike say the same value.
uint32_t nvencFingerprint(NV_ENC_INITIALIZE_PARAMS& init, const NV_ENC_CONFIG& config);

/// The ready line after "<name> ready: ", shared by both encoders.
std::string nvencReadyDetails(const NvencRequest& request, const NvencPreset& preset,
                              const NV_ENC_CONFIG& config, const NvencPlan& plan,
                              bool refInvalidation, uint32_t fingerprint);

} // namespace mw::native::encode
