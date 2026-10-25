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

#include "encode/Av1EncodeNegotiation.h"
#include "encode/H264EncodeNegotiation.h"
#include "encode/HevcEncodeNegotiation.h"

#include <d3d12video.h>
#include <wrl/client.h>

namespace mw::native::encode {

/// The questions HevcEncodeNegotiation asks, put to a D3D12 video device.
///
/// Every answer D3D12 types as a BOOL is read as "not zero": the Intel driver
/// says 128 where the others say 1 (26/09/2026). The structures an answer was
/// given for are built here too, by the same functions the encoder uses to
/// create itself — what was asked is what gets created.
class VideoEncodeCaps12 : public HevcDriverQueries
{
public:
    explicit VideoEncodeCaps12(ID3D12VideoDevice3* video);

    HevcDriverLimits limits(bool tenBit) override;
    HevcBlocksAnswer blocks(const HevcBlocks& blocks, bool tenBit) override;
    HevcSupportAnswer support(const HevcSupportQuestion& question) override;

    /// The level the driver suggested in its last "yes" to support().
    D3D12_VIDEO_ENCODER_LEVEL_TIER_CONSTRAINTS_HEVC suggestedLevel() const { return m_Level; }

    static D3D12_VIDEO_ENCODER_PROFILE_HEVC profile(bool tenBit);
    static D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_HEVC
    configuration(const HevcBlocks& blocks, const HevcBlocksAnswer& flags);
    /// 30 × the level: D3D12's enumeration in the SPS's terms.
    static int levelIdc(D3D12_VIDEO_ENCODER_LEVELS_HEVC level);

    /// The rate control of @p rate at @p fps, at a nominal bitrate (the answer
    /// does not depend on it): the structures D3D12 points to, kept together.
    /// AV1's quantizer is a qindex, 0 to 255, where H.264's and HEVC's QP runs
    /// to 51: @p av1 puts the same bounds on that scale.
    struct RateControl
    {
        D3D12_VIDEO_ENCODER_RATE_CONTROL desc = {};
        D3D12_VIDEO_ENCODER_RATE_CONTROL_CBR cbr = {};
        D3D12_VIDEO_ENCODER_RATE_CONTROL_CBR1 cbr1 = {};
        D3D12_VIDEO_ENCODER_RATE_CONTROL_CQP cqp = {};
        D3D12_VIDEO_ENCODER_RATE_CONTROL_CQP1 cqp1 = {};

        RateControl(const HevcRate& rate, int fps, uint32_t bitsPerSecond, bool av1 = false);
        RateControl(const RateControl&) = delete;
        RateControl& operator=(const RateControl&) = delete;

        /// A new CBR target; the VBV by the rule every encoder follows
        /// (RateControl.h), or @p vbvFrames frames' worth when the bench asks.
        void setBitrate(uint32_t bitsPerSecond, int fps, int vbvFrames);
        /// A new constant QP, for every kind of picture: which one a driver
        /// reads for its P pictures is its own business (the Arc codes them
        /// as low-delay B).
        void setQp(UINT qp);
    };

private:
    Microsoft::WRL::ComPtr<ID3D12VideoDevice3> m_Video;
    D3D12_VIDEO_ENCODER_LEVEL_TIER_CONSTRAINTS_HEVC m_Level = {};
};

/// The questions H264EncodeNegotiation asks, put to a D3D12 video device
/// (plan C9.1): VideoEncodeCaps12's, in H.264. The support answer's level is
/// level_idc here (tenths of a level), not HEVC's thirtieths.
class VideoEncodeCapsH264 : public H264DriverQueries
{
public:
    explicit VideoEncodeCapsH264(ID3D12VideoDevice3* video);

    H264DriverLimits limits() override;
    H264ConfigAnswer configuration() override;
    HevcSupportAnswer support(const H264SupportQuestion& question) override;

    /// The level the driver suggested in its last "yes" to support().
    D3D12_VIDEO_ENCODER_LEVELS_H264 suggestedLevel() const { return m_Level; }

    static D3D12_VIDEO_ENCODER_PROFILE_H264 profile()
    {
        return D3D12_VIDEO_ENCODER_PROFILE_H264_HIGH;
    }
    static D3D12_VIDEO_ENCODER_CODEC_CONFIGURATION_H264 codecConfiguration(bool cabac,
                                                                           bool transform8x8);
    /// The encoder's GOP: endless, P only, POC type 2, frame_num 16 bits wide
    /// — the SPS's (ParameterSets.h).
    static D3D12_VIDEO_ENCODER_SEQUENCE_GOP_STRUCTURE_H264 gop();
    /// level_idc: D3D12's enumeration in the SPS's terms (9 for 1b).
    static int levelIdc(D3D12_VIDEO_ENCODER_LEVELS_H264 level);

private:
    Microsoft::WRL::ComPtr<ID3D12VideoDevice3> m_Video;
    D3D12_VIDEO_ENCODER_LEVELS_H264 m_Level = D3D12_VIDEO_ENCODER_LEVELS_H264_51;
};

/// The questions Av1EncodeNegotiation asks, put to a D3D12 video device
/// (plan C9.2). The support answer's suggested level is seq_level_idx, which
/// D3D12's enumeration is.
class VideoEncodeCapsAv1 : public Av1DriverQueries
{
public:
    explicit VideoEncodeCapsAv1(ID3D12VideoDevice3* video);

    Av1DriverLimits limits(bool tenBit) override;
    Av1ConfigAnswer configuration() override;
    HevcSupportAnswer support(const Av1SupportQuestion& question) override;

    static D3D12_VIDEO_ENCODER_AV1_PROFILE profile()
    {
        return D3D12_VIDEO_ENCODER_AV1_PROFILE_MAIN;
    }
    static D3D12_VIDEO_ENCODER_AV1_CODEC_CONFIGURATION codecConfiguration(uint32_t features,
                                                                          int orderHintBits);
    /// Key frames on demand, no B frames.
    static D3D12_VIDEO_ENCODER_AV1_SEQUENCE_STRUCTURE sequence() { return {0, 1}; }

private:
    Microsoft::WRL::ComPtr<ID3D12VideoDevice3> m_Video;
};

} // namespace mw::native::encode
