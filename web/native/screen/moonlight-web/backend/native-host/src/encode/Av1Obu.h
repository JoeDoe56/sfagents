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

// The AV1 headers of a stream whose tiles a driver codes (plan
// pipeline-video-d3d12-v2, C9.2): D3D12 Video Encode writes the tile data
// alone, and hands back, once the picture is coded, the values of the frame
// header it chose — quantizer, loop filter, CDEF, segmentation. The sequence
// header, the temporal delimiter and the frame header are written here, from
// the AV1 specification (section 5), in the low-overhead format: every OBU
// carries its size.
//
// What the encoder asks for, and so what these write: shown frames only, key
// or inter, a single tile (a picture up to 4096 wide and 4096×2304 in area),
// no frame size override, no screen content tools, no super-resolution, no
// film grain, no frame ids, no decoder model. Pure bytes: testable anywhere.

#include "H264Vui.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace mw::native::encode::av1 {

constexpr int kNumRefFrames = 8;
constexpr int kRefsPerFrame = 7;
constexpr int kPrimaryRefNone = 7;
constexpr int kMaxSegments = 8;
constexpr int kSegLvlMax = 8;
/// A single tile covers up to this: MAX_TILE_WIDTH and MAX_TILE_AREA.
constexpr uint32_t kMaxTileWidth = 4096;
constexpr uint32_t kMaxTileArea = 4096 * 2304;

enum class ObuType : uint8_t
{
    SequenceHeader = 1,
    TemporalDelimiter = 2,
    FrameHeader = 3,
    TileGroup = 4,
    Metadata = 5,
    Frame = 6,
};

struct Sequence
{
    int profile = 0;  ///< seq_profile: 0 Main, 4:2:0 in 8 or 10 bits
    int levelIdx = 8; ///< seq_level_idx: (major - 2) × 4 + minor
    int tier = 0;
    uint32_t width = 0; ///< the frames' size: no frame carries its own
    uint32_t height = 0;
    bool tenBit = false;
    /// BT.2020 PQ (HDR) rather than BT.709; limited range either way.
    bool hdr = false;
    int orderHintBits = 8; ///< 0: no order hints
    bool sb128 = false;
    bool filterIntra = false;
    bool intraEdgeFilter = false;
    bool interintraCompound = false;
    bool maskedCompound = false;
    bool warpedMotion = false;
    bool dualFilter = false;
    bool jntComp = false;
    bool refFrameMvs = false;
    bool cdef = false;
    bool restoration = false;
    /// A driver may give U and V different quantizer deltas.
    bool separateUvDeltaQ = true;
};

struct Quantization
{
    int baseQIdx = 0;
    int deltaQYDc = 0;
    int deltaQUDc = 0;
    int deltaQUAc = 0;
    int deltaQVDc = 0;
    int deltaQVAc = 0;
    bool usingQmatrix = false;
    int qmY = 0;
    int qmU = 0;
    int qmV = 0;
};

struct Segmentation
{
    bool enabled = false;
    bool updateMap = false;
    bool temporalUpdate = false;
    bool updateData = false;
    /// Bit j of segment i: feature j (SEG_LVL_ALT_Q = 0 … SEG_LVL_GLOBALMV = 7).
    std::array<uint32_t, kMaxSegments> features{};
    std::array<std::array<int, kSegLvlMax>, kMaxSegments> values{};
};

struct LoopFilter
{
    std::array<int, 4> level{}; ///< Y vertical, Y horizontal, U, V
    int sharpness = 0;
    bool deltaEnabled = false;
    /// D3D12 says one update flag for all eight references, one for both modes.
    bool updateRefDelta = false;
    std::array<int, kNumRefFrames> refDeltas{};
    bool updateModeDelta = false;
    std::array<int, 2> modeDeltas{};
};

struct Cdef
{
    int dampingMinus3 = 0;
    int bits = 0;
    /// As coded: a secondary strength of 3 means 4.
    std::array<int, 8> yPri{};
    std::array<int, 8> ySec{};
    std::array<int, 8> uvPri{};
    std::array<int, 8> uvSec{};
};

/// One shown frame, key or inter.
struct Frame
{
    bool key = true;
    uint32_t orderHint = 0;
    int primaryRefFrame = kPrimaryRefNone;
    uint8_t refreshFrameFlags = 0xFF;
    std::array<int, kRefsPerFrame> refFrameIdx{};
    /// The order hints the eight slots hold: skip mode's arithmetic.
    std::array<uint32_t, kNumRefFrames> refOrderHint{};
    bool errorResilient = false; ///< inter frames; a shown key frame always is
    bool disableCdfUpdate = false;
    bool disableFrameEndUpdateCdf = false;
    /// The picture shown, when it is smaller than the frame; 0 for the frame's.
    uint32_t renderWidth = 0;
    uint32_t renderHeight = 0;
    bool allowHighPrecisionMv = false;
    int interpolationFilter = 4; ///< EIGHTTAP 0 … BILINEAR 3, 4 switchable
    bool motionModeSwitchable = false;
    bool useRefFrameMvs = false;
    Quantization q;
    Segmentation seg;
    bool deltaQPresent = false;
    int deltaQRes = 0;
    bool deltaLfPresent = false;
    int deltaLfRes = 0;
    bool deltaLfMulti = false;
    LoopFilter lf;
    Cdef cdef;
    std::array<int, 3> lrType{}; ///< as coded: 0 none, 1 switchable, 2 Wiener, 3 self-guided
    bool lrUnitShift = false;
    bool lrUnitExtraShift = false;
    bool lrUvShift = false;
    bool txModeSelect = true;
    bool referenceSelect = false;
    bool skipModePresent = false;
    bool allowWarpedMotion = false;
    bool reducedTxSet = false;
};

