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

#include "encode/windows/d3d12/VideoEncodeCaps12.h"

#include <vector>

namespace mw::native::encode {

namespace {

template <typename T> bool feature(ID3D12VideoDevice3* video, D3D12_FEATURE_VIDEO f, T& data)
{
    return SUCCEEDED(video->CheckFeatureSupport(f, &data, sizeof(data)));
}

D3D12_VIDEO_ENCODER_PROFILE_DESC profileDesc(D3D12_VIDEO_ENCODER_PROFILE_HEVC& profile)
{
    D3D12_VIDEO_ENCODER_PROFILE_DESC d = {};
    d.DataSize = sizeof(profile);
    d.pHEVCProfile = &profile;
    return d;
}

} // namespace

VideoEncodeCaps12::VideoEncodeCaps12(ID3D12VideoDevice3* video)
    : m_Video(video)
{}

D3D12_VIDEO_ENCODER_PROFILE_HEVC VideoEncodeCaps12::profile(bool tenBit)
{
    return tenBit ? D3D12_VIDEO_ENCODER_PROFILE_HEVC_MAIN10 : D3D12_VIDEO_ENCODER_PROFILE_HEVC_MAIN;
}

D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC
VideoEncodeCaps12::configuration(const HevcBlocks& blocks, const HevcBlocksAnswer& flags)
{
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC c = {};
    // AMP where the driver requires it, nothing else: the configurations
    // whose slices ffmpeg decoded without an error (ParameterSets.h).
    if (flags.ampRequired)
        c.ConfigurationFlags |=
            D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC_FLAG_USE_ASYMETRIC_MOTION_PARTITION;
    c.MinLumaCodingUnitSize = static_cast<D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC_CUSIZE>(
        blocks.log2MinCodingBlock - 3);
    c.MaxLumaCodingUnitSize = static_cast<D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC_CUSIZE>(
        blocks.log2MaxCodingBlock - 3);
    c.MinLumaTransformUnitSize = static_cast<D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC_TUSIZE>(
        blocks.log2MinTransformBlock - 2);
    c.MaxLumaTransformUnitSize = static_cast<D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC_TUSIZE>(
        blocks.log2MaxTransformBlock - 2);
    c.max_transform_hierarchy_depth_inter = static_cast<UCHAR>(blocks.depth);
    c.max_transform_hierarchy_depth_intra = static_cast<UCHAR>(blocks.depth);
    return c;
}

int VideoEncodeCaps12::levelIdc(D3D12_VIDEO_ENCODER_LEVELS_HEVC level)
{
    static const int kIdc[] = {30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186};
    const int i = static_cast<int>(level);
    return i >= 0 && i < 13 ? kIdc[i] : 0;
}

VideoEncodeCaps12::RateControl::RateControl(const HevcRate& rate, int fps, uint32_t bitsPerSecond,
                                            bool av1)
{
    // The engine's QP floor: below 18 a still picture spends bits on noise
    // the eye cannot see. In AV1's qindex, the same points: QP × 255 / 51.
    const UINT initial = av1 ? 150 : 30;
    const UINT floor = av1 ? 90 : 18;
    const UINT ceiling = av1 ? 255 : 51;
    desc.TargetFrameRate = {static_cast<UINT>(fps > 0 ? fps : 60), 1};
    if (rate.mode == HevcRate::Mode::Cbr) {
        desc.Mode = D3D12_VIDEO_ENCODER_RATE_CONTROL_MODE_CBR;
        cbr.InitialQP = initial;
        cbr.MinQP = floor;
        cbr.MaxQP = ceiling;
        cbr1.InitialQP = cbr.InitialQP;
        cbr1.MinQP = cbr.MinQP;
        cbr1.MaxQP = cbr.MaxQP;
        cbr1.QualityVsSpeed = 0; // the fastest end (measured 26/09/2026)
        setBitrate(bitsPerSecond, fps, 0);
        if (rate.qualityVsSpeed) {
            desc.ConfigParams.DataSize = sizeof(cbr1);
            desc.ConfigParams.pConfiguration_CBR1 = &cbr1;
        } else {
            desc.ConfigParams.DataSize = sizeof(cbr);
            desc.ConfigParams.pConfiguration_CBR = &cbr;
        }
    } else {
        desc.Mode = D3D12_VIDEO_ENCODER_RATE_CONTROL_MODE_CQP;
        cqp = {initial, initial, initial};
        cqp1.ConstantQP_FullIntracodedFrame = initial;
        cqp1.ConstantQP_InterPredictedFrame_PrevRefOnly = initial;
        cqp1.ConstantQP_InterPredictedFrame_BiDirectionalRef = initial;
        cqp1.QualityVsSpeed = 0;
        if (rate.qualityVsSpeed) {
            desc.ConfigParams.DataSize = sizeof(cqp1);
            desc.ConfigParams.pConfiguration_CQP1 = &cqp1;
        } else {
            desc.ConfigParams.DataSize = sizeof(cqp);
            desc.ConfigParams.pConfiguration_CQP = &cqp;
        }
    }
    if (rate.qualityVsSpeed)
        desc.Flags |= D3D12_VIDEO_ENCODER_RATE_CONTROL_FLAG_ENABLE_EXTENSION1_SUPPORT |
                      D3D12_VIDEO_ENCODER_RATE_CONTROL_FLAG_ENABLE_QUALITY_VS_SPEED;
    if (rate.vbv) desc.Flags |= D3D12_VIDEO_ENCODER_RATE_CONTROL_FLAG_ENABLE_VBV_SIZES;
    if (rate.qpRange) desc.Flags |= D3D12_VIDEO_ENCODER_RATE_CONTROL_FLAG_ENABLE_QP_RANGE;
    if (rate.frameSizeCap)
        desc.Flags |= D3D12_VIDEO_ENCODER_RATE_CONTROL_FLAG_ENABLE_MAX_FRAME_SIZE;
}

void VideoEncodeCaps12::RateControl::setBitrate(uint32_t bitsPerSecond, int fps, int vbvFrames)
{
    cbr.TargetBitRate = bitsPerSecond;
    cbr.VBVCapacity = vbvBits(bitsPerSecond, fps, vbvFrames);
    cbr.InitialVBVFullness = cbr.VBVCapacity;
    cbr.MaxFrameBitSize = cbr.VBVCapacity;
    cbr1.TargetBitRate = cbr.TargetBitRate;
    cbr1.VBVCapacity = cbr.VBVCapacity;
    cbr1.InitialVBVFullness = cbr.InitialVBVFullness;
    cbr1.MaxFrameBitSize = cbr.MaxFrameBitSize;
}

void VideoEncodeCaps12::RateControl::setQp(UINT qp)
{
    cqp = {qp, qp, qp};
    cqp1.ConstantQP_FullIntracodedFrame = qp;
    cqp1.ConstantQP_InterPredictedFrame_PrevRefOnly = qp;
    cqp1.ConstantQP_InterPredictedFrame_BiDirectionalRef = qp;
}

HevcDriverLimits VideoEncodeCaps12::limits(bool tenBit)
{
    HevcDriverLimits l;
    if (!m_Video) return l;
    D3D12_VIDEO_ENCODER_PROFILE_HEVC prof = profile(tenBit);

    D3D12_FEATURE_DATA_VIDEO_ENCODER_OUTPUT_RESOLUTION_RATIOS_COUNT count = {};
    count.Codec = D3D12_VIDEO_ENCODER_CODEC_HEVC;
    feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_OUTPUT_RESOLUTION_RATIOS_COUNT, count);
    std::vector<D3D12_VIDEO_ENCODER_PICTURE_RESOLUTION_RATIO_DESC> ratios(
        count.ResolutionRatiosCount ? count.ResolutionRatiosCount : 1);
    D3D12_FEATURE_DATA_VIDEO_ENCODER_OUTPUT_RESOLUTION res = {};
    res.Codec = D3D12_VIDEO_ENCODER_CODEC_HEVC;
    res.ResolutionRatiosCount = count.ResolutionRatiosCount;
    res.pResolutionRatios = count.ResolutionRatiosCount ? ratios.data() : nullptr;
    if (feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_OUTPUT_RESOLUTION, res) &&
        res.IsSupported != 0) {
        l.minWidth = res.MinResolutionSupported.Width;
        l.minHeight = res.MinResolutionSupported.Height;
        l.maxWidth = res.MaxResolutionSupported.Width;
        l.maxHeight = res.MaxResolutionSupported.Height;
    }

    D3D12_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT_HEVC pc = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT pcs = {};
    pcs.Codec = D3D12_VIDEO_ENCODER_CODEC_HEVC;
    pcs.Profile = profileDesc(prof);
    pcs.PictureSupport.DataSize = sizeof(pc);
    pcs.PictureSupport.pHEVCSupport = &pc;
    if (feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT, pcs) &&
        pcs.IsSupported != 0) {
        l.maxL0ForP = pc.MaxL0ReferencesForP;
        l.maxDpb = pc.MaxDPBCapacity;
    }

    D3D12_VIDEO_ENCODER_PROFILE_HEVC main10 = D3D12_VIDEO_ENCODER_PROFILE_HEVC_MAIN10;
    D3D12_FEATURE_DATA_VIDEO_ENCODER_INPUT_FORMAT input = {};
    input.Codec = D3D12_VIDEO_ENCODER_CODEC_HEVC;
    input.Profile = profileDesc(main10);
    input.Format = DXGI_FORMAT_P010;
    l.main10 = feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_INPUT_FORMAT, input) &&
               input.IsSupported != 0;
    return l;
}

