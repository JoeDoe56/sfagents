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

#include <algorithm>
#include <cstdint>
#include <initializer_list>
#include <vector>

// The parameter sets and slice headers of an H.264 or HEVC stream, written by
// us — for a driver that wants them from the application.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// Mesa's VA-API encoders stopped writing their own headers somewhere after
// 23.2: from 25.x (radeonsi, and every driver behind the same frontend) the
// VPS/SPS/PPS come out ONLY when the application hands them in as packed
// headers, and the slice header's frame_num (H.264) or reference picture set
// (HEVC) are read from the application's packed slice header too — without
// one they are zero. Mesa then re-writes every one of them itself from what it
// parsed, so what is written here is the description, and the driver's own
// writer produces the bytes that leave. That is why these must say exactly
// what the parameter buffers say: they are not decoration on top of them,
// they replace them.
//
// Measured on a Radeon 610M, Mesa 25.2.8 (16/09/2026): keyframes of the
// picture alone, no parameter set, no client could start. Same binary on a
// 780M under Mesa 23.2: all four sets, written by the driver.
//
// D3D12 Video Encode is the other one: its drivers write the slices and leave
// the HEVC parameter sets to the application, with nothing in between — see
// HevcDialect::D3d12, whose bytes differ from Mesa's where the drivers' slices
// say so.
//
// ── What they say ───────────────────────────────────────────────────────────
//
// The encoder's choices, nothing more: I and P only, one reference used per
// picture (the others kept, so a repair after a loss can reach back to them),
// POC = decode order, no reordering (the B8 lesson: bitstream_restriction on
// H.264), BT.709 limited range — the converter's output — declared in the VUI.
//
// Every function returns one NAL unit in Annex-B form: a four-byte start code,
// the NAL header, the RBSP with emulation prevention and its trailing bits.
// Pure bytes, no driver: testable anywhere.