namespace detail {

using h264vui_detail::BitWriter;

/// su(n): n bits, two's complement.
inline void su(BitWriter& w, int n, int value)
{
    w.u(n, static_cast<uint32_t>(value) & ((1u << n) - 1u));
}

inline void deltaQ(BitWriter& w, int value)
{
    w.u(1, value != 0 ? 1 : 0); // delta_coded
    if (value != 0) su(w, 7, value);
}

inline void byteAlignment(BitWriter& w)
{
    while (w.used != 8)
        w.u(1, 0);
}

inline void trailingBits(BitWriter& w)
{
    w.u(1, 1);
    byteAlignment(w);
}

inline std::vector<uint8_t> leb128(uint64_t value)
{
    std::vector<uint8_t> out;
    do {
        uint8_t byte = value & 0x7F;
        value >>= 7;
        if (value) byte |= 0x80;
        out.push_back(byte);
    } while (value);
    return out;
}

/// obu_header() with obu_has_size_field, then obu_size.
inline std::vector<uint8_t> obuHeader(ObuType type, uint64_t payloadSize)
{
    std::vector<uint8_t> out = {static_cast<uint8_t>((static_cast<uint8_t>(type) << 3) | 0x02)};
    const std::vector<uint8_t> size = leb128(payloadSize);
    out.insert(out.end(), size.begin(), size.end());
    return out;
}

/// Bits enough for @p value (at least one).
inline int bitsFor(uint32_t value)
{
    int n = 1;
    while (n < 32 && (value >> n) != 0)
        ++n;
    return n;
}

/// tile_log2(blkSize, target): the smallest k with blkSize << k >= target.
inline int tileLog2(uint32_t blkSize, uint32_t target)
{
    int k = 0;
    while ((static_cast<uint64_t>(blkSize) << k) < target)
        ++k;
    return k;
}

/// get_relative_dist().
inline int relativeDist(uint32_t a, uint32_t b, int bits)
{
    if (bits == 0) return 0;
    int diff = static_cast<int>(a) - static_cast<int>(b);
    const int m = 1 << (bits - 1);
    diff = (diff & (m - 1)) - (diff & m);
    return diff;
}

inline bool skipModeAllowed(const Sequence& s, const Frame& f)
{
    if (f.key || !f.referenceSelect || s.orderHintBits == 0) return false;
    int forward = -1, backward = -1;
    uint32_t forwardHint = 0, backwardHint = 0;
    for (int i = 0; i < kRefsPerFrame; ++i) {
        const uint32_t hint = f.refOrderHint[static_cast<size_t>(f.refFrameIdx[i])];
        if (relativeDist(hint, f.orderHint, s.orderHintBits) < 0) {
            if (forward < 0 || relativeDist(hint, forwardHint, s.orderHintBits) > 0) {
                forward = i;
                forwardHint = hint;
            }
        } else if (relativeDist(hint, f.orderHint, s.orderHintBits) > 0) {
            if (backward < 0 || relativeDist(hint, backwardHint, s.orderHintBits) < 0) {
                backward = i;
                backwardHint = hint;
            }
        }
    }
    if (forward < 0) return false;
    if (backward >= 0) return true;
    for (int i = 0; i < kRefsPerFrame; ++i) {
        const uint32_t hint = f.refOrderHint[static_cast<size_t>(f.refFrameIdx[i])];
        if (relativeDist(hint, forwardHint, s.orderHintBits) < 0) return true;
    }
    return false;
}

/// get_qindex(1, segmentId) of segment @p segment.
inline int segmentQIndex(const Frame& f, int segment)
{
    const auto i = static_cast<size_t>(segment);
    if (f.seg.enabled && (f.seg.features[i] & 1u))
        return std::clamp(f.q.baseQIdx + f.seg.values[i][0], 0, 255);
    return f.q.baseQIdx;
}

inline bool codedLossless(const Frame& f)
{
    if (f.q.deltaQYDc || f.q.deltaQUDc || f.q.deltaQUAc || f.q.deltaQVDc || f.q.deltaQVAc)
        return false;
    for (int i = 0; i < kMaxSegments; ++i)
        if (segmentQIndex(f, i) != 0) return false;
    return true;
}

} // namespace detail