HevcBlocksAnswer VideoEncodeCaps12::blocks(const HevcBlocks& blocks, bool tenBit)
{
    HevcBlocksAnswer a;
    if (!m_Video) return a;
    D3D12_VIDEO_ENCODER_PROFILE_HEVC prof = profile(tenBit);
    const D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC proposal = configuration(blocks, a);
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT_HEVC caps = {};
    caps.MinLumaCodingUnitSize = proposal.MinLumaCodingUnitSize;
    caps.MaxLumaCodingUnitSize = proposal.MaxLumaCodingUnitSize;
    caps.MinLumaTransformUnitSize = proposal.MinLumaTransformUnitSize;
    caps.MaxLumaTransformUnitSize = proposal.MaxLumaTransformUnitSize;
    caps.max_transform_hierarchy_depth_inter = proposal.max_transform_hierarchy_depth_inter;
    caps.max_transform_hierarchy_depth_intra = proposal.max_transform_hierarchy_depth_intra;
    D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT support = {};
    support.Codec = D3D12_VIDEO_ENCODER_CODEC_HEVC;
    support.Profile = profileDesc(prof);
    support.CodecSupportLimits.DataSize = sizeof(caps);
    support.CodecSupportLimits.pHEVCSupport = &caps;
    if (!feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT, support) ||
        support.IsSupported == 0)
        return a;
    a.taken = true;
    a.ampRequired =
        (caps.SupportFlags &
         D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT_HEVC_FLAG_ASYMETRIC_MOTION_PARTITION_REQUIRED) !=
        0;
    a.pAsLowDelayB =
        (caps.SupportFlags &
         D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT_HEVC_FLAG_P_FRAMES_IMPLEMENTED_AS_LOW_DELAY_B_FRAMES) !=
        0;
    return a;
}

