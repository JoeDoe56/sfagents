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

#include "encode/windows/d3d12/VideoEncode12.h"

#include "core/Log.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace mw::native::encode {

using Microsoft::WRL::ComPtr;

namespace {

/// A GPU that takes this long over one picture is gone, not slow (plan §3.1,
/// d3d12::kGpuGoneMs): the session goes back to D3D11 rather than freezing on
/// it.
constexpr uint32_t kWaitMs = d3d12::kGpuGoneMs;

/// Pictures whose slice headers are read back with our SPS and PPS: the IDR
/// and the P pictures after it. HevcSliceParser is a sieve — a wrong PPS can
/// land on one header's alignment by chance, it does not land on six.
constexpr int kGuardedPictures = 6;

/// Pictures in a row whose QP, as the driver says it, is not the one asked,
/// before our rate control is taken to have lost its lever: one may be a
/// driver rounding an average, three are a driver that stopped listening.
constexpr int kQpMisses = 3;

/// Room in front of an AV1 tile for the headers written after the picture:
/// a temporal delimiter (2 bytes), a sequence header (~20), OBU_FRAME's
/// header and size and a frame header — ~100 bytes with eight segments'
/// features, loop filter deltas and eight CDEF strengths.
constexpr UINT64 kAv1HeaderRoom = 512;

/// The resolved metadata's room for tiles or slices: one is asked for.
constexpr UINT64 kMaxSubregions = 64;

/// D3D12's index for a reference slot that holds nothing.
constexpr UINT kUnusedSlot = 0xFF;

/// The picture flags the AV1 configuration's features want on every picture:
/// D3D12's validation refuses a required feature left off a picture — the
/// RTX requires auto segmentation (28/09/2026). The frame header says the
/// same (finishAv1).
D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAGS av1PictureFlags(uint32_t features)
{
    UINT f = D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_NONE;
    if (features & av1feature::kAutoSegmentation)
        f |= D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_ENABLE_FRAME_SEGMENTATION_AUTO;
    if (features & av1feature::kWarpedMotion)
        f |= D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_ENABLE_WARPED_MOTION;
    if (features & av1feature::kReducedTxSet)
        f |= D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_REDUCED_TX_SET;
    if (features & av1feature::kMotionModeSwitchable)
        f |= D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_MOTION_MODE_SWITCHABLE;
    if (features & av1feature::kHighPrecisionMv)
        f |= D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_ALLOW_HIGH_PRECISION_MV;
    if (features & av1feature::kSkipMode)
        f |= D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_ENABLE_SKIP_MODE;
    if (features & av1feature::kRefFrameMvs)
        f |= D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAG_FRAME_REFERENCE_MOTION_VECTORS;
    return static_cast<D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_FLAGS>(f);
}

D3D12_RESOURCE_BARRIER transition(ID3D12Resource* resource, D3D12_RESOURCE_STATES before,
                                  D3D12_RESOURCE_STATES after,
                                  UINT subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES)
{
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = resource;
    b.Transition.Subresource = subresource;
    b.Transition.StateBefore = before;
    b.Transition.StateAfter = after;
    return b;
}

D3D12_RESOURCE_DESC bufferDesc(UINT64 size)
{
    D3D12_RESOURCE_DESC rd = {};
    rd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    rd.Width = size;
    rd.Height = 1;
    rd.DepthOrArraySize = 1;
    rd.MipLevels = 1;
    rd.SampleDesc.Count = 1;
    rd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    return rd;
}

/// A buffer in system memory the GPU writes and the CPU reads in place — the
/// bitstream and the metadata: no copy on the GPU, and none waited for.
ComPtr<ID3D12Resource> systemBuffer(ID3D12Device* device, UINT64 size)
{
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_CUSTOM;
    hp.CPUPageProperty = D3D12_CPU_PAGE_PROPERTY_WRITE_BACK;
    hp.MemoryPoolPreference = D3D12_MEMORY_POOL_L0;
    const D3D12_RESOURCE_DESC rd = bufferDesc(size);
    ComPtr<ID3D12Resource> r;
    device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd, D3D12_RESOURCE_STATE_COMMON,
                                    nullptr, IID_PPV_ARGS(&r));
    return r;
}

ComPtr<ID3D12Resource> videoBuffer(ID3D12Device* device, UINT64 size)
{
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_DEFAULT;
    const D3D12_RESOURCE_DESC rd = bufferDesc(size);
    ComPtr<ID3D12Resource> r;
    device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd, D3D12_RESOURCE_STATE_COMMON,
                                    nullptr, IID_PPV_ARGS(&r));
    return r;
}

ComPtr<ID3D12Resource> texture(ID3D12Device* device, UINT width, UINT height, UINT16 slices,
                               DXGI_FORMAT format, D3D12_RESOURCE_FLAGS flags)
{
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_DEFAULT;
    D3D12_RESOURCE_DESC rd = {};
    rd.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    rd.Width = width;
    rd.Height = height;
    rd.DepthOrArraySize = slices;
    rd.MipLevels = 1;
    rd.Format = format;
    rd.SampleDesc.Count = 1;
    rd.Flags = flags;
    ComPtr<ID3D12Resource> r;
    device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd, D3D12_RESOURCE_STATE_COMMON,
                                    nullptr, IID_PPV_ARGS(&r));
    return r;
}

std::string hex(uint64_t value)
{
    char text[24];
    std::snprintf(text, sizeof(text), "0x%llx", static_cast<unsigned long long>(value));
    return text;
}

std::string levelText(int idc)
{
    return std::to_string(idc / 30) + (idc % 30 ? "." + std::to_string(idc % 30 / 3) : "");
}

/// H.264's level_idc counts tenths; 9 is level 1b.
std::string h264LevelText(int idc)
{
    if (idc == 9) return "1b";
    return std::to_string(idc / 10) + (idc % 10 ? "." + std::to_string(idc % 10) : "");
}

/// The QP of the picture's first slice (SliceQpY), -1 if it does not read.
/// Only its header is read, and the scan stops there.
int firstSliceQp(const uint8_t* data, size_t size, const HevcSpsFields& sps,
                 const HevcPpsFields& pps)
{
    for (size_t i = 0; i + 3 < size; ++i) {
        if (data[i] != 0 || data[i + 1] != 0 || data[i + 2] != 1) continue;
        const uint8_t* unit = data + i + 3;
        if (((unit[0] >> 1) & 0x3f) > 31) continue; // an AUD or an SEI in front
        HevcSliceFields f;
        return parseHevcSliceHeader(unit, size - i - 3, sps, pps, f).empty() ? f.qp : -1;
    }
    return -1;
}

int firstH264SliceQp(const uint8_t* data, size_t size, const H264SpsFields& sps,
                     const H264PpsFields& pps)
{
    for (size_t i = 0; i + 3 < size; ++i) {
        if (data[i] != 0 || data[i + 1] != 0 || data[i + 2] != 1) continue;
        const uint8_t* unit = data + i + 3;
        const uint32_t type = unit[0] & 0x1Fu;
        if (type != 1 && type != 5) continue; // an AUD or an SEI in front
        H264SliceFields f;
        return parseH264SliceHeader(unit, size - i - 3, sps, pps, f).empty() ? f.qp : -1;
    }
    return -1;
}

/// The negotiation, then — where the driver's CBR cannot move its target in
/// flight — ours on a constant QP (plan §4.6); a driver that takes no constant
/// QP either keeps its CBR, at the bitrate it starts with. Either codec.
template <typename Setup, typename Request, typename Negotiate>
Setup settle(const Request& request, const EncoderTuning& tuning, const Negotiate& negotiate,
             const std::string& deviceName, std::string& rateWhy)
{
    Setup s = negotiate(request);
    if (!s.ok || tuning.rc12 != EncoderTuning::RateControl12::Default ||
        s.support.rateReconfigurable)
        return s;
    Request own = request;
    own.ownRateControl = true;
    Setup ownSetup = negotiate(own);
    if (ownSetup.ok) {
        rateWhy = "the driver moves its bitrate only with a new sequence";
        return ownSetup;
    }
    log::warning("[native] D3D12 Video Encode on " + deviceName + " takes no constant QP (" +
                 ownSetup.reason + "): the bitrate stays where it starts");
    // The level the driver suggests is the last "yes" it gave.
    return negotiate(request);
}

} // namespace

VideoEncode12::~VideoEncode12()
{
    stop();
}