/// Why @p s cannot be written as one tile, or "" when it can: the tile_info()
/// arithmetic, in superblocks — MinLog2TileCols and MinLog2Tiles are 0.
inline std::string singleTileRefusal(const Sequence& s)
{
    if (s.width == 0 || s.height == 0) return "no size";
    const uint32_t miCols = 2 * ((s.width + 7) >> 3);
    const uint32_t miRows = 2 * ((s.height + 7) >> 3);
    const int sbShift = s.sb128 ? 5 : 4;
    const int sbSize = sbShift + 2;
    const uint32_t sbCols = (miCols + (1u << sbShift) - 1) >> sbShift;
    const uint32_t sbRows = (miRows + (1u << sbShift) - 1) >> sbShift;
    if (detail::tileLog2(kMaxTileWidth >> sbSize, sbCols) > 0)
        return std::to_string(s.width) + " wide: over " + std::to_string(kMaxTileWidth) +
               ", one tile does not hold it";
    if (detail::tileLog2(kMaxTileArea >> (2 * sbSize), sbRows * sbCols) > 0)
        return std::to_string(s.width) + "x" + std::to_string(s.height) + ": over one tile's area";
    return {};
}

/// OBU_TEMPORAL_DELIMITER: every temporal unit starts with one.
inline std::vector<uint8_t> temporalDelimiter()
{
    return detail::obuHeader(ObuType::TemporalDelimiter, 0);
}

inline std::vector<uint8_t> sequenceHeader(const Sequence& s)
{
    detail::BitWriter w;
    w.u(3, static_cast<uint32_t>(s.profile));
    w.u(1, 0);  // still_picture
    w.u(1, 0);  // reduced_still_picture_header
    w.u(1, 0);  // timing_info_present_flag
    w.u(1, 0);  // initial_display_delay_present_flag
    w.u(5, 0);  // operating_points_cnt_minus_1
    w.u(12, 0); // operating_point_idc[0]
    w.u(5, static_cast<uint32_t>(s.levelIdx));
    if (s.levelIdx > 7) w.u(1, static_cast<uint32_t>(s.tier));
    const int widthBits = detail::bitsFor(s.width - 1);
    const int heightBits = detail::bitsFor(s.height - 1);
    w.u(4, static_cast<uint32_t>(widthBits - 1));
    w.u(4, static_cast<uint32_t>(heightBits - 1));
    w.u(widthBits, s.width - 1);
    w.u(heightBits, s.height - 1);
    w.u(1, 0); // frame_id_numbers_present_flag
    w.u(1, s.sb128 ? 1 : 0);
    w.u(1, s.filterIntra ? 1 : 0);
    w.u(1, s.intraEdgeFilter ? 1 : 0);
    w.u(1, s.interintraCompound ? 1 : 0);
    w.u(1, s.maskedCompound ? 1 : 0);
    w.u(1, s.warpedMotion ? 1 : 0);
    w.u(1, s.dualFilter ? 1 : 0);
    const bool orderHint = s.orderHintBits > 0;
    w.u(1, orderHint ? 1 : 0);
    if (orderHint) {
        w.u(1, s.jntComp ? 1 : 0);
        w.u(1, s.refFrameMvs ? 1 : 0);
    }
    w.u(1, 0); // seq_choose_screen_content_tools
    w.u(1, 0); // seq_force_screen_content_tools: never
    if (orderHint) w.u(3, static_cast<uint32_t>(s.orderHintBits - 1));
    w.u(1, 0); // enable_superres
    w.u(1, s.cdef ? 1 : 0);
    w.u(1, s.restoration ? 1 : 0);
    // color_config()
    w.u(1, s.tenBit ? 1 : 0); // high_bitdepth
    w.u(1, 0);                // mono_chrome
    w.u(1, 1);                // color_description_present_flag
    w.u(8, s.hdr ? 9 : 1);    // color_primaries: BT.2020 or BT.709
    w.u(8, s.hdr ? 16 : 1);   // transfer_characteristics: PQ or BT.709
    w.u(8, s.hdr ? 9 : 1);    // matrix_coefficients: BT.2020 NCL or BT.709
    w.u(1, 0);                // color_range: limited
    w.u(2, 0);                // chroma_sample_position: unknown
    w.u(1, s.separateUvDeltaQ ? 1 : 0);
    w.u(1, 0); // film_grain_params_present
    detail::trailingBits(w);
    std::vector<uint8_t> out = detail::obuHeader(ObuType::SequenceHeader, w.bytes.size());
    out.insert(out.end(), w.bytes.begin(), w.bytes.end());
    return out;
}

