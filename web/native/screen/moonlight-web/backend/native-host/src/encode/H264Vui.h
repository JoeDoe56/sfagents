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

#include <cstddef>
#include <cstdint>
#include <vector>

// Tell a browser's H.264 decoder that the stream has nothing to reorder, when
// the encoder itself offers no way to say it.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// Bug B8, on NVENC: without the VUI's bitstream_restriction, the browser's
// hardware decoder assumes the worst — a DPB's worth of reordering — and holds
// that many frames before showing the first. NVENC, VA-API and oneVPL all have
// a knob for it and all set it. VideoToolbox has none: its H.264 SPS comes out
// with no VUI at all. Measured on bench-mac (21/09/2026, 1662×1080 H.264 High
// level 4.2, max_num_ref_frames 1): Chrome on Windows spent 90–105 ms (p99)
// decoding each frame of it, against 1 ms for the same host's HEVC and 1 ms for
// every other host's H.264 — four frames of DPB at 50 fps. HEVC is spared
// because its parameter sets always carry sps_max_num_reorder_pics.
//
// So the SPS is rewritten on its way out: everything up to the VUI (or, when
// there is one, up to its bitstream_restriction_flag) is kept bit for bit, and
// the tail says "no reordering, one picture to hold per reference frame".

namespace mw::native::encode {

namespace h264vui_detail {

/// Reads an RBSP (emulation prevention already removed), MSB first.
struct BitReader
{
    const std::vector<uint8_t>& bytes;
    size_t pos = 0;
    bool overrun = false;

    uint32_t u(int n)
    {
        uint32_t v = 0;
        for (int i = 0; i < n; ++i) {
            if (pos >= bytes.size() * 8) {
                overrun = true;
                return 0;
            }
            v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1u);
            ++pos;
        }
        return v;
    }
    uint32_t ue()
    {
        int zeros = 0;
        while (u(1) == 0) {
            if (overrun || ++zeros > 31) {
                overrun = true;
                return 0;
            }
        }
        return ((1u << zeros) - 1u) + u(zeros);
    }
    int32_t se()
    {
        const uint32_t v = ue();
        return (v & 1u) ? static_cast<int32_t>((v + 1) / 2) : -static_cast<int32_t>(v / 2);
    }
};

struct BitWriter
{
    std::vector<uint8_t> bytes;
    int used = 8; // bits used in the last byte; 8 = start a new one

    void u(int n, uint32_t v)
    {
        for (int i = n - 1; i >= 0; --i) {
            if (used == 8) {
                bytes.push_back(0);
                used = 0;
            }
            if ((v >> i) & 1u) bytes.back() |= static_cast<uint8_t>(0x80u >> used);
            ++used;
        }
    }
    void ue(uint32_t v)
    {
        const uint64_t x = static_cast<uint64_t>(v) + 1;
        int bits = 0;
        while ((x >> bits) > 1)
            ++bits;
        u(bits, 0);
        u(bits + 1, static_cast<uint32_t>(x));
    }
};

inline std::vector<uint8_t> unescape(const uint8_t* p, size_t size)
{
    std::vector<uint8_t> out;
    out.reserve(size);
    int zeros = 0;
    for (size_t i = 0; i < size; ++i) {
        if (zeros >= 2 && p[i] == 3) {
            zeros = 0;
            continue;
        }
        out.push_back(p[i]);
        zeros = p[i] == 0 ? zeros + 1 : 0;
    }
    return out;
}

inline void escapeInto(const std::vector<uint8_t>& rbsp, std::vector<uint8_t>& out)
{
    int zeros = 0;
    for (uint8_t b : rbsp) {
        if (zeros >= 2 && b <= 3) {
            out.push_back(3);
            zeros = 0;
        }
        out.push_back(b);
        zeros = b == 0 ? zeros + 1 : 0;
    }
}

inline void skipScalingList(BitReader& r, int size)
{
    int32_t last = 8;
    int32_t next = 8;
    for (int j = 0; j < size && !r.overrun; ++j) {
        if (next != 0) next = (last + r.se() + 256) % 256;
        last = next == 0 ? last : next;
    }
}

inline void skipHrd(BitReader& r)
{
    const uint32_t cpbCount = r.ue() + 1;
    if (cpbCount > 32) {
        r.overrun = true;
        return;
    }
    r.u(4); // bit_rate_scale
    r.u(4); // cpb_size_scale
    for (uint32_t i = 0; i < cpbCount && !r.overrun; ++i) {
        r.ue(); // bit_rate_value_minus1
        r.ue(); // cpb_size_value_minus1
        r.u(1); // cbr_flag
    }
    r.u(5); // initial_cpb_removal_delay_length_minus1
    r.u(5); // cpb_removal_delay_length_minus1
    r.u(5); // dpb_output_delay_length_minus1
    r.u(5); // time_offset_length
}

} // namespace h264vui_detail