bool VideoEncode12::init(const std::shared_ptr<d3d12::D3d12Device>& device, Codec codec, int width,
                         int height, int fps, int bitrateKbps, bool hdr, bool intraRefresh,
                         const EncoderTuning& tuning, std::string& error)
{
    stop();
    if (codec != Codec::Hevc && codec != Codec::H264 && codec != Codec::Av1) {
        error = std::string("D3D12 Video Encode does not do ") + toString(codec);
        return false;
    }
    if (codec == Codec::H264 && hdr) {
        error = "H.264 goes out in 8 bits: no HDR";
        return false;
    }
    if (codec == Codec::Av1 && tuning.rc12 == EncoderTuning::RateControl12::Qp) {
        error = "rc12=qp: our rate control speaks HEVC's and H.264's QP, not AV1's qindex";
        return false;
    }
    if (!device || !device->device()) {
        error = "no D3D12 device";
        return false;
    }
    m_Device = device;
    if (FAILED(device->device()->QueryInterface(IID_PPV_ARGS(&m_Video)))) {
        error = "no ID3D12VideoDevice3 on " + device->name();
        stop();
        return false;
    }
    m_Codec = codec;
    const int rate = fps > 0 ? fps : 60;
    const bool rc12Qp = tuning.rc12 == EncoderTuning::RateControl12::Qp;
    // The driver's CBR where it can move its target in flight; ours where it
    // cannot, on a constant QP (plan §4.6).
    std::string rateWhy = rc12Qp ? "the bench's rc12=qp" : "";
    if (codec == Codec::H264) {
        VideoEncodeCapsH264 caps(m_Video.Get());
        H264EncodeRequest request;
        request.width = static_cast<uint32_t>((std::max)(width, 0));
        request.height = static_cast<uint32_t>((std::max)(height, 0));
        request.fps = rate;
        request.intraRefresh = intraRefresh;
        request.ownRateControl = rc12Qp;
        m_H264 = settle<H264EncodeSetup>(
            request, tuning, [&](const H264EncodeRequest& r) { return negotiateH264(r, caps); },
            device->name(), rateWhy);
        if (!m_H264.ok) {
            error = "D3D12 Video Encode takes no H.264 " + std::to_string(width) + "x" +
                    std::to_string(height) + " on " + device->name() + ": " + m_H264.reason;
            stop();
            return false;
        }
        // The part both codecs share, where the encoder reads it.
        m_Setup.ok = true;
        m_Setup.reason = m_H264.reason;
        m_Setup.rate = m_H264.rate;
        m_Setup.support = m_H264.support;
        m_Setup.codedWidth = m_H264.codedWidth;
        m_Setup.codedHeight = m_H264.codedHeight;
        m_Setup.dpbCapacity = 1;
        m_Setup.intraRefreshFrames = m_H264.intraRefreshFrames;
        m_Setup.queries = m_H264.queries;
        m_H264Level = caps.suggestedLevel();
        m_H264Config = VideoEncodeCapsH264::codecConfiguration(m_H264.cabac, m_H264.transform8x8);
        m_H264Gop = VideoEncodeCapsH264::gop();
    } else if (codec == Codec::Av1) {
        VideoEncodeCapsAv1 caps(m_Video.Get());
        Av1EncodeRequest request;
        request.width = static_cast<uint32_t>((std::max)(width, 0));
        request.height = static_cast<uint32_t>((std::max)(height, 0));
        request.fps = rate;
        request.hdr = hdr;
        request.intraRefresh = intraRefresh;
        m_Av1 = negotiateAv1(request, caps);
        if (!m_Av1.ok) {
            error = "D3D12 Video Encode takes no AV1 " + std::to_string(width) + "x" +
                    std::to_string(height) + " on " + device->name() + ": " + m_Av1.reason;
            stop();
            return false;
        }
        if (!m_Av1.support.rateReconfigurable)
            log::warning("[native] D3D12 Video Encode on " + device->name() +
                         " moves its AV1 bitrate only with a new sequence: the bitrate stays "
                         "where it starts");
        m_Setup.ok = true;
        m_Setup.reason = m_Av1.reason;
        m_Setup.rate = m_Av1.rate;
        m_Setup.support = m_Av1.support;
        m_Setup.codedWidth = m_Av1.codedWidth;
        m_Setup.codedHeight = m_Av1.codedHeight;
        m_Setup.dpbCapacity = 1;
        m_Setup.intraRefreshFrames = m_Av1.intraRefreshFrames;
        m_Setup.queries = m_Av1.queries;
        m_Av1Profile = VideoEncodeCapsAv1::profile();
        m_Av1Level.Level = static_cast<D3D12_VIDEO_ENCODER_AV1_LEVELS>(m_Av1.sequence.levelIdx);
        m_Av1Level.Tier = D3D12_VIDEO_ENCODER_AV1_TIER_MAIN;
        m_Av1Config =
            VideoEncodeCapsAv1::codecConfiguration(m_Av1.features, m_Av1.sequence.orderHintBits);
        m_Av1Sequence = VideoEncodeCapsAv1::sequence();
        m_RenderWidth = request.width != m_Av1.codedWidth ? request.width : 0;
        m_RenderHeight = request.height != m_Av1.codedHeight ? request.height : 0;
    } else {
        VideoEncodeCaps12 caps(m_Video.Get());
        HevcEncodeRequest request;
        request.width = static_cast<uint32_t>((std::max)(width, 0));
        request.height = static_cast<uint32_t>((std::max)(height, 0));
        request.fps = rate;
        request.hdr = hdr;
        request.intraRefresh = intraRefresh;
        request.dpbFrames = tuning.dpbFrames;
        request.ownRateControl = rc12Qp;
        m_Setup = settle<HevcEncodeSetup>(
            request, tuning, [&](const HevcEncodeRequest& r) { return negotiateHevc(r, caps); },
            device->name(), rateWhy);
        if (!m_Setup.ok) {
            error = "D3D12 Video Encode takes no HEVC " + std::to_string(width) + "x" +
                    std::to_string(height) + " on " + device->name() + ": " + m_Setup.reason;
            stop();
            return false;
        }
        m_Level = caps.suggestedLevel();
        m_Profile = VideoEncodeCaps12::profile(hdr);
        m_Config = VideoEncodeCaps12::configuration(m_Setup.blocks, m_Setup.blocksAnswer);
        // Endless, P only, the POC as wide as the SPS says.
        m_Gop = {0, 1, static_cast<UCHAR>(m_Setup.sequence.log2MaxPocLsb - 4)};
    }
    m_OwnRate = m_Setup.rate.mode == HevcRate::Mode::Cqp;
    m_Reencode = m_OwnRate && tuning.reencode12 != EncoderTuning::Choice::Off;
    m_Fps = rate;
    m_VbvFrames = tuning.vbvFrames;
    m_QueueRequest = d3d12::queueRequestFor(D3D12_COMMAND_LIST_TYPE_VIDEO_ENCODE, tuning,
                                            L"MoonlightWeb video encode");
    m_Format = hdr ? DXGI_FORMAT_P010 : DXGI_FORMAT_NV12;
    const uint32_t bitsPerSecond = static_cast<uint32_t>((std::max)(bitrateKbps, 1)) * 1000u;
    m_Rate = std::make_unique<VideoEncodeCaps12::RateControl>(m_Setup.rate, m_Fps, bitsPerSecond,
                                                              codec == Codec::Av1);
    if (m_OwnRate) {
        const double floor = tuning.interFloor12 > 0 ? -static_cast<double>(tuning.interFloor12)
                                                     : QpRateController::kNoInterFloor;
        m_Controller.start(bitsPerSecond, m_Fps, m_VbvFrames,
                           static_cast<uint64_t>(m_Setup.codedWidth) * m_Setup.codedHeight, floor);
        m_Controller.setReencodeFit(m_Reencode &&
                                    tuning.reencodeFit12 != EncoderTuning::Choice::Off);
        m_SubmittedQp = static_cast<int>(m_Rate->cqp.ConstantQP_FullIntracodedFrame);
    } else {
        m_Rate->setBitrate(bitsPerSecond, m_Fps, m_VbvFrames);
    }
    m_Dpb = HevcDpb(m_Setup.dpbCapacity, m_Fps);

    // The parameter sets, once for the session — and read back at once: a
    // writer that cannot read its own SPS has nothing to judge a slice with.
    m_Headers.clear();
    std::string unread;
    if (codec == Codec::H264) {
        const std::vector<uint8_t> sps = paramsets::h264Sps(m_H264.sequence);
        const std::vector<uint8_t> pps = paramsets::h264Pps(m_H264.sequence);
        m_Headers = sps;
        m_Headers.insert(m_Headers.end(), pps.begin(), pps.end());
        unread = parseH264Sps(sps.data(), sps.size(), m_H264Sps);
        if (unread.empty()) unread = parseH264Pps(pps.data(), pps.size(), m_H264Pps);
    } else if (codec == Codec::Av1) {
        // The sequence header, in front of every key frame.
        m_Headers = av1::sequenceHeader(m_Av1.sequence);
        const std::vector<av1::Obu> units = av1::obus(m_Headers.data(), m_Headers.size());
        av1::Sequence back;
        unread = units.size() == 1 && units[0].type == av1::ObuType::SequenceHeader
                     ? av1::parseSequenceHeader(units[0].payload, units[0].size, back)
                     : "not one sequence header OBU";
        if (unread.empty() &&
            (back.width != m_Av1.sequence.width || back.height != m_Av1.sequence.height))
            unread = "the size read back differs";
    } else {
        for (const auto& unit :
             {paramsets::hevcVps(m_Setup.sequence), paramsets::hevcSps(m_Setup.sequence),
              paramsets::hevcPps(m_Setup.sequence)})
            m_Headers.insert(m_Headers.end(), unit.begin(), unit.end());
        const std::vector<uint8_t> sps = paramsets::hevcSps(m_Setup.sequence);
        const std::vector<uint8_t> pps = paramsets::hevcPps(m_Setup.sequence);
        unread = parseHevcSps(sps.data(), sps.size(), m_SpsFields);
        if (unread.empty()) unread = parseHevcPps(pps.data(), pps.size(), m_PpsFields);
    }
    if (!unread.empty()) {
        error = "our own parameter sets do not read back: " + unread;
        stop();
        return false;
    }

    if (!createResources(error)) {
        stop();
        return false;
    }
    m_Timing = tuning.gpuTiming && setUpTiming();
    // The first encode costs what the next ones do not — the Arc spends
    // 12.7 ms on its first IDR, ~2.3 after (21/09/2026): paid here, on a blank
    // picture, and its slices are the first the guard reads, so a driver that
    // disagrees with our parameter sets is caught before the stream starts.
    if (!warmUp(error)) {
        error = "D3D12 Video Encode, first picture: " + error;
        stop();
        return false;
    }
    m_GuardLeft = kGuardedPictures;
    m_SliceQpMoves = false;
    m_IntraRefreshIndex = 0;
    m_LastReady = nullptr;
    m_LastReadyValue = 0;

    std::string shape;
    if (codec == Codec::H264) {
        shape = "level " + h264LevelText(m_H264.sequence.levelIdc) + ", " +
                (m_H264.cabac ? "CABAC" : "CAVLC") +
                (m_H264.transform8x8 ? ", 8x8 transform" : "") + ", 1 picture kept";
    } else if (codec == Codec::Av1) {
        const av1::Sequence& q = m_Av1.sequence;
        shape = "level " + std::to_string(2 + q.levelIdx / 4) + "." +
                std::to_string(q.levelIdx % 4) + ", one tile" + (q.cdef ? ", CDEF" : "") +
                (q.restoration ? ", loop restoration" : "") +
                (q.orderHintBits ? ", order hints" : "") + ", features " + hex(m_Av1.features) +
                ", values after the picture " + hex(m_Av1.postEncode) +
                (m_Av1.interpolationFilter == 4 ? ", switchable filters" : "") +
                ", 1 picture kept, first " + m_Av1Layout;
    } else {
        const HevcBlocks& b = m_Setup.blocks;
        shape = "level " + levelText(m_Setup.sequence.levelIdc) + ", blocks " +
                std::to_string(1 << b.log2MinCodingBlock) + ".." +
                std::to_string(1 << b.log2MaxCodingBlock) + " depth " + std::to_string(b.depth) +
                (m_Setup.blocksAnswer.ampRequired ? ", AMP" : "") +
                (m_Setup.blocksAnswer.pAsLowDelayB ? ", P as low-delay B" : "") + ", " +
                std::to_string(m_Dpb.capacity()) + " pictures kept (reach " +
                std::to_string(m_Dpb.reachFrames()) + " frames)";
    }
    log::info("[native] D3D12 Video Encode ready on " + device->name() + ": " +
              (codec == Codec::H264  ? "H.264 High "
               : codec == Codec::Av1 ? (hdr ? "AV1 Main 10-bit (BT.2020 PQ) " : "AV1 Main ")
               : hdr                 ? "HEVC Main 10 (BT.2020 PQ) "
                                     : "HEVC Main ") +
              std::to_string(width) + "x" + std::to_string(height) + " coded " +
              std::to_string(m_Setup.codedWidth) + "x" + std::to_string(m_Setup.codedHeight) + "@" +
              std::to_string(m_Fps) + ", " + m_Setup.rate.describe() +
              (m_OwnRate ? " moved by our own rate control (" + rateWhy + ")" +
                               (m_Reencode ? m_Controller.reencodeFit()
                                                 ? ", overshoots coded again under the line"
                                                 : ", overshoots coded again"
                                           : "") +
                               " at "
                         : std::string(" ")) +
              std::to_string(bitrateKbps) + " kbps, " + shape + ", " +
              (m_Setup.intraRefreshFrames > 0
                   ? "intra refresh over " + std::to_string(m_Setup.intraRefreshFrames) + " frames"
                   : std::string("keyframes on demand")) +
              ", " + m_Queue.description + (m_Setup.reason.empty() ? "" : " — " + m_Setup.reason));
    return true;
}