/// frame_header_obu()'s uncompressed_header(), then byte_alignment(): what
/// OBU_FRAME carries in front of its tile group.
inline std::vector<uint8_t> frameHeaderBits(const Sequence& s, const Frame& f)
{
    using namespace detail;
    BitWriter w;
    const int numPlanes = 3;
    w.u(1, 0);             // show_existing_frame
    w.u(2, f.key ? 0 : 1); // frame_type: KEY_FRAME or INTER_FRAME
    w.u(1, 1);             // show_frame
    const bool errorResilient = f.key || f.errorResilient;
    if (!f.key) w.u(1, f.errorResilient ? 1 : 0);
    w.u(1, f.disableCdfUpdate ? 1 : 0);
    // No screen content tools: allow_screen_content_tools 0, force_integer_mv
    // not read.
    w.u(1, 0); // frame_size_override_flag
    if (s.orderHintBits > 0) w.u(s.orderHintBits, f.orderHint & ((1u << s.orderHintBits) - 1u));
    const int primary = (f.key || errorResilient) ? kPrimaryRefNone : f.primaryRefFrame;
    if (!f.key && !errorResilient) w.u(3, static_cast<uint32_t>(f.primaryRefFrame));
    if (!f.key) w.u(8, f.refreshFrameFlags);
    if ((!f.key || f.refreshFrameFlags != 0xFF) && errorResilient && s.orderHintBits > 0)
        for (int i = 0; i < kNumRefFrames; ++i)
            w.u(s.orderHintBits,
                f.refOrderHint[static_cast<size_t>(i)] & ((1u << s.orderHintBits) - 1u));
    const auto renderSize = [&] {
        const bool different = (f.renderWidth && f.renderWidth != s.width) ||
                               (f.renderHeight && f.renderHeight != s.height);
        w.u(1, different ? 1 : 0); // render_and_frame_size_different
        if (different) {
            w.u(16, (f.renderWidth ? f.renderWidth : s.width) - 1);
            w.u(16, (f.renderHeight ? f.renderHeight : s.height) - 1);
        }
    };
    if (f.key) {
        // frame_size(): the sequence's, no super-resolution.
        renderSize();
    } else {
        if (s.orderHintBits > 0) w.u(1, 0); // frame_refs_short_signaling
        for (int i = 0; i < kRefsPerFrame; ++i)
            w.u(3, static_cast<uint32_t>(f.refFrameIdx[static_cast<size_t>(i)]));
        renderSize();                           // frame_size() writes nothing, as for a key frame
        w.u(1, f.allowHighPrecisionMv ? 1 : 0); // force_integer_mv is 0
        const bool switchable = f.interpolationFilter == 4;
        w.u(1, switchable ? 1 : 0); // is_filter_switchable
        if (!switchable) w.u(2, static_cast<uint32_t>(f.interpolationFilter));
        w.u(1, f.motionModeSwitchable ? 1 : 0);
        if (!errorResilient && s.refFrameMvs) w.u(1, f.useRefFrameMvs ? 1 : 0);
    }
    if (!f.disableCdfUpdate) w.u(1, f.disableFrameEndUpdateCdf ? 1 : 0);

    // tile_info(): one tile, uniform spacing.
    const uint32_t miCols = 2 * ((s.width + 7) >> 3);
    const uint32_t miRows = 2 * ((s.height + 7) >> 3);
    const int sbShift = s.sb128 ? 5 : 4;
    const uint32_t sbCols = (miCols + (1u << sbShift) - 1) >> sbShift;
    const uint32_t sbRows = (miRows + (1u << sbShift) - 1) >> sbShift;
    // MinLog2TileCols and MinLog2Tiles are 0 (singleTileRefusal): one zero
    // increment each, where the loop would read one.
    const int maxLog2TileCols = tileLog2(1, (std::min)(sbCols, 64u));
    const int maxLog2TileRows = tileLog2(1, (std::min)(sbRows, 64u));
    w.u(1, 1);                          // uniform_tile_spacing_flag
    if (0 < maxLog2TileCols) w.u(1, 0); // increment_tile_cols_log2
    if (0 < maxLog2TileRows) w.u(1, 0); // increment_tile_rows_log2

    // quantization_params()
    w.u(8, static_cast<uint32_t>(f.q.baseQIdx));
    deltaQ(w, f.q.deltaQYDc);
    const bool diffUv = f.q.deltaQUDc != f.q.deltaQVDc || f.q.deltaQUAc != f.q.deltaQVAc;
    if (numPlanes > 1) {
        if (s.separateUvDeltaQ) w.u(1, diffUv ? 1 : 0);
        deltaQ(w, f.q.deltaQUDc);
        deltaQ(w, f.q.deltaQUAc);
        if (s.separateUvDeltaQ && diffUv) {
            deltaQ(w, f.q.deltaQVDc);
            deltaQ(w, f.q.deltaQVAc);
        }
    }
    w.u(1, f.q.usingQmatrix ? 1 : 0);
    if (f.q.usingQmatrix) {
        w.u(4, static_cast<uint32_t>(f.q.qmY));
        w.u(4, static_cast<uint32_t>(f.q.qmU));
        if (s.separateUvDeltaQ) w.u(4, static_cast<uint32_t>(f.q.qmV));
    }

    // segmentation_params()
    w.u(1, f.seg.enabled ? 1 : 0);
    if (f.seg.enabled) {
        bool updateData = true;
        if (primary != kPrimaryRefNone) {
            w.u(1, f.seg.updateMap ? 1 : 0);
            if (f.seg.updateMap) w.u(1, f.seg.temporalUpdate ? 1 : 0);
            w.u(1, f.seg.updateData ? 1 : 0);
            updateData = f.seg.updateData;
        }
        if (updateData) {
            static const int kBits[kSegLvlMax] = {8, 6, 6, 6, 6, 3, 0, 0};
            static const bool kSigned[kSegLvlMax] = {true, true,  true,  true,
                                                     true, false, false, false};
            for (int i = 0; i < kMaxSegments; ++i)
                for (int j = 0; j < kSegLvlMax; ++j) {
                    const bool on = (f.seg.features[static_cast<size_t>(i)] >> j) & 1u;
                    w.u(1, on ? 1 : 0);
                    if (!on) continue;
                    const int v = f.seg.values[static_cast<size_t>(i)][static_cast<size_t>(j)];
                    if (kSigned[j])
                        su(w, 1 + kBits[j], v);
                    else if (kBits[j] > 0)
                        w.u(kBits[j], static_cast<uint32_t>(v));
                }
        }
    }

    // delta_q_params(), delta_lf_params()
    if (f.q.baseQIdx > 0) w.u(1, f.deltaQPresent ? 1 : 0);
    if (f.q.baseQIdx > 0 && f.deltaQPresent) {
        w.u(2, static_cast<uint32_t>(f.deltaQRes));
        w.u(1, f.deltaLfPresent ? 1 : 0); // no intra block copy
        if (f.deltaLfPresent) {
            w.u(2, static_cast<uint32_t>(f.deltaLfRes));
            w.u(1, f.deltaLfMulti ? 1 : 0);
        }
    }

    const bool lossless = codedLossless(f);
    // loop_filter_params()
    if (!lossless) {
        w.u(6, static_cast<uint32_t>(f.lf.level[0]));
        w.u(6, static_cast<uint32_t>(f.lf.level[1]));
        if (f.lf.level[0] || f.lf.level[1]) {
            w.u(6, static_cast<uint32_t>(f.lf.level[2]));
            w.u(6, static_cast<uint32_t>(f.lf.level[3]));
        }
        w.u(3, static_cast<uint32_t>(f.lf.sharpness));
        w.u(1, f.lf.deltaEnabled ? 1 : 0);
        if (f.lf.deltaEnabled) {
            const bool update = f.lf.updateRefDelta || f.lf.updateModeDelta;
            w.u(1, update ? 1 : 0);
            if (update) {
                for (int i = 0; i < kNumRefFrames; ++i) {
                    w.u(1, f.lf.updateRefDelta ? 1 : 0);
                    if (f.lf.updateRefDelta) su(w, 7, f.lf.refDeltas[static_cast<size_t>(i)]);
                }
                for (int i = 0; i < 2; ++i) {
                    w.u(1, f.lf.updateModeDelta ? 1 : 0);
                    if (f.lf.updateModeDelta) su(w, 7, f.lf.modeDeltas[static_cast<size_t>(i)]);
                }
            }
        }
    }
    // cdef_params()
    if (!lossless && s.cdef) {
        w.u(2, static_cast<uint32_t>(f.cdef.dampingMinus3));
        w.u(2, static_cast<uint32_t>(f.cdef.bits));
        for (int i = 0; i < (1 << f.cdef.bits); ++i) {
            const auto k = static_cast<size_t>(i);
            w.u(4, static_cast<uint32_t>(f.cdef.yPri[k]));
            w.u(2, static_cast<uint32_t>(f.cdef.ySec[k]));
            w.u(4, static_cast<uint32_t>(f.cdef.uvPri[k]));
            w.u(2, static_cast<uint32_t>(f.cdef.uvSec[k]));
        }
    }
    // lr_params(): AllLossless is CodedLossless here — no super-resolution.
    if (!lossless && s.restoration) {
        bool usesLr = false, usesChromaLr = false;
        for (int i = 0; i < numPlanes; ++i) {
            const int type = f.lrType[static_cast<size_t>(i)];
            w.u(2, static_cast<uint32_t>(type));
            if (type != 0) {
                usesLr = true;
                if (i > 0) usesChromaLr = true;
            }
        }
        if (usesLr) {
            w.u(1, f.lrUnitShift ? 1 : 0);
            if (!s.sb128 && f.lrUnitShift) w.u(1, f.lrUnitExtraShift ? 1 : 0);
            if (usesChromaLr) w.u(1, f.lrUvShift ? 1 : 0);
        }
    }
    // read_tx_mode()
    if (!lossless) w.u(1, f.txModeSelect ? 1 : 0);
    // frame_reference_mode()
    if (!f.key) w.u(1, f.referenceSelect ? 1 : 0);
    // skip_mode_params()
    if (skipModeAllowed(s, f)) w.u(1, f.skipModePresent ? 1 : 0);
    if (!f.key && !errorResilient && s.warpedMotion) w.u(1, f.allowWarpedMotion ? 1 : 0);
    w.u(1, f.reducedTxSet ? 1 : 0);
    // global_motion_params(): identity everywhere.
    if (!f.key)
        for (int i = 0; i < kRefsPerFrame; ++i)
            w.u(1, 0); // is_global
    // film_grain_params(): not present in the sequence.
    byteAlignment(w);
    return w.bytes;
}

