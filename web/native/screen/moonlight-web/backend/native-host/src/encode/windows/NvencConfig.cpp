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

#include "NvencConfig.h"

#include "../ConfigFingerprint.h"
#include "../RateControl.h"

#include <cstring>

namespace mw::native::encode {
namespace {

/// The engine's own preset: P1, the fastest, since the bench of 04/09/2026
/// (`docs/bench-native-host.md`).
///
/// It started as P4, on the belief that P1 would be visibly softer for under a
/// millisecond of gain. Measured on an RTX 5060 Ti at 1440p, 40 Mbit/s: P1
/// encodes a first-person shooter in 3.4 ms against 7.7 for P4 (p99 5 against
/// 11), at the SAME average QP (25) and with nothing to tell apart on the
/// decoded picture; a platform game costs +1 QP, and only scrolling text — sharp
/// high-contrast edges P4 predicts better — pays +5 QP while it moves. Latency
/// first (rule 3 of the module): the shooter is the target, the text is the
/// exception. P2 was slower AND softer, P3/P5/P6 equal P4, P7 slower still.
///
/// What stays: the ULL tuning's quarter-resolution multipass. Turning it off
/// buys 0.6 ms more but breaks the still-screen refinement burst (§9.1) — the
/// single-pass rate control of a picture that just stopped moving never spends
/// its budget, and the QP stalls at 29 instead of reaching 8.
constexpr int kDefaultPreset = 1;

const GUID& presetGuid(int preset)
{
    switch (preset) {
    case 1: return NV_ENC_PRESET_P1_GUID;
    case 2: return NV_ENC_PRESET_P2_GUID;
    case 3: return NV_ENC_PRESET_P3_GUID;
    case 5: return NV_ENC_PRESET_P5_GUID;
    case 6: return NV_ENC_PRESET_P6_GUID;
    case 7: return NV_ENC_PRESET_P7_GUID;
    default: return NV_ENC_PRESET_P4_GUID;
    }
}

const char* multiPassName(NV_ENC_MULTI_PASS mode)
{
    switch (mode) {
    case NV_ENC_TWO_PASS_QUARTER_RESOLUTION: return "quarter";
    case NV_ENC_TWO_PASS_FULL_RESOLUTION: return "full";
    default: return "off";
    }
}

} // namespace

const GUID& nvencCodecGuid(Codec codec)
{
    switch (codec) {
    case Codec::Av1: return NV_ENC_CODEC_AV1_GUID;
    case Codec::Hevc: return NV_ENC_CODEC_HEVC_GUID;
    case Codec::H264: break;
    }
    return NV_ENC_CODEC_H264_GUID;
}

NvencPreset nvencPresetFor(const EncoderTuning& tuning)
{
    // The preset and the latency tuning are the engine's (kDefaultPreset — P1,
    // see there — and ultra-low-latency) unless the bench moved them — see
    // EncoderTuning.
    NvencPreset preset;
    preset.number = tuning.nvencPreset > 0 ? tuning.nvencPreset : kDefaultPreset;
    preset.guid = presetGuid(preset.number);
    preset.tuningInfo = tuning.nvencTuning == EncoderTuning::Latency::Low
                            ? NV_ENC_TUNING_INFO_LOW_LATENCY
                            : NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    return preset;
}

std::string nvencPresetLine(const NvencPreset& preset, const NV_ENC_CONFIG& shipped)
{
    // A preset is a bundle of decisions the driver took, and the bench compares
    // against them without being able to read them any other way.
    return std::string("[native] NVENC preset P") + std::to_string(preset.number) +
           (preset.tuningInfo == NV_ENC_TUNING_INFO_LOW_LATENCY ? "/LL" : "/ULL") +
           " as the driver ships it: multipass=" + multiPassName(shipped.rcParams.multiPass) +
           " aq=" + std::to_string(shipped.rcParams.enableAQ) +
           " taq=" + std::to_string(shipped.rcParams.enableTemporalAQ) + " lookahead=" +
           std::to_string(shipped.rcParams.enableLookahead ? shipped.rcParams.lookaheadDepth : 0) +
           " rc=" + std::to_string(static_cast<int>(shipped.rcParams.rateControlMode));
}

std::string nvencRefusal(const NvencRequest& request)
{
    // H.264 has a 10-bit profile, and no browser decodes HDR with it. The
    // Selector already routes HDR to HEVC or AV1; this is the guard that keeps
    // a misrouted session from encoding something unplayable.
    if (request.hdr && request.codec == Codec::H264)
        return "HDR needs HEVC or AV1 — H.264 has no HDR path a browser decodes";
    return {};
}

bool buildNvencConfig(const NvencRequest& request, const NvencPreset& preset, NV_ENC_CONFIG& config,
                      NV_ENC_INITIALIZE_PARAMS& init, NvencPlan& plan, std::string& error)
{
    const EncoderTuning& tuning = request.tuning;
    const Codec codec = request.codec;
    const bool yuv444 = request.yuv444;
    const bool hdr = request.hdr;
    const int fps = request.fps > 0 ? request.fps : 60;
    const int bitrateKbps = request.bitrateKbps > 0 ? request.bitrateKbps : 20000;
    error = nvencRefusal(request);
    if (!error.empty()) return false;

    plan = NvencPlan{};
    // P010 is what the HDR conversion pass produces, AYUV the 4:4:4 one, NV12
    // the plain 4:2:0 one. NVENC calls P010 "YUV420_10BIT" and, like the
    // shader, puts the ten bits in the high end of each 16-bit word.
    plan.bufferFormat = hdr      ? NV_ENC_BUFFER_FORMAT_YUV420_10BIT
                        : yuv444 ? NV_ENC_BUFFER_FORMAT_AYUV
                                 : NV_ENC_BUFFER_FORMAT_NV12;
    plan.fps = fps;
    plan.bitrateKbps = bitrateKbps;

    // Start from the driver's own preset rather than a hand-built config: the
    // preset carries the tuning for this GPU generation, and only the settings
    // that are wrong for a live stream are then overridden.
    config.version = NV_ENC_CONFIG_VER;

    // ── The bench's overrides, where it gave any ────────────────────────────
    // Lookahead is deliberately NOT among them: it holds N frames back by
    // definition, so it is N frame intervals of latency before any measurement
    // — disqualified by construction, not by a number.
    switch (tuning.nvencMultiPass) {
    case EncoderTuning::MultiPass::Off:
        config.rcParams.multiPass = NV_ENC_MULTI_PASS_DISABLED;
        break;
    case EncoderTuning::MultiPass::QuarterRes:
        config.rcParams.multiPass = NV_ENC_TWO_PASS_QUARTER_RESOLUTION;
        break;
    case EncoderTuning::MultiPass::FullRes:
        config.rcParams.multiPass = NV_ENC_TWO_PASS_FULL_RESOLUTION;
        break;
    case EncoderTuning::MultiPass::Default: break;
    }
    if (tuning.spatialAq != EncoderTuning::Choice::Default)
        config.rcParams.enableAQ = tuning.spatialAq == EncoderTuning::Choice::On ? 1u : 0u;
    if (tuning.temporalAq != EncoderTuning::Choice::Default)
        config.rcParams.enableTemporalAQ = tuning.temporalAq == EncoderTuning::Choice::On ? 1u : 0u;
    plan.vbvFrames = tuning.vbvFrames;

    // ── Never send a periodic keyframe ──────────────────────────────────────
    // A keyframe is a bitrate spike; on a congested link the spike causes the
    // loss that causes the request for another keyframe. Infinite GOP plus
    // intra-refresh spreads the same recovery information across every frame.
    config.gopLength = NVENC_INFINITE_GOPLENGTH;
    // No B-frames: one would make the encoder hold a frame back to reference a
    // picture that has not been sent, buying a whole frame of latency.
    config.frameIntervalP = 1;

    // ── Constant bitrate ────────────────────────────────────────────────────
    // The link has a budget; spending it evenly beats saving up for a burst
    // that arrives as packet loss.
    config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    config.rcParams.averageBitRate = static_cast<uint32_t>(bitrateKbps) * 1000u;
    config.rcParams.maxBitRate = config.rcParams.averageBitRate;
    // The VBV is what actually enforces low latency: it caps how far ahead the
    // encoder may spend, so no single frame can be so large that it takes
    // several frame times to transmit. See RateControl.h for why it has a
    // floor rather than being one frame at any refresh rate.
    config.rcParams.vbvBufferSize = vbvBits(config.rcParams.averageBitRate, fps, plan.vbvFrames);
    config.rcParams.vbvInitialDelay = config.rcParams.vbvBufferSize;
    // ── A QP floor ──────────────────────────────────────────────────────────
    // CBR without one spends the whole budget on a picture that barely moves:
    // a page of text with a spinner on it was refined down to QP 7, 14 KB a
    // frame — 7.7 Mbps for a desktop (HEVC, 1080p60 at 20 Mbps, RTX 5060 Ti,
    // 22/09/2026), and AV1 16 Mbps. A capped VBR changed nothing and the VBR
    // target quality is ignored at P1/ULL; the floor is what stops it. Motion
    // never reaches it (a scroll at 20 Mbps sits at QP 32, the same with and
    // without), so it only ever cuts what a still picture would have wasted.
    // QP 18 is visually lossless for text; AV1 counts on a 0-255 scale, where
    // qindex 32 is the same quantizer step. Together with the spaced sweep
    // below: 7.7 → 1.0 Mbps (HEVC), 16 → 2.6 Mbps (AV1).
    if (tuning.nvencMinQp >= 0) {
        const auto qp = static_cast<uint32_t>(tuning.nvencMinQp > 0 ? tuning.nvencMinQp
                                              : codec == Codec::Av1 ? 32
                                                                    : 18);
        config.rcParams.enableMinQP = 1;
        config.rcParams.minQP = {qp, qp, qp};
    }

    // ── Codec-specific: parameter sets and intra-refresh ────────────────────
    // repeatSPSPPS matters for the browser: its decoder configures itself from
    // the parameter sets, so a client that joins late or loses the first
    // keyframe must be able to start from the next one.
    // The profile has to agree with the input format. Without this NVENC
    // accepts 4:4:4 input and encodes 4:2:0 from it — the extra chroma is
    // silently discarded, which looks exactly like the feature not working.
    if (yuv444) {
        if (codec == Codec::Av1) {
            // No 4:4:4 profile exists for AV1 in this SDK, and the capability
            // query says so per codec — the Selector routes 4:4:4 to HEVC or
            // H.264 instead. Refusing here keeps a misrouted session from
            // encoding 4:2:0 under a 4:4:4 label.
            error = "NVENC has no 4:4:4 path for AV1";
            return false;
        }
        config.profileGUID = codec == Codec::Hevc ? NV_ENC_HEVC_PROFILE_FREXT_GUID
                                                  : NV_ENC_H264_PROFILE_HIGH_444_GUID;
    }
    // HEVC's 10-bit profile has to be named, exactly like the 4:4:4 one above:
    // left on Main, NVENC accepts the P010 surface and encodes 8-bit from it,
    // so the HDR would be silently thrown away. AV1 carries its bit depth in
    // the config rather than in a profile GUID, and is set below.
    if (hdr && codec == Codec::Hevc) config.profileGUID = NV_ENC_HEVC_PROFILE_MAIN10_GUID;

    // Intra-refresh only when the caller asked for it. Enabling it unasked
    // costs slightly larger P-frames at a fixed CBR budget for a benefit only a
    // receiver that decodes through damage can collect — see SessionConfig.
    plan.intraRefresh = request.intraRefresh;
    const uint32_t refreshEnabled = request.intraRefresh ? 1u : 0u;
    // The wave replaces the periodic keyframe: a band of intra blocks crosses
    // the picture over refreshCount frames, and a new sweep starts every
    // refreshPeriod. The sweeps are spaced as on Intel, one every eight
    // seconds (encode::intraRefreshDistanceFrames): with the QP floor above, a
    // still page went from 5.8 KB a frame with a sweep every two seconds to
    // 2.1 KB. A loss may take the gap plus one sweep to heal, and the receiver
    // is told so.
    plan.refreshPeriod =
        static_cast<uint32_t>(tuning.nvencIntraRefreshPeriod > 0 ? tuning.nvencIntraRefreshPeriod
                                                                 : intraRefreshDistanceFrames(fps));
    plan.refreshCount =
        static_cast<uint32_t>(tuning.nvencIntraRefreshCount > 0 ? tuning.nvencIntraRefreshCount
                                                                : intraRefreshCountFrames(fps));
    plan.intraRefreshHorizon = static_cast<int>(plan.refreshPeriod + plan.refreshCount);

    // ── A DPB deep enough to lose a frame in ────────────────────────────────
    // Reference invalidation (design §9.2) only works when the encoder has
    // somewhere else to look: with one reference frame, invalidating it leaves
    // nothing but an IDR. Four frames of DPB let up to three consecutive lost
    // frames be healed by an ordinary delta. The encoder still predicts from
    // the most recent frame — the DPB is a fallback, not a wider search — so
    // the encode time is unchanged (measured: within noise at P1).
    plan.dpbFrames = tuning.dpbFrames > 0 ? static_cast<uint32_t>(tuning.dpbFrames) : 4u;

    switch (codec) {
    case Codec::H264: {
        NV_ENC_CONFIG_H264& h264 = config.encodeCodecConfig.h264Config;
        h264.chromaFormatIDC = yuv444 ? 3 : 1;
        h264.repeatSPSPPS = 1;
        h264.idrPeriod = NVENC_INFINITE_GOPLENGTH;
        h264.maxNumRefFrames = plan.dpbFrames;
        // Tell the decoder there is nothing to reorder. Without the VUI's
        // bitstream_restriction the browser's D3D11 H.264 decoder assumes the
        // worst — a DPB's worth of reordering, which at 1440p60 is a dozen
        // frames it holds back before showing any. Measured on the bench:
        // 200 ms of decode latency on a stream with no B-frames at all, against
        // 1 ms for HEVC, whose parameter sets carry the figure by default.
        h264.h264VUIParameters.bitstreamRestrictionFlag = 1;
        h264.enableIntraRefresh = refreshEnabled;
        h264.intraRefreshPeriod = plan.refreshPeriod;
        h264.intraRefreshCnt = plan.refreshCount;
        break;
    }
    case Codec::Hevc: {
        NV_ENC_CONFIG_HEVC& hevc = config.encodeCodecConfig.hevcConfig;
        hevc.chromaFormatIDC = yuv444 ? 3 : 1;
        hevc.repeatSPSPPS = 1;
        hevc.idrPeriod = NVENC_INFINITE_GOPLENGTH;
        hevc.maxNumRefFramesInDPB = plan.dpbFrames;
        hevc.enableIntraRefresh = refreshEnabled;
        hevc.intraRefreshPeriod = plan.refreshPeriod;
        hevc.intraRefreshCnt = plan.refreshCount;
        if (hdr) {
            hevc.pixelBitDepthMinus8 = 2;
            // The colour description travels in the VUI, and it is the whole
            // reason a browser knows to run the PQ curve backwards. Without it
            // the decoder assumes BT.709 sRGB and paints a flat, grey picture:
            // the classic "HDR looks washed out" that reads as a shader bug and
            // is in fact three missing integers.
            hevc.hevcVUIParameters.videoSignalTypePresentFlag = 1;
            hevc.hevcVUIParameters.videoFullRangeFlag = 0; // limited, as the shader writes
            hevc.hevcVUIParameters.colourDescriptionPresentFlag = 1;
            hevc.hevcVUIParameters.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT2020;
            hevc.hevcVUIParameters.transferCharacteristics =
                NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SMPTE2084;
            hevc.hevcVUIParameters.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_BT2020_NCL;
        }
        break;
    }
    case Codec::Av1: {
        NV_ENC_CONFIG_AV1& av1 = config.encodeCodecConfig.av1Config;
        // AV1's answer to repeatSPSPPS. Without it NVENC writes the sequence
        // header once, at the very start: a browser served any keyframe but the
        // first has nothing to configure its decoder from. The relay sends the
        // LAST buffered keyframe, so that is the ordinary case, not the rare
        // one — the same failure the AMD path had until 06/09/2026.
        av1.repeatSeqHdr = 1;
        av1.idrPeriod = NVENC_INFINITE_GOPLENGTH;
        av1.maxNumRefFramesInDPB = plan.dpbFrames;
        av1.enableIntraRefresh = refreshEnabled;
        av1.intraRefreshPeriod = plan.refreshPeriod;
        av1.intraRefreshCnt = plan.refreshCount;
        if (hdr) {
            // AV1 names its depth in the config, in and out: the input really is
            // 10-bit and so must the bitstream be, or the hardware would helpfully
            // convert one to the other and drop the range we came for.
            av1.inputPixelBitDepthMinus8 = 2;
            av1.pixelBitDepthMinus8 = 2;
            av1.colorPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT2020;
            av1.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SMPTE2084;
            av1.matrixCoefficients = NV_ENC_VUI_MATRIX_COEFFS_BT2020_NCL;
        }
        break;
    }
    }

    // Zeroed in place: the structure is two kilobytes, and a temporary of it
    // would be one more on a stack ARM64 wants under four (plan §7).
    std::memset(&init, 0, sizeof(init));
    init.version = NV_ENC_INITIALIZE_PARAMS_VER;
    init.encodeGUID = nvencCodecGuid(codec);
    init.presetGUID = preset.guid;
    init.tuningInfo = preset.tuningInfo;
    init.encodeWidth = static_cast<uint32_t>(request.width);
    init.encodeHeight = static_cast<uint32_t>(request.height);
    init.darWidth = static_cast<uint32_t>(request.width);
    init.darHeight = static_cast<uint32_t>(request.height);
    init.frameRateNum = static_cast<uint32_t>(fps);
    init.frameRateDen = 1;
    init.maxEncodeWidth = static_cast<uint32_t>(request.width);
    init.maxEncodeHeight = static_cast<uint32_t>(request.height);
    // Synchronous: nvEncLockBitstream blocks until the frame is done. An async
    // session would need an event and a second thread to gain nothing here —
    // there is exactly one frame in flight by design.
    init.enableEncodeAsync = 0;
    // Let the encoder decide picture types. We only ever override it to force
    // an IDR, which NV_ENC_PIC_FLAG_FORCEIDR does per frame.
    init.enablePTD = 1;
    init.encodeConfig = &config;
    return true;
}

void retargetNvencConfig(NV_ENC_CONFIG& config, NvencPlan& plan, int bitrateKbps)
{
    plan.bitrateKbps = bitrateKbps;
    config.rcParams.averageBitRate = static_cast<uint32_t>(bitrateKbps) * 1000u;
    config.rcParams.maxBitRate = config.rcParams.averageBitRate;
    if (plan.fps > 0) {
        config.rcParams.vbvBufferSize =
            vbvBits(config.rcParams.averageBitRate, plan.fps, plan.vbvFrames);
        config.rcParams.vbvInitialDelay = config.rcParams.vbvBufferSize;
    }
}

uint32_t nvencFingerprint(NV_ENC_INITIALIZE_PARAMS& init, const NV_ENC_CONFIG& config)
{
    NV_ENC_CONFIG* const pointer = init.encodeConfig;
    const NV_ENC_BUFFER_FORMAT format = init.bufferFormat;
    init.encodeConfig = nullptr;
    init.bufferFormat = NV_ENC_BUFFER_FORMAT_UNDEFINED;
    ConfigFingerprint fingerprint;
    fingerprint.addValue(init);
    fingerprint.addValue(config);
    init.encodeConfig = pointer;
    init.bufferFormat = format;
    return fingerprint.value();
}

std::string nvencReadyDetails(const NvencRequest& request, const NvencPreset& preset,
                              const NV_ENC_CONFIG& config, const NvencPlan& plan,
                              bool refInvalidation, uint32_t fingerprint)
{
    const std::string overrides = request.tuning.describe();
    return std::to_string(request.width) + "x" + std::to_string(request.height) + "@" +
           std::to_string(plan.fps) + " " + toString(request.codec) +
           (request.hdr ? " Main10 (BT.2020 PQ)" : "") + " CBR " +
           std::to_string(plan.bitrateKbps) + " kbps, VBV " +
           std::to_string(config.rcParams.vbvBufferSize / 8 / 1024) + " KB" +
           (config.rcParams.enableMinQP
                ? ", QP >= " + std::to_string(config.rcParams.minQP.qpInterP)
                : "") +
           (plan.intraRefresh ? ", intra-refresh over " + std::to_string(plan.refreshCount) +
                                    " frames every " + std::to_string(plan.refreshPeriod)
                              : ", keyframes") +
           ", P" + std::to_string(preset.number) +
           (preset.tuningInfo == NV_ENC_TUNING_INFO_LOW_LATENCY ? "/LL" : "/ULL") +
           " multipass=" + multiPassName(config.rcParams.multiPass) +
           " aq=" + std::to_string(config.rcParams.enableAQ) +
           " taq=" + std::to_string(config.rcParams.enableTemporalAQ) + ", DPB " +
           std::to_string(plan.dpbFrames) +
           (refInvalidation ? " with reference invalidation" : ", no reference invalidation") +
           ", config " + ConfigFingerprint::text(fingerprint) +
           (overrides.empty() ? "" : " [bench: " + overrides + "]");
}

} // namespace mw::native::encode