HevcSupportAnswer VideoEncodeCaps12::support(const HevcSupportQuestion& q)
{
    HevcSupportAnswer a;
    if (!m_Video) return a;
    // No profile in the question: the input format says Main or Main 10, and
    // the driver suggests the profile back.
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC config = configuration(q.blocks, q.blockFlags);
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION codec = {};
    codec.DataSize = sizeof(config);
    codec.pHEVCConfig = &config;
    // The product's sequence: endless, P only, an 8-bit POC (ParameterSets.h).
    D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE_HEVC gop = {0, 1, 4};
    D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE gopDesc = {};
    gopDesc.DataSize = sizeof(gop);
    gopDesc.pHEVCGroupOfPictures = &gop;
    const RateControl rate(q.rate, q.fps, 20000000);
    D3D12_VIDEO_ENCODER_PICTURE_RESOLUTION_DESC res = {q.codedWidth, q.codedHeight};

    D3D12_VIDEO_ENCODER_PROFILE_HEVC suggestedProfile = {};
    D3D12_VIDEO_ENCODER_LEVEL_TIER_CONSTRAINTS_HEVC suggestedLevel = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_RESOLUTION_SUPPORT_LIMITS limits = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_SUPPORT1 s = {};
    s.Codec = D3D12_VIDEO_ENCODER_CODEC_HEVC;
    s.InputFormat = q.tenBit ? DXGI_FORMAT_P010 : DXGI_FORMAT_NV12;
    s.CodecConfiguration = codec;
    s.CodecGopSequence = gopDesc;
    s.RateControl = rate.desc;
    s.IntraRefresh = q.intraRefresh ? D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_ROW_BASED
                                    : D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_NONE;
    s.SubregionFrameEncoding = D3D12_VIDEO_ENCODER_FRAME_SUBREGION_LAYOUT_MODE_FULL_FRAME;
    s.ResolutionsListCount = 1;
    s.pResolutionList = &res;
    s.MaxReferenceFramesInDPB = q.dpb;
    s.SuggestedProfile.DataSize = sizeof(suggestedProfile);
    s.SuggestedProfile.pHEVCProfile = &suggestedProfile;
    s.SuggestedLevel.DataSize = sizeof(suggestedLevel);
    s.SuggestedLevel.pHEVCLevelSetting = &suggestedLevel;
    s.pResolutionDependentSupport = &limits;
    // SUPPORT1 knows QualityVsSpeed; a runtime or driver without it takes the
    // original structure, which is SUPPORT1 without its last members.
    HRESULT asked =
        m_Video->CheckFeatureSupport(D3D12_FEATURE_VIDEO_ENCODER_SUPPORT1, &s, sizeof(s));
    if (FAILED(asked) && !q.rate.qualityVsSpeed)
        asked = m_Video->CheckFeatureSupport(D3D12_FEATURE_VIDEO_ENCODER_SUPPORT, &s,
                                             sizeof(D3D12_FEATURE_DATA_VIDEO_ENCODER_SUPPORT));
    if (FAILED(asked) ||
        (s.SupportFlags & D3D12_VIDEO_ENCODER_SUPPORT_FLAG_GENERAL_SUPPORT_OK) == 0)
        return a;
    a.ok = true;
    a.rateReconfigurable =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_RATE_CONTROL_RECONFIGURATION_AVAILABLE) != 0;
    a.reconTextureArray =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_RECONSTRUCTED_FRAMES_REQUIRE_TEXTURE_ARRAYS) != 0;
    a.reconReadable =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_READABLE_RECONSTRUCTED_PICTURE_LAYOUT_AVAILABLE) != 0;
    a.suggestedLevelIdc = levelIdc(suggestedLevel.Level);
    a.qpMapRegion = limits.QPMapRegionPixelsSize;
    a.maxIntraRefreshFrames = limits.MaxIntraRefreshFrameDuration;
    a.maxQualityVsSpeed = s.MaxQualityVsSpeed;
    m_Level = suggestedLevel;
    return a;
}

