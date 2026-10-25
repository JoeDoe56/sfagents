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

#include "H264Vui.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

// The slice header of an HEVC picture, read back with the parameter sets that
// go ahead of it.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// A D3D12 Video Encode driver writes the slices and the application writes the
// parameter sets (ParameterSets.h, HevcDialect::D3d12), and nothing checks that
// the two agree. The slice header is where a disagreement shows: its syntax
// hangs on a dozen flags of the SPS and PPS, and read with the wrong ones it
// ends somewhere else than on the byte_alignment() that closes it — a one,
// then zeros to the byte — or it names a parameter set, a slice type, a
// reference that cannot be. So the encoder reads its first slices back with
// the parameter sets it sends, and a slice that does not read sends the session
// back to D3D11 before a viewer is shown noise.
//
// It is a sieve, not a proof: read with the Mesa dialect's PPS, the slices of
// the three GPUs of DualRTX (26/09/2026) miss the alignment on 12 headers of
// 15 — the other three happen to land on it. A wrong parameter set can pass
// one slice; it does not pass several. Read more than one.
//
// Only what the parameter sets written here can say is followed: no scaling
// list data, no short-term sets in the SPS, no weighted prediction, no
// dependent slice segments, no extensions (range, SCC, multilayer). A
// parameter set or a slice that uses one is refused, not guessed at. Pure
// bytes, no driver: testable anywhere.

namespace mw::native::encode {

/// One NAL unit of an Annex-B stream, start code off, trailing zeros off.
struct HevcNalUnit
{
    const uint8_t* data = nullptr;
    size_t size = 0;

    uint8_t type() const { return size ? static_cast<uint8_t>((data[0] >> 1) & 0x3F) : 0xFF; }
};

/// What the slice header's syntax depends on in an SPS — and, from the
/// profile to the transform tree, what a decoder's session parameters take:
/// the Vulkan encoder's pixel proof decodes its own stream (C13.5).
struct HevcSpsFields
{
    uint32_t spsId = 0;
    uint32_t vpsId = 0;
    uint32_t maxSubLayersMinus1 = 0;
    bool temporalIdNesting = false;
    /// profile_tier_level()'s general part.
    uint32_t profileIdc = 0;
    bool highTier = false;
    uint32_t levelIdc = 0; ///< 30 × the level: 123 for 4.1
    bool progressiveSource = false;
    bool interlacedSource = false;
    bool nonPackedConstraint = false;
    bool frameOnlyConstraint = false;
    uint32_t chromaFormatIdc = 1;
    /// pic_width/height_in_luma_samples: the size as coded.
    uint32_t width = 0;
    uint32_t height = 0;
    /// The conformance window, in chroma samples.
    uint32_t cropLeft = 0;
    uint32_t cropRight = 0;
    uint32_t cropTop = 0;
    uint32_t cropBottom = 0;
    uint32_t bitDepthLuma = 8;
    uint32_t bitDepthChroma = 8;
    int log2MaxPocLsb = 4;
    uint32_t maxDecPicBufferingMinus1 = 0; ///< of the highest sub-layer
    uint32_t maxNumReorderPics = 0;
    uint32_t maxLatencyIncreasePlus1 = 0;
    int log2MinCodingBlock = 3;
    int log2CodingTreeBlock = 3;
    int log2MinTransformBlock = 2;
    int log2MaxTransformBlock = 2;
    /// What AMD's firmware codes whatever the SPS says — and what a decoder
    /// must be told for its split flags to line up (bench §8o.3).
    uint32_t maxTransformHierarchyDepthInter = 0;
    uint32_t maxTransformHierarchyDepthIntra = 0;
    /// scaling_list_enabled_flag, with the default lists: data in the SPS is
    /// refused.
    bool scalingList = false;
    bool asymmetricMotionPartitions = false;
    bool sampleAdaptiveOffset = false;
    bool pcm = false;
    uint32_t pcmBitDepthLuma = 0;
    uint32_t pcmBitDepthChroma = 0;
    int log2MinPcmCodingBlock = 0;
    int log2MaxPcmCodingBlock = 0;
    bool pcmLoopFilterDisabled = false;
    bool longTermReferences = false;
    std::vector<uint32_t> longTermPocLsb; ///< lt_ref_pic_poc_lsb_sps
    std::vector<bool> longTermUsed;       ///< used_by_curr_pic_lt_sps_flag
    bool temporalMvp = false;
    bool strongIntraSmoothing = false;
    bool vui = false; ///< vui_parameters_present_flag; the VUI itself is not read