D3D12_VIDEO_ENCODER_CODEC VideoEncode12::d3d12Codec() const
{
    switch (m_Codec) {
    case Codec::H264: return D3D12_VIDEO_ENCODER_CODEC_H264;
    case Codec::Av1: return D3D12_VIDEO_ENCODER_CODEC_AV1;
    default: return D3D12_VIDEO_ENCODER_CODEC_HEVC;
    }
}

D3D12_VIDEO_ENCODER_PROFILE_DESC VideoEncode12::profileDesc()
{
    D3D12_VIDEO_ENCODER_PROFILE_DESC d = {};
    if (m_Codec == Codec::H264) {
        d.DataSize = sizeof(m_H264Profile);
        d.pH264Profile = &m_H264Profile;
    } else if (m_Codec == Codec::Av1) {
        d.DataSize = sizeof(m_Av1Profile);
        d.pAV1Profile = &m_Av1Profile;
    } else {
        d.DataSize = sizeof(m_Profile);
        d.pHEVCProfile = &m_Profile;
    }
    return d;
}

D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION VideoEncode12::configurationDesc()
{
    D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION d = {};
    if (m_Codec == Codec::H264) {
        d.DataSize = sizeof(m_H264Config);
        d.pH264Config = &m_H264Config;
    } else if (m_Codec == Codec::Av1) {
        d.DataSize = sizeof(m_Av1Config);
        d.pAV1Config = &m_Av1Config;
    } else {
        d.DataSize = sizeof(m_Config);
        d.pHEVCConfig = &m_Config;
    }
    return d;
}

D3D12_VIDEO_ENCODER_LEVEL_SETTING VideoEncode12::levelDesc()
{
    D3D12_VIDEO_ENCODER_LEVEL_SETTING d = {};
    if (m_Codec == Codec::H264) {
        d.DataSize = sizeof(m_H264Level);
        d.pH264LevelSetting = &m_H264Level;
    } else if (m_Codec == Codec::Av1) {
        d.DataSize = sizeof(m_Av1Level);
        d.pAV1LevelSetting = &m_Av1Level;
    } else {
        d.DataSize = sizeof(m_Level);
        d.pHEVCLevelSetting = &m_Level;
    }
    return d;
}

D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE VideoEncode12::gopDesc()
{
    D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE d = {};
    if (m_Codec == Codec::H264) {
        d.DataSize = sizeof(m_H264Gop);
        d.pH264GroupOfPictures = &m_H264Gop;
    } else if (m_Codec == Codec::Av1) {
        d.DataSize = sizeof(m_Av1Sequence);
        d.pAV1SequenceStructure = &m_Av1Sequence;
    } else {
        d.DataSize = sizeof(m_Gop);
        d.pHEVCGroupOfPictures = &m_Gop;
    }
    return d;
}

bool VideoEncode12::createResources(std::string& error)
{
    ID3D12Device* d = m_Device->device();
    const D3D12_VIDEO_ENCODER_PROFILE_DESC profile = profileDesc();
    D3D12_VIDEO_ENCODER_PICTURE_RESOLUTION_DESC res = {m_Setup.codedWidth, m_Setup.codedHeight};

    D3D12_VIDEO_ENCODER_DESC ed = {};
    ed.EncodeCodec = d3d12Codec();
    ed.EncodeProfile = profile;
    ed.InputFormat = m_Format;
    ed.CodecConfiguration = configurationDesc();
    ed.MaxMotionEstimationPrecision = D3D12_VIDEO_ENCODER_MOTION_ESTIMATION_PRECISION_MODE_MAXIMUM;
    HRESULT h = m_Video->CreateVideoEncoder(&ed, IID_PPV_ARGS(&m_Encoder));
    if (FAILED(h)) {
        error = "the driver refuses the encoder it said it takes (" + d3d12::hresultText(h) + ")";
        return false;
    }
    D3D12_VIDEO_ENCODER_HEAP_DESC hd = {};
    hd.EncodeCodec = d3d12Codec();
    hd.EncodeProfile = profile;
    hd.EncodeLevel = levelDesc();
    hd.ResolutionsListCount = 1;
    hd.pResolutionList = &res;
    h = m_Video->CreateVideoEncoderHeap(&hd, IID_PPV_ARGS(&m_Heap));
    if (FAILED(h)) {
        error = "the encoder heap was refused (" + d3d12::hresultText(h) + ")";
        return false;
    }

    if (!m_Device->createQueue(m_QueueRequest, m_Queue, error)) return false;
    if (FAILED(h = d->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_VIDEO_ENCODE,
                                             IID_PPV_ARGS(&m_Allocator))) ||
        FAILED(h = d->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_VIDEO_ENCODE, m_Allocator.Get(),
                                        nullptr, IID_PPV_ARGS(&m_List))) ||
        FAILED(h = m_List->Close())) {
        error = "the video encode command list was refused (" + d3d12::hresultText(h) + ")";
        return false;
    }
    if (!m_Encoded.create(d, false, error)) return false;

    D3D12_FEATURE_DATA_VIDEO_ENCODER_RESOURCE_REQUIREMENTS req = {};
    req.Codec = d3d12Codec();
    req.Profile = profile;
    req.InputFormat = m_Format;
    req.PictureTargetResolution = res;
    if (FAILED(m_Video->CheckFeatureSupport(D3D12_FEATURE_VIDEO_ENCODER_RESOURCE_REQUIREMENTS, &req,
                                            sizeof(req))) ||
        req.IsSupported == 0) {
        error = "no resource requirements for " + std::to_string(res.Width) + "x" +
                std::to_string(res.Height);
        return false;
    }

    // The reconstructed pictures: HevcDpb's pool, one array where the driver
    // wants one (the AMD iGPU), the encoder's alone unless it lets others read.
    m_ReconCount = m_Dpb.textures();
    const D3D12_RESOURCE_FLAGS reconFlags = m_Setup.support.reconReadable
                                                ? D3D12_RESOURCE_FLAG_NONE
                                                : D3D12_RESOURCE_FLAG_VIDEO_ENCODE_REFERENCE_ONLY |
                                                      D3D12_RESOURCE_FLAG_DENY_SHADER_RESOURCE;
    m_Recon.clear();
    if (m_Setup.support.reconTextureArray) {
        m_Recon.push_back(texture(d, res.Width, res.Height, static_cast<UINT16>(m_ReconCount),
                                  m_Format, reconFlags));
    } else {
        for (int i = 0; i < m_ReconCount; ++i)
            m_Recon.push_back(texture(d, res.Width, res.Height, 1, m_Format, reconFlags));
    }
    for (const auto& r : m_Recon)
        if (!r) {
            error = "the reconstructed pictures were refused";
            return false;
        }

    // The bitstream: room for the parameter sets, then the worst picture (an
    // IDR at a high bitrate on a busy desktop), the slices at an offset the
    // driver accepts. The parameter sets are written now, once, right in
    // front of that offset.
    const UINT64 alignment = std::max<UINT64>(1, req.CompressedBitstreamBufferAccessAlignment);
    // AV1's tile is written at the buffer's start: the Arc writes its AV1 there
    // whatever the frame start offset says (28/09/2026, where it honours the
    // offset in HEVC and H.264), and the headers, written after the picture,
    // move the tile along (finishAv1) — room for them at the buffer's end.
    const UINT64 headerRoom = m_Codec == Codec::Av1 ? 0 : m_Headers.size();
    m_SliceOffset = (headerRoom + alignment - 1) / alignment * alignment;
    // A raw 4:2:0 picture: 1.5 bytes a pixel, twice that in P010.
    const UINT64 raw = static_cast<UINT64>(res.Width) * res.Height * 3 / 2;
    const UINT64 worst = raw * (m_Format == DXGI_FORMAT_P010 ? 2 : 1) + 65536 +
                         (m_Codec == Codec::Av1 ? kAv1HeaderRoom : 0);
    m_BitstreamSize = (m_SliceOffset + worst + 65535) / 65536 * 65536;
    m_Bitstream = systemBuffer(d, m_BitstreamSize);
    const UINT64 metadataSize = std::max<UINT64>(4096, req.MaxEncoderOutputMetadataBufferSize);
    m_HwMetadata = videoBuffer(d, metadataSize);
    // Resolved: the output metadata, one entry per tile or slice, and for AV1
    // the tile layout and the frame header's values after them.
    const UINT64 resolved =
        sizeof(D3D12_VIDEO_ENCODER_OUTPUT_METADATA) +
        kMaxSubregions * sizeof(D3D12_VIDEO_ENCODER_FRAME_SUBREGION_METADATA) +
        sizeof(D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_SUBREGIONS_LAYOUT_DATA_TILES) +
        sizeof(D3D12_VIDEO_ENCODER_AV1_POST_ENCODE_VALUES);
    m_Metadata = systemBuffer(d, (resolved + 4095) / 4096 * 4096);
    if (!m_Bitstream || !m_HwMetadata || !m_Metadata ||
        FAILED(m_Bitstream->Map(0, nullptr, reinterpret_cast<void**>(&m_BitstreamCpu))) ||
        FAILED(m_Metadata->Map(0, nullptr, reinterpret_cast<void**>(&m_MetadataCpu)))) {
        error = "no system-memory buffers for the bitstream";
        return false;
    }
    if (m_Codec != Codec::Av1)
        std::memcpy(m_BitstreamCpu + m_SliceOffset - m_Headers.size(), m_Headers.data(),
                    m_Headers.size());
    return true;
}