/// The SPS NAL unit `sps` (header byte included, emulation prevention in
/// place, no start code), rewritten so its VUI carries bitstream_restriction
/// with max_num_reorder_frames = 0 and max_dec_frame_buffering =
/// max_num_ref_frames (at least 1). Returns an empty vector when the input is
/// not an SPS this can parse — the caller then sends the original, which is
/// slower to decode but still correct.
inline std::vector<uint8_t> h264WithNoReorderVui(const uint8_t* sps, size_t size)
{
    using namespace h264vui_detail;
    if (!sps || size < 4 || (sps[0] & 0x1f) != 7) return {};

    const std::vector<uint8_t> rbsp = unescape(sps + 1, size - 1);
    BitReader r{rbsp};

    const uint32_t profile = r.u(8);
    r.u(8); // constraint flags + reserved
    r.u(8); // level_idc
    r.ue(); // seq_parameter_set_id
    if (profile == 100 || profile == 110 || profile == 122 || profile == 244 || profile == 44 ||
        profile == 83 || profile == 86 || profile == 118 || profile == 128 || profile == 138 ||
        profile == 139 || profile == 134 || profile == 135) {
        const uint32_t chroma = r.ue();
        if (chroma == 3) r.u(1); // separate_colour_plane_flag
        r.ue();                  // bit_depth_luma_minus8
        r.ue();                  // bit_depth_chroma_minus8
        r.u(1);                  // qpprime_y_zero_transform_bypass_flag
        if (r.u(1)) {            // seq_scaling_matrix_present_flag
            const int lists = chroma == 3 ? 12 : 8;
            for (int i = 0; i < lists && !r.overrun; ++i)
                if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
        }
    }
    r.ue(); // log2_max_frame_num_minus4
    const uint32_t pocType = r.ue();
    if (pocType == 0) {
        r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType == 1) {
        r.u(1); // delta_pic_order_always_zero_flag
        r.se(); // offset_for_non_ref_pic
        r.se(); // offset_for_top_to_bottom_field
        const uint32_t cycle = r.ue();
        if (cycle > 255) return {};
        for (uint32_t i = 0; i < cycle && !r.overrun; ++i)
            r.se();
    }
    const uint32_t refFrames = r.ue(); // max_num_ref_frames
    r.u(1);                            // gaps_in_frame_num_value_allowed_flag
    r.ue();                            // pic_width_in_mbs_minus1
    r.ue();                            // pic_height_in_map_units_minus1
    if (!r.u(1)) r.u(1);               // frame_mbs_only_flag, mb_adaptive_frame_field_flag
    r.u(1);                            // direct_8x8_inference_flag
    if (r.u(1)) {                      // frame_cropping_flag
        r.ue();
        r.ue();
        r.ue();
        r.ue();
    }
    if (r.overrun) return {};

    // Where the kept prefix ends, and whether a VUI header must be written.
    size_t keep = r.pos;
    const bool hasVui = r.u(1) != 0;
    if (hasVui) {
        if (r.u(1)) {                   // aspect_ratio_info_present_flag
            if (r.u(8) == 255) r.u(32); // Extended_SAR: sar_width, sar_height
        }
        if (r.u(1)) r.u(1);      // overscan_info_present / appropriate
        if (r.u(1)) {            // video_signal_type_present_flag
            r.u(4);              // video_format, video_full_range_flag
            if (r.u(1)) r.u(24); // colour_description_present_flag
        }
        if (r.u(1)) { // chroma_loc_info_present_flag
            r.ue();
            r.ue();
        }
        if (r.u(1)) r.u(65); // timing_info: 32 + 32 + fixed_frame_rate_flag
        const bool nalHrd = r.u(1) != 0;
        if (nalHrd) skipHrd(r);
        const bool vclHrd = r.u(1) != 0;
        if (vclHrd) skipHrd(r);
        if (nalHrd || vclHrd) r.u(1); // low_delay_hrd_flag
        r.u(1);                       // pic_struct_present_flag
        if (r.overrun) return {};
        keep = r.pos; // the bitstream_restriction_flag, replaced below
    }

    BitWriter w;
    for (size_t i = 0; i < keep; ++i)
        w.u(1, (rbsp[i >> 3] >> (7 - (i & 7))) & 1u);
    if (!hasVui) {
        w.u(1, 1); // vui_parameters_present_flag
        w.u(1, 0); // aspect_ratio_info_present_flag
        w.u(1, 0); // overscan_info_present_flag
        w.u(1, 0); // video_signal_type_present_flag
        w.u(1, 0); // chroma_loc_info_present_flag
        w.u(1, 0); // timing_info_present_flag
        w.u(1, 0); // nal_hrd_parameters_present_flag
        w.u(1, 0); // vcl_hrd_parameters_present_flag
        w.u(1, 0); // pic_struct_present_flag
    }
    w.u(1, 1);                           // bitstream_restriction_flag
    w.u(1, 1);                           // motion_vectors_over_pic_boundaries_flag
    w.ue(2);                             // max_bytes_per_pic_denom (the default)
    w.ue(1);                             // max_bits_per_mb_denom (the default)
    w.ue(15);                            // log2_max_mv_length_horizontal
    w.ue(15);                            // log2_max_mv_length_vertical
    w.ue(0);                             // max_num_reorder_frames — the point of all this
    w.ue(refFrames > 0 ? refFrames : 1); // max_dec_frame_buffering
    w.u(1, 1);                           // rbsp_stop_one_bit, then zeros to the byte
    // An RBSP may not end on a zero byte; the stop bit guarantees it does not.

    std::vector<uint8_t> out;
    out.reserve(size + 8);
    out.push_back(sps[0]);
    escapeInto(w.bytes, out);
    return out;
}

} // namespace mw::native::encode