// ── H.264 ───────────────────────────────────────────────────────────────────

namespace {

D3D12_VIDEO_ENCODER_PROFILE_DESC profileDesc(D3D12_VIDEO_ENCODER_PROFILE_H264& profile)
{
    D3D12_VIDEO_ENCODER_PROFILE_DESC d = {};
    d.DataSize = sizeof(profile);
    d.pH264Profile = &profile;
    return d;
}

} // namespace

VideoEncodeCapsH264::VideoEncodeCapsH264(ID3D12VideoDevice3* video)
    : m_Video(video)
{}

D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264
VideoEncodeCapsH264::codecConfiguration(bool cabac, bool transform8x8)
{
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264 c = {};
    if (cabac)
        c.ConfigurationFlags |=
            D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264_FLAG_ENABLE_CABAC_ENCODING;
    if (transform8x8)
        c.ConfigurationFlags |=
            D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264_FLAG_USE_ADAPTIVE_8x8_TRANSFORM;
    // No B pictures, so no direct prediction; every edge filtered, as the
    // slices' disable_deblocking_filter_idc 0 says.
    c.DirectModeConfig = D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264_DIRECT_MODES_DISABLED;
    c.DisableDeblockingFilterConfig =
        D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264_SLICES_DEBLOCKING_MODE_0_ALL_LUMA_CHROMA_SLICE_BLOCK_EDGES_ALWAYS_FILTERED;
    return c;
}

D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE_H264 VideoEncodeCapsH264::gop()
{
    D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE_H264 g = {};
    g.GOPLength = 0;      // endless: IDRs on demand
    g.PPicturePeriod = 1; // no B pictures
    g.pic_order_cnt_type = 2;
    g.log2_max_frame_num_minus4 = 12;
    g.log2_max_pic_order_cnt_lsb_minus4 = 0; // unused with POC type 2
    return g;
}