/// OBU_FRAME's header and size, then its frame header: @p tileBytes of tile
/// data follow, one tile, whose tile group writes nothing in front of it.
inline std::vector<uint8_t> frameObuPrefix(const Sequence& s, const Frame& f, uint64_t tileBytes)
{
    const std::vector<uint8_t> header = frameHeaderBits(s, f);
    std::vector<uint8_t> out = detail::obuHeader(ObuType::Frame, header.size() + tileBytes);
    out.insert(out.end(), header.begin(), header.end());
    return out;
}

// ── Reading back ────────────────────────────────────────────────────────────

/// One OBU of a low-overhead stream.
struct Obu
{
    ObuType type = ObuType::TemporalDelimiter;
    const uint8_t* payload = nullptr;
    size_t size = 0;
};

/// The OBUs of @p data, in order; stops at the first that does not read.
inline std::vector<Obu> obus(const uint8_t* data, size_t size)
{
    std::vector<Obu> out;
    size_t pos = 0;
    while (pos < size) {
        const uint8_t h = data[pos++];
        if (h & 0x80) break; // forbidden bit
        const bool extension = (h >> 2) & 1u;
        const bool hasSize = (h >> 1) & 1u;
        if (extension) ++pos;
        uint64_t length = 0;
        if (hasSize) {
            for (int i = 0; i < 8 && pos < size; ++i) {
                const uint8_t b = data[pos++];
                length |= static_cast<uint64_t>(b & 0x7F) << (7 * i);
                if (!(b & 0x80)) break;
            }
        } else {
            length = size - pos;
        }
        if (pos + length > size) break;
        Obu o;
        o.type = static_cast<ObuType>((h >> 3) & 0x0F);
        o.payload = data + pos;
        o.size = static_cast<size_t>(length);
        out.push_back(o);
        pos += static_cast<size_t>(length);
    }
    return out;
}