    uint32_t pictureSizeInCtbs() const
    {
        const uint32_t ctb = 1u << log2CodingTreeBlock;
        return ((width + ctb - 1) / ctb) * ((height + ctb - 1) / ctb);
    }
};

/// What the slice header's syntax depends on in a PPS.
struct HevcPpsFields
{
    uint32_t ppsId = 0;
    uint32_t spsId = 0;
    bool dependentSliceSegments = false;
    bool outputFlagPresent = false;
    uint32_t extraSliceHeaderBits = 0;
    bool signDataHiding = false;
    bool cabacInitPresent = false;
    uint32_t defaultActiveL0 = 1; ///< num_ref_idx_l0_default_active_minus1 + 1
    uint32_t defaultActiveL1 = 1;
    int32_t initQp = 26;
    bool constrainedIntraPred = false;
    bool transformSkip = false;
    bool cuQpDelta = false;
    uint32_t diffCuQpDeltaDepth = 0;
    int32_t cbQpOffset = 0;
    int32_t crQpOffset = 0;
    bool sliceChromaQpOffsets = false;
    bool weightedPred = false;
    bool weightedBipred = false;
    bool transquantBypass = false;
    bool tiles = false;
    bool entropyCodingSync = false;
    bool loopFilterAcrossSlices = false;
    bool deblockingControlPresent = false;
    bool deblockingOverride = false; ///< deblocking_filter_override_enabled_flag
    bool deblockingDisabled = false;
    int32_t betaOffsetDiv2 = 0;
    int32_t tcOffsetDiv2 = 0;
    bool listsModification = false;
    int log2ParallelMergeLevel = 2;
    bool sliceHeaderExtension = false;
};

/// A slice segment header, as read.
struct HevcSliceFields
{
    struct Reference
    {
        int32_t deltaPoc = 0; ///< from this picture: negative for the ones before it
        bool used = false;    ///< predicted from, not only kept
    };
    struct LongTerm
    {
        uint32_t pocLsb = 0;
        bool used = false;
        bool msbPresent = false;
        uint32_t msbCycle = 0;
    };

    uint8_t nalType = 0;
    bool noOutputOfPriorPics = false;
    uint32_t ppsId = 0;
    uint32_t segmentAddress = 0; ///< 0 on a picture's first slice
    uint32_t sliceType = 2;      ///< 0 B, 1 P, 2 I
    uint32_t pocLsb = 0;         ///< an IDR carries none: 0
    /// The short-term reference picture set: the ones before this picture
    /// first, nearest first, then the ones after it.
    std::vector<Reference> shortTerm;
    /// st_ref_pic_set()'s length in the header, in bits — what a Vulkan
    /// decoder is handed as NumBitsForSTRPSInSlice. 0 on an IDR.
    uint32_t shortTermSetBits = 0;
    std::vector<LongTerm> longTerm;
    bool temporalMvp = false;
    bool saoLuma = false;
    bool saoChroma = false;
    uint32_t activeL0 = 0; ///< num_ref_idx_l0_active_minus1 + 1, override applied; 0 on I
    uint32_t activeL1 = 0; ///< same for L1; 0 unless B
    std::vector<uint32_t> listEntryL0; ///< empty unless the list was modified
    std::vector<uint32_t> listEntryL1;
    bool mvdL1Zero = false;
    bool cabacInit = false;
    bool collocatedFromL0 = true;
    uint32_t collocatedRefIdx = 0;
    uint32_t maxMergeCandidates = 5;
    int32_t qp = 26; ///< SliceQpY: the PPS's initial QP plus slice_qp_delta
    int32_t cbQpOffset = 0;
    int32_t crQpOffset = 0;
    bool deblockingDisabled = false;
    int32_t betaOffsetDiv2 = 0;
    int32_t tcOffsetDiv2 = 0;
    bool loopFilterAcrossSlices = false;
    uint32_t entryPoints = 0;
    /// The header's length in the RBSP after the two-byte NAL header,
    /// byte_alignment() included.
    size_t headerBits = 0;