bool VideoEncode12::setUpTiming()
{
    // Resolved straight into system memory, like the metadata: a readback
    // heap cannot be written from a video queue.
    ID3D12Device* d = m_Device->device();
    D3D12_QUERY_HEAP_DESC heap = {};
    heap.Type = D3D12_QUERY_HEAP_TYPE_TIMESTAMP;
    heap.Count = 2;
    HRESULT h = d->CreateQueryHeap(&heap, IID_PPV_ARGS(&m_StampHeap));
    m_Stamps = systemBuffer(d, 256);
    void* mapped = nullptr;
    if (SUCCEEDED(h)) h = m_Stamps ? m_Stamps->Map(0, nullptr, &mapped) : E_OUTOFMEMORY;
    if (SUCCEEDED(h)) h = m_Queue.queue->GetTimestampFrequency(&m_StampFrequency);
    if (FAILED(h) || m_StampFrequency == 0) {
        log::warning("[native] D3D12 Video Encode: its queue cannot be timed (" +
                     d3d12::hresultText(h) + ") — no gpu_encode_us");
        m_StampHeap.Reset();
        m_Stamps.Reset();
        m_StampsCpu = nullptr;
        return false;
    }
    m_StampsCpu = static_cast<const uint64_t*>(mapped);
    m_StampChecks = 0;
    m_StampGpuUs = 0;
    m_StampWallUs = 0;
    m_StampsTrusted = false;
    return true;
}

ID3D12Resource* VideoEncode12::reconResource(int texture) const
{
    return m_Setup.support.reconTextureArray ? m_Recon[0].Get()
                                             : m_Recon[static_cast<size_t>(texture)].Get();
}

UINT VideoEncode12::reconSubresource(int texture) const
{
    return m_Setup.support.reconTextureArray ? static_cast<UINT>(texture) : 0u;
}

D3D12_RESOURCE_BARRIER VideoEncode12::reconBarrier(int texture, UINT plane,
                                                   D3D12_RESOURCE_STATES before,
                                                   D3D12_RESOURCE_STATES after) const
{
    if (!m_Setup.support.reconTextureArray)
        return transition(reconResource(texture), before, after);
    // Slice `texture`, plane `plane` of the array (one mip level).
    return transition(m_Recon[0].Get(), before, after,
                      static_cast<UINT>(texture) + plane * static_cast<UINT>(m_ReconCount));
}

