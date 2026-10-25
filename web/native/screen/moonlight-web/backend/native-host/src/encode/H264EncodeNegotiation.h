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

// H.264 through D3D12 Video Encode (plan pipeline-video-d3d12-v2, C9.1): what
// the product asks of a driver, then less, until it says yes — as
// HevcEncodeNegotiation.h for HEVC, whose rate ladder, intra-refresh rule and
// support answer this reuses. Pure: the driver is an interface, a table in
// the tests.
//
// The sequence is the one the VA-API path has streamed since the start: High
// profile, one reference, the sliding window, frame_num 16 bits wide, POC type
// 2 (decode order is display order: no B pictures), the VUI's
// bitstream_restriction (ParameterSets.h, the B8 lesson). A lost picture costs
// a keyframe: reference invalidation over H.264's short-term references would
// need memory-management operations in every slice, which D3D12 lets the
// caller write — a later step, when a gate asks for it.

#include "HevcEncodeNegotiation.h"
#include "ParameterSets.h"

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace mw::native::encode {

/// What does not depend on a proposal.
struct H264DriverLimits
{
    uint32_t minWidth = 0;
    uint32_t minHeight = 0;
    uint32_t maxWidth = 0;
    uint32_t maxHeight = 0;
    uint32_t maxL0ForP = 1;
    uint32_t maxDpb = 1;
};

/// What a driver says it codes: the codec configuration's flags and the
/// deblocking the PPS promises (disable_deblocking_filter_idc 0, every edge).
struct H264ConfigAnswer
{
    bool taken = false;
    bool cabac = false;
    bool transform8x8 = false;
    bool deblockingAllEdges = false;
};

/// A whole encoder, as it is put to the driver.
struct H264SupportQuestion
{
    bool cabac = false;
    bool transform8x8 = false;
    HevcRate rate;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    bool intraRefresh = false;
    int fps = 60;
};

/// The driver, as the negotiation sees it: VideoEncodeCapsH264 on a device,
/// a table in the tests.
class H264DriverQueries
{
public:
    virtual ~H264DriverQueries() = default;
    virtual H264DriverLimits limits() = 0;
    virtual H264ConfigAnswer configuration() = 0;
    virtual HevcSupportAnswer support(const H264SupportQuestion& question) = 0;
};

struct H264EncodeRequest
{
    uint32_t width = 0;
    uint32_t height = 0;
    int fps = 60;
    bool intraRefresh = false;
    /// CQP, the QP set picture by picture by our own controller (plan §4.6).
    bool ownRateControl = false;
};

struct H264EncodeSetup
{
    bool ok = false;
    /// Why there is no setup; with one, what had to be given up ("" if nothing).
    std::string reason;
    HevcRate rate;
    HevcSupportAnswer support;
    bool cabac = false;
    bool transform8x8 = false;
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    int intraRefreshFrames = 0; ///< 0: keyframes on demand
    int queries = 0;
    paramsets::H264Sequence sequence;
};

/// The level when the driver suggests none: 5.1 (level_idc counts tenths),
/// room for 4K at 60 frames/s.
inline int h264DefaultLevelIdc()
{
    return 51;
}

/// Everything the product would like, then less, until the driver says yes.
inline H264EncodeSetup negotiateH264(const H264EncodeRequest& request, H264DriverQueries& driver)
{
    using hevcneg_detail::add;
    H264EncodeSetup s;
    if (request.width == 0 || request.height == 0 || (request.width | request.height) & 1) {
        s.reason = "a size of " + std::to_string(request.width) + "x" +
                   std::to_string(request.height) + ": 4:2:0 wants it even";
        return s;
    }
    const H264DriverLimits limits = driver.limits();
    // Whole macroblocks; the SPS crops the band past the picture, which the
    // converter pads.
    s.codedWidth = (request.width + 15) / 16 * 16;
    s.codedHeight = (request.height + 15) / 16 * 16;
    if (s.codedWidth < limits.minWidth || s.codedHeight < limits.minHeight ||
        s.codedWidth > limits.maxWidth || s.codedHeight > limits.maxHeight) {
        s.reason = std::to_string(s.codedWidth) + "x" + std::to_string(s.codedHeight) +
                   " is outside what the driver encodes (" + std::to_string(limits.minWidth) + "x" +
                   std::to_string(limits.minHeight) + " to " + std::to_string(limits.maxWidth) +
                   "x" + std::to_string(limits.maxHeight) + ")";
        return s;
    }

    ++s.queries;
    const H264ConfigAnswer config = driver.configuration();
    if (!config.taken) {
        s.reason = "no H.264 configuration taken";
        return s;
    }
    if (!config.deblockingAllEdges) {
        s.reason = "the driver does not filter every edge (disable_deblocking_filter_idc 0), "
                   "which the PPS says";
        return s;
    }
    // CABAC and the 8×8 transform where the driver has them: High profile's
    // two savings. Without them the stream is still High profile — both are
    // flags the PPS says, not the profile.
    s.cabac = config.cabac;
    s.transform8x8 = config.transform8x8;
    if (!s.cabac) add(s.reason, "no CABAC: CAVLC");

    // The rate control, richest first — HEVC's ladder.
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
    const auto climb = [&](bool intraRefresh) {
        H264SupportQuestion question;
        question.cabac = s.cabac;
        question.transform8x8 = s.transform8x8;
        question.codedWidth = s.codedWidth;
        question.codedHeight = s.codedHeight;
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
        s.reason = "no rate control taken, down to plain " +
                   std::string(request.ownRateControl ? "CQP" : "CBR");
        return s;
    }
    if (rung > 0)
        add(s.reason, "rate control " + s.rate.describe() + ", not " + ladder.front().describe());
    if (!request.ownRateControl && !s.support.rateReconfigurable)
        add(s.reason, "the bitrate cannot change without a new sequence");

    paramsets::H264Sequence& q = s.sequence;
    q.profileIdc = 100;
    q.levelIdc =
        s.support.suggestedLevelIdc > 0 ? s.support.suggestedLevelIdc : h264DefaultLevelIdc();
    q.widthMbs = s.codedWidth / 16;
    q.heightMbs = s.codedHeight / 16;
    // frame_crop_*_offset counts pairs of luma samples in 4:2:0.
    q.cropRight = (s.codedWidth - request.width) / 2;
    q.cropBottom = (s.codedHeight - request.height) / 2;
    q.maxRefFrames = 1;
    q.log2MaxFrameNum = 16;
    q.fps = request.fps;
    q.cabac = s.cabac;
    q.transform8x8 = s.transform8x8;
    s.ok = true;
    return s;
}

} // namespace mw::native::encode