    /// NumPicTotalCurr: the pictures this one may predict from.
    uint32_t referencesUsed() const
    {
        uint32_t n = 0;
        for (const Reference& r : shortTerm)
            n += r.used ? 1 : 0;
        for (const LongTerm& l : longTerm)
            n += l.used ? 1 : 0;
        return n;
    }
};

namespace hevcparse_detail {

using h264vui_detail::BitReader;

/// A slice header is a few dozen bytes; the slice behind it, megabytes. Only
/// this much of a unit is unescaped.
constexpr size_t kHeaderLimit = 1024;

/// A reader that ran out reads zeros, which parse as something; this is said
/// before any value read past the end is judged.
constexpr const char* kPastTheEnd = "the header runs past the end of the unit";

inline uint32_t ceilLog2(uint32_t v)
{
    uint32_t n = 0;
    while ((uint64_t(1) << n) < v)
        ++n;
    return n;
}

/// @p data with its start code off, if it has one.
inline void skipStartCode(const uint8_t*& data, size_t& size)
{
    if (size >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 1) {
        data += 4;
        size -= 4;
    } else if (size >= 3 && data[0] == 0 && data[1] == 0 && data[2] == 1) {
        data += 3;
        size -= 3;
    }
}

/// The NAL unit type of @p data (start code off), after checking the header;
/// an error otherwise.
inline std::string header(const uint8_t* data, size_t size, uint8_t& type)
{
    if (size < 2) return "a unit too short for its NAL header";
    if (data[0] & 0x80) return "forbidden_zero_bit set";
    const uint32_t layer = ((data[0] & 1u) << 5) | (data[1] >> 3);
    if (layer != 0) return "nuh_layer_id " + std::to_string(layer) + ": one layer only";
    if ((data[1] & 7) == 0) return "nuh_temporal_id_plus1 0";
    type = static_cast<uint8_t>((data[0] >> 1) & 0x3F);
    return {};
}

/// The RBSP after the NAL header, emulation prevention undone, up to @p limit bytes.
inline std::vector<uint8_t> payload(const uint8_t* data, size_t size, size_t limit)
{
    const size_t n = size - 2 < limit ? size - 2 : limit;
    return h264vui_detail::unescape(data + 2, n);
}

/// profile_tier_level(1, maxSubLayersMinus1): the general part into @p s, the
/// sub-layers' skipped.
inline void readProfileTierLevel(BitReader& r, uint32_t maxSubLayersMinus1, HevcSpsFields& s)
{
    r.u(2); // general_profile_space
    s.highTier = r.u(1) != 0;
    s.profileIdc = r.u(5);
    r.u(32); // general_profile_compatibility_flag[32]
    s.progressiveSource = r.u(1) != 0;
    s.interlacedSource = r.u(1) != 0;
    s.nonPackedConstraint = r.u(1) != 0;
    s.frameOnlyConstraint = r.u(1) != 0;
    r.u(32); // the 43 bits of constraint flags and reserved ones…
    r.u(12); // …and general_inbld_flag or its reserved bit
    s.levelIdc = r.u(8);
    bool profile[8] = {};
    bool level[8] = {};
    for (uint32_t i = 0; i < maxSubLayersMinus1; ++i) {
        profile[i] = r.u(1) != 0;
        level[i] = r.u(1) != 0;
    }
    if (maxSubLayersMinus1 > 0)
        for (uint32_t i = maxSubLayersMinus1; i < 8; ++i)
            r.u(2); // reserved_zero_2bits
    for (uint32_t i = 0; i < maxSubLayersMinus1; ++i) {
        if (profile[i]) {
            r.u(32);
            r.u(32);
            r.u(24); // sub_layer profile: 88 bits
        }
        if (level[i]) r.u(8);
    }
}

/// rbsp_trailing_bits(): a one, then zeros to the byte, then nothing.
inline bool trailing(BitReader& r)
{
    if (r.u(1) != 1) return false;
    while (r.pos % 8)
        if (r.u(1) != 0) return false;
    return !r.overrun && r.pos == r.bytes.size() * 8;
}

} // namespace hevcparse_detail

/// The NAL units of an Annex-B stream.
inline std::vector<HevcNalUnit> hevcNalUnits(const uint8_t* data, size_t size)
{
    std::vector<HevcNalUnit> units;
    size_t start = SIZE_MAX;
    size_t i = 0;
    while (i + 3 <= size) {
        if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) {
            if (start != SIZE_MAX) {
                size_t end = i;
                while (end > start && data[end - 1] == 0)
                    --end;
                units.push_back({data + start, end - start});
            }
            i += 3;
            start = i;
        } else {
            ++i;
        }
    }
    if (start != SIZE_MAX) {
        size_t end = size;
        while (end > start && data[end - 1] == 0)
            --end;
        units.push_back({data + start, end - start});
    }
    return units;
}

