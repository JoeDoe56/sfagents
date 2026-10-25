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

// Which chain a build of a Windows session runs its pictures through (plan
// pipeline-video-d3d12-v2, §3.3). Pure, so that it is tested everywhere.
//
// The bench key over the setting over the vendor table; then, when that says
// D3D12, what rules D3D12 out for THIS build — asked again at the next one,
// never remembered. A D3D12 session that fails while streaming is the
// session's to handle: it goes back to D3D11 for good, which is not a choice
// made here.

#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"
#include "mw/native/VideoPipeline.h"

#include <string>

namespace mw::native {

/// What one build of a session knows when it picks its chain.
struct VideoPipelineFacts
{
    /// The bench's key (EncoderTuning::pipeline) and the setting
    /// (SessionConfig::videoPipeline); Auto is no opinion.
    VideoPipeline benchKey = VideoPipeline::Auto;
    VideoPipeline setting = VideoPipeline::Auto;
    /// The encoder the Selector picked, and the codec.
    EncoderApi encoder = EncoderApi::None;
    Codec codec = Codec::H264;
    /// The bench's knobs that name a D3D12 route: the conversion's queue and
    /// the encoder (Default: the vendor's, defaultEncoder12).
    EncoderTuning::ConvertQueue12 conv12 = EncoderTuning::ConvertQueue12::Default;
    EncoderTuning::Encoder12 enc12 = EncoderTuning::Encoder12::Default;

    // ── What rules D3D12 out for this build ─────────────────────────────────
    //
    // Not the capture any more: Desktop Duplication's surface is opened by
    // its NT handle, and Windows.Graphics.Capture's, which has none, is
    // copied into one of the interop's own on the capture's context, behind
    // the same two fences (DdaInterop::open; plan « Gels du lien », route B,
    // 22/10/2026).