bool VideoEncode12::submit(ID3D12Resource* picture, ID3D12Fence* ready, uint64_t readyValue,
                           const HevcDpb::Plan& plan, std::string& error)
{
    HRESULT h = m_Allocator->Reset();
    if (SUCCEEDED(h)) h = m_List->Reset(m_Allocator.Get());
    if (FAILED(h)) {
        error = "the encode list could not be reset (" + d3d12::hresultText(h) + ")";
        return false;
    }

    std::vector<D3D12_RESOURCE_BARRIER> pre = {
        transition(picture, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_VIDEO_ENCODE_READ),
        transition(m_Bitstream.Get(), D3D12_RESOURCE_STATE_COMMON,
                   D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE),
        transition(m_HwMetadata.Get(), D3D12_RESOURCE_STATE_COMMON,
                   D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE),
    };
    if (m_Timing)
        pre.push_back(transition(m_Stamps.Get(), D3D12_RESOURCE_STATE_COMMON,
                                 D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE));
    const UINT planes = m_Setup.support.reconTextureArray ? 2u : 1u;
    for (UINT p = 0; p < planes; ++p)
        pre.push_back(reconBarrier(plan.texture, p, D3D12_RESOURCE_STATE_COMMON,
                                   D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE));
    // H.264 numbers a picture twice: frame_num, its place since the IDR
    // modulo MaxFrameNum, and a POC of twice that place (type 2).
    const uint32_t frameNumMask = (1u << m_H264.sequence.log2MaxFrameNum) - 1u;
    std::vector<ID3D12Resource*> references;
    std::vector<UINT> subresources;
    std::vector<D3D12_VIDEO_ENCODER_REFERENCE_PICTURE_DESCRIPTOR_HEVC> descriptors;
    std::vector<D3D12_VIDEO_ENCODER_REFERENCE_PICTURE_DESCRIPTOR_H264> h264Descriptors;
    for (size_t k = 0; k < plan.references.size(); ++k) {
        const HevcDpb::Reference& r = plan.references[k];
        for (UINT p = 0; p < planes; ++p)
            pre.push_back(reconBarrier(r.texture, p, D3D12_RESOURCE_STATE_COMMON,
                                       D3D12_RESOURCE_STATE_VIDEO_ENCODE_READ));
        references.push_back(reconResource(r.texture));
        subresources.push_back(reconSubresource(r.texture));
        D3D12_VIDEO_ENCODER_REFERENCE_PICTURE_DESCRIPTOR_HEVC ref = {};
        ref.ReconstructedPictureResourceIndex = static_cast<UINT>(k);
        ref.IsRefUsedByCurrentPic = r.used;
        ref.IsLongTermReference = FALSE;
        ref.PictureOrderCountNumber = r.poc;
        descriptors.push_back(ref);
        D3D12_VIDEO_ENCODER_REFERENCE_PICTURE_DESCRIPTOR_H264 ref264 = {};
        ref264.ReconstructedPictureResourceIndex = static_cast<UINT>(k);
        ref264.IsLongTermReference = FALSE;
        ref264.PictureOrderCountNumber = 2 * r.poc;
        ref264.FrameDecodingOrderNumber = r.poc & frameNumMask;
        h264Descriptors.push_back(ref264);
    }
    m_List->ResourceBarrier(static_cast<UINT>(pre.size()), pre.data());
    if (m_Timing) m_List->EndQuery(m_StampHeap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 0);

    // The used reference is listed first: L0 = {0}.
    UINT list0[1] = {0};
    D3D12_VIDEO_ENCODER_PICTURE_CONTROL_CODEC_DATA_HEVC pic = {};
    pic.FrameType = plan.idr ? D3D12_VIDEO_ENCODER_FRAME_TYPE_HEVC_IDR_FRAME
                             : D3D12_VIDEO_ENCODER_FRAME_TYPE_HEVC_P_FRAME;
    pic.PictureOrderCountNumber = plan.poc;
    D3D12_VIDEO_ENCODER_PICTURE_CONTROL_CODEC_DATA_H264 pic264 = {};
    pic264.FrameType = plan.idr ? D3D12_VIDEO_ENCODER_FRAME_TYPE_H264_IDR_FRAME
                                : D3D12_VIDEO_ENCODER_FRAME_TYPE_H264_P_FRAME;
    pic264.idr_pic_id = m_IdrPicId;
    pic264.PictureOrderCountNumber = 2 * plan.poc;
    pic264.FrameDecodingOrderNumber = plan.poc & frameNumMask;
    if (!plan.idr) {
        pic.List0ReferenceFramesCount = 1;
        pic.pList0ReferenceFrames = list0;
        pic.ReferenceFramesReconPictureDescriptorsCount = static_cast<UINT>(descriptors.size());
        pic.pReferenceFramesReconPictureDescriptors = descriptors.data();
        pic264.List0ReferenceFramesCount = 1;
        pic264.pList0ReferenceFrames = list0;
        pic264.ReferenceFramesReconPictureDescriptorsCount =
            static_cast<UINT>(h264Descriptors.size());
        pic264.pReferenceFramesReconPictureDescriptors = h264Descriptors.data();
    }

    // AV1: every frame refreshes the eight slots, so every slot holds the
    // previous picture and the seven references all name slot 0. A key frame
    // names none.
    D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_CODEC_DATA picAv1 = {};
    if (m_Codec == Codec::Av1) {
        const int bits = m_Av1.sequence.orderHintBits;
        const UINT hintMask = bits > 0 ? (1u << bits) - 1u : 0u;
        picAv1.Flags = av1PictureFlags(m_Av1.features);
        picAv1.FrameType = plan.idr ? D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_KEY_FRAME
                                    : D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_INTER_FRAME;
        picAv1.CompoundPredictionType =
            D3D12_VIDEO_ENCODER_AV1_COMP_PREDICTION_TYPE_SINGLE_REFERENCE;
        picAv1.InterpolationFilter =
            static_cast<D3D12_VIDEO_ENCODER_AV1_INTERPOLATION_FILTERS>(m_Av1.interpolationFilter);
        picAv1.TxMode = (plan.idr ? m_Av1.txSelectKey : m_Av1.txSelectInter)
                            ? D3D12_VIDEO_ENCODER_AV1_TX_MODE_SELECT
                            : D3D12_VIDEO_ENCODER_AV1_TX_MODE_LARGEST;
        picAv1.SuperResDenominator = 8; // SUPERRES_NUM: no scaling
        picAv1.OrderHint = plan.poc & hintMask;
        picAv1.PictureIndex = plan.poc;
        for (auto& d : picAv1.ReferenceFramesReconPictureDescriptors) {
            d.ReconstructedPictureResourceIndex = kUnusedSlot;
            if (plan.idr || plan.references.empty()) continue;
            const HevcDpb::Reference& r = plan.references[0];
            d.ReconstructedPictureResourceIndex = 0;
            d.FrameType = r.poc == 0 ? D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_KEY_FRAME
                                     : D3D12_VIDEO_ENCODER_AV1_FRAME_TYPE_INTER_FRAME;
            d.OrderHint = r.poc & hintMask;
            d.PictureIndex = r.poc;
        }
        picAv1.PrimaryRefFrame = plan.idr ? av1::kPrimaryRefNone : 0;
        picAv1.RefreshFrameFlags = 0xFF;
        // What a driver that gives nothing back codes with: the rate
        // control's starting quantizer, and no filter of its own choosing.
        picAv1.Quantization.BaseQIndex = m_Rate->cbr.InitialQP ? m_Rate->cbr.InitialQP : 150;
    }

    D3D12_VIDEO_ENCODER_ENCODEFRAME_INPUT_ARGUMENTS in = {};
    in.SequenceControlDesc.Flags =
        m_RateChanged ? D3D12_VIDEO_ENCODER_SEQUENCE_CONTROL_FLAG_RATE_CONTROL_CHANGE
                      : D3D12_VIDEO_ENCODER_SEQUENCE_CONTROL_FLAG_NONE;
    const UINT refresh = static_cast<UINT>(m_Setup.intraRefreshFrames);
    in.SequenceControlDesc.IntraRefreshConfig = {
        refresh > 0 ? D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_ROW_BASED
                    : D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_NONE,
        refresh};
    in.SequenceControlDesc.RateControl = m_Rate->desc;
    in.SequenceControlDesc.PictureTargetResolution = {m_Setup.codedWidth, m_Setup.codedHeight};
    in.SequenceControlDesc.SelectedLayoutMode =
        D3D12_VIDEO_ENCODER_FRAME_SUBREGION_LAYOUT_MODE_FULL_FRAME;
    in.SequenceControlDesc.CodecGopSequence = gopDesc();
    in.PictureControlDesc.IntraRefreshFrameIndex = refresh > 0 ? m_IntraRefreshIndex % refresh : 0;
    in.PictureControlDesc.Flags =
        D3D12_VIDEO_ENCODER_PICTURE_CONTROL_FLAG_USED_AS_REFERENCE_PICTURE;
    if (m_Codec == Codec::H264) {
        in.PictureControlDesc.PictureControlCodecData.DataSize = sizeof(pic264);
        in.PictureControlDesc.PictureControlCodecData.pH264PicData = &pic264;
    } else if (m_Codec == Codec::Av1) {
        in.PictureControlDesc.PictureControlCodecData.DataSize = sizeof(picAv1);
        in.PictureControlDesc.PictureControlCodecData.pAV1PicData = &picAv1;
    } else {
        in.PictureControlDesc.PictureControlCodecData.DataSize = sizeof(pic);
        in.PictureControlDesc.PictureControlCodecData.pHEVCPicData = &pic;
    }
    if (!plan.idr) {
        in.PictureControlDesc.ReferenceFrames.NumTexture2Ds = static_cast<UINT>(references.size());
        in.PictureControlDesc.ReferenceFrames.ppTexture2Ds = references.data();
        in.PictureControlDesc.ReferenceFrames.pSubresources =
            m_Setup.support.reconTextureArray ? subresources.data() : nullptr;
    }
    in.pInputFrame = picture;
    in.InputFrameSubresource = 0;
    D3D12_VIDEO_ENCODER_ENCODEFRAME_OUTPUT_ARGUMENTS out = {};
    out.Bitstream = {m_Bitstream.Get(), m_SliceOffset};
    out.ReconstructedPicture = {reconResource(plan.texture), reconSubresource(plan.texture)};
    out.EncoderOutputMetadata = {m_HwMetadata.Get(), 0};
    m_List->EncodeFrame(m_Encoder.Get(), m_Heap.Get(), &in, &out);

    D3D12_RESOURCE_BARRIER mid[2] = {
        transition(m_HwMetadata.Get(), D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE,
                   D3D12_RESOURCE_STATE_VIDEO_ENCODE_READ),
        transition(m_Metadata.Get(), D3D12_RESOURCE_STATE_COMMON,
                   D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE),
    };
    m_List->ResourceBarrier(2, mid);
    D3D12_VIDEO_ENCODER_RESOLVE_METADATA_INPUT_ARGUMENTS rin = {};
    rin.EncoderCodec = d3d12Codec();
    rin.EncoderProfile = profileDesc();
    rin.EncoderInputFormat = m_Format;
    rin.EncodedPictureEffectiveResolution = {m_Setup.codedWidth, m_Setup.codedHeight};
    rin.HWLayoutMetadata = {m_HwMetadata.Get(), 0};
    D3D12_VIDEO_ENCODER_RESOLVE_METADATA_OUTPUT_ARGUMENTS rout = {};
    rout.ResolvedLayoutMetadata = {m_Metadata.Get(), 0};
    m_List->ResolveEncoderOutputMetadata(&rin, &rout);
    if (m_Timing) {
        m_List->EndQuery(m_StampHeap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 1);
        m_List->ResolveQueryData(m_StampHeap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 0, 2,
                                 m_Stamps.Get(), 0);
    }

    // Everything back to COMMON: the conversion's queue and the next picture
    // find them as they expect.
    std::vector<D3D12_RESOURCE_BARRIER> post;
    for (D3D12_RESOURCE_BARRIER b : pre) {
        std::swap(b.Transition.StateBefore, b.Transition.StateAfter);
        if (b.Transition.pResource == m_HwMetadata.Get())
            b.Transition.StateBefore = D3D12_RESOURCE_STATE_VIDEO_ENCODE_READ;
        post.push_back(b);
    }
    post.push_back(transition(m_Metadata.Get(), D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE,
                              D3D12_RESOURCE_STATE_COMMON));
    m_List->ResourceBarrier(static_cast<UINT>(post.size()), post.data());
    if (FAILED(h = m_List->Close())) {
        error = "the encode list was refused (" + d3d12::hresultText(h) + ")";
        m_Device->relayMessages();
        return false;
    }

    ID3D12CommandQueue* queue = m_Queue.queue.Get();
    if (ready && FAILED(h = queue->Wait(ready, readyValue))) {
        error = "the encode queue cannot wait for the picture (" + d3d12::hresultText(h) + ")";
        return false;
    }
    const auto submitted = std::chrono::steady_clock::now();
    ID3D12CommandList* lists[] = {m_List.Get()};
    queue->ExecuteCommandLists(1, lists);
    const uint64_t value = m_Encoded.signal(queue, error);
    if (value == 0) return false;
    const d3d12::GpuFence::Wait waited = m_Encoded.wait(value, kWaitMs, error);
    if (waited != d3d12::GpuFence::Wait::Done) {
        if (waited == d3d12::GpuFence::Wait::TimedOut)
            error = "the picture took over " + std::to_string(kWaitMs) + " ms to encode";
        return false;
    }
    if (m_Timing) {
        const int64_t gpuUs = m_StampsCpu[1] > m_StampsCpu[0]
                                  ? static_cast<int64_t>((m_StampsCpu[1] - m_StampsCpu[0]) *
                                                         1000000 / m_StampFrequency)
                                  : 0;
        m_PictureGpuUs += gpuUs;
        if (!m_StampsTrusted) checkStamps(gpuUs, submitted);
    }
    return true;
}