/// Removes the filler-data units (type 38) of an Annex-B stream in place and
/// returns the size kept — `size` itself when there are none. Each unit goes
/// with its own start code; every other byte keeps its order.
///
/// A constant-bitrate encoder pads a short picture up to its budget with
/// them. RADV does, after the slices (Mesa 26.2.3 on the 780M, 29/09/2026): a
/// quarter to a third of a moving desktop's bytes at 16 Mbit/s, and all but a
/// few hundred bytes of an unchanged picture's. Nothing past the encoder needs
/// them — the browser's decoder drops them. The shim strips Sunshine's the
/// same way (backend/src/streaming/AnnexBFiller.h, which this module may not
/// include). Annex B's emulation prevention keeps start codes out of a unit,
/// so the scan cannot cut one in two.
inline size_t stripHevcFiller(uint8_t* data, size_t size)
{
    constexpr size_t kNone = SIZE_MAX;
    size_t written = 0;       // bytes kept so far, compacted at the front
    size_t pendingFrom = 0;   // start of the kept run not moved yet
    size_t unitStart = kNone; // start code of the unit being walked
    size_t unitHeader = kNone;
    bool unitIsFiller = false;
    bool removed = false;

    const auto close = [&](size_t end) {
        if (unitStart == kNone || !unitIsFiller) return;
        // Keep what came before this unit, drop the unit itself.
        if (written != pendingFrom)
            std::memmove(data + written, data + pendingFrom, unitStart - pendingFrom);
        written += unitStart - pendingFrom;
        pendingFrom = end;
        removed = true;
    };

    size_t from = 2; // a start code's 0x01 sits at index 2 at the earliest
    while (from < size) {
        const void* hit = std::memchr(data + from, 0x01, size - from);
        if (!hit) break;
        const size_t one = static_cast<size_t>(static_cast<const uint8_t*>(hit) - data);
        from = one + 1;
        if (data[one - 1] != 0 || data[one - 2] != 0) continue;
        size_t start = one - 2;
        // The four-byte form, without eating the previous unit's header.
        if (start > 0 && data[start - 1] == 0 && (unitHeader == kNone || start - 1 > unitHeader))
            --start;
        close(start);
        unitStart = start;
        unitHeader = one + 1;
        unitIsFiller = unitHeader < size && ((data[unitHeader] >> 1) & 0x3F) == 38;
        from = one + 3; // the next 0x01 needs a header byte and two zeros first
    }
    close(size);

    if (!removed) return size;
    if (written != pendingFrom)
        std::memmove(data + written, data + pendingFrom, size - pendingFrom);
    return written + (size - pendingFrom);
}