int VideoEncodeCapsH264::levelIdc(D3D12_VIDEO_ENCODER_LEVELS_H264 level)
{
    static const int kIdc[] = {10, 9,  11, 12, 13, 20, 21, 22, 30, 31,
                               32, 40, 41, 42, 50, 51, 52, 60, 61, 62};
    const int i = static_cast<int>(level);
    return i >= 0 && i < 20 ? kIdc[i] : 0;
}

H264DriverLimits VideoEncodeCapsH264::limits()
{
    H264DriverLimits l;
    if (!m_Video) return l;
    D3D12_VIDEO_ENCODER_PROFILE_H264 prof = profile();

    D3D12_FEATURE_DATA_VIDEO_ENCODER_OUTPUT_RESOLUTION_RATIOS_COUNT count = {};
    count.Codec = D3D12_VIDEO_ENCODER_CODEC_H264;
    feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_OUTPUT_RESOLUTION_RATIOS_COUNT, count);
    std::vector<D3D12_VIDEO_ENCODER_PICTURE_RESOLUTION_RATIO_DESC> ratios(
        count.ResolutionRatiosCount ? count.ResolutionRatiosCount : 1);
    D3D12_FEATURE_DATA_VIDEO_ENCODER_OUTPUT_RESOLUTION res = {};
    res.Codec = D3D12_VIDEO_ENCODER_CODEC_H264;
    res.ResolutionRatiosCount = count.ResolutionRatiosCount;
    res.pResolutionRatios = count.ResolutionRatiosCount ? ratios.data() : nullptr;
    if (feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_OUTPUT_RESOLUTION, res) &&
        res.IsSupported != 0) {
        l.minWidth = res.MinResolutionSupported.Width;
        l.minHeight = res.MinResolutionSupported.Height;
        l.maxWidth = res.MaxResolutionSupported.Width;
        l.maxHeight = res.MaxResolutionSupported.Height;
    }

    D3D12_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT_H264 pc = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT pcs = {};
    pcs.Codec = D3D12_VIDEO_ENCODER_CODEC_H264;
    pcs.Profile = profileDesc(prof);
    pcs.PictureSupport.DataSize = sizeof(pc);
    pcs.PictureSupport.pH264Support = &pc;
    if (feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT, pcs) &&
        pcs.IsSupported != 0) {
        l.maxL0ForP = pc.MaxL0ReferencesForP;
        l.maxDpb = pc.MaxDPBCapacity;
    }
    return l;
}

H264ConfigAnswer VideoEncodeCapsH264::configuration()
{
    H264ConfigAnswer a;
    if (!m_Video) return a;
    D3D12_VIDEO_ENCODER_PROFILE_H264 prof = profile();
    // The driver fills the structure in: what it codes, and which deblocking
    // modes.
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT_H264 caps = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT support = {};
    support.Codec = D3D12_VIDEO_ENCODER_CODEC_H264;
    support.Profile = profileDesc(prof);
    support.CodecSupportLimits.DataSize = sizeof(caps);
    support.CodecSupportLimits.pH264Support = &caps;
    if (!feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT, support) ||
        support.IsSupported == 0)
        return a;
    a.taken = true;
    a.cabac =
        (caps.SupportFlags &
         D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT_H264_FLAG_CABAC_ENCODING_SUPPORT) != 0;
    a.transform8x8 =
        (caps.SupportFlags &
         D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT_H264_FLAG_ADAPTIVE_8x8_TRANSFORM_ENCODING_SUPPORT) !=
        0;
    a.deblockingAllEdges =
        (caps.DisableDeblockingFilterSupportedModes &
         D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264_SLICES_DEBLOCKING_MODE_FLAG_0_ALL_LUMA_CHROMA_SLICE_BLOCK_EDGES_ALWAYS_FILTERED) !=
        0;
    return a;
}