namespace mw::native::encode::paramsets {

namespace detail {

using h264vui_detail::BitWriter;

inline void se(BitWriter& w, int32_t v)
{
    w.ue(v > 0 ? static_cast<uint32_t>(2 * v - 1) : static_cast<uint32_t>(-2 * v));
}

/// rbsp_trailing_bits(): a one, then zeros to the byte.
inline void trailing(BitWriter& w)
{
    w.u(1, 1);
    while (w.used != 8)
        w.u(1, 0);
}

inline std::vector<uint8_t> nal(std::initializer_list<uint8_t> header, BitWriter& w)
{
    trailing(w);
    std::vector<uint8_t> out = {0, 0, 0, 1};
    out.insert(out.end(), header.begin(), header.end());
    h264vui_detail::escapeInto(w.bytes, out);
    return out;
}

/// BT.709, limited range: what GlConvert and every other converter here write.
inline void bt709Limited(BitWriter& w)
{
    w.u(1, 1); // video_signal_type_present_flag
    w.u(3, 5); // video_format: unspecified
    w.u(1, 0); // video_full_range_flag
    w.u(1, 1); // colour_description_present_flag
    w.u(8, 1); // colour_primaries: BT.709
    w.u(8, 1); // transfer_characteristics: BT.709
    w.u(8, 1); // matrix_coefficients: BT.709
}

} // namespace detail

// ── H.264 ───────────────────────────────────────────────────────────────────

struct H264Sequence
{
    int profileIdc = 100; ///< 66 Constrained Baseline, 77 Main, 100 High
    int levelIdc = 51;
    uint32_t widthMbs = 0;
    uint32_t heightMbs = 0;
    /// The crop, in the frame_crop_*_offset unit: two luma samples in 4:2:0.
    uint32_t cropRight = 0;
    uint32_t cropBottom = 0;
    uint32_t maxRefFrames = 1;
    /// log2_max_frame_num: frame_num is this many bits wide.
    int log2MaxFrameNum = 16;
    int fps = 60;
    /// CABAC and the 8×8 transform, above Baseline: what VA-API has always
    /// streamed. A D3D12 driver without one says so (H264EncodeNegotiation),
    /// and its PPS must then say it too.
    bool cabac = true;
    bool transform8x8 = true;
};

inline std::vector<uint8_t> h264Sps(const H264Sequence& s)
{
    detail::BitWriter w;
    w.u(8, static_cast<uint32_t>(s.profileIdc));
    // Constrained Baseline is Baseline with constraint_set0 and 1: the only
    // Baseline a browser decodes.
    w.u(8, s.profileIdc == 66 ? 0xC0 : 0x00); // constraint flags + reserved_zero_2bits
    w.u(8, static_cast<uint32_t>(s.levelIdc));
    w.ue(0); // seq_parameter_set_id
    if (s.profileIdc == 100) {
        w.ue(1);   // chroma_format_idc: 4:2:0
        w.ue(0);   // bit_depth_luma_minus8
        w.ue(0);   // bit_depth_chroma_minus8
        w.u(1, 0); // qpprime_y_zero_transform_bypass_flag
        w.u(1, 0); // seq_scaling_matrix_present_flag
    }
    w.ue(static_cast<uint32_t>(s.log2MaxFrameNum - 4));
    // POC type 2: output order IS decode order — no B-frames, nothing to count.
    w.ue(2);
    w.ue(s.maxRefFrames);
    w.u(1, 0); // gaps_in_frame_num_value_allowed_flag
    w.ue(s.widthMbs - 1);
    w.ue(s.heightMbs - 1);
    w.u(1, 1); // frame_mbs_only_flag
    w.u(1, 1); // direct_8x8_inference_flag
    const bool crop = s.cropRight || s.cropBottom;
    w.u(1, crop ? 1 : 0);
    if (crop) {
        w.ue(0);
        w.ue(s.cropRight);
        w.ue(0);
        w.ue(s.cropBottom);
    }

    w.u(1, 1); // vui_parameters_present_flag
    w.u(1, 0); // aspect_ratio_info_present_flag
    w.u(1, 0); // overscan_info_present_flag
    detail::bt709Limited(w);
    w.u(1, 0);  // chroma_loc_info_present_flag
    w.u(1, 1);  // timing_info_present_flag — the tick counts fields, hence ×2
    w.u(32, 1); // num_units_in_tick
    w.u(32, static_cast<uint32_t>(s.fps) * 2);
    w.u(1, 0); // fixed_frame_rate_flag
    w.u(1, 0); // nal_hrd_parameters_present_flag
    w.u(1, 0); // vcl_hrd_parameters_present_flag
    w.u(1, 0); // pic_struct_present_flag
    // bitstream_restriction — the B8 lesson: without it a hardware decoder
    // holds a DPB's worth of frames on a stream that reorders none.
    w.u(1, 1);
    w.u(1, 1); // motion_vectors_over_pic_boundaries_flag
    w.ue(2);   // max_bytes_per_pic_denom (the default)
    w.ue(1);   // max_bits_per_mb_denom (the default)
    w.ue(15);  // log2_max_mv_length_horizontal
    w.ue(15);  // log2_max_mv_length_vertical
    w.ue(0);   // max_num_reorder_frames
    w.ue(s.maxRefFrames);
    return detail::nal({0x67}, w); // nal_ref_idc 3, type 7
}

inline std::vector<uint8_t> h264Pps(const H264Sequence& s)
{
    detail::BitWriter w;
    w.ue(0);                                       // pic_parameter_set_id
    w.ue(0);                                       // seq_parameter_set_id
    w.u(1, s.profileIdc != 66 && s.cabac ? 1 : 0); // entropy_coding_mode_flag: CABAC above Baseline
    w.u(1, 0);                                     // bottom_field_pic_order_in_frame_present_flag
    w.ue(0);                                       // num_slice_groups_minus1
    w.ue(0);          // num_ref_idx_l0_default_active_minus1: one reference per picture
    w.ue(0);          // num_ref_idx_l1_default_active_minus1
    w.u(1, 0);        // weighted_pred_flag
    w.u(2, 0);        // weighted_bipred_idc
    detail::se(w, 0); // pic_init_qp_minus26 — the parameter buffer's 26
    detail::se(w, 0); // pic_init_qs_minus26
    detail::se(w, 0); // chroma_qp_index_offset
    w.u(1, 1);        // deblocking_filter_control_present_flag
    w.u(1, 0);        // constrained_intra_pred_flag
    w.u(1, 0);        // redundant_pic_cnt_present_flag
    if (s.profileIdc == 100) {
        w.u(1, s.transform8x8 ? 1 : 0); // transform_8x8_mode_flag
        w.u(1, 0);                      // pic_scaling_matrix_present_flag
        detail::se(w, 0);               // second_chroma_qp_index_offset
    }
    return detail::nal({0x68}, w);
}

struct H264Slice
{
    bool idr = false;
    uint32_t frameNum = 0;
    uint32_t idrPicId = 0;
    /// The frame_num of the picture this one predicts from. Ignored on an IDR.
    uint32_t referenceFrameNum = 0;
};

/// The slice header, up to and including the deblocking fields.
///
/// A P picture predicts from the newest short-term picture by default. When it
/// must reach further back — the frames after the reference were lost — the
/// header reorders the list so the chosen one comes first
/// (ref_pic_list_modification, subtracting from the current picture number).
inline std::vector<uint8_t> h264SliceHeader(const H264Sequence& s, const H264Slice& slice)
{
    const uint32_t frameNumMask = (1u << s.log2MaxFrameNum) - 1u;
    detail::BitWriter w;
    w.ue(0);                 // first_mb_in_slice
    w.ue(slice.idr ? 7 : 5); // slice_type, every slice of the picture alike
    w.ue(0);                 // pic_parameter_set_id
    w.u(s.log2MaxFrameNum, slice.frameNum & frameNumMask);
    if (slice.idr) w.ue(slice.idrPicId & 0xFFFF);
    // POC type 2: no pic_order_cnt_lsb.
    if (!slice.idr) {
        w.u(1, 0); // num_ref_idx_active_override_flag
        const uint32_t distance = (slice.frameNum - slice.referenceFrameNum) & frameNumMask;
        const bool reorder = distance != 1;
        w.u(1, reorder ? 1 : 0); // ref_pic_list_modification_flag_l0
        if (reorder) {
            w.ue(0);            // modification_of_pic_nums_idc: subtract
            w.ue(distance - 1); // abs_diff_pic_num_minus1
            w.ue(3);            // end of the list
        }
    }
    // dec_ref_pic_marking: every picture is a reference.
    if (slice.idr) {
        w.u(1, 0); // no_output_of_prior_pics_flag
        w.u(1, 0); // long_term_reference_flag
    } else {
        w.u(1, 0); // adaptive_ref_pic_marking_mode_flag: the sliding window
    }
    if (!slice.idr && s.profileIdc != 66 && s.cabac) w.ue(0); // cabac_init_idc
    detail::se(w, 0);                                         // slice_qp_delta
    w.ue(0);                                                  // disable_deblocking_filter_idc
    detail::se(w, 0);                                         // slice_alpha_c0_offset_div2
    detail::se(w, 0);                                         // slice_beta_offset_div2
    return detail::nal({static_cast<uint8_t>(slice.idr ? 0x65 : 0x41)}, w);
}

// ── HEVC ────────────────────────────────────────────────────────────────────

/// Whose slices the parameter sets describe.
///
/// MesaVaapi: Mesa's VA-API frontend, which re-writes every header from what
/// it parsed (see the top of this file). The bytes the Linux hosts send; frozen
/// by the golden tests of test_parameter_sets.cpp.
///
/// D3d12: a D3D12 Video Encode driver, which writes the slices and leaves the
/// parameter sets to the application — and nothing checks that the two agree.
/// A PPS that says cabac_init_present_flag = 0 over slices coded with it set
/// decodes as noise, with no error from anybody. So this dialect says what a
/// D3D12 driver's slices assume, which the API fixes for everything it does not
/// let the caller choose: no tiles, no weighted prediction, no scaling lists,
/// no temporal MVP, no short-term sets in the SPS (each slice header carries
/// its own), and cabac_init, per-slice chroma QP offsets, CU-level QP deltas
/// and deblocking control present. What the caller did choose — block sizes,
/// AMP, SAO, long-term references — comes from the configuration the encoder
/// was created with. Checked with ffmpeg over the Arc's slices (21/09/2026) and
/// over the three GPUs of DualRTX (26/09/2026), once the coded size is a whole
/// number of coding tree blocks: the three code every CTB whole, whatever size
/// their support query accepted. Over an SPS that ends inside them — 1080
/// lines, 1440 over CTBs of 64, 3440 columns — every picture decodes wrong
/// from there on, and ffmpeg flags only a few (27/09/2026): its error count is
/// no proof, the pixels are (the lab's encode probe, --dump-input).
enum class HevcDialect
{
    MesaVaapi,
    D3d12,
};

struct HevcSequence
{
    /// The picture as shown.
    uint32_t width = 0;
    uint32_t height = 0;
    /// The picture as coded — a whole number of the blocks the encoder works
    /// in (D3D12: its coding tree blocks). The difference goes in the
    /// conformance window, in chroma samples.
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    int levelIdc = 153; ///< 30 × the level number: 153 = 5.1
    /// sps_max_dec_pic_buffering_minus1: the pictures kept for reference.
    uint32_t maxReferences = 1;
    int log2MaxPocLsb = 16;
    int fps = 60;