void VideoEncode12::checkStamps(int64_t gpuUs, std::chrono::steady_clock::time_point submitted)
{
    constexpr int kChecks = 30;
    m_StampGpuUs += gpuUs;
    m_StampWallUs += std::chrono::duration_cast<std::chrono::microseconds>(
                         std::chrono::steady_clock::now() - submitted)
                         .count();
    if (++m_StampChecks < kChecks) return;
    // A tenth of the wait: the RTX and the AMD iGPU give 0.8 of it, the Arc
    // 0.005.
    if (m_StampGpuUs * 10 >= m_StampWallUs) {
        m_StampsTrusted = true;
        return;
    }
    m_Timing = false;
    log::info("[native] D3D12 Video Encode: the encode queue's timestamps do not bracket the "
              "encode on this GPU (" +
              std::to_string(m_StampGpuUs / kChecks) + " us against " +
              std::to_string(m_StampWallUs / kChecks) + " us waited) — no gpu_encode_us");
}

bool VideoEncode12::encode(ID3D12Resource* picture, ID3D12Fence* ready, uint64_t readyValue,
                           bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out,
                           std::string& error)
{
    if (!m_Encoder) {
        error = "the encoder is not initialized";
        return false;
    }
    if (m_OutputHeld) {
        error = "the previous frame was not released";
        return false;
    }
    if (!picture) {
        error = "no picture";
        return false;
    }
    const HevcDpb::Plan plan = m_Dpb.plan(frameNumber, forceKeyframe);
    m_PictureGpuUs = 0;
    if (plan.idr) {
        m_IntraRefreshIndex = 0;
        // Coded again after an overshoot, the IDR keeps its number.
        m_IdrPicId = (m_IdrPicId + 1) & 0xFFFFu;
    }
    // The conversion signals a new value for every picture it writes: the
    // value of the last one encoded again is the same picture again.
    const bool newPicture =
        readyValue == 0 || ready != m_LastReady || readyValue != m_LastReadyValue;
    m_LastReady = ready;
    m_LastReadyValue = readyValue;
    QpRateController::Picture asked;
    if (m_OwnRate) {
        asked = m_Controller.plan(plan.idr, newPicture);
        applyQp(asked.qp);
    }
    uint64_t bytes = 0;
    if (!submit(picture, ready, readyValue, plan, error) || !written(bytes, error)) return false;
    // Far over its budget, the picture is coded again where it fits: the
    // same plan, the same reference, its reconstruction written over.
    if (m_Reencode && m_Controller.strongOvershoot(asked, bytes * 8)) {
        m_Controller.overshot(asked, bytes * 8);
        asked = m_Controller.reencode(asked, bytes * 8);
        applyQp(asked.qp);
        if (!submit(picture, ready, readyValue, plan, error) || !written(bytes, error))
            return false;
        ++m_Reencoded;
        // Under the fitting rule the first try aims under the overshoot line
        // by the slope learned; a picture it leaves far over — a new page —
        // gets the textbook's.
        if (m_Controller.lastTryWanted(asked, bytes * 8)) {
            asked = m_Controller.reencode(asked, bytes * 8, true);
            applyQp(asked.qp);
            if (!submit(picture, ready, readyValue, plan, error) || !written(bytes, error))
                return false;
            ++m_ReencodedTwice;
        }
    }
    if (m_Codec == Codec::Av1) {
        // The headers ours, the tile the driver's: written in front of it.
        const uint8_t* data = nullptr;
        size_t size = 0;
        if (!finishAv1(plan, data, size, error)) return false;
        if (m_GuardLeft > 0) --m_GuardLeft;
        m_DriverQp = m_Av1Frame.q.baseQIdx;
        m_Dpb.encoded(plan);
        m_RateChanged = false;
        ++m_IntraRefreshIndex;
        out.data = data;
        out.size = size;
        out.keyframe = plan.idr;
        out.avgQp = m_DriverQp; // the qindex, as NVENC's AV1 says it
        out.gpuEncodeUs = m_Timing && m_StampsTrusted ? m_PictureGpuUs : -1;
        m_OutputHeld = true;
        return true;
    }
    const auto* metadata =
        reinterpret_cast<const D3D12_VIDEO_ENCODER_OUTPUT_METADATA*>(m_MetadataCpu);
    const uint8_t* slices = m_BitstreamCpu + m_SliceOffset;
    if (m_GuardLeft > 0) {
        if (!guard(slices, static_cast<size_t>(bytes), plan, error)) return false;
        --m_GuardLeft;
    }
    // Out of HEVC's range, the average says nothing: the N95's driver reports
    // 184 under its CBR (27/09/2026), and the slice is read instead.
    const uint64_t average = metadata->EncodeStats.AverageQP;
    m_DriverQp = average <= 51 ? static_cast<int>(average) : 0;
    if (m_DriverQp <= 0) m_DriverQp = reportedQp(slices, static_cast<size_t>(bytes));
    if (m_OwnRate) {
        m_Controller.encoded(asked, bytes * 8);
        if (!qpFollowed(asked.qp, m_DriverQp, error)) return false;
    }
    m_Dpb.encoded(plan);
    m_RateChanged = false;
    ++m_IntraRefreshIndex;

    out.data = plan.idr ? slices - m_Headers.size() : slices;
    out.size = static_cast<size_t>(bytes) + (plan.idr ? m_Headers.size() : 0);
    out.keyframe = plan.idr;
    // Ours is the QP asked, and the driver was held to it; the driver's own
    // otherwise, -1 where it does not say (reportedQp).
    out.avgQp = m_OwnRate ? asked.qp : m_DriverQp;
    out.gpuEncodeUs = m_Timing && m_StampsTrusted ? m_PictureGpuUs : -1;
    m_OutputHeld = true;
    return true;
}

int VideoEncode12::reportedQp(const uint8_t* slices, size_t size)
{
    // The Arc and the AMD iGPU leave the average at 0 under CBR (the AMD
    // under CQP too, 27/09/2026). The AMD writes the QP its rate control
    // chose in the slice header; the Arc writes slice_qp_delta 0 and moves
    // its QP in the coding units, out of reach without the CABAC. So the
    // slice's QP counts once it has left the PPS's; until then the QP is
    // unknown (-1), which the overlay and the still-screen refinement
    // (RefineConvergence) take as an encoder that does not say.
    const bool h264 = m_Codec == Codec::H264;
    const int qp = h264 ? firstH264SliceQp(slices, size, m_H264Sps, m_H264Pps)
                        : firstSliceQp(slices, size, m_SpsFields, m_PpsFields);
    if (qp >= 0 && qp != (h264 ? m_H264Pps.initQp : m_PpsFields.initQp)) m_SliceQpMoves = true;
    return m_SliceQpMoves ? qp : -1;
}

void VideoEncode12::applyQp(int qp)
{
    if (qp == m_SubmittedQp) return;
    m_Rate->setQp(static_cast<UINT>(qp));
    // Said to a driver that takes a change in flight — the AMD iGPU ignores
    // one it is not told of (26/09/2026). The Arc takes it untold, and would
    // refuse the telling: it has no rate change without a new sequence.
    if (m_Setup.support.rateReconfigurable) m_RateChanged = true;
    m_SubmittedQp = qp;
}

bool VideoEncode12::qpFollowed(int asked, int said, std::string& error)
{
    // A driver that does not say is taken on its word — none of the three
    // does not.
    if (said < 0) return true;
    // A driver may say its QP in units of its own (Main 10's offset, say):
    // what counts is that it moves with ours, at the distance it said first.
    if (!m_QpOffsetKnown) {
        m_QpOffsetKnown = true;
        m_QpOffset = said - asked;
        if (m_QpOffset != 0)
            log::info("[native] D3D12 Video Encode says its QP " + std::to_string(m_QpOffset) +
                      " away from the one asked");
    }
    if (std::abs(said - asked - m_QpOffset) <= 1) {
        m_QpMisses = 0;
        return true;
    }
    ++m_QpNotFollowed;
    if (++m_QpMisses < kQpMisses) return true;
    error = "the driver does not code the QP asked any more (asked " + std::to_string(asked) +
            ", coded " + std::to_string(said - m_QpOffset) + ", " + std::to_string(kQpMisses) +
            " pictures in a row)";
    return false;
}

bool VideoEncode12::written(uint64_t& bytes, std::string& error) const
{
    const auto* metadata =
        reinterpret_cast<const D3D12_VIDEO_ENCODER_OUTPUT_METADATA*>(m_MetadataCpu);
    bytes = metadata->EncodedBitstreamWrittenBytesCount;
    if (metadata->EncodeErrorFlags != 0) {
        error = "the driver flagged the picture (" + hex(metadata->EncodeErrorFlags) + ")";
        return false;
    }
    if (bytes == 0 || bytes > m_BitstreamSize - m_SliceOffset) {
        error = "the driver says it wrote " + std::to_string(bytes) + " bytes";
        return false;
    }
    return true;
}

