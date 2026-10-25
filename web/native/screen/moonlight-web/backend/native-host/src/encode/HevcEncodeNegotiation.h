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

#include "ParameterSets.h"
#include "RateControl.h"

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

// How an HEVC stream is set up on a D3D12 Video Encode driver: which of the
// configurations the product would like the driver takes, and what follows from
// its answers for the parameter sets, the DPB and the rate control.
//
// ── Why a negotiation ───────────────────────────────────────────────────────
//
// D3D12 has the application propose and the driver accept or refuse — block
// sizes, a rate control and its options, a size — and the answers differ from
// one GPU to the next. The three of DualRTX (26/09/2026, mw-d3d12-lab caps and
// encode):
// - RTX 5060 Ti: coding blocks 8..32 (64 refused), depth 3 only, AMP
//   required; CBR with VBV and a QP range but no frame-size cap; the rate
//   changes on the fly.
// - AMD iGPU: 8..64, depth 4, AMP free; every CBR option, the cap included;
//   one L0 reference; reconstructed pictures in a texture array.
// - Arc A380: 8..64, depth 2, AMP required, P pictures sent as low-delay B;
//   no rate change without a new sequence.
// And all three code whole coding tree blocks, whatever size the query
// accepts: the stream is coded at a whole number of them, and the SPS says so
// and crops (ParameterSets.h, HevcDialect::D3d12).
//
// The order the proposals are tried in is the product's preference, written
// here; the questions themselves are VideoEncodeCaps12's, on a device. Pure
// logic, tested everywhere against the three GPUs' answers.

namespace mw::native::encode {

/// A block configuration: sizes as log2, one transform depth for inter and
/// intra alike.
struct HevcBlocks
{
    int log2MinCodingBlock = 3;
    int log2MaxCodingBlock = 6;
    int log2MinTransformBlock = 2;
    int log2MaxTransformBlock = 5;
    int depth = 2;

    bool operator==(const HevcBlocks& o) const
    {
        return log2MinCodingBlock == o.log2MinCodingBlock &&
               log2MaxCodingBlock == o.log2MaxCodingBlock &&
               log2MinTransformBlock == o.log2MinTransformBlock &&
               log2MaxTransformBlock == o.log2MaxTransformBlock && depth == o.depth;
    }
};

/// What a driver says of a block configuration.
struct HevcBlocksAnswer
{
    bool taken = false;
    bool ampRequired = false;  ///< AMP on, or the configuration is refused
    bool pAsLowDelayB = false; ///< P pictures go in as B, with L1 = L0
};

/// A rate control and the options asked with it.
struct HevcRate
{
    enum class Mode
    {
        Cbr,
        Cqp,
    };
    Mode mode = Mode::Cbr;
    bool qualityVsSpeed = false; ///< the EXTENSION1 structures (CBR1, CQP1)
    bool vbv = false;
    bool qpRange = false;
    bool frameSizeCap = false;