    HevcDialect dialect = HevcDialect::MesaVaapi;

    // The D3D12 dialect's own: the configuration the encoder was created with.
    // Unread by MesaVaapi, whose geometry is its sequence buffer's.
    bool tenBit = false; ///< Main 10, 10-bit samples
    bool hdr = false;    ///< BT.2020 + PQ in the VUI; BT.709 otherwise. Limited range.
    int log2MinCodingBlock = 3;
    int log2MaxCodingBlock = 6;
    int log2MinTransformBlock = 2;
    int log2MaxTransformBlock = 5;
    int transformDepthInter = 2;
    int transformDepthIntra = 2;
    bool asymmetricMotionPartitions = false;
    bool sampleAdaptiveOffset = false;
    bool longTermReferences = false; ///< also turns on lists_modification_present_flag
    bool transformSkip = false;
    bool constrainedIntraPrediction = false;
    bool loopFilterAcrossSlices = true;
    uint32_t defaultActiveReferences = 1;
};

namespace detail {

inline void profileTierLevel(BitWriter& w, int levelIdc)
{
    w.u(2, 0);           // general_profile_space
    w.u(1, 0);           // general_tier_flag: Main tier
    w.u(5, 1);           // general_profile_idc: Main
    w.u(32, 0x60000000); // compatible with Main (1) and Main 10 (2)
    w.u(1, 1);           // general_progressive_source_flag
    w.u(1, 0);           // general_interlaced_source_flag
    w.u(1, 0);           // general_non_packed_constraint_flag
    w.u(1, 1);           // general_frame_only_constraint_flag
    w.u(32, 0);          // general_reserved_zero_43bits + general_inbld_flag…
    w.u(12, 0);          // …44 bits in all
    w.u(8, static_cast<uint32_t>(levelIdc));
}

// ── The D3D12 dialect ──
//
// The writer of the first D3D12 attempt (HevcParamSets, 84524e7f^), ported bit
// for bit: its bytes went ahead of the Arc's slices on 21/09 and of the three
// GPUs' on 26/09, and ffmpeg decoded them all without an error. They are the
// goldens of test_parameter_sets.cpp — change one bit, run the lab's encode
// probe on the three GPUs again.

/// profile_tier_level(1, 0): the general part only, there are no sub-layers.
inline void d3d12ProfileTierLevel(BitWriter& w, const HevcSequence& s)
{
    const uint32_t profile = s.tenBit ? 2 : 1; // Main 10 : Main
    w.u(2, 0);                                 // general_profile_space
    w.u(1, 0);                                 // general_tier_flag: Main tier
    w.u(5, profile);
    // A Main stream is also a conforming Main 10 stream, and says so.
    w.u(32, profile == 1 ? 0x60000000 : 0x20000000); // general_profile_compatibility_flag[32]
    w.u(1, 1);                                       // general_progressive_source_flag
    w.u(1, 0);                                       // general_interlaced_source_flag
    w.u(1, 1);                                       // general_non_packed_constraint_flag
    w.u(1, 1);                                       // general_frame_only_constraint_flag
    w.u(32, 0); // general_reserved_zero_43bits + general_inbld_flag…
    w.u(12, 0); // …44 bits in all
    w.u(8, static_cast<uint32_t>(s.levelIdc));
}

/// One ordering triple for every sub-layer — no reordering, which is what
/// spares the viewer's decoder a DPB of delay.
inline void d3d12OrderingInfo(BitWriter& w, const HevcSequence& s)
{
    w.u(1, 0);             // *_sub_layer_ordering_info_present_flag
    w.ue(s.maxReferences); // *_max_dec_pic_buffering_minus1
    w.ue(0);               // *_max_num_reorder_pics
    w.ue(0);               // *_max_latency_increase_plus1: no limit expressed
}

inline void d3d12Vui(BitWriter& w, const HevcSequence& s)
{
    w.u(1, 0);              // aspect_ratio_info_present_flag
    w.u(1, 0);              // overscan_info_present_flag
    w.u(1, 1);              // video_signal_type_present_flag
    w.u(3, 5);              // video_format: unspecified
    w.u(1, 0);              // video_full_range_flag: limited, as the conversion writes
    w.u(1, 1);              // colour_description_present_flag
    w.u(8, s.hdr ? 9 : 1);  // colour_primaries: BT.2020 : BT.709
    w.u(8, s.hdr ? 16 : 1); // transfer_characteristics: SMPTE 2084 (PQ) : BT.709
    w.u(8, s.hdr ? 9 : 1);  // matrix_coefficients: BT.2020 NCL : BT.709
    w.u(1, 0);              // chroma_loc_info_present_flag
    w.u(1, 0);              // neutral_chroma_indication_flag
    w.u(1, 0);              // field_seq_flag
    w.u(1, 0);              // frame_field_info_present_flag
    w.u(1, 0);              // default_display_window_flag
    w.u(1, 0);              // vui_timing_info_present_flag
    w.u(1, 0);              // bitstream_restriction_flag
}

inline std::vector<uint8_t> d3d12Vps(const HevcSequence& s)
{
    BitWriter w;
    w.u(4, 0);       // vps_video_parameter_set_id
    w.u(1, 1);       // vps_base_layer_internal_flag
    w.u(1, 1);       // vps_base_layer_available_flag
    w.u(6, 0);       // vps_max_layers_minus1
    w.u(3, 0);       // vps_max_sub_layers_minus1
    w.u(1, 1);       // vps_temporal_id_nesting_flag
    w.u(16, 0xFFFF); // vps_reserved_0xffff_16bits
    d3d12ProfileTierLevel(w, s);
    d3d12OrderingInfo(w, s);
    w.u(6, 0); // vps_max_layer_id
    w.ue(0);   // vps_num_layer_sets_minus1
    w.u(1, 0); // vps_timing_info_present_flag
    w.u(1, 0); // vps_extension_flag
    return nal({0x40, 0x01}, w);
}

inline std::vector<uint8_t> d3d12Sps(const HevcSequence& s)
{
    BitWriter w;
    w.u(4, 0); // sps_video_parameter_set_id
    w.u(3, 0); // sps_max_sub_layers_minus1
    w.u(1, 1); // sps_temporal_id_nesting_flag
    d3d12ProfileTierLevel(w, s);
    w.ue(0); // sps_seq_parameter_set_id
    w.ue(1); // chroma_format_idc: 4:2:0
    w.ue(s.codedWidth);
    w.ue(s.codedHeight);
    const uint32_t right = (s.codedWidth - s.width) / 2;
    const uint32_t bottom = (s.codedHeight - s.height) / 2;
    const bool window = right || bottom;
    w.u(1, window ? 1 : 0); // conformance_window_flag
    if (window) {
        w.ue(0);
        w.ue(right);
        w.ue(0);
        w.ue(bottom);
    }
    w.ue(s.tenBit ? 2 : 0); // bit_depth_luma_minus8
    w.ue(s.tenBit ? 2 : 0); // bit_depth_chroma_minus8
    w.ue(static_cast<uint32_t>(s.log2MaxPocLsb - 4));
    d3d12OrderingInfo(w, s);
    w.ue(static_cast<uint32_t>(s.log2MinCodingBlock - 3));
    w.ue(static_cast<uint32_t>(s.log2MaxCodingBlock - s.log2MinCodingBlock));
    w.ue(static_cast<uint32_t>(s.log2MinTransformBlock - 2));
    w.ue(static_cast<uint32_t>(s.log2MaxTransformBlock - s.log2MinTransformBlock));
    w.ue(static_cast<uint32_t>(s.transformDepthInter));
    w.ue(static_cast<uint32_t>(s.transformDepthIntra));
    w.u(1, 0); // scaling_list_enabled_flag
    w.u(1, s.asymmetricMotionPartitions ? 1 : 0);
    w.u(1, s.sampleAdaptiveOffset ? 1 : 0);
    w.u(1, 0); // pcm_enabled_flag
    w.ue(0);   // num_short_term_ref_pic_sets: every slice header carries its own
    w.u(1, s.longTermReferences ? 1 : 0);
    if (s.longTermReferences) w.ue(0); // num_long_term_ref_pics_sps: slice headers again
    w.u(1, 0);                         // sps_temporal_mvp_enabled_flag
    w.u(1, 0);                         // strong_intra_smoothing_enabled_flag
    w.u(1, 1);                         // vui_parameters_present_flag
    d3d12Vui(w, s);
    w.u(1, 0); // sps_extension_present_flag
    return nal({0x42, 0x01}, w);
}

inline std::vector<uint8_t> d3d12Pps(const HevcSequence& s)
{
    BitWriter w;
    w.ue(0);                             // pps_pic_parameter_set_id
    w.ue(0);                             // pps_seq_parameter_set_id
    w.u(1, 0);                           // dependent_slice_segments_enabled_flag
    w.u(1, 0);                           // output_flag_present_flag
    w.u(3, 0);                           // num_extra_slice_header_bits
    w.u(1, 0);                           // sign_data_hiding_enabled_flag
    w.u(1, 1);                           // cabac_init_present_flag
    w.ue(s.defaultActiveReferences - 1); // num_ref_idx_l0_default_active_minus1
    // One in L1 too: the Arc codes its P pictures as B, with L1 = L0.
    w.ue(0);  // num_ref_idx_l1_default_active_minus1
    se(w, 0); // init_qp_minus26
    w.u(1, s.constrainedIntraPrediction ? 1 : 0);
    w.u(1, s.transformSkip ? 1 : 0);
    w.u(1, 1); // cu_qp_delta_enabled_flag: rate control moves the QP inside a picture
    w.ue(0);   // diff_cu_qp_delta_depth
    se(w, 0);  // pps_cb_qp_offset
    se(w, 0);  // pps_cr_qp_offset
    w.u(1, 1); // pps_slice_chroma_qp_offsets_present_flag
    w.u(1, 0); // weighted_pred_flag
    w.u(1, 0); // weighted_bipred_flag
    w.u(1, 0); // transquant_bypass_enabled_flag
    w.u(1, 0); // tiles_enabled_flag
    w.u(1, 0); // entropy_coding_sync_enabled_flag
    w.u(1, s.loopFilterAcrossSlices ? 1 : 0);
    w.u(1, 1);                            // deblocking_filter_control_present_flag
    w.u(1, 0);                            //   deblocking_filter_override_enabled_flag
    w.u(1, 0);                            //   pps_deblocking_filter_disabled_flag
    se(w, 0);                             //   pps_beta_offset_div2
    se(w, 0);                             //   pps_tc_offset_div2
    w.u(1, 0);                            // pps_scaling_list_data_present_flag
    w.u(1, s.longTermReferences ? 1 : 0); // lists_modification_present_flag
    w.ue(0);                              // log2_parallel_merge_level_minus2
    w.u(1, 0);                            // slice_segment_header_extension_present_flag
    w.u(1, 0);                            // pps_extension_present_flag
    return nal({0x44, 0x01}, w);
}

} // namespace detail

inline std::vector<uint8_t> hevcVps(const HevcSequence& s)
{
    if (s.dialect == HevcDialect::D3d12) return detail::d3d12Vps(s);
    detail::BitWriter w;
    w.u(4, 0);       // vps_video_parameter_set_id
    w.u(1, 1);       // vps_base_layer_internal_flag
    w.u(1, 1);       // vps_base_layer_available_flag
    w.u(6, 0);       // vps_max_layers_minus1
    w.u(3, 0);       // vps_max_sub_layers_minus1
    w.u(1, 1);       // vps_temporal_id_nesting_flag
    w.u(16, 0xFFFF); // vps_reserved_0xffff_16bits
    detail::profileTierLevel(w, s.levelIdc);
    w.u(1, 1); // vps_sub_layer_ordering_info_present_flag
    w.ue(s.maxReferences);
    w.ue(0);   // vps_max_num_reorder_pics
    w.ue(0);   // vps_max_latency_increase_plus1
    w.u(6, 0); // vps_max_layer_id
    w.ue(0);   // vps_num_layer_sets_minus1
    w.u(1, 0); // vps_timing_info_present_flag
    w.u(1, 0); // vps_extension_flag
    return detail::nal({0x40, 0x01}, w);
}

inline std::vector<uint8_t> hevcSps(const HevcSequence& s)
{
    if (s.dialect == HevcDialect::D3d12) return detail::d3d12Sps(s);
    detail::BitWriter w;
    w.u(4, 0); // sps_video_parameter_set_id
    w.u(3, 0); // sps_max_sub_layers_minus1
    w.u(1, 1); // sps_temporal_id_nesting_flag
    detail::profileTierLevel(w, s.levelIdc);
    w.ue(0); // sps_seq_parameter_set_id
    w.ue(1); // chroma_format_idc: 4:2:0
    w.ue(s.codedWidth);
    w.ue(s.codedHeight);
    const uint32_t right = (s.codedWidth - s.width) / 2;
    const uint32_t bottom = (s.codedHeight - s.height) / 2;
    const bool window = right || bottom;
    w.u(1, window ? 1 : 0); // conformance_window_flag
    if (window) {
        w.ue(0);
        w.ue(right);
        w.ue(0);
        w.ue(bottom);
    }
    w.ue(0); // bit_depth_luma_minus8
    w.ue(0); // bit_depth_chroma_minus8
    w.ue(static_cast<uint32_t>(s.log2MaxPocLsb - 4));
    w.u(1, 1);             // sps_sub_layer_ordering_info_present_flag
    w.ue(s.maxReferences); // sps_max_dec_pic_buffering_minus1
    w.ue(0);               // sps_max_num_reorder_pics — the whole point
    w.ue(0);               // sps_max_latency_increase_plus1
    // The block geometry of the sequence parameter buffer: CTB 64, min CB 8.
    w.ue(0);   // log2_min_luma_coding_block_size_minus3
    w.ue(3);   // log2_diff_max_min_luma_coding_block_size
    w.ue(0);   // log2_min_luma_transform_block_size_minus2
    w.ue(3);   // log2_diff_max_min_luma_transform_block_size
    w.ue(2);   // max_transform_hierarchy_depth_inter
    w.ue(2);   // max_transform_hierarchy_depth_intra
    w.u(1, 0); // scaling_list_enabled_flag
    w.u(1, 1); // amp_enabled_flag
    w.u(1, 1); // sample_adaptive_offset_enabled_flag
    w.u(1, 0); // pcm_enabled_flag
    w.ue(0);   // num_short_term_ref_pic_sets: each slice carries its own
    w.u(1, 0); // long_term_ref_pics_present_flag
    w.u(1, 0); // sps_temporal_mvp_enabled_flag
    w.u(1, 1); // strong_intra_smoothing_enabled_flag

    w.u(1, 1); // vui_parameters_present_flag
    w.u(1, 0); // aspect_ratio_info_present_flag
    w.u(1, 0); // overscan_info_present_flag
    detail::bt709Limited(w);
    w.u(1, 0);  // chroma_loc_info_present_flag
    w.u(1, 0);  // neutral_chroma_indication_flag
    w.u(1, 0);  // field_seq_flag
    w.u(1, 0);  // frame_field_info_present_flag
    w.u(1, 0);  // default_display_window_flag
    w.u(1, 1);  // vui_timing_info_present_flag — a tick is a frame here
    w.u(32, 1); // vui_num_units_in_tick
    w.u(32, static_cast<uint32_t>(s.fps));
    w.u(1, 0); // vui_poc_proportional_to_timing_flag
    w.u(1, 0); // vui_hrd_parameters_present_flag
    w.u(1, 1); // bitstream_restriction_flag
    w.u(1, 0); // tiles_fixed_structure_flag
    w.u(1, 1); // motion_vectors_over_pic_boundaries_flag
    w.u(1, 1); // restricted_ref_pic_lists_flag
    w.ue(0);   // min_spatial_segmentation_idc
    w.ue(2);   // max_bytes_per_pic_denom
    w.ue(1);   // max_bits_per_min_cu_denom
    w.ue(15);  // log2_max_mv_length_horizontal
    w.ue(15);  // log2_max_mv_length_vertical
    w.u(1, 0); // sps_extension_present_flag
    return detail::nal({0x42, 0x01}, w);
}

inline std::vector<uint8_t> hevcPps(const HevcSequence& s)
{
    if (s.dialect == HevcDialect::D3d12) return detail::d3d12Pps(s);
    detail::BitWriter w;
    w.ue(0);          // pps_pic_parameter_set_id
    w.ue(0);          // pps_seq_parameter_set_id
    w.u(1, 0);        // dependent_slice_segments_enabled_flag
    w.u(1, 0);        // output_flag_present_flag
    w.u(3, 0);        // num_extra_slice_header_bits
    w.u(1, 0);        // sign_data_hiding_enabled_flag
    w.u(1, 0);        // cabac_init_present_flag
    w.ue(0);          // num_ref_idx_l0_default_active_minus1: one reference per picture
    w.ue(0);          // num_ref_idx_l1_default_active_minus1
    detail::se(w, 0); // init_qp_minus26
    w.u(1, 0);        // constrained_intra_pred_flag
    w.u(1, 0);        // transform_skip_enabled_flag
    w.u(1, 1);        // cu_qp_delta_enabled_flag — what the picture buffer asks for
    w.ue(0);          // diff_cu_qp_delta_depth
    detail::se(w, 0); // pps_cb_qp_offset
    detail::se(w, 0); // pps_cr_qp_offset
    w.u(1, 0);        // pps_slice_chroma_qp_offsets_present_flag
    w.u(1, 0);        // weighted_pred_flag
    w.u(1, 0);        // weighted_bipred_flag
    w.u(1, 0);        // transquant_bypass_enabled_flag
    w.u(1, 0);        // tiles_enabled_flag
    w.u(1, 0);        // entropy_coding_sync_enabled_flag
    w.u(1, 0);        // pps_loop_filter_across_slices_enabled_flag: one slice
    w.u(1, 0);        // deblocking_filter_control_present_flag: the default filter
    w.u(1, 0);        // pps_scaling_list_data_present_flag
    w.u(1, 0);        // lists_modification_present_flag
    w.ue(0);          // log2_parallel_merge_level_minus2
    w.u(1, 0);        // slice_segment_header_extension_present_flag
    w.u(1, 0);        // pps_extension_present_flag
    return detail::nal({0x44, 0x01}, w);
}

struct HevcSlice
{
    bool idr = false;
    /// The picture order count of this picture: its number since the IDR.
    uint32_t poc = 0;
    /// Every picture still held for reference, by POC, the one used included.
    std::vector<uint32_t> kept;
    /// The one this picture predicts from — must be among `kept`.
    uint32_t referencePoc = 0;
};

/// The slice segment header of a picture's only slice, in the MesaVaapi dialect
/// — a D3D12 driver writes its slices itself.
///
/// HEVC keeps in the decoder only the pictures the reference picture set
/// lists: one left out is gone for good. So every picture still held is
/// listed — the one predicted from marked "used", the others kept for a repair
/// that may need to reach back to them after a loss.
inline std::vector<uint8_t> hevcSliceHeader(const HevcSequence& s, const HevcSlice& slice)
{
    detail::BitWriter w;
    w.u(1, 1);                // first_slice_segment_in_pic_flag
    if (slice.idr) w.u(1, 0); // no_output_of_prior_pics_flag
    w.ue(0);                  // slice_pic_parameter_set_id
    w.ue(slice.idr ? 2 : 1);  // slice_type: I or P
    if (!slice.idr) {
        w.u(s.log2MaxPocLsb, slice.poc & ((1u << s.log2MaxPocLsb) - 1u));
        w.u(1, 0); // short_term_ref_pic_set_sps_flag: the set follows

        std::vector<uint32_t> before;
        for (uint32_t poc : slice.kept)
            if (poc < slice.poc) before.push_back(poc);
        std::sort(before.begin(), before.end(), [](uint32_t a, uint32_t b) { return a > b; });

        // st_ref_pic_set(num_short_term_ref_pic_sets = 0): no prediction from
        // another set, since there is none.
        w.ue(static_cast<uint32_t>(before.size())); // num_negative_pics
        w.ue(0);                                    // num_positive_pics
        uint32_t previous = slice.poc;
        for (uint32_t poc : before) {
            w.ue(previous - poc - 1);                  // delta_poc_s0_minus1
            w.u(1, poc == slice.referencePoc ? 1 : 0); // used_by_curr_pic_s0_flag
            previous = poc;
        }
    }
    w.u(1, 1); // slice_sao_luma_flag
    w.u(1, 1); // slice_sao_chroma_flag
    if (!slice.idr) {
        w.u(1, 0); // num_ref_idx_active_override_flag
        w.ue(0);   // five_minus_max_num_merge_cand
    }
    detail::se(w, 0);                        // slice_qp_delta
    const uint8_t type = slice.idr ? 19 : 1; // IDR_W_RADL, TRAIL_R
    return detail::nal({static_cast<uint8_t>(type << 1), 0x01}, w);
}

} // namespace mw::native::encode::paramsets