bool VideoEncode12::warmUp(std::string& error)
{
    // Committed resources come zeroed: a flat picture is all the driver needs
    // to set itself up.
    ComPtr<ID3D12Resource> blank =
        texture(m_Device->device(), m_Setup.codedWidth, m_Setup.codedHeight, 1, m_Format,
                D3D12_RESOURCE_FLAG_NONE);
    if (!blank) {
        error = "no picture to warm the encoder up with";
        return false;
    }
    // Not recorded in the DPB: the first real picture is an IDR all the same.
    const HevcDpb::Plan plan = m_Dpb.plan(0, true);
    uint64_t bytes = 0;
    if (!submit(blank.Get(), nullptr, 0, plan, error) || !written(bytes, error)) return false;
    if (m_Codec == Codec::Av1) {
        // No slice header of the driver's to read: its values, checked.
        const uint8_t* data = nullptr;
        size_t size = 0;
        return finishAv1(plan, data, size, error);
    }
    return guard(m_BitstreamCpu + m_SliceOffset, static_cast<size_t>(bytes), plan, error);
}

bool VideoEncode12::guard(const uint8_t* data, size_t size, const HevcDpb::Plan& plan,
                          std::string& error)
{
    if (m_Codec == Codec::H264) return guardH264(data, size, plan, error);
    int slices = 0;
    for (const HevcNalUnit& unit : hevcNalUnits(data, size)) {
        if (unit.type() > 31) continue; // not a slice: an AUD or an SEI the driver adds
        HevcSliceFields f;
        const std::string wrong =
            parseHevcSliceHeader(unit.data, unit.size, m_SpsFields, m_PpsFields, f);
        if (!wrong.empty()) {
            error = "the driver's slices do not read with our parameter sets: " + wrong;
            return false;
        }
        // What we asked for, said back: the picture's place, and the one it
        // predicts from.
        const uint32_t pocMask = (1u << m_SpsFields.log2MaxPocLsb) - 1u;
        if (!plan.idr && f.pocLsb != (plan.poc & pocMask)) {
            error = "the driver numbered picture " + std::to_string(plan.poc) + " as " +
                    std::to_string(f.pocLsb);
            return false;
        }
        if (!plan.idr && !plan.references.empty()) {
            const int32_t wanted =
                static_cast<int32_t>(plan.references[0].poc) - static_cast<int32_t>(plan.poc);
            const bool found = std::any_of(f.shortTerm.begin(), f.shortTerm.end(),
                                           [&](const HevcSliceFields::Reference& r) {
                                               return r.used && r.deltaPoc == wanted;
                                           });
            if (!found) {
                error = "the driver's slice does not predict from the picture asked (POC delta " +
                        std::to_string(wanted) + ")";
                return false;
            }
        }
        ++slices;
    }
    if (slices == 0) {
        error = "no slice in the driver's output";
        return false;
    }
    return true;
}

bool VideoEncode12::guardH264(const uint8_t* data, size_t size, const HevcDpb::Plan& plan,
                              std::string& error)
{
    const uint32_t frameNumMask = (1u << m_H264Sps.log2MaxFrameNum) - 1u;
    int slices = 0;
    for (const HevcNalUnit& unit : hevcNalUnits(data, size)) {
        const uint32_t type = h264NalType(unit);
        if (type != 1 && type != 5) continue; // not a slice: an AUD or an SEI the driver adds
        H264SliceFields f;
        const std::string wrong =
            parseH264SliceHeader(unit.data, unit.size, m_H264Sps, m_H264Pps, f);
        if (!wrong.empty()) {
            error = "the driver's slices do not read with our parameter sets: " + wrong;
            return false;
        }
        // What we asked for, said back: the kind of picture, its number, and
        // a reference kept the way the SPS says — every picture is the next
        // one's, by the sliding window, and a P predicts from that one alone.
        if ((type == 5) != plan.idr) {
            error = plan.idr ? "the driver coded the IDR asked as an ordinary picture"
                             : "the driver coded an IDR where a P picture was asked";
            return false;
        }
        if (f.frameNum != (plan.poc & frameNumMask)) {
            error = "the driver numbered picture " + std::to_string(plan.poc) + " as frame_num " +
                    std::to_string(f.frameNum);
            return false;
        }
        if (f.nalRefIdc == 0 || f.adaptiveMarking) {
            error = "the driver does not keep the picture as the next one's reference (" +
                    std::string(f.nalRefIdc == 0 ? "nal_ref_idc 0" : "memory management") + ")";
            return false;
        }
        if (!plan.idr && f.numRefIdxL0Active != 1) {
            error = "the driver's slice predicts from " + std::to_string(f.numRefIdxL0Active) +
                    " pictures where one is kept";
            return false;
        }
        ++slices;
    }
    if (slices == 0) {
        error = "no slice in the driver's output";
        return false;
    }
    return true;
}