/// Reads what sequenceHeader() writes. Empty on success.
inline std::string parseSequenceHeader(const uint8_t* payload, size_t size, Sequence& out)
{
    const std::vector<uint8_t> bytes(payload, payload + size);
    h264vui_detail::BitReader r{bytes};
    Sequence s;
    s.profile = static_cast<int>(r.u(3));
    if (r.u(1)) return "still_picture";
    if (r.u(1)) return "reduced_still_picture_header";
    if (r.u(1)) return "timing_info_present_flag: not written here";
    const bool displayDelay = r.u(1) != 0;
    const uint32_t points = r.u(5) + 1;
    for (uint32_t i = 0; i < points; ++i) {
        r.u(12); // operating_point_idc
        const int level = static_cast<int>(r.u(5));
        const int tier = level > 7 ? static_cast<int>(r.u(1)) : 0;
        if (displayDelay && r.u(1)) r.u(4);
        if (i == 0) {
            s.levelIdx = level;
            s.tier = tier;
        }
    }
    const int widthBits = static_cast<int>(r.u(4)) + 1;
    const int heightBits = static_cast<int>(r.u(4)) + 1;
    s.width = r.u(widthBits) + 1;
    s.height = r.u(heightBits) + 1;
    if (r.u(1)) return "frame_id_numbers_present_flag: not written here";
    s.sb128 = r.u(1) != 0;
    s.filterIntra = r.u(1) != 0;
    s.intraEdgeFilter = r.u(1) != 0;
    s.interintraCompound = r.u(1) != 0;
    s.maskedCompound = r.u(1) != 0;
    s.warpedMotion = r.u(1) != 0;
    s.dualFilter = r.u(1) != 0;
    const bool orderHint = r.u(1) != 0;
    if (orderHint) {
        s.jntComp = r.u(1) != 0;
        s.refFrameMvs = r.u(1) != 0;
    }
    if (r.u(1)) return "seq_choose_screen_content_tools: not written here";
    if (r.u(1)) return "seq_force_screen_content_tools: not written here";
    s.orderHintBits = orderHint ? static_cast<int>(r.u(3)) + 1 : 0;
    if (r.u(1)) return "enable_superres: not written here";
    s.cdef = r.u(1) != 0;
    s.restoration = r.u(1) != 0;
    s.tenBit = r.u(1) != 0;
    if (r.u(1)) return "mono_chrome";
    if (!r.u(1)) return "no color description";
    const uint32_t primaries = r.u(8);
    const uint32_t transfer = r.u(8);
    const uint32_t matrix = r.u(8);
    s.hdr = primaries == 9 && transfer == 16 && matrix == 9;
    if (!s.hdr && !(primaries == 1 && transfer == 1 && matrix == 1))
        return "colours neither BT.709 nor BT.2020 PQ";
    if (r.u(1)) return "full range";
    r.u(2); // chroma_sample_position
    s.separateUvDeltaQ = r.u(1) != 0;
    if (r.u(1)) return "film grain";
    if (r.u(1) != 1) return "no trailing one bit";
    if (r.overrun) return "past the end";
    out = s;
    return {};
}