/// Reads an SPS unit (start code or not) up to the VUI. Empty on success,
/// otherwise what could not be read.
inline std::string parseHevcSps(const uint8_t* data, size_t size, HevcSpsFields& out)
{
    using namespace hevcparse_detail;
    skipStartCode(data, size);
    uint8_t type = 0;
    const std::string bad = header(data, size, type);
    if (!bad.empty()) return bad;
    if (type != 33) return "not an SPS: NAL type " + std::to_string(type);
    const std::vector<uint8_t> rbsp = payload(data, size, kHeaderLimit);
    BitReader r{rbsp};
    HevcSpsFields s;
    s.vpsId = r.u(4);
    const uint32_t maxSubLayersMinus1 = r.u(3);
    if (maxSubLayersMinus1 > 6)
        return "sps_max_sub_layers_minus1 " + std::to_string(maxSubLayersMinus1);
    s.maxSubLayersMinus1 = maxSubLayersMinus1;
    s.temporalIdNesting = r.u(1) != 0;
    readProfileTierLevel(r, maxSubLayersMinus1, s);
    s.spsId = r.ue();
    if (s.spsId > 15) return "sps_seq_parameter_set_id " + std::to_string(s.spsId);
    s.chromaFormatIdc = r.ue();
    if (s.chromaFormatIdc > 3) return "chroma_format_idc " + std::to_string(s.chromaFormatIdc);
    if (s.chromaFormatIdc == 3 && r.u(1)) return "separate colour planes: not followed";
    s.width = r.ue();
    s.height = r.ue();
    if (r.u(1)) { // conformance_window_flag
        s.cropLeft = r.ue();
        s.cropRight = r.ue();
        s.cropTop = r.ue();
        s.cropBottom = r.ue();
    }
    s.bitDepthLuma = r.ue() + 8;
    s.bitDepthChroma = r.ue() + 8;
    if (s.bitDepthLuma > 16 || s.bitDepthChroma > 16) return "a bit depth above 16";
    const uint32_t pocMinus4 = r.ue();
    if (pocMinus4 > 12) return "log2_max_pic_order_cnt_lsb_minus4 " + std::to_string(pocMinus4);
    s.log2MaxPocLsb = static_cast<int>(pocMinus4) + 4;
    const bool everySubLayer = r.u(1) != 0; // sps_sub_layer_ordering_info_present_flag
    for (uint32_t i = everySubLayer ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; ++i) {
        s.maxDecPicBufferingMinus1 = r.ue();
        s.maxNumReorderPics = r.ue();
        s.maxLatencyIncreasePlus1 = r.ue();
    }
    if (s.maxDecPicBufferingMinus1 > 15) return "a DPB of more than 16 pictures";
    const uint32_t minCbMinus3 = r.ue();
    const uint32_t ctbDiff = r.ue();
    if (minCbMinus3 > 3 || minCbMinus3 + ctbDiff > 3) return "coding blocks beyond 64";
    s.log2MinCodingBlock = static_cast<int>(minCbMinus3) + 3;
    s.log2CodingTreeBlock = s.log2MinCodingBlock + static_cast<int>(ctbDiff);
    const uint32_t minTbMinus2 = r.ue();
    const uint32_t tbDiff = r.ue();
    if (minTbMinus2 > 3 || minTbMinus2 + tbDiff > 3) return "transform blocks beyond 32";
    s.log2MinTransformBlock = static_cast<int>(minTbMinus2) + 2;
    s.log2MaxTransformBlock = s.log2MinTransformBlock + static_cast<int>(tbDiff);
    s.maxTransformHierarchyDepthInter = r.ue();
    s.maxTransformHierarchyDepthIntra = r.ue();
    const uint32_t depthLimit =
        static_cast<uint32_t>(s.log2CodingTreeBlock - s.log2MinTransformBlock);
    if (s.maxTransformHierarchyDepthInter > depthLimit ||
        s.maxTransformHierarchyDepthIntra > depthLimit)
        return "a transform hierarchy deeper than the CTB allows";
    s.scalingList = r.u(1) != 0;
    if (s.scalingList && r.u(1)) return "scaling list data in the SPS: not followed";
    s.asymmetricMotionPartitions = r.u(1) != 0;
    s.sampleAdaptiveOffset = r.u(1) != 0;
    s.pcm = r.u(1) != 0;
    if (s.pcm) {
        s.pcmBitDepthLuma = r.u(4) + 1;
        s.pcmBitDepthChroma = r.u(4) + 1;
        s.log2MinPcmCodingBlock = static_cast<int>(r.ue()) + 3;
        s.log2MaxPcmCodingBlock = s.log2MinPcmCodingBlock + static_cast<int>(r.ue());
        s.pcmLoopFilterDisabled = r.u(1) != 0;
    }
    const uint32_t sets = r.ue();
    if (sets != 0) return std::to_string(sets) + " short-term sets in the SPS: not followed";
    s.longTermReferences = r.u(1) != 0;
    if (s.longTermReferences) {
        const uint32_t count = r.ue();
        if (count > 32) return "num_long_term_ref_pics_sps " + std::to_string(count);
        for (uint32_t i = 0; i < count; ++i) {
            s.longTermPocLsb.push_back(r.u(s.log2MaxPocLsb));
            s.longTermUsed.push_back(r.u(1) != 0);
        }
    }
    s.temporalMvp = r.u(1) != 0;
    s.strongIntraSmoothing = r.u(1) != 0;
    // The VUI says nothing a slice depends on, nor a decoder's parameters.
    s.vui = r.u(1) != 0;
    if (r.overrun) return "the SPS runs past its end";
    out = s;
    return {};
}