bool VideoEncode12::finishAv1(const HevcDpb::Plan& plan, const uint8_t*& data, size_t& size,
                              std::string& error)
{
    // The resolved metadata: the output metadata, one entry per tile, the
    // tile layout, then the frame header's values (D3D12's order).
    const auto* md = reinterpret_cast<const D3D12_VIDEO_ENCODER_OUTPUT_METADATA*>(m_MetadataCpu);
    if (md->WrittenSubregionsCount != 1) {
        error = "the driver wrote " + std::to_string(md->WrittenSubregionsCount) +
                " tiles where one was asked";
        return false;
    }
    const auto* tile =
        reinterpret_cast<const D3D12_VIDEO_ENCODER_FRAME_SUBREGION_METADATA*>(md + 1);
    const auto* layout = reinterpret_cast<
        const D3D12_VIDEO_ENCODER_AV1_PICTURE_CONTROL_SUBREGIONS_LAYOUT_DATA_TILES*>(tile + 1);
    const auto* v = reinterpret_cast<const D3D12_VIDEO_ENCODER_AV1_POST_ENCODE_VALUES*>(layout + 1);
    // A tile's size counts its start offset (the drivers' and Mesa's reading).
    const uint64_t start = tile->bStartOffset;
    if (tile->bSize <= start || tile->bSize + kAv1HeaderRoom > m_BitstreamSize) {
        error = "the driver's tile runs from " + std::to_string(start) + " to " +
                std::to_string(tile->bSize);
        return false;
    }
    const uint64_t tileBytes = tile->bSize - start;
    if (m_Av1Layout.empty()) {
        m_Av1Layout = "tile from " + std::to_string(start) + " to " + std::to_string(tile->bSize) +
                      " (header " + std::to_string(tile->bHeaderSize) + "), layout " +
                      std::to_string(layout->RowCount) + "x" + std::to_string(layout->ColCount) +
                      " context " + std::to_string(layout->ContextUpdateTileId) +
                      ", the driver says " + std::to_string(md->EncodedBitstreamWrittenBytesCount) +
                      " bytes written:";
        const uint8_t* at = m_BitstreamCpu + m_SliceOffset;
        for (int i = 0; i < 12; ++i) {
            char b[4];
            std::snprintf(b, sizeof(b), " %02x", at[i]);
            m_Av1Layout += b;
        }
    }

    // The frame header: our choices, and what the driver says it chose.
    const auto inRange = [](int64_t value, int64_t low, int64_t high) {
        return value >= low && value <= high;
    };
    const auto& q = v->Quantization;
    const auto& lf = v->LoopFilter;
    const auto& cd = v->CDEF;
    const auto& seg = v->SegmentationConfig;
    bool sane = q.BaseQIndex <= 255 && inRange(q.YDCDeltaQ, -64, 63) &&
                inRange(q.UDCDeltaQ, -64, 63) && inRange(q.UACDeltaQ, -64, 63) &&
                inRange(q.VDCDeltaQ, -64, 63) && inRange(q.VACDeltaQ, -64, 63) && q.QMY <= 15 &&
                q.QMU <= 15 && q.QMV <= 15 && lf.LoopFilterLevel[0] <= 63 &&
                lf.LoopFilterLevel[1] <= 63 && lf.LoopFilterLevelU <= 63 &&
                lf.LoopFilterLevelV <= 63 && lf.LoopFilterSharpnessLevel <= 7 && cd.CdefBits <= 3 &&
                cd.CdefDampingMinus3 <= 3 && v->QuantizationDelta.DeltaQRes <= 3 &&
                v->LoopFilterDelta.DeltaLFRes <= 3 && v->PrimaryRefFrame <= 7 &&
                seg.NumSegments <= av1::kMaxSegments;
    for (int i = 0; i < 8 && sane; ++i)
        sane = inRange(lf.RefDeltas[i], -64, 63) && cd.CdefYPriStrength[i] <= 15 &&
               cd.CdefYSecStrength[i] <= 3 && cd.CdefUVPriStrength[i] <= 15 &&
               cd.CdefUVSecStrength[i] <= 3;
    sane = sane && inRange(lf.ModeDeltas[0], -64, 63) && inRange(lf.ModeDeltas[1], -64, 63);
    if (!sane) {
        error = "the driver's frame header values are out of AV1's ranges (base_q_idx " +
                std::to_string(q.BaseQIndex) + ")";
        return false;
    }

    const int bits = m_Av1.sequence.orderHintBits;
    const uint32_t hintMask = bits > 0 ? (1u << bits) - 1u : 0u;
    av1::Frame f;
    f.key = plan.idr;
    f.orderHint = plan.poc & hintMask;
    f.refreshFrameFlags = 0xFF;
    if (!plan.idr) {
        const uint32_t previous = plan.references.empty() ? 0 : plan.references[0].poc & hintMask;
        f.refOrderHint.fill(previous);
        for (int i = 0; i < av1::kRefsPerFrame; ++i)
            f.refFrameIdx[static_cast<size_t>(i)] = v->ReferenceIndices[i] < av1::kNumRefFrames
                                                        ? static_cast<int>(v->ReferenceIndices[i])
                                                        : 0;
        f.primaryRefFrame = static_cast<int>(v->PrimaryRefFrame);
    }
    f.renderWidth = m_RenderWidth;
    f.renderHeight = m_RenderHeight;
    f.interpolationFilter = m_Av1.interpolationFilter;
    f.q.baseQIdx = static_cast<int>(q.BaseQIndex);
    f.q.deltaQYDc = static_cast<int>(q.YDCDeltaQ);
    f.q.deltaQUDc = static_cast<int>(q.UDCDeltaQ);
    f.q.deltaQUAc = static_cast<int>(q.UACDeltaQ);
    f.q.deltaQVDc = static_cast<int>(q.VDCDeltaQ);
    f.q.deltaQVAc = static_cast<int>(q.VACDeltaQ);
    f.q.usingQmatrix = q.UsingQMatrix != 0;
    f.q.qmY = static_cast<int>(q.QMY);
    f.q.qmU = static_cast<int>(q.QMU);
    f.q.qmV = static_cast<int>(q.QMV);
    f.seg.enabled = seg.NumSegments > 0;
    if (f.seg.enabled) {
        f.seg.updateMap = seg.UpdateMap != 0;
        f.seg.temporalUpdate = seg.TemporalUpdate != 0;
        f.seg.updateData = seg.UpdateData != 0;
        for (size_t i = 0; i < av1::kMaxSegments; ++i) {
            f.seg.features[i] = static_cast<uint32_t>(seg.SegmentsData[i].EnabledFeatures);
            for (size_t j = 0; j < av1::kSegLvlMax; ++j)
                f.seg.values[i][j] = static_cast<int>(seg.SegmentsData[i].FeatureValue[j]);
        }
    }
    f.deltaQPresent = v->QuantizationDelta.DeltaQPresent != 0;
    f.deltaQRes = static_cast<int>(v->QuantizationDelta.DeltaQRes);
    f.deltaLfPresent = v->LoopFilterDelta.DeltaLFPresent != 0;
    f.deltaLfRes = static_cast<int>(v->LoopFilterDelta.DeltaLFRes);
    f.deltaLfMulti = v->LoopFilterDelta.DeltaLFMulti != 0;
    f.lf.level = {static_cast<int>(lf.LoopFilterLevel[0]), static_cast<int>(lf.LoopFilterLevel[1]),
                  static_cast<int>(lf.LoopFilterLevelU), static_cast<int>(lf.LoopFilterLevelV)};
    f.lf.sharpness = static_cast<int>(lf.LoopFilterSharpnessLevel);
    f.lf.deltaEnabled = lf.LoopFilterDeltaEnabled != 0;
    f.lf.updateRefDelta = lf.UpdateRefDelta != 0;
    f.lf.updateModeDelta = lf.UpdateModeDelta != 0;
    for (size_t i = 0; i < av1::kNumRefFrames; ++i)
        f.lf.refDeltas[i] = static_cast<int>(lf.RefDeltas[i]);
    f.lf.modeDeltas = {static_cast<int>(lf.ModeDeltas[0]), static_cast<int>(lf.ModeDeltas[1])};
    f.cdef.dampingMinus3 = static_cast<int>(cd.CdefDampingMinus3);
    f.cdef.bits = static_cast<int>(cd.CdefBits);
    for (size_t i = 0; i < 8; ++i) {
        f.cdef.yPri[i] = static_cast<int>(cd.CdefYPriStrength[i]);
        f.cdef.ySec[i] = static_cast<int>(cd.CdefYSecStrength[i]);
        f.cdef.uvPri[i] = static_cast<int>(cd.CdefUVPriStrength[i]);
        f.cdef.uvSec[i] = static_cast<int>(cd.CdefUVSecStrength[i]);
    }
    f.txModeSelect = plan.idr ? m_Av1.txSelectKey : m_Av1.txSelectInter;
    f.referenceSelect = !plan.idr && v->CompoundPredictionType != 0;
    // The tools a required feature switched on for the picture (av1PictureFlags).
    const uint32_t features = m_Av1.features;
    f.allowWarpedMotion = !plan.idr && (features & av1feature::kWarpedMotion);
    f.reducedTxSet = (features & av1feature::kReducedTxSet) != 0;
    f.motionModeSwitchable = !plan.idr && (features & av1feature::kMotionModeSwitchable);
    f.allowHighPrecisionMv = !plan.idr && (features & av1feature::kHighPrecisionMv);
    f.skipModePresent = (features & av1feature::kSkipMode) != 0;
    f.useRefFrameMvs = !plan.idr && (features & av1feature::kRefFrameMvs);

    // In front of the tile: the temporal delimiter, the sequence header on a
    // key frame, OBU_FRAME's header — one run with the tile, which moves up
    // to make room (tens of kilobytes: microseconds).
    std::vector<uint8_t> prefix = av1::temporalDelimiter();
    if (plan.idr) prefix.insert(prefix.end(), m_Headers.begin(), m_Headers.end());
    const std::vector<uint8_t> frame = av1::frameObuPrefix(m_Av1.sequence, f, tileBytes);
    prefix.insert(prefix.end(), frame.begin(), frame.end());
    if (prefix.size() > kAv1HeaderRoom) {
        error = "the AV1 headers (" + std::to_string(prefix.size()) + " bytes) outgrow their room";
        return false;
    }
    uint8_t* base = m_BitstreamCpu + m_SliceOffset;
    std::memmove(base + prefix.size(), base + start, static_cast<size_t>(tileBytes));
    std::memcpy(base, prefix.data(), prefix.size());
    data = base;
    size = prefix.size() + static_cast<size_t>(tileBytes);
    m_Av1Frame = f;
    return true;
}

bool VideoEncode12::invalidateReference(uint32_t frameNumber, std::string& error)
{
    if (!m_Encoder) {
        error = "the encoder is not initialized";
        return false;
    }
    if (!m_Dpb.invalidate(frameNumber)) {
        error = "no picture from before frame " + std::to_string(frameNumber) +
                " is kept: a keyframe is the only repair";
        return false;
    }
    return true;
}

bool VideoEncode12::setBitrate(int bitrateKbps, std::string& error)
{
    if (!m_Encoder || !m_Rate) {
        error = "the encoder is not initialized";
        return false;
    }
    const uint32_t bitsPerSecond = static_cast<uint32_t>((std::max)(bitrateKbps, 1)) * 1000u;
    // Ours: a new budget from the next picture, nothing said to the driver.
    if (m_OwnRate) {
        m_Controller.setBitrate(bitsPerSecond);
        return true;
    }
    if (!m_Setup.support.rateReconfigurable) {
        error = "this driver changes its bitrate only with a new sequence, and runs its own rate "
                "control here";
        return false;
    }
    m_Rate->setBitrate(bitsPerSecond, m_Fps, m_VbvFrames);
    m_RateChanged = true;
    return true;
}

void VideoEncode12::stop()
{
    if (m_OwnRate && m_Controller.pictures() > 0) {
        char mean[16];
        std::snprintf(mean, sizeof(mean), "%.1f", m_Controller.meanQp());
        log::info("[native] D3D12 Video Encode, our rate control: " +
                  std::to_string(m_Controller.pictures()) + " pictures at QP " + mean +
                  " on average, " + std::to_string(m_Controller.strongOvershoots()) +
                  " far over their budget, " + std::to_string(m_Reencoded) + " coded again" +
                  (m_Controller.reencodeFit()
                       ? " (" + std::to_string(m_ReencodedTwice) + " of them twice)"
                       : std::string()) +
                  ", " + std::to_string(m_QpNotFollowed) + " whose QP the driver did not follow");
    }
    if (m_Queue.queue && m_Encoded.fence()) {
        std::string ignored;
        const uint64_t value = m_Encoded.signal(m_Queue.queue.Get(), ignored);
        if (value) m_Encoded.wait(value, kWaitMs, ignored);
    }
    if (m_Bitstream && m_BitstreamCpu) m_Bitstream->Unmap(0, nullptr);
    if (m_Metadata && m_MetadataCpu) m_Metadata->Unmap(0, nullptr);
    if (m_Stamps && m_StampsCpu) m_Stamps->Unmap(0, nullptr);
    m_BitstreamCpu = nullptr;
    m_MetadataCpu = nullptr;
    m_StampsCpu = nullptr;
    m_Timing = false;
    m_Stamps.Reset();
    m_StampHeap.Reset();
    m_Bitstream.Reset();
    m_Metadata.Reset();
    m_HwMetadata.Reset();
    m_Recon.clear();
    m_ReconCount = 0;
    m_List.Reset();
    m_Allocator.Reset();
    m_Encoded.reset();
    m_Queue = d3d12::Queue();
    m_Heap.Reset();
    m_Encoder.Reset();
    m_Video.Reset();
    m_Device.reset();
    m_Rate.reset();
    m_Dpb.reset();
    m_Headers.clear();
    m_Setup = HevcEncodeSetup();
    m_H264 = H264EncodeSetup();
    m_Av1 = Av1EncodeSetup();
    m_Av1Frame = av1::Frame();
    m_Av1Layout.clear();
    m_RenderWidth = 0;
    m_RenderHeight = 0;
    m_Codec = Codec::Hevc;
    m_IdrPicId = 0;
    m_GuardLeft = 0;
    m_SliceQpMoves = false;
    m_RateChanged = false;
    m_OutputHeld = false;
    m_OwnRate = false;
    m_Reencode = false;
    m_Controller = QpRateController();
    m_SubmittedQp = 0;
    m_LastReady = nullptr;
    m_LastReadyValue = 0;
    m_QpOffsetKnown = false;
    m_QpOffset = 0;
    m_QpMisses = 0;
    m_QpNotFollowed = 0;
    m_DriverQp = -1;
    m_Reencoded = 0;
    m_ReencodedTwice = 0;
}

} // namespace mw::native::encode