    std::string describe() const
    {
        std::string s = mode == Mode::Cbr ? (qualityVsSpeed ? "CBR1" : "CBR")
                                          : (qualityVsSpeed ? "CQP1" : "CQP");
        if (vbv) s += " + VBV";
        if (qpRange) s += " + QP range";
        if (frameSizeCap) s += " + frame size cap";
        return s;
    }
};

/// What a driver says of a whole encoder: blocks, rate control and size.
struct HevcSupportAnswer
{
    bool ok = false;
    bool rateReconfigurable = false; ///< a new bitrate without a new sequence
    bool reconTextureArray = false;  ///< reconstructed pictures in one texture array
    /// Reconstructed pictures in a layout others may read; otherwise they are
    /// the encoder's alone (VIDEO_ENCODE_REFERENCE_ONLY).
    bool reconReadable = false;
    int suggestedLevelIdc = 0; ///< 30 × the level
    uint32_t qpMapRegion = 0;  ///< pixels per side of a QP map region
    uint32_t maxIntraRefreshFrames = 0;
    uint32_t maxQualityVsSpeed = 0;
};

/// What does not depend on a proposal.
struct HevcDriverLimits
{
    uint32_t minWidth = 0;
    uint32_t minHeight = 0;
    uint32_t maxWidth = 0;
    uint32_t maxHeight = 0;
    uint32_t maxL0ForP = 1;
    uint32_t maxDpb = 1;
    bool main10 = false;
};

/// A whole encoder, as it is put to the driver.
struct HevcSupportQuestion
{
    HevcBlocks blocks;
    HevcBlocksAnswer blockFlags; ///< what the driver said of the blocks: AMP required…
    HevcRate rate;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    uint32_t dpb = 1; ///< pictures kept
    bool intraRefresh = false;
    bool tenBit = false;
    int fps = 60;
};

/// The driver, as the negotiation sees it: VideoEncodeCaps12 on a device, a
/// table in the tests.
class HevcDriverQueries
{
public:
    virtual ~HevcDriverQueries() = default;
    virtual HevcDriverLimits limits(bool tenBit) = 0;
    virtual HevcBlocksAnswer blocks(const HevcBlocks& blocks, bool tenBit) = 0;
    virtual HevcSupportAnswer support(const HevcSupportQuestion& question) = 0;
};

struct HevcEncodeRequest
{
    uint32_t width = 0;
    uint32_t height = 0;
    int fps = 60;
    bool hdr = false;          ///< Main 10, BT.2020 PQ
    bool intraRefresh = false; ///< the wave instead of keyframes, where it can be had
    /// CQP, the QP set picture by picture by our own controller (plan §4.6) —
    /// on a driver that cannot change its bitrate in flight.
    bool ownRateControl = false;
    int dpbFrames = 0; ///< pictures kept for a repair; 0: the default
};

struct HevcEncodeSetup
{
    bool ok = false;
    /// Why there is no setup; with one, what had to be given up ("" if nothing).
    std::string reason;
    HevcBlocks blocks;
    HevcBlocksAnswer blocksAnswer;
    HevcRate rate;
    HevcSupportAnswer support;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    int dpbCapacity = 1;        ///< HevcDpb's capacity: pictures kept
    int intraRefreshFrames = 0; ///< 0: keyframes on demand
    int queries = 0;            ///< how many proposals it took, for the log
    paramsets::HevcSequence sequence;
};

namespace hevcneg_detail {

/// The pictures kept by default: NVENC's DPB (NvencEncoder, kDpbFrames), and
/// VA-API's — three consecutive losses healed by an ordinary delta.
constexpr int kDefaultDpbFrames = 4;

/// The HEVC level's MaxLumaPs (Table A.8), by general_level_idc.
inline uint64_t maxLumaPictureSize(int levelIdc)
{
    if (levelIdc <= 30) return 36864;
    if (levelIdc <= 60) return 122880;
    if (levelIdc <= 63) return 245760;
    if (levelIdc <= 90) return 552960;
    if (levelIdc <= 93) return 983040;
    if (levelIdc <= 123) return 2228224;
    if (levelIdc <= 156) return 8912896;
    return 35651584;
}

inline void add(std::string& reason, const std::string& what)
{
    reason += (reason.empty() ? "" : "; ") + what;
}

} // namespace hevcneg_detail

/// MaxDpbSize (A.4.2): how many pictures, the current one included, a decoder
/// at @p levelIdc holds for a picture of @p lumaSamples.
inline int hevcMaxDpbSize(int levelIdc, uint64_t lumaSamples)
{
    const uint64_t maxLumaPs = hevcneg_detail::maxLumaPictureSize(levelIdc);
    constexpr int maxDpbPicBuf = 6;
    if (lumaSamples <= (maxLumaPs >> 2)) return (std::min)(4 * maxDpbPicBuf, 16);
    if (lumaSamples <= (maxLumaPs >> 1)) return (std::min)(2 * maxDpbPicBuf, 16);
    if (lumaSamples <= ((3 * maxLumaPs) >> 2)) return (std::min)((4 * maxDpbPicBuf) / 3, 16);
    return maxDpbPicBuf;
}

/// Everything the product would like, then less, until the driver says yes.
inline HevcEncodeSetup negotiateHevc(const HevcEncodeRequest& request, HevcDriverQueries& driver)
{
    using hevcneg_detail::add;
    HevcEncodeSetup s;
    const bool tenBit = request.hdr;
    const HevcDriverLimits limits = driver.limits(tenBit);
    if (tenBit && !limits.main10) {
        s.reason = "no Main 10 on this driver";
        return s;
    }

    // The size: 4:2:0 wants it even.
    if (request.width == 0 || request.height == 0 || (request.width | request.height) & 1) {
        s.reason = "a size of " + std::to_string(request.width) + "x" +
                   std::to_string(request.height) + ": 4:2:0 wants it even";
        return s;
    }

    // Blocks: the smallest minimums and the largest maximums first, then the
    // shallowest transform tree the driver takes — the order the lab found
    // the three GPUs' only configurations in.
    bool found = false;
    for (int minCb = 3; minCb <= 6 && !found; ++minCb)
        for (int maxCb = 6; maxCb >= minCb && !found; --maxCb)
            for (int minTb = 2; minTb <= 5 && !found; ++minTb)
                for (int maxTb = 5; maxTb >= minTb && !found; --maxTb)
                    for (int depth = 0; depth <= 4 && !found; ++depth) {
                        const HevcBlocks b{minCb, maxCb, minTb, maxTb, depth};
                        ++s.queries;
                        const HevcBlocksAnswer a = driver.blocks(b, tenBit);
                        if (a.taken) {
                            s.blocks = b;
                            s.blocksAnswer = a;
                            found = true;
                        }
                    }
    if (!found) {
        s.reason = "no block configuration taken";
        return s;
    }

    // The coded size, in whole coding tree blocks. The drivers code every CTB
    // whole, whatever size their support query accepts: over a size that ends
    // inside one, the decoder infers the splits HEVC makes at a picture's
    // edge, the driver's slices do not have them, and every picture decodes
    // wrong from that row or column of blocks on, while ffmpeg flags a few in
    // a thousand. The lab's pixels against its input (27/09/2026): 1440 lines
    // over CTBs of 64 (Arc, AMD iGPU), 1080 over 32 or 64, 3440 columns over
    // either — every picture wrong; in whole CTBs, none. The converter pads
    // the band past the picture; the SPS crops it.
    const uint32_t ctb = 1u << s.blocks.log2MaxCodingBlock;
    s.codedWidth = (request.width + ctb - 1) / ctb * ctb;
    s.codedHeight = (request.height + ctb - 1) / ctb * ctb;
    if (s.codedWidth < limits.minWidth || s.codedHeight < limits.minHeight ||
        s.codedWidth > limits.maxWidth || s.codedHeight > limits.maxHeight) {
        s.reason = std::to_string(s.codedWidth) + "x" + std::to_string(s.codedHeight) +
                   " is outside what the driver encodes (" + std::to_string(limits.minWidth) + "x" +
                   std::to_string(limits.minHeight) + " to " + std::to_string(limits.maxWidth) +
                   "x" + std::to_string(limits.maxHeight) + ")";
        return s;
    }

    // Pictures kept: the default, within the driver's DPB. The level's
    // limit is only known once the driver suggested a level, below.
    const int wanted =
        request.dpbFrames > 0 ? request.dpbFrames : hevcneg_detail::kDefaultDpbFrames;
    int capacity = std::clamp(wanted, 1, static_cast<int>(std::max<uint32_t>(limits.maxDpb, 1)));

    // The rate control, richest first.
    std::vector<HevcRate> ladder;
    if (request.ownRateControl) {
        ladder = {{HevcRate::Mode::Cqp, true, false, false, false},
                  {HevcRate::Mode::Cqp, false, false, false, false}};
    } else {
        ladder = {{HevcRate::Mode::Cbr, true, true, true, true},
                  {HevcRate::Mode::Cbr, true, true, true, false},
                  {HevcRate::Mode::Cbr, false, true, true, false},
                  {HevcRate::Mode::Cbr, false, true, false, false},
                  {HevcRate::Mode::Cbr, false, false, false, false}};
    }
    // The first rung the driver takes, or -1.
    const auto climb = [&](bool intraRefresh) {
        HevcSupportQuestion question;
        question.blocks = s.blocks;
        question.blockFlags = s.blocksAnswer;
        question.codedWidth = s.codedWidth;
        question.codedHeight = s.codedHeight;
        question.dpb = static_cast<uint32_t>(capacity);
        question.intraRefresh = intraRefresh;
        question.tenBit = tenBit;
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
    // Intra refresh is worth having only over a real sweep: a driver that
    // takes it over a frame or two (the Arc says 1) repairs nothing a keyframe
    // would not.
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
        s.reason = "no rate control taken, down to plain " +
                   std::string(request.ownRateControl ? "CQP" : "CBR");
        return s;
    }
    if (rung > 0)
        add(s.reason, "rate control " + s.rate.describe() + ", not " + ladder.front().describe());
    if (!request.ownRateControl && !s.support.rateReconfigurable)
        add(s.reason, "the bitrate cannot change without a new sequence");

    // The level the driver suggests, and the DPB it allows.
    const int level = s.support.suggestedLevelIdc > 0 ? s.support.suggestedLevelIdc : 153;
    const int levelDpb =
        hevcMaxDpbSize(level, static_cast<uint64_t>(s.codedWidth) * s.codedHeight) - 1;
    if (capacity > levelDpb) {
        add(s.reason, std::to_string(levelDpb) + " pictures kept, the level's most");
        capacity = (std::max)(levelDpb, 1);
    }
    s.dpbCapacity = capacity;

    paramsets::HevcSequence& q = s.sequence;
    q.dialect = paramsets::HevcDialect::D3d12;
    q.width = request.width;
    q.height = request.height;
    q.codedWidth = s.codedWidth;
    q.codedHeight = s.codedHeight;
    q.levelIdc = level;
    q.maxReferences = static_cast<uint32_t>(capacity);
    // 8 bits: HevcDpb keeps pictures from the last 125 ms or so, a few dozen
    // frames even at 240 frames/s, far inside the 128 an 8-bit POC tells apart.
    q.log2MaxPocLsb = 8;
    q.fps = request.fps;
    q.tenBit = tenBit;
    q.hdr = request.hdr;
    q.log2MinCodingBlock = s.blocks.log2MinCodingBlock;
    q.log2MaxCodingBlock = s.blocks.log2MaxCodingBlock;
    q.log2MinTransformBlock = s.blocks.log2MinTransformBlock;
    q.log2MaxTransformBlock = s.blocks.log2MaxTransformBlock;
    q.transformDepthInter = s.blocks.depth;
    q.transformDepthIntra = s.blocks.depth;
    // AMP only where the driver requires it, SAO and the rest off: the
    // configurations whose slices ffmpeg decoded without an error.
    q.asymmetricMotionPartitions = s.blocksAnswer.ampRequired;
    q.defaultActiveReferences = 1;
    s.ok = true;
    return s;
}

} // namespace mw::native::encode