/// Reads a PPS unit (start code or not), to its trailing bits. Empty on
/// success, otherwise what could not be read.
inline std::string parseHevcPps(const uint8_t* data, size_t size, HevcPpsFields& out)
{
    using namespace hevcparse_detail;
    skipStartCode(data, size);
    uint8_t type = 0;
    const std::string bad = header(data, size, type);
    if (!bad.empty()) return bad;
    if (type != 34) return "not a PPS: NAL type " + std::to_string(type);
    const std::vector<uint8_t> rbsp = payload(data, size, kHeaderLimit);
    BitReader r{rbsp};
    HevcPpsFields p;
    p.ppsId = r.ue();
    p.spsId = r.ue();
    if (p.ppsId > 63 || p.spsId > 15) return "a parameter set id out of range";
    p.dependentSliceSegments = r.u(1) != 0;
    p.outputFlagPresent = r.u(1) != 0;
    p.extraSliceHeaderBits = r.u(3);
    p.signDataHiding = r.u(1) != 0;
    p.cabacInitPresent = r.u(1) != 0;
    p.defaultActiveL0 = r.ue() + 1;
    p.defaultActiveL1 = r.ue() + 1;
    if (p.defaultActiveL0 > 15 || p.defaultActiveL1 > 15) return "more than 15 default references";
    p.initQp = 26 + r.se();
    p.constrainedIntraPred = r.u(1) != 0;
    p.transformSkip = r.u(1) != 0;
    p.cuQpDelta = r.u(1) != 0;
    if (p.cuQpDelta) p.diffCuQpDeltaDepth = r.ue();
    if (p.diffCuQpDeltaDepth > 3) return "diff_cu_qp_delta_depth beyond the CTB";
    p.cbQpOffset = r.se();
    p.crQpOffset = r.se();
    if (p.cbQpOffset < -12 || p.cbQpOffset > 12 || p.crQpOffset < -12 || p.crQpOffset > 12)
        return "a chroma QP offset beyond ±12";
    p.sliceChromaQpOffsets = r.u(1) != 0;
    p.weightedPred = r.u(1) != 0;
    p.weightedBipred = r.u(1) != 0;
    p.transquantBypass = r.u(1) != 0;
    p.tiles = r.u(1) != 0;
    p.entropyCodingSync = r.u(1) != 0;
    if (p.tiles) {
        const uint32_t columns = r.ue() + 1;
        const uint32_t rows = r.ue() + 1;
        if (columns > 20 || rows > 22) return "more tiles than any level allows";
        if (!r.u(1)) { // uniform_spacing_flag
            for (uint32_t i = 0; i + 1 < columns; ++i)
                r.ue();
            for (uint32_t i = 0; i + 1 < rows; ++i)
                r.ue();
        }
        r.u(1); // loop_filter_across_tiles_enabled_flag
    }
    p.loopFilterAcrossSlices = r.u(1) != 0;
    p.deblockingControlPresent = r.u(1) != 0;
    if (p.deblockingControlPresent) {
        p.deblockingOverride = r.u(1) != 0;
        p.deblockingDisabled = r.u(1) != 0;
        if (!p.deblockingDisabled) {
            p.betaOffsetDiv2 = r.se();
            p.tcOffsetDiv2 = r.se();
        }
    }
    if (r.u(1)) return "scaling list data in the PPS: not followed";
    p.listsModification = r.u(1) != 0;
    p.log2ParallelMergeLevel = static_cast<int>(r.ue()) + 2;
    if (p.log2ParallelMergeLevel > 6) return "log2_parallel_merge_level beyond the CTB";
    p.sliceHeaderExtension = r.u(1) != 0;
    if (r.u(1)) return "PPS extensions: not followed";
    if (!trailing(r)) return "the PPS does not end on its trailing bits";
    out = p;
    return {};
}