HevcSupportAnswer VideoEncodeCapsH264::support(const H264SupportQuestion& q)
{
    HevcSupportAnswer a;
    if (!m_Video) return a;
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264 config =
        codecConfiguration(q.cabac, q.transform8x8);
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION codec = {};
    codec.DataSize = sizeof(config);
    codec.pH264Config = &config;
    D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE_H264 g = gop();
    D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE gopDesc = {};
    gopDesc.DataSize = sizeof(g);
    gopDesc.pH264GroupOfPictures = &g;
    const VideoEncodeCaps12::RateControl rate(q.rate, q.fps, 20000000);
    D3D12_VIDEO_ENCODER_PICTURE_RESOLUTION_DESC res = {q.codedWidth, q.codedHeight};

    D3D12_VIDEO_ENCODER_PROFILE_H264 suggestedProfile = {};
    D3D12_VIDEO_ENCODER_LEVELS_H264 suggestedLevel = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_RESOLUTION_SUPPORT_LIMITS limits = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_SUPPORT1 s = {};
    s.Codec = D3D12_VIDEO_ENCODER_CODEC_H264;
    s.InputFormat = DXGI_FORMAT_NV12;
    s.CodecConfiguration = codec;
    s.CodecGopSequence = gopDesc;
    s.RateControl = rate.desc;
    s.IntraRefresh = q.intraRefresh ? D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_ROW_BASED
                                    : D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_NONE;
    s.SubregionFrameEncoding = D3D12_VIDEO_ENCODER_FRAME_SUBREGION_LAYOUT_MODE_FULL_FRAME;
    s.ResolutionsListCount = 1;
    s.pResolutionList = &res;
    s.MaxReferenceFramesInDPB = 1;
    s.SuggestedProfile.DataSize = sizeof(suggestedProfile);
    s.SuggestedProfile.pH264Profile = &suggestedProfile;
    s.SuggestedLevel.DataSize = sizeof(suggestedLevel);
    s.SuggestedLevel.pH264LevelSetting = &suggestedLevel;
    s.pResolutionDependentSupport = &limits;
    HRESULT asked =
        m_Video->CheckFeatureSupport(D3D12_FEATURE_VIDEO_ENCODER_SUPPORT1, &s, sizeof(s));
    if (FAILED(asked) && !q.rate.qualityVsSpeed)
        asked = m_Video->CheckFeatureSupport(D3D12_FEATURE_VIDEO_ENCODER_SUPPORT, &s,
                                             sizeof(D3D12_FEATURE_DATA_VIDEO_ENCODER_SUPPORT));
    if (FAILED(asked) ||
        (s.SupportFlags & D3D12_VIDEO_ENCODER_SUPPORT_FLAG_GENERAL_SUPPORT_OK) == 0)
        return a;
    a.ok = true;
    a.rateReconfigurable =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_RATE_CONTROL_RECONFIGURATION_AVAILABLE) != 0;
    a.reconTextureArray =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_RECONSTRUCTED_FRAMES_REQUIRE_TEXTURE_ARRAYS) != 0;
    a.reconReadable =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_READABLE_RECONSTRUCTED_PICTURE_LAYOUT_AVAILABLE) != 0;
    a.suggestedLevelIdc = levelIdc(suggestedLevel);
    a.qpMapRegion = limits.QPMapRegionPixelsSize;
    a.maxIntraRefreshFrames = limits.MaxIntraRefreshFrameDuration;
    a.maxQualityVsSpeed = s.MaxQualityVsSpeed;
    m_Level = suggestedLevel;
    return a;
}

// ── AV1 ─────────────────────────────────────────────────────────────────────

namespace {

D3D12_VIDEO_ENCODER_PROFILE_DESC profileDesc(D3D12_VIDEO_ENCODER_AV1_PROFILE& profile)
{
    D3D12_VIDEO_ENCODER_PROFILE_DESC d = {};
    d.DataSize = sizeof(profile);
    d.pAV1Profile = &profile;
    return d;
}

} // namespace

VideoEncodeCapsAv1::VideoEncodeCapsAv1(ID3D12VideoDevice3* video)
    : m_Video(video)
{}

D3D12_VIDEO_ENCODER_AV1_CODEC_CONFIGURATION
VideoEncodeCapsAv1::codecConfiguration(uint32_t features, int orderHintBits)
{
    D3D12_VIDEO_ENCODER_AV1_CODEC_CONFIGURATION c = {};
    c.FeatureFlags = static_cast<D3D12_VIDEO_ENCODER_AV1_FEATURE_FLAGS>(features);
    c.OrderHintBitsMinus1 = static_cast<UINT>(orderHintBits > 0 ? orderHintBits - 1 : 7);
    return c;
}