    /// The cross-GPU bridge is D3D11 end to end.
    bool crossGpuCopy = false;
    /// No D3D12 encoder takes 4:4:4 (AYUV input nowhere, measured).
    bool yuv444 = false;
    /// The GPU's D3D12 Video Encode takes this codec: an ID3D12VideoDevice3
    /// (none on Windows 10) and a profile for it.
    bool videoEncode12 = false;
    /// The vendors' SDKs take D3D12 pictures on this machine: their runtime is
    /// there (NvencEncoder12, AmfEncoder12).
    bool nvenc12 = false;
    bool amf12 = false;
    /// Why this GPU's driver is kept off the D3D12 route, "" when it is not
    /// (d3d12DriverExcluded).
    std::string driverExcluded;
    /// The stream must refresh by intra-refresh (SessionConfig::
    /// intraRefreshRequired: the bench's intra=2), and whether the D3D12
    /// route grants it on this GPU — taken for granted until a build finds
    /// out, like videoEncode12: the Arc's D3D12 Video Encode sweeps one frame
    /// at most, which is no wave at all, while its D3D11 oneVPL sweeps a real
    /// one. Once a build has seen it, the builds after it choose D3D11 from
    /// the start.
    bool intraRefreshRequired = false;
    bool d3d12IntraRefresh = true;
};

struct VideoPipelineChoice
{
    /// Never Auto.
    VideoPipeline pipeline = VideoPipeline::D3d11;
    /// "D3D11", or the D3D12 route: "DIRECT conversion → D3D12 Video Encode
    /// HEVC".
    std::string route = "D3D11";
    /// The D3D12 route's encoder as the stats overlay names it — "D3D12 VE",
    /// "NVENC (D3D12)", "AMF (D3D12)" — and empty on D3D11, where the
    /// Selector's own encoder speaks for itself.
    std::string encoder;
    /// Why, for the log: which of the bench key, the setting and the table
    /// decided — and, when D3D12 was asked for and D3D11 runs, what refused.
    std::string reason;
    /// D3D12 was asked for — by the bench key, the setting or the table's
    /// line — and D3D11 runs.
    bool refused = false;
    /// The D3D12 route's encoder, the bench key's or the vendor's; it means
    /// nothing on D3D11.
    EncoderTuning::Encoder12 encoder12 = EncoderTuning::Encoder12::VideoEncode;
};

/// The encoder the D3D12 route runs on a GPU reached through @p api, when the
/// bench's enc12= names none: the vendor's own SDK fed D3D12 pictures where it
/// won, D3D12 Video Encode otherwise. NVIDIA's moved with G1 (Bruno,
/// 27/09/2026): NVENC takes a D3D12 picture at the speed of its D3D11 path,
/// where VE ran three times slower on the RTX. AMD's waits for G4 — AMF-DX12
/// against VE under a game — and Bruno's word; Intel has only VE.
inline EncoderTuning::Encoder12 defaultEncoder12(EncoderApi api)
{
    switch (api) {
    case EncoderApi::Nvenc: return EncoderTuning::Encoder12::Nvenc;
    default: return EncoderTuning::Encoder12::VideoEncode;
    }
}

/// Whether D3D12 Video Encode takes two pictures in flight (EncoderTuning::
/// pipelined, design §32.17) when the bench's key says nothing: on an Intel
/// GPU with memory of its own, not on one that shares the CPU's (Bruno,
/// 29/09/2026, §9-26). The Arc takes 2 to 4.5 % more pictures at 244 Hz and
/// loses nothing measurable elsewhere; on an iGPU the conversion slows the
/// encoder through the memory they share (the N95 at 120 Hz: +52 ms at the
/// p99). NVIDIA and AMD stream through their own SDKs, one picture at a time.
inline bool pipelinedByDefault(uint32_t vendorId, bool unifiedMemory)
{
    return vendorId == 0x8086 && !unifiedMemory;
}

namespace videopipeline_detail {

inline const char* encoderName(EncoderTuning::Encoder12 e)
{
    switch (e) {
    case EncoderTuning::Encoder12::Nvenc: return "NVENC (D3D12)";
    case EncoderTuning::Encoder12::Amf: return "AMF (D3D12)";
    case EncoderTuning::Encoder12::Pyrowave: return "PyroWave (D3D12)";
    default: return "D3D12 Video Encode";
    }
}

/// The same encoder in the fewest characters: the overlay's value column is a
/// phone's width.
inline const char* encoderLabel(EncoderTuning::Encoder12 e)
{
    switch (e) {
    case EncoderTuning::Encoder12::Nvenc: return "NVENC (D3D12)";
    case EncoderTuning::Encoder12::Amf: return "AMF (D3D12)";
    case EncoderTuning::Encoder12::Pyrowave: return "PyroWave";
    default: return "D3D12 VE";
    }
}

/// Why D3D12 cannot carry this build, or "" when it can. @p encoder is the
/// D3D12 route's encoder, already resolved from its Default.
inline std::string refusal(const VideoPipelineFacts& f, EncoderTuning::Encoder12 encoder)
{
    using E = EncoderTuning::Encoder12;
    if (f.crossGpuCopy) return "the pictures cross to another GPU, over a D3D11 bridge";
    if (f.encoder != EncoderApi::Nvenc && f.encoder != EncoderApi::Amf &&
        f.encoder != EncoderApi::Vpl)
        return std::string(toString(f.encoder)) + " has no D3D12 route";
    if (!f.driverExcluded.empty()) return "the D3D12 route stays off " + f.driverExcluded;
    if (f.yuv444) return "4:4:4, which no D3D12 encoder takes";
    if (encoder == E::Nvenc && f.encoder != EncoderApi::Nvenc)
        return "enc12=nvenc on a GPU NVENC does not drive";
    if (encoder == E::Amf && f.encoder != EncoderApi::Amf)
        return "enc12=amf on a GPU AMF does not drive";
    if (encoder == E::Nvenc && !f.nvenc12) return "NVENC takes no D3D12 picture on this machine";
    if (encoder == E::Amf && !f.amf12) return "AMF takes no D3D12 picture on this machine";
    // The vendors' SDKs code what their D3D11 path codes; D3D12 Video Encode
    // codes HEVC, H.264 and AV1 (Phase 9) — each where the GPU's driver does,
    // which the encoder's negotiation asks.
    if (encoder == E::VideoEncode && !f.videoEncode12)
        return std::string("this GPU's D3D12 Video Encode does not take ") + toString(f.codec);
    // PyroWave (POC Ultra) codes every frame alone: no codec to negotiate
    // with the GPU, no refresh wave to grant.
    if (encoder == E::Pyrowave) return {};
    if (f.intraRefreshRequired && !f.d3d12IntraRefresh)
        return "the stream must refresh by intra-refresh, which the D3D12 route does not grant "
               "on this GPU";
    return {};
}

} // namespace videopipeline_detail

inline VideoPipelineChoice chooseVideoPipeline(const VideoPipelineFacts& f)
{
    VideoPipeline wanted = VideoPipeline::D3d11;
    std::string why;
    std::string asker; // who asked for D3D12, in a refusal's words
    // Linux's chains (vaapi, vulkan) are no opinion here, as Auto is.
    if (f.benchKey != VideoPipeline::Auto && isWindowsPipeline(f.benchKey)) {
        wanted = f.benchKey;
        why = std::string("the bench key pipeline=") + toString(f.benchKey);
        asker = why;
    } else if (f.setting != VideoPipeline::Auto && isWindowsPipeline(f.setting)) {
        wanted = f.setting;
        why = std::string("the setting (") + toString(f.setting) + ")";
        asker = why;
    } else {
        wanted = autoVideoPipeline(f.encoder);
        why = std::string("auto: the vendor table has ") +
              (wanted == VideoPipeline::D3d12 ? "D3D12" : "D3D11") + " for " + toString(f.encoder);
        asker = std::string("auto: the vendor table for ") + toString(f.encoder);
        if (wanted == VideoPipeline::D3d12 && !autoD3d12Codec(f.codec)) {
            wanted = VideoPipeline::D3d11;
            why +=
                std::string(" in HEVC, D3D11 in ") + toString(f.codec) + " (not measured on D3D12)";
        }
    }

    VideoPipelineChoice c;
    if (wanted != VideoPipeline::D3d12) {
        c.reason = why;
        return c;
    }
    const EncoderTuning::Encoder12 encoder =
        f.enc12 == EncoderTuning::Encoder12::Default ? defaultEncoder12(f.encoder) : f.enc12;
    const std::string refused = videopipeline_detail::refusal(f, encoder);
    if (!refused.empty()) {
        c.refused = true;
        c.reason = asker + " asks for D3D12, D3D11 runs: " + refused;
        return c;
    }
    c.pipeline = VideoPipeline::D3d12;
    c.encoder12 = encoder;
    c.route =
        std::string(f.conv12 == EncoderTuning::ConvertQueue12::Compute ? "COMPUTE" : "DIRECT") +
        " conversion → " + videopipeline_detail::encoderName(encoder) + " " + toString(f.codec);
    c.encoder = videopipeline_detail::encoderLabel(encoder);
    c.reason = why;
    return c;
}

} // namespace mw::native