/// The first fields of an uncompressed_header(), read with the sequence.
struct FrameStart
{
    bool showExisting = false;
    int frameType = 0;
    bool showFrame = false;
    bool errorResilient = false;
    uint32_t orderHint = 0;
    int primaryRefFrame = kPrimaryRefNone;
    uint8_t refreshFrameFlags = 0xFF;
    std::array<int, kRefsPerFrame> refFrameIdx{};
};

inline std::string parseFrameStart(const uint8_t* payload, size_t size, const Sequence& s,
                                   FrameStart& out)
{
    const std::vector<uint8_t> bytes(payload, payload + size);
    h264vui_detail::BitReader r{bytes};
    FrameStart f;
    f.showExisting = r.u(1) != 0;
    if (f.showExisting) return "show_existing_frame: not written here";
    f.frameType = static_cast<int>(r.u(2));
    f.showFrame = r.u(1) != 0;
    if (!f.showFrame) return "a frame not shown";
    const bool key = f.frameType == 0;
    f.errorResilient = key ? true : r.u(1) != 0;
    r.u(1); // disable_cdf_update
    if (r.u(1)) return "frame_size_override_flag";
    if (s.orderHintBits > 0) f.orderHint = r.u(s.orderHintBits);
    if (!key && !f.errorResilient) f.primaryRefFrame = static_cast<int>(r.u(3));
    if (!key) f.refreshFrameFlags = static_cast<uint8_t>(r.u(8));
    if (!key && f.errorResilient && s.orderHintBits > 0)
        for (int i = 0; i < kNumRefFrames; ++i)
            r.u(s.orderHintBits);
    if (!key) {
        if (s.orderHintBits > 0 && r.u(1)) return "frame_refs_short_signaling";
        for (int i = 0; i < kRefsPerFrame; ++i)
            f.refFrameIdx[static_cast<size_t>(i)] = static_cast<int>(r.u(3));
    }
    if (r.overrun) return "past the end";
    out = f;
    return {};
}

/// An uncompressed_header() read as far as its quantizer: what a driver that
/// writes the frame header itself (Vulkan Video, C13.12) is checked by — the
/// frame it was asked for, and the base_q_idx its rate control chose.
struct FrameHeader
{
    FrameStart start;
    uint32_t renderWidth = 0; ///< 0: the frame's own size
    uint32_t renderHeight = 0;
    int tileCols = 1;
    int tileRows = 1;
    int baseQIdx = 0;
    /// delta_q_present, when the header could be read that far — not past a
    /// segmentation it does not follow. Present, base_q_idx is a starting
    /// point the superblocks move from (RADV's rate control does exactly
    /// that, 04/10/2026), not the picture's quantizer.
    bool deltaQKnown = false;
    bool deltaQPresent = false;
};

namespace detail {

/// ns(n): a value below @p n, in as few bits as the spec's code allows.
inline uint32_t ns(h264vui_detail::BitReader& r, uint32_t n)
{
    int w = 0;
    for (uint32_t x = n; x != 0; x >>= 1)
        ++w;
    const uint32_t m = (1u << w) - n;
    const uint32_t v = r.u(w - 1);
    if (v < m) return v;
    return (v << 1) - m + r.u(1);
}

} // namespace detail