/// Reads the header of a slice segment unit (start code or not) with the SPS
/// and PPS it refers to, down to its byte_alignment(). Empty on success,
/// otherwise the first thing that does not fit.
inline std::string parseHevcSliceHeader(const uint8_t* data, size_t size, const HevcSpsFields& sps,
                                        const HevcPpsFields& pps, HevcSliceFields& out)
{
    using namespace hevcparse_detail;
    skipStartCode(data, size);
    uint8_t type = 0;
    const std::string bad = header(data, size, type);
    if (!bad.empty()) return bad;
    if (type > 21 || (type > 9 && type < 16))
        return "not a slice: NAL type " + std::to_string(type);
    if (pps.spsId != sps.spsId) return "the PPS names another SPS";
    const bool irap = type >= 16;
    const bool idr = type == 19 || type == 20;
    const std::vector<uint8_t> rbsp = payload(data, size, kHeaderLimit);
    BitReader r{rbsp};
    HevcSliceFields f;
    f.nalType = type;

    const bool first = r.u(1) != 0;
    if (irap) f.noOutputOfPriorPics = r.u(1) != 0;
    f.ppsId = r.ue();
    if (f.ppsId != pps.ppsId)
        return "the slice names PPS " + std::to_string(f.ppsId) + ", the stream has " +
               std::to_string(pps.ppsId);
    if (!first) {
        if (pps.dependentSliceSegments && r.u(1)) return "a dependent slice segment: not followed";
        const uint32_t ctbs = sps.pictureSizeInCtbs();
        f.segmentAddress = r.u(static_cast<int>(ceilLog2(ctbs)));
        if (f.segmentAddress >= ctbs) return "slice_segment_address beyond the picture";
    }
    r.u(static_cast<int>(pps.extraSliceHeaderBits));
    f.sliceType = r.ue();
    if (f.sliceType > 2) return "slice_type " + std::to_string(f.sliceType);
    if (irap && f.sliceType != 2) return "an IRAP picture with a P or B slice";
    if (pps.outputFlagPresent) r.u(1); // pic_output_flag

    if (!idr) {
        f.pocLsb = r.u(sps.log2MaxPocLsb);
        if (r.u(1)) return "short_term_ref_pic_set_sps_flag set, and the SPS has no set";
        // st_ref_pic_set(num_short_term_ref_pic_sets), with none in the SPS:
        // no prediction from another set. Its length is what a decoder is told.
        const size_t setStart = r.pos;
        const uint32_t before = r.ue();
        const uint32_t after = r.ue();
        if (before > sps.maxDecPicBufferingMinus1 || after > sps.maxDecPicBufferingMinus1 - before)
            return std::to_string(before) + "+" + std::to_string(after) +
                   " pictures in the reference set, more than the DPB holds";
        int32_t poc = 0;
        for (uint32_t i = 0; i < before; ++i) {
            poc -= static_cast<int32_t>(r.ue()) + 1;
            f.shortTerm.push_back({poc, r.u(1) != 0});
        }
        poc = 0;
        for (uint32_t i = 0; i < after; ++i) {
            poc += static_cast<int32_t>(r.ue()) + 1;
            f.shortTerm.push_back({poc, r.u(1) != 0});
        }
        f.shortTermSetBits = static_cast<uint32_t>(r.pos - setStart);
        if (sps.longTermReferences) {
            const uint32_t spsCount = static_cast<uint32_t>(sps.longTermPocLsb.size());
            const uint32_t fromSps = spsCount > 0 ? r.ue() : 0;
            const uint32_t own = r.ue();
            if (fromSps > spsCount || fromSps + own > 16) return "too many long-term pictures";
            for (uint32_t i = 0; i < fromSps + own; ++i) {
                HevcSliceFields::LongTerm lt;
                if (i < fromSps) {
                    const uint32_t idx =
                        spsCount > 1 ? r.u(static_cast<int>(ceilLog2(spsCount))) : 0;
                    if (idx >= spsCount) return "lt_idx_sps beyond the SPS's list";
                    lt.pocLsb = sps.longTermPocLsb[idx];
                    lt.used = sps.longTermUsed[idx];
                } else {
                    lt.pocLsb = r.u(sps.log2MaxPocLsb);
                    lt.used = r.u(1) != 0;
                }
                lt.msbPresent = r.u(1) != 0;
                if (lt.msbPresent) lt.msbCycle = r.ue();
                f.longTerm.push_back(lt);
            }
        }
        if (sps.temporalMvp) f.temporalMvp = r.u(1) != 0;
    }
    if (r.overrun) return kPastTheEnd;
    if (sps.sampleAdaptiveOffset) {
        f.saoLuma = r.u(1) != 0;
        if (sps.chromaFormatIdc != 0) f.saoChroma = r.u(1) != 0;
    }

    if (f.sliceType != 2) {
        const bool b = f.sliceType == 0;
        const uint32_t total = f.referencesUsed();
        if (total == 0) return "a P or B slice with nothing to predict from";
        f.activeL0 = pps.defaultActiveL0;
        f.activeL1 = b ? pps.defaultActiveL1 : 0;
        if (r.u(1)) { // num_ref_idx_active_override_flag
            f.activeL0 = r.ue() + 1;
            if (b) f.activeL1 = r.ue() + 1;
        }
        if (f.activeL0 > 15 || f.activeL1 > 15) return "more than 15 active references";
        if (pps.listsModification && total > 1) {
            const int bits = static_cast<int>(ceilLog2(total));
            if (r.u(1))
                for (uint32_t i = 0; i < f.activeL0; ++i)
                    f.listEntryL0.push_back(r.u(bits));
            if (b && r.u(1))
                for (uint32_t i = 0; i < f.activeL1; ++i)
                    f.listEntryL1.push_back(r.u(bits));
            for (uint32_t entry : f.listEntryL0)
                if (entry >= total) return "list_entry_l0 beyond the reference set";
            for (uint32_t entry : f.listEntryL1)
                if (entry >= total) return "list_entry_l1 beyond the reference set";
        }
        if (b) f.mvdL1Zero = r.u(1) != 0;
        if (pps.cabacInitPresent) f.cabacInit = r.u(1) != 0;
        if (f.temporalMvp) {
            if (b) f.collocatedFromL0 = r.u(1) != 0;
            const uint32_t active = f.collocatedFromL0 ? f.activeL0 : f.activeL1;
            if (active > 1) {
                f.collocatedRefIdx = r.ue();
                if (f.collocatedRefIdx >= active) return "collocated_ref_idx beyond its list";
            }
        }
        if ((pps.weightedPred && !b) || (pps.weightedBipred && b))
            return "weighted prediction: not followed";
        const uint32_t fiveMinus = r.ue();
        if (fiveMinus > 4) return "five_minus_max_num_merge_cand " + std::to_string(fiveMinus);
        f.maxMergeCandidates = 5 - fiveMinus;
    }

    f.qp = pps.initQp + r.se();
    const int32_t lowestQp = -6 * static_cast<int32_t>(sps.bitDepthLuma - 8);
    if (f.qp < lowestQp || f.qp > 51) return "slice QP " + std::to_string(f.qp);
    if (pps.sliceChromaQpOffsets) {
        f.cbQpOffset = r.se();
        f.crQpOffset = r.se();
        const auto inRange = [](int32_t v) { return v >= -12 && v <= 12; };
        if (!inRange(f.cbQpOffset) || !inRange(f.crQpOffset) ||
            !inRange(f.cbQpOffset + pps.cbQpOffset) || !inRange(f.crQpOffset + pps.crQpOffset))
            return "a slice chroma QP offset beyond ±12";
    }
    f.deblockingDisabled = pps.deblockingDisabled;
    f.betaOffsetDiv2 = pps.betaOffsetDiv2;
    f.tcOffsetDiv2 = pps.tcOffsetDiv2;
    if (pps.deblockingOverride && r.u(1)) { // deblocking_filter_override_flag
        f.deblockingDisabled = r.u(1) != 0;
        if (!f.deblockingDisabled) {
            f.betaOffsetDiv2 = r.se();
            f.tcOffsetDiv2 = r.se();
            if (f.betaOffsetDiv2 < -6 || f.betaOffsetDiv2 > 6 || f.tcOffsetDiv2 < -6 ||
                f.tcOffsetDiv2 > 6)
                return "a deblocking offset beyond ±6";
        }
    }
    f.loopFilterAcrossSlices = pps.loopFilterAcrossSlices;
    if (pps.loopFilterAcrossSlices && (f.saoLuma || f.saoChroma || !f.deblockingDisabled))
        f.loopFilterAcrossSlices = r.u(1) != 0;

    if (pps.tiles || pps.entropyCodingSync) {
        f.entryPoints = r.ue();
        if (f.entryPoints > 440) return "more entry points than any picture has";
        if (f.entryPoints > 0) {
            const uint32_t lengthMinus1 = r.ue();
            if (lengthMinus1 > 31) return "offset_len_minus1 " + std::to_string(lengthMinus1);
            for (uint32_t i = 0; i < f.entryPoints; ++i)
                r.u(static_cast<int>(lengthMinus1) + 1);
        }
    }
    if (pps.sliceHeaderExtension) {
        const uint32_t length = r.ue();
        if (length > 256) return "a slice header extension of " + std::to_string(length) + " bytes";
        for (uint32_t i = 0; i < length; ++i)
            r.u(8);
    }

    // byte_alignment(): where the parameter sets and the driver disagree, this
    // is where it shows.
    const size_t end = r.pos;
    bool aligned = r.u(1) == 1;
    while (aligned && r.pos % 8)
        aligned = r.u(1) == 0;
    if (r.overrun) return kPastTheEnd;
    if (!aligned)
        return "no byte_alignment() where the parameter sets end the header (bit " +
               std::to_string(end) + ")";
    f.headerBits = r.pos;
    out = f;
    return {};
}

} // namespace mw::native::encode