Av1DriverLimits VideoEncodeCapsAv1::limits(bool tenBit)
{
    Av1DriverLimits l;
    if (!m_Video) return l;
    D3D12_FEATURE_DATA_VIDEO_ENCODER_OUTPUT_RESOLUTION_RATIOS_COUNT count = {};
    count.Codec = D3D12_VIDEO_ENCODER_CODEC_AV1;
    feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_OUTPUT_RESOLUTION_RATIOS_COUNT, count);
    std::vector<D3D12_VIDEO_ENCODER_PICTURE_RESOLUTION_RATIO_DESC> ratios(
        count.ResolutionRatiosCount ? count.ResolutionRatiosCount : 1);
    D3D12_FEATURE_DATA_VIDEO_ENCODER_OUTPUT_RESOLUTION res = {};
    res.Codec = D3D12_VIDEO_ENCODER_CODEC_AV1;
    res.ResolutionRatiosCount = count.ResolutionRatiosCount;
    res.pResolutionRatios = count.ResolutionRatiosCount ? ratios.data() : nullptr;
    if (feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_OUTPUT_RESOLUTION, res) &&
        res.IsSupported != 0) {
        l.minWidth = res.MinResolutionSupported.Width;
        l.minHeight = res.MinResolutionSupported.Height;
        l.maxWidth = res.MaxResolutionSupported.Width;
        l.maxHeight = res.MaxResolutionSupported.Height;
        l.widthMultiple = res.ResolutionWidthMultipleRequirement;
        l.heightMultiple = res.ResolutionHeightMultipleRequirement;
    }
    D3D12_VIDEO_ENCODER_AV1_PROFILE main = profile();
    D3D12_FEATURE_DATA_VIDEO_ENCODER_INPUT_FORMAT input = {};
    input.Codec = D3D12_VIDEO_ENCODER_CODEC_AV1;
    input.Profile = profileDesc(main);
    input.Format = DXGI_FORMAT_P010;
    l.tenBit = feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_INPUT_FORMAT, input) &&
               input.IsSupported != 0;
    (void)tenBit;
    return l;
}

Av1ConfigAnswer VideoEncodeCapsAv1::configuration()
{
    Av1ConfigAnswer a;
    if (!m_Video) return a;
    D3D12_VIDEO_ENCODER_AV1_PROFILE prof = profile();
    D3D12_VIDEO_ENCODER_AV1_CODEC_CONFIGURATION_SUPPORT caps = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT support = {};
    support.Codec = D3D12_VIDEO_ENCODER_CODEC_AV1;
    support.Profile = profileDesc(prof);
    support.CodecSupportLimits.DataSize = sizeof(caps);
    support.CodecSupportLimits.pAV1Support = &caps;
    if (!feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_CODEC_CONFIGURATION_SUPPORT, support) ||
        support.IsSupported == 0)
        return a;
    a.taken = true;
    a.supported = static_cast<uint32_t>(caps.SupportedFeatureFlags);
    a.required = static_cast<uint32_t>(caps.RequiredFeatureFlags);
    a.postEncode = static_cast<uint32_t>(caps.PostEncodeValuesFlags);
    a.filters = static_cast<uint32_t>(caps.SupportedInterpolationFilters);
    a.txKey =
        static_cast<uint32_t>(caps.SupportedTxModes[D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_KEY_FRAME]);
    a.txInter = static_cast<uint32_t>(
        caps.SupportedTxModes[D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_INTER_FRAME]);

    D3D12_VIDEO_ENCODER_CODEC_AV1_PICTURE_CONTROL_SUPPORT pc = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT pcs = {};
    pcs.Codec = D3D12_VIDEO_ENCODER_CODEC_AV1;
    pcs.Profile = profileDesc(prof);
    pcs.PictureSupport.DataSize = sizeof(pc);
    pcs.PictureSupport.pAV1Support = &pc;
    const UINT both = D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_FLAG_KEY_FRAME |
                      D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_FLAG_INTER_FRAME;
    a.keyAndInterFrames =
        feature(m_Video.Get(), D3D12_FEATURE_VIDEO_ENCODER_CODEC_PICTURE_CONTROL_SUPPORT, pcs) &&
        pcs.IsSupported != 0 && (static_cast<UINT>(pc.SupportedFrameTypes) & both) == both &&
        pc.MaxUniqueReferencesPerFrame >= 1;
    return a;
}

