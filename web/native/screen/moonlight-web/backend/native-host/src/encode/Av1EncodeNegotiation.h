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

// AV1 through D3D12 Video Encode (plan pipeline-video-d3d12-v2, C9.2): what the
// product asks of a driver, then less, until it says yes — as
// HevcEncodeNegotiation.h, whose rate ladder, intra-refresh rule and support
// answer this reuses. Pure: the driver is an interface, a table in the tests.
//
// The driver codes the tiles and says, once a picture is coded, the frame
// header's values it chose; the rest of the headers are ours (Av1Obu.h). So
// the features taken are the ones the driver requires plus CDEF and order
// hints where it has them, and a driver that requires one the headers cannot
// say — screen content tools, super-resolution, intra block copy — has no
// encoder. The sequence is one tile, key frames and shown inter frames, every
// slot refreshed by every frame: one picture kept, and a loss costs a key
// frame.
//
// Measured on DualRTX (28/09/2026, mw-d3d12-lab caps): the RTX 5060 Ti
// requires loop restoration, CDEF and auto segmentation and gives the
// quantizer, the loop filter and CDEF back after the picture; the Arc A380
// requires nothing and gives nothing back — it codes with the values it is
// handed; the AMD iGPU has no AV1 encoder.

#include "Av1Obu.h"
#include "HevcEncodeNegotiation.h"

#include <cstdint>
#include <string>
#include <vector>

