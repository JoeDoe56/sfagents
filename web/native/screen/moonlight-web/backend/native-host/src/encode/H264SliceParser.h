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

// H.264's parameter sets and slice headers, read back (plan
// pipeline-video-d3d12-v2, C9.1): what HevcSliceParser.h is to HEVC. A D3D12
// Video Encode driver writes the slices and leaves the SPS and PPS to the
// application, with nothing to check that the two agree — so the first
// pictures' slice headers are read with our own parameter sets, and a driver
// whose slices say something else sends the session back to D3D11 before a
// viewer sees noise. Pure; up to the fields the guard and the rate control
// read, and every field in front of them.

#include "HevcSliceParser.h"

#include <cstdint>
#include <string>
#include <vector>

namespace mw::native::encode {

struct H264SpsFields
{
    uint32_t profileIdc = 0;
    uint32_t levelIdc = 0;
    uint32_t chromaFormatIdc = 1;
    uint32_t log2MaxFrameNum = 4;
    uint32_t pocType = 0;
    uint32_t log2MaxPocLsb = 4;
    uint32_t maxRefFrames = 0;
    bool gapsAllowed = false;
    uint32_t widthMbs = 0;
    uint32_t heightMbs = 0;
    bool frameMbsOnly = true;
    bool direct8x8 = false;
};

struct H264PpsFields
{
    bool cabac = false;
    bool bottomFieldPicOrder = false;
    uint32_t numRefIdxL0Default = 1;
    uint32_t numRefIdxL1Default = 1;
    bool weightedPred = false;
    uint32_t weightedBipredIdc = 0;
    /// 26 + pic_init_qp_minus26: the QP a slice whose delta is 0 codes at.
    int initQp = 26;
    bool deblockingControl = false;
    bool constrainedIntra = false;
    bool redundantPicCnt = false;
    bool transform8x8 = false;
};

struct H264SliceFields
{
    uint32_t nalType = 0;
    uint32_t nalRefIdc = 0;
    uint32_t firstMb = 0;
    /// slice_type % 5: 0 P, 1 B, 2 I.
    uint32_t sliceType = 0;
    uint32_t frameNum = 0;
    uint32_t idrPicId = 0;
    uint32_t pocLsb = 0;
    uint32_t numRefIdxL0Active = 1;
    /// ref_pic_list_modification for L0: (modification_of_pic_nums_idc, value).
    std::vector<std::pair<uint32_t, uint32_t>> listModifications;
    bool adaptiveMarking = false;
    /// SliceQPY: the PPS's init QP plus slice_qp_delta.
    int qp = 0;
};

namespace h264parse_detail {

using h264vui_detail::BitReader;
using hevcparse_detail::kHeaderLimit;
using hevcparse_detail::kPastTheEnd;
using hevcparse_detail::skipStartCode;

/// The RBSP after the one-byte NAL header, emulation prevention undone, up to
/// @p limit bytes.
inline std::vector<uint8_t> payload(const uint8_t* data, size_t size, size_t limit)
{
    const size_t n = size - 1 < limit ? size - 1 : limit;
    return h264vui_detail::unescape(data + 1, n);
}

/// more_rbsp_data(): whether anything but rbsp_trailing_bits() follows the
/// reader's position — the last one bit of the RBSP being its stop bit.
inline bool moreRbspData(const BitReader& r, const std::vector<uint8_t>& rbsp)
{
    size_t last = rbsp.size();
    while (last > 0 && rbsp[last - 1] == 0)
        --last;
    if (last == 0) return false;
    const uint8_t byte = rbsp[last - 1];
    int bit = 0; // from the least significant end
    while (bit < 8 && !((byte >> bit) & 1))
        ++bit;
    const size_t stop = (last - 1) * 8 + static_cast<size_t>(7 - bit);
    return r.pos < stop;
}

inline std::string header(const uint8_t* data, size_t size, uint32_t& type, uint32_t& refIdc)
{
    if (size < 2) return "a unit too short for its NAL header";
    if (data[0] & 0x80) return "forbidden_zero_bit set";
    refIdc = (data[0] >> 5) & 3u;
    type = data[0] & 0x1Fu;
    return {};
}

} // namespace h264parse_detail

/// The NAL unit type of an H.264 unit (start code off).
inline uint32_t h264NalType(const HevcNalUnit& unit)
{
    return unit.size > 0 ? (unit.data[0] & 0x1Fu) : 0u;
}

/// Reads an SPS unit (start code or not) up to the VUI. Empty on success,
/// otherwise what could not be read.
inline std::string parseH264Sps(const uint8_t* data, size_t size, H264SpsFields& out)
{
    using namespace h264parse_detail;
    skipStartCode(data, size);
    uint32_t type = 0, refIdc = 0;
    std::string e = header(data, size, type, refIdc);
    if (!e.empty()) return e;
    if (type != 7) return "not an SPS (NAL type " + std::to_string(type) + ")";
    const std::vector<uint8_t> rbsp = payload(data, size, kHeaderLimit);
    BitReader r{rbsp};
    H264SpsFields s;
    s.profileIdc = r.u(8);
    r.u(8); // constraint_set flags and reserved_zero_2bits
    s.levelIdc = r.u(8);
    if (r.ue() != 0) return "seq_parameter_set_id other than 0";
    const uint32_t p = s.profileIdc;
    if (p == 100 || p == 110 || p == 122 || p == 244 || p == 44 || p == 83 || p == 86 || p == 118 ||
        p == 128 || p == 138 || p == 139 || p == 134 || p == 135) {
        s.chromaFormatIdc = r.ue();
        if (s.chromaFormatIdc == 3) r.u(1); // separate_colour_plane_flag
        r.ue();                             // bit_depth_luma_minus8
        r.ue();                             // bit_depth_chroma_minus8
        r.u(1);                             // qpprime_y_zero_transform_bypass_flag
        if (r.u(1) != 0) return "seq_scaling_matrix_present_flag: no scaling lists here";
    }
    s.log2MaxFrameNum = r.ue() + 4;
    s.pocType = r.ue();
    if (s.pocType == 0) {
        s.log2MaxPocLsb = r.ue() + 4;
    } else if (s.pocType == 1) {
        return "pic_order_cnt_type 1: not written here";
    }
    s.maxRefFrames = r.ue();
    s.gapsAllowed = r.u(1) != 0;
    s.widthMbs = r.ue() + 1;
    s.heightMbs = r.ue() + 1;
    s.frameMbsOnly = r.u(1) != 0;
    if (!s.frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
    s.direct8x8 = r.u(1) != 0;
    if (r.overrun) return kPastTheEnd;
    if (s.log2MaxFrameNum > 16) return "log2_max_frame_num over 16";
    if (s.pocType > 2) return "pic_order_cnt_type over 2";
    out = s;
    return {};
}

/// Reads a PPS unit (start code or not).
inline std::string parseH264Pps(const uint8_t* data, size_t size, H264PpsFields& out)
{
    using namespace h264parse_detail;
    skipStartCode(data, size);
    uint32_t type = 0, refIdc = 0;
    std::string e = header(data, size, type, refIdc);
    if (!e.empty()) return e;
    if (type != 8) return "not a PPS (NAL type " + std::to_string(type) + ")";
    const std::vector<uint8_t> rbsp = payload(data, size, kHeaderLimit);
    BitReader r{rbsp};
    H264PpsFields s;
    if (r.ue() != 0) return "pic_parameter_set_id other than 0";
    if (r.ue() != 0) return "seq_parameter_set_id other than 0";
    s.cabac = r.u(1) != 0;
    s.bottomFieldPicOrder = r.u(1) != 0;
    if (r.ue() != 0) return "slice groups: not written here";
    s.numRefIdxL0Default = r.ue() + 1;
    s.numRefIdxL1Default = r.ue() + 1;
    s.weightedPred = r.u(1) != 0;
    s.weightedBipredIdc = r.u(2);
    s.initQp = 26 + r.se();
    r.se(); // pic_init_qs_minus26
    r.se(); // chroma_qp_index_offset
    s.deblockingControl = r.u(1) != 0;
    s.constrainedIntra = r.u(1) != 0;
    s.redundantPicCnt = r.u(1) != 0;
    // The High profile's tail, when there is more RBSP than the trailing bits.
    if (moreRbspData(r, rbsp)) {
        s.transform8x8 = r.u(1) != 0;
        if (r.u(1) != 0) return "pic_scaling_matrix_present_flag: no scaling lists here";
        r.se(); // second_chroma_qp_index_offset
    }
    if (r.overrun) return kPastTheEnd;
    out = s;
    return {};
}

/// Reads a slice header (start code or not) with @p sps and @p pps, up to
/// slice_qp_delta. Empty on success, otherwise what could not be read or
/// makes no sense with those parameter sets.
inline std::string parseH264SliceHeader(const uint8_t* data, size_t size, const H264SpsFields& sps,
                                        const H264PpsFields& pps, H264SliceFields& out)
{
    using namespace h264parse_detail;
    skipStartCode(data, size);
    H264SliceFields f;
    std::string e = header(data, size, f.nalType, f.nalRefIdc);
    if (!e.empty()) return e;
    if (f.nalType != 1 && f.nalType != 5)
        return "not a slice (NAL type " + std::to_string(f.nalType) + ")";
    const bool idr = f.nalType == 5;
    const std::vector<uint8_t> rbsp = payload(data, size, kHeaderLimit);
    BitReader r{rbsp};
    f.firstMb = r.ue();
    f.sliceType = r.ue() % 5;
    if (f.sliceType == 1) return "a B slice: not asked for";
    if (f.sliceType != 0 && f.sliceType != 2)
        return "slice_type " + std::to_string(f.sliceType) + " (SP or SI)";
    if (idr && f.sliceType != 2) return "an IDR with a P slice";
    if (r.ue() != 0) return "a slice naming another PPS";
    f.frameNum = r.u(static_cast<int>(sps.log2MaxFrameNum));
    if (!sps.frameMbsOnly) return "fields: not written here";
    if (idr) f.idrPicId = r.ue();
    if (sps.pocType == 0) {
        f.pocLsb = r.u(static_cast<int>(sps.log2MaxPocLsb));
        if (pps.bottomFieldPicOrder) r.se(); // delta_pic_order_cnt_bottom
    }
    if (pps.redundantPicCnt) r.ue();
    if (f.sliceType == 0) {
        f.numRefIdxL0Active = pps.numRefIdxL0Default;
        if (r.u(1) != 0) f.numRefIdxL0Active = r.ue() + 1; // num_ref_idx_active_override_flag
        // ref_pic_list_modification() for L0
        if (r.u(1) != 0) {
            for (int guard = 0; guard < 33; ++guard) {
                const uint32_t idc = r.ue();
                if (idc == 3) break;
                if (idc > 5) return "modification_of_pic_nums_idc " + std::to_string(idc);
                f.listModifications.emplace_back(idc, r.ue());
                if (r.overrun) return kPastTheEnd;
            }
        }
        if (pps.weightedPred) return "weighted prediction: not asked for";
    }
    if (f.nalRefIdc != 0) {
        // dec_ref_pic_marking()
        if (idr) {
            r.u(1); // no_output_of_prior_pics_flag
            r.u(1); // long_term_reference_flag
        } else {
            f.adaptiveMarking = r.u(1) != 0;
            if (f.adaptiveMarking) {
                for (int guard = 0; guard < 66; ++guard) {
                    const uint32_t op = r.ue();
                    if (op == 0) break;
                    if (op > 6) return "memory_management_control_operation " + std::to_string(op);
                    if (op == 1 || op == 3) r.ue(); // difference_of_pic_nums_minus1
                    if (op == 2) r.ue();            // long_term_pic_num
                    if (op == 3 || op == 6) r.ue(); // long_term_frame_idx
                    if (op == 4) r.ue();            // max_long_term_frame_idx_plus1
                    if (r.overrun) return kPastTheEnd;
                }
            }
        }
    }
    if (pps.cabac && f.sliceType != 2) {
        const uint32_t cabacInit = r.ue();
        if (cabacInit > 2) return "cabac_init_idc " + std::to_string(cabacInit);
    }
    f.qp = pps.initQp + r.se();
    if (r.overrun) return kPastTheEnd;
    if (f.qp < 0 || f.qp > 51) return "slice QP " + std::to_string(f.qp) + " out of range";
    out = f;
    return {};
}

} // namespace mw::native::encode