/// Reads an uncompressed_header() of @p s up to base_q_idx: the fields
/// frameHeaderBits() writes, with any tile layout the driver chose. Frames
/// whose header says what the sequence here never allows — screen content
/// tools, a frame size of their own, frame ids — do not read.
inline std::string parseFrameHeader(const uint8_t* payload, size_t size, const Sequence& s,
                                    FrameHeader& out)
{
    const std::vector<uint8_t> bytes(payload, payload + size);
    h264vui_detail::BitReader r{bytes};
    FrameHeader h;
    FrameStart& f = h.start;
    f.showExisting = r.u(1) != 0;
    if (f.showExisting) return "show_existing_frame: not written here";
    f.frameType = static_cast<int>(r.u(2));
    f.showFrame = r.u(1) != 0;
    if (!f.showFrame) return "a frame not shown";
    const bool key = f.frameType == 0;
    if (f.frameType == 2 || f.frameType == 3) return "an intra-only or switch frame";
    f.errorResilient = key ? true : r.u(1) != 0;
    const bool disableCdfUpdate = r.u(1) != 0;
    if (r.u(1)) return "frame_size_override_flag";
    if (s.orderHintBits > 0) f.orderHint = r.u(s.orderHintBits);
    if (!key && !f.errorResilient) f.primaryRefFrame = static_cast<int>(r.u(3));
    if (!key) f.refreshFrameFlags = static_cast<uint8_t>(r.u(8));
    if (!key && f.errorResilient && s.orderHintBits > 0)
        for (int i = 0; i < kNumRefFrames; ++i)
            r.u(s.orderHintBits);
    const auto renderSize = [&] {
        if (r.u(1)) {
            h.renderWidth = r.u(16) + 1;
            h.renderHeight = r.u(16) + 1;
        }
    };
    if (key) {
        renderSize(); // frame_size(): the sequence's
    } else {
        if (s.orderHintBits > 0 && r.u(1)) return "frame_refs_short_signaling";
        for (int i = 0; i < kRefsPerFrame; ++i)
            f.refFrameIdx[static_cast<size_t>(i)] = static_cast<int>(r.u(3));
        renderSize();
        r.u(1);              // allow_high_precision_mv: force_integer_mv is 0
        if (!r.u(1)) r.u(2); // is_filter_switchable, interpolation_filter
        r.u(1);              // is_motion_mode_switchable
        if (!f.errorResilient && s.refFrameMvs) r.u(1); // use_ref_frame_mvs
    }
    if (!disableCdfUpdate) r.u(1); // disable_frame_end_update_cdf

    // tile_info()
    const uint32_t miCols = 2 * ((s.width + 7) >> 3);
    const uint32_t miRows = 2 * ((s.height + 7) >> 3);
    const int sbShift = s.sb128 ? 5 : 4;
    const int sbSize = sbShift + 2;
    const uint32_t sbCols = (miCols + (1u << sbShift) - 1) >> sbShift;
    const uint32_t sbRows = (miRows + (1u << sbShift) - 1) >> sbShift;
    const uint32_t maxTileWidthSb = kMaxTileWidth >> sbSize;
    uint32_t maxTileAreaSb = kMaxTileArea >> (2 * sbSize);
    const int minLog2TileCols = detail::tileLog2(maxTileWidthSb, sbCols);
    const int maxLog2TileCols = detail::tileLog2(1, (std::min)(sbCols, 64u));
    const int maxLog2TileRows = detail::tileLog2(1, (std::min)(sbRows, 64u));
    const int minLog2Tiles =
        (std::max)(minLog2TileCols, detail::tileLog2(maxTileAreaSb, sbRows * sbCols));
    int tileColsLog2 = 0, tileRowsLog2 = 0;
    if (r.u(1)) { // uniform_tile_spacing_flag
        tileColsLog2 = minLog2TileCols;
        while (tileColsLog2 < maxLog2TileCols && r.u(1))
            ++tileColsLog2;
        const uint32_t widthSb = (sbCols + (1u << tileColsLog2) - 1) >> tileColsLog2;
        h.tileCols = static_cast<int>((sbCols + widthSb - 1) / widthSb);
        tileRowsLog2 = (std::max)(minLog2Tiles - tileColsLog2, 0);
        while (tileRowsLog2 < maxLog2TileRows && r.u(1))
            ++tileRowsLog2;
        const uint32_t heightSb = (sbRows + (1u << tileRowsLog2) - 1) >> tileRowsLog2;
        h.tileRows = static_cast<int>((sbRows + heightSb - 1) / heightSb);
    } else {
        uint32_t widest = 0, start = 0;
        int cols = 0;
        for (; start < sbCols && !r.overrun; ++cols) {
            const uint32_t sizeSb = detail::ns(r, (std::min)(sbCols - start, maxTileWidthSb)) + 1;
            widest = (std::max)(widest, sizeSb);
            start += sizeSb;
        }
        h.tileCols = cols;
        tileColsLog2 = detail::tileLog2(1, static_cast<uint32_t>(cols));
        maxTileAreaSb =
            minLog2Tiles > 0 ? (sbRows * sbCols) >> (minLog2Tiles + 1) : sbRows * sbCols;
        const uint32_t maxTileHeightSb = (std::max)(maxTileAreaSb / (std::max)(widest, 1u), 1u);
        int rows = 0;
        for (start = 0; start < sbRows && !r.overrun; ++rows)
            start += detail::ns(r, (std::min)(sbRows - start, maxTileHeightSb)) + 1;
        h.tileRows = rows;
        tileRowsLog2 = detail::tileLog2(1, static_cast<uint32_t>(rows));
    }
    if (tileColsLog2 > 0 || tileRowsLog2 > 0) {
        r.u(tileRowsLog2 + tileColsLog2); // context_update_tile_id
        r.u(2);                           // tile_size_bytes_minus_1
    }
    h.baseQIdx = static_cast<int>(r.u(8));
    // The rest of quantization_params(), then segmentation_params() when it
    // is off, then delta_q_params()'s first bit.
    const auto deltaQ = [&] {
        if (r.u(1)) r.u(7);
    };
    deltaQ(); // DeltaQYDc
    bool diffUv = false;
    if (s.separateUvDeltaQ) diffUv = r.u(1) != 0;
    deltaQ(); // DeltaQUDc
    deltaQ(); // DeltaQUAc
    if (diffUv) {
        deltaQ();
        deltaQ();
    }
    if (r.u(1)) { // using_qmatrix
        r.u(4);
        r.u(4);
        if (s.separateUvDeltaQ) r.u(4);
    }
    if (!r.u(1)) { // segmentation_enabled
        h.deltaQKnown = true;
        h.deltaQPresent = h.baseQIdx > 0 && r.u(1) != 0;
    }
    if (r.overrun) return "past the end";
    out = h;
    return {};
}

} // namespace mw::native::encode::av1