HevcSupportAnswer VideoEncodeCapsAv1::support(const Av1SupportQuestion& q)
{
    HevcSupportAnswer a;
    if (!m_Video) return a;
    D3D12_VIDEO_ENCODER_AV1_CODEC_CONFIGURATION config =
        codecConfiguration(q.features, q.orderHintBits);
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION codec = {};
    codec.DataSize = sizeof(config);
    codec.pAV1Config = &config;
    D3D12_VIDEO_ENCODER_AV1_SEQUENCE_STRUCTURE seq = sequence();
    D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE gopDesc = {};
    gopDesc.DataSize = sizeof(seq);
    gopDesc.pAV1SequenceStructure = &seq;
    const VideoEncodeCaps12::RateControl rate(q.rate, q.fps, 20000000, true);
    D3D12_VIDEO_ENCODER_PICTURE_RESOLUTION_DESC res = {q.codedWidth, q.codedHeight};

    D3D12_VIDEO_ENCODER_AV1_PROFILE suggestedProfile = {};
    D3D12_VIDEO_ENCODER_AV1_LEVEL_TIER_CONSTRAINTS suggestedLevel = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_RESOLUTION_SUPPORT_LIMITS limits = {};
    D3D12_FEATURE_DATA_VIDEO_ENCODER_SUPPORT1 s = {};
    s.Codec = D3D12_VIDEO_ENCODER_CODEC_AV1;
    s.InputFormat = q.tenBit ? DXGI_FORMAT_P010 : DXGI_FORMAT_NV12;
    s.CodecConfiguration = codec;
    s.CodecGopSequence = gopDesc;
    s.RateControl = rate.desc;
    s.IntraRefresh = q.intraRefresh ? D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_ROW_BASED
                                    : D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_NONE;
    s.SubregionFrameEncoding = D3D12_VIDEO_ENCODER_FRAME_SUBREGION_LAYOUT_MODE_FULL_FRAME;
    s.ResolutionsListCount = 1;
    s.pResolutionList = &res;
    s.MaxReferenceFramesInDPB = 1;
    s.SuggestedProfile.DataSize = sizeof(suggestedProfile);
    s.SuggestedProfile.pAV1Profile = &suggestedProfile;
    s.SuggestedLevel.DataSize = sizeof(suggestedLevel);
    s.SuggestedLevel.pAV1LevelSetting = &suggestedLevel;
    s.pResolutionDependentSupport = &limits;
    HRESULT asked =
        m_Video->CheckFeatureSupport(D3D12_FEATURE_VIDEO_ENCODER_SUPPORT1, &s, sizeof(s));
    if (FAILED(asked) && !q.rate.qualityVsSpeed)
        asked = m_Video->CheckFeatureSupport(D3D12_FEATURE_VIDEO_ENCODER_SUPPORT, &s,
                                             sizeof(D3D12_FEATURE_DATA_VIDEO_ENCODER_SUPPORT));
    if (FAILED(asked) ||
        (s.SupportFlags & D3D12_VIDEO_ENCODER_SUPPORT_FLAG_GENERAL_SUPPORT_OK) == 0)
        return a;
    a.ok = true;
    a.rateReconfigurable =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_RATE_CONTROL_RECONFIGURATION_AVAILABLE) != 0;
    a.reconTextureArray =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_RECONSTRUCTED_FRAMES_REQUIRE_TEXTURE_ARRAYS) != 0;
    a.reconReadable =
        (s.SupportFlags &
         D3D12_VIDEO_ENCODER_SUPPORT_FLAG_READABLE_RECONSTRUCTED_PICTURE_LAYOUT_AVAILABLE) != 0;
    a.suggestedLevelIdc = static_cast<int>(suggestedLevel.Level);
    a.qpMapRegion = limits.QPMapRegionPixelsSize;
    a.maxIntraRefreshFrames = limits.MaxIntraRefreshFrameDuration;
    a.maxQualityVsSpeed = s.MaxQualityVsSpeed;
    return a;
}

} // namespace mw::native::encode