namespace mw::native::encode {

/// D3D12_VIDEO_ENCODER_AV1_FEATURE_FLAGS, as the negotiation needs them.
namespace av1feature {
constexpr uint32_t kSb128 = 0x1;
constexpr uint32_t kFilterIntra = 0x2;
constexpr uint32_t kIntraEdgeFilter = 0x4;
constexpr uint32_t kInterintraCompound = 0x8;
constexpr uint32_t kMaskedCompound = 0x10;
constexpr uint32_t kWarpedMotion = 0x20;
constexpr uint32_t kDualFilter = 0x40;
constexpr uint32_t kJntComp = 0x80;
constexpr uint32_t kForcedIntegerMv = 0x100;
constexpr uint32_t kSuperResolution = 0x200;
constexpr uint32_t kRestoration = 0x400;
constexpr uint32_t kPalette = 0x800;
constexpr uint32_t kCdef = 0x1000;
constexpr uint32_t kIntraBlockCopy = 0x2000;
constexpr uint32_t kRefFrameMvs = 0x4000;
constexpr uint32_t kOrderHint = 0x8000;
constexpr uint32_t kAutoSegmentation = 0x10000;
constexpr uint32_t kCustomSegmentation = 0x20000;
constexpr uint32_t kReducedTxSet = 0x200000;
constexpr uint32_t kMotionModeSwitchable = 0x400000;
constexpr uint32_t kHighPrecisionMv = 0x800000;
constexpr uint32_t kSkipMode = 0x1000000;
/// What the headers written here cannot say, or the encoder cannot feed (a
/// segment map of its own).
constexpr uint32_t kUnwritable =
    kForcedIntegerMv | kSuperResolution | kPalette | kIntraBlockCopy | kCustomSegmentation;
} // namespace av1feature

/// What does not depend on a proposal.
struct Av1DriverLimits
{
    uint32_t minWidth = 0;
    uint32_t minHeight = 0;
    uint32_t maxWidth = 0;
    uint32_t maxHeight = 0;
    uint32_t widthMultiple = 1;
    uint32_t heightMultiple = 1;
    bool tenBit = false; ///< P010 in
};

/// The codec configuration support: D3D12's flags, as the driver gave them.
struct Av1ConfigAnswer
{
    bool taken = false;
    uint32_t supported = 0;
    uint32_t required = 0;
    uint32_t postEncode = 0;
    /// D3D12_VIDEO_ENCODER_AV1_INTERPOLATION_FILTERS_FLAGS: bit 4 switchable.
    uint32_t filters = 0;
    /// D3D12_VIDEO_ENCODER_AV1_TX_MODE_FLAGS for key and inter frames: bit 1
    /// largest, bit 2 select.
    uint32_t txKey = 0;
    uint32_t txInter = 0;
    bool keyAndInterFrames = false; ///< the picture control takes both
};

/// A whole encoder, as it is put to the driver.
struct Av1SupportQuestion
{
    uint32_t features = 0;
    int orderHintBits = 0;
    HevcRate rate;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    bool tenBit = false;
    bool intraRefresh = false;
    int fps = 60;
};

class Av1DriverQueries
{
public:
    virtual ~Av1DriverQueries() = default;
    virtual Av1DriverLimits limits(bool tenBit) = 0;
    virtual Av1ConfigAnswer configuration() = 0;
    /// The answer's suggested level is seq_level_idx here.
    virtual HevcSupportAnswer support(const Av1SupportQuestion& question) = 0;
};

struct Av1EncodeRequest
{
    uint32_t width = 0;
    uint32_t height = 0;
    int fps = 60;
    bool hdr = false; ///< Main 10, BT.2020 PQ
    bool intraRefresh = false;
};

struct Av1EncodeSetup
{
    bool ok = false;
    std::string reason;
    HevcRate rate;
    HevcSupportAnswer support;
    uint32_t features = 0;
    uint32_t postEncode = 0;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    int intraRefreshFrames = 0;
    int queries = 0;
    int interpolationFilter = 0; ///< as coded: 0 EIGHTTAP … 4 switchable
    bool txSelectKey = true;
    bool txSelectInter = true;
    av1::Sequence sequence;
};

/// The smallest level whose picture size and display rate hold @p width x
/// @p height at @p fps (AV1 specification, annex A.3), as seq_level_idx:
/// 4.1 for 1080p60, 5.0 at 120, 5.1 for 1440p120 and 4K60. A driver may
/// suggest more — the Arc says 6.0 for 1080p60 — and a decoder may refuse a
/// level it does not reach: the stream says what it needs.
inline int av1LevelIdx(uint32_t width, uint32_t height, int fps)
{
    struct Level
    {
        int idx;
        uint64_t maxPicSize;
        uint32_t maxH;
        uint32_t maxV;
        uint64_t maxDisplayRate;
    };
    static const Level kLevels[] = {
        {0, 147456, 2048, 1152, 4423680},           {1, 278784, 2816, 1584, 8363520},
        {4, 665856, 4352, 2448, 19975680},          {5, 1065024, 5504, 3096, 31950720},
        {8, 2359296, 6144, 3456, 70778880},         {9, 2359296, 6144, 3456, 141557760},
        {12, 8912896, 8192, 4352, 267386880},       {13, 8912896, 8192, 4352, 534773760},
        {14, 8912896, 8192, 4352, 1069547520},      {15, 8912896, 8192, 4352, 1069547520},
        {16, 35651584, 16384, 8704, 1069547520},    {17, 35651584, 16384, 8704, 2139095040},
        {18, 35651584, 16384, 8704, 4278190080ull}, {19, 35651584, 16384, 8704, 4278190080ull},
    };
    const uint64_t picture = static_cast<uint64_t>(width) * height;
    const uint64_t rate = picture * static_cast<uint64_t>(fps > 0 ? fps : 60);
    for (const Level& l : kLevels)
        if (picture <= l.maxPicSize && width <= l.maxH && height <= l.maxV &&
            rate <= l.maxDisplayRate)
            return l.idx;
    return 19;
}

namespace av1neg_detail {

inline std::string hex(uint32_t v)
{
    static const char* kDigits = "0123456789abcdef";
    std::string t = "0x";
    bool started = false;
    for (int i = 28; i >= 0; i -= 4) {
        const uint32_t d = (v >> i) & 0xFu;
        if (d || started || i == 0) {
            t += kDigits[d];
            started = true;
        }
    }
    return t;
}

} // namespace av1neg_detail

inline Av1EncodeSetup negotiateAv1(const Av1EncodeRequest& request, Av1DriverQueries& driver)
{
    using hevcneg_detail::add;
    Av1EncodeSetup s;
    if (request.width == 0 || request.height == 0 || (request.width | request.height) & 1) {
        s.reason = "a size of " + std::to_string(request.width) + "x" +
                   std::to_string(request.height) + ": 4:2:0 wants it even";
        return s;
    }
    const Av1DriverLimits limits = driver.limits(request.hdr);
    if (request.hdr && !limits.tenBit) {
        s.reason = "no 10-bit input: no HDR";
        return s;
    }
    // AV1 codes the picture's own size; the driver may want a multiple.
    const uint32_t wm = limits.widthMultiple ? limits.widthMultiple : 1;
    const uint32_t hm = limits.heightMultiple ? limits.heightMultiple : 1;
    s.codedWidth = (request.width + wm - 1) / wm * wm;
    s.codedHeight = (request.height + hm - 1) / hm * hm;
    s.codedWidth += s.codedWidth & 1;
    s.codedHeight += s.codedHeight & 1;
    if (s.codedWidth < limits.minWidth || s.codedHeight < limits.minHeight ||
        s.codedWidth > limits.maxWidth || s.codedHeight > limits.maxHeight) {
        s.reason = std::to_string(s.codedWidth) + "x" + std::to_string(s.codedHeight) +
                   " is outside what the driver encodes (" + std::to_string(limits.minWidth) + "x" +
                   std::to_string(limits.minHeight) + " to " + std::to_string(limits.maxWidth) +
                   "x" + std::to_string(limits.maxHeight) + ")";
        return s;
    }

    ++s.queries;
    const Av1ConfigAnswer config = driver.configuration();
    if (!config.taken || !config.keyAndInterFrames) {
        s.reason = config.taken ? "the driver codes no key and inter frames"
                                : "no AV1 configuration taken";
        return s;
    }
    if (config.required & av1feature::kUnwritable) {
        s.reason = "the driver requires a tool the headers here cannot say (features " +
                   av1neg_detail::hex(config.required & av1feature::kUnwritable) + ")";
        return s;
    }
    s.features =
        config.required | (config.supported & (av1feature::kCdef | av1feature::kOrderHint));
    s.postEncode = config.postEncode;
    // Switchable where the driver has it: it picks the filter block by block.
    s.interpolationFilter = (config.filters & (1u << 4)) ? 4 : (config.filters & 1u) ? 0 : -1;
    if (s.interpolationFilter < 0) {
        for (int f = 1; f < 4; ++f)
            if (config.filters & (1u << f)) {
                s.interpolationFilter = f;
                break;
            }
    }
    if (s.interpolationFilter < 0) {
        s.reason = "no interpolation filter";
        return s;
    }
    // TX_MODE_SELECT, or TX_MODE_LARGEST; ONLY_4X4 is only said by a lossless
    // frame.
    const auto txSelect = [](uint32_t flags, bool& select) {
        if (flags & 0x4u)
            select = true;
        else if (flags & 0x2u)
            select = false;
        else
            return false;
        return true;
    };
    if (!txSelect(config.txKey, s.txSelectKey) || !txSelect(config.txInter, s.txSelectInter)) {
        s.reason = "no transform mode the frame header can say";
        return s;
    }

    av1::Sequence& q = s.sequence;
    q.width = s.codedWidth;
    q.height = s.codedHeight;
    q.tenBit = request.hdr;
    q.hdr = request.hdr;
    q.sb128 = (s.features & av1feature::kSb128) != 0;
    const std::string tile = av1::singleTileRefusal(q);
    if (!tile.empty()) {
        s.reason = tile;
        return s;
    }

    std::vector<HevcRate> ladder = {{HevcRate::Mode::Cbr, true, true, true, true},
                                    {HevcRate::Mode::Cbr, true, true, true, false},
                                    {HevcRate::Mode::Cbr, false, true, true, false},
                                    {HevcRate::Mode::Cbr, false, true, false, false},
                                    {HevcRate::Mode::Cbr, false, false, false, false}};
    const int orderHintBits = (s.features & av1feature::kOrderHint) ? 8 : 0;
    const auto climb = [&](bool intraRefresh) {
        Av1SupportQuestion question;
        question.features = s.features;
        question.orderHintBits = orderHintBits;
        question.codedWidth = s.codedWidth;
        question.codedHeight = s.codedHeight;
        question.tenBit = request.hdr;
        question.intraRefresh = intraRefresh;
        question.fps = request.fps;
        for (size_t i = 0; i < ladder.size(); ++i) {
            ++s.queries;
            question.rate = ladder[i];
            const HevcSupportAnswer a = driver.support(question);
            if (a.ok) {
                s.rate = ladder[i];
                s.support = a;
                return static_cast<int>(i);
            }
        }
        return -1;
    };
    int rung = -1;
    if (request.intraRefresh) {
        rung = climb(true);
        const int most = rung >= 0 ? static_cast<int>(s.support.maxIntraRefreshFrames) : 0;
        if (most >= kIntraRefreshMinFrames) {
            s.intraRefreshFrames = (std::min)(intraRefreshPeriodFrames(request.fps), most);
        } else {
            add(s.reason, rung < 0 ? "no intra refresh taken: keyframes on demand"
                                   : "no intra refresh (the driver sweeps " + std::to_string(most) +
                                         " frames at most): keyframes on demand");
            rung = -1;
        }
    }
    if (rung < 0) rung = climb(false);
    if (rung < 0) {
        s.reason = "no rate control taken, down to plain CBR";
        return s;
    }
    if (rung > 0)
        add(s.reason, "rate control " + s.rate.describe() + ", not " + ladder.front().describe());
    if (!s.support.rateReconfigurable)
        add(s.reason, "the bitrate cannot change without a new sequence");

    q.levelIdx = av1LevelIdx(s.codedWidth, s.codedHeight, request.fps);
    q.orderHintBits = orderHintBits;
    q.filterIntra = (s.features & av1feature::kFilterIntra) != 0;
    q.intraEdgeFilter = (s.features & av1feature::kIntraEdgeFilter) != 0;
    q.interintraCompound = (s.features & av1feature::kInterintraCompound) != 0;
    q.maskedCompound = (s.features & av1feature::kMaskedCompound) != 0;
    q.warpedMotion = (s.features & av1feature::kWarpedMotion) != 0;
    q.dualFilter = (s.features & av1feature::kDualFilter) != 0;
    q.jntComp = orderHintBits && (s.features & av1feature::kJntComp) != 0;
    q.refFrameMvs = orderHintBits && (s.features & av1feature::kRefFrameMvs) != 0;
    q.cdef = (s.features & av1feature::kCdef) != 0;
    q.restoration = (s.features & av1feature::kRestoration) != 0;
    q.separateUvDeltaQ = true;
    s.ok = true;
    return s;
}

} // namespace mw::native::encode
