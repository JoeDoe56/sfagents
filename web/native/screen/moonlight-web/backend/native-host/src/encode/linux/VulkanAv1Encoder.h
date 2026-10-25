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

#include "../Av1Obu.h"
#include "../EncoderOutput.h"
#include "../HevcDpb.h"
#include "../IntraRefreshSweep.h"
#include "VulkanHevcEncoder.h"
#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// AV1 through Vulkan Video (plan pipeline-video-d3d12-v2, C13.12): the HEVC
// encoder's twin (VulkanHevcEncoder.h), on the same device as the Vulkan
// conversion, for the one Linux chain that can carry AV1 at all — Mesa's
// VA-API lists the profile and describes no encoder (LinuxProbe.cpp).
//
// ── One picture ─────────────────────────────────────────────────────────────
//
// As in HEVC: the conversion writes the encoder's NV12 input in place, one
// command buffer on the encode queue waits for it on the GPU, encodes, and the
// CPU waits for that alone.
//
// ── The headers ─────────────────────────────────────────────────────────────
//
// The driver writes the frame header and the tiles; the sequence header is
// ours as a StdVideo structure, its bytes the driver's
// (vkGetEncodedVideoSessionParametersKHR). In front of every picture a
// temporal delimiter, and in front of a key frame the sequence header — laid
// in the bitstream buffer right before what the driver wrote, so a picture
// goes out as one run. The first pictures' frame headers are read back with
// that sequence header (the HEVC chain's guard), and every picture's
// base_q_idx is what the session logs as its quantizer.
//
// ── The references ──────────────────────────────────────────────────────────
//
// HevcDpb's bookkeeping, one picture of its pool to one of AV1's eight
// reference slots: a picture refreshes the slot of the texture it is
// reconstructed into — never a kept picture's — and every one of its seven
// reference names points at the one picture it predicts from. A loss leaves
// the slots the lost pictures refreshed stale at the receiver; nothing points
// at them again before they are refreshed, so the repair predicts from a
// picture both sides hold, as in HEVC.
//
// ── Size ────────────────────────────────────────────────────────────────────
//
// The picture is brought onto the driver's grid (codedPictureAlignment, 64×16
// on the 780M), its shape kept (alignedToGrid): 1080p is encoded 1792x1008,
// and input() says so — the conversion scales to it. A frame padded past the
// picture would say it in AV1's render size, which Chrome does not read: it
// shows the whole frame, padding included.
//
// Unless the client crops (setClientCrops): the frame is then padded to the
// grid (1920x1088), the render size says the picture (1920x1080), input()
// keeps the picture's size, and the viewer cuts the decoded frame to the size
// the session announces.

namespace mw::native::encode {

class VulkanAv1Encoder
{
public:
    using Witness = VulkanEncodeWitness;

    VulkanAv1Encoder();
    ~VulkanAv1Encoder();

    VulkanAv1Encoder(const VulkanAv1Encoder&) = delete;
    VulkanAv1Encoder& operator=(const VulkanAv1Encoder&) = delete;

    /// AV1 Main, 8 bits, 4:2:0, of @p width × @p height on @p device, opened
    /// with an AV1 encode queue (DeviceOptions::encodeAv1). Refused, with the
    /// reason, for any other codec and wherever the driver cannot.
    /// @p witness: constantQp is a qindex here; the transform depth is HEVC's.
    bool init(const std::shared_ptr<vulkan::VulkanDevice>& device, Codec codec, int width,
              int height, int fps, int bitrateKbps, bool intraRefresh, const EncoderTuning& tuning,
              std::string& error, const Witness& witness = Witness());

    /// Before init: the viewer cuts the decoded frame to the picture's size
    /// (SessionConfig::clientCropsToFrame), so the frame may be padded past
    /// the picture rather than the picture scaled onto the driver's grid.
    void setClientCrops(bool crops) { m_ClientCrops = crops; }

    const VulkanPicture& input() const { return m_Input; }
    bool upload(const uint8_t* nv12, std::string& error);
    bool encode(bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out, std::string& error);
    void releaseOutput() { m_OutputHeld = false; }

    bool supportsReferenceInvalidation() const { return m_Dpb.capacity() > 1; }
    bool invalidateReference(uint32_t frameNumber, std::string& error);
    bool setBitrate(int bitrateKbps, std::string& error);

    bool intraRefreshEnabled() const { return m_Sweep.enabled(); }
    int intraRefreshFrames() const { return static_cast<int>(m_Sweep.horizon()); }

    /// The sequence header OBU as the driver writes it, and as it reads.
    const std::vector<uint8_t>& sequenceHeader() const { return m_SequenceObu; }
    const av1::Sequence& sequence() const { return m_Sequence; }
    std::string describe() const;
    bool lost() const { return m_Failed; }

    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> d;

    bool createResources(std::string& error);
    bool createSession(std::string& error);
    bool readSequenceHeader(std::string& error);
    bool submit(const HevcDpb::Plan& plan, uint32_t& offset, uint32_t& bytes, std::string& error);
    /// The driver's picture read back: the frame asked for, or why not.
    bool check(const av1::FrameHeader& header, const HevcDpb::Plan& plan, std::string& error) const;
    std::string refreshText(const std::string& noRefresh) const;

    int m_Width = 0;
    int m_Height = 0;
    int m_Fps = 60;
    int m_BitrateKbps = 20000;
    int m_VbvFrames = 0;
    bool m_ClientCrops = false;
    Witness m_Witness;
    VulkanPicture m_Input;
    HevcDpb m_Dpb;
    IntraRefreshSweep m_Sweep;
    IntraRefreshSweep::Step m_Step;
    /// The order hint each of the eight reference slots holds, as this
    /// encoder wrote them.
    std::array<uint8_t, av1::kNumRefFrames> m_SlotHint{};
    std::vector<uint8_t> m_SequenceObu;
    av1::Sequence m_Sequence;
    int m_GuardLeft = 0;
    bool m_RateChanged = false;
    bool m_FirstPicture = true;
    bool m_OutputHeld = false;
    bool m_Failed = false;
    /// The driver's padding OBUs, taken out before the link.
    uint64_t m_PaddingBytes = 0;
    uint64_t m_PaddingPictures = 0;
};

} // namespace mw::native::encode
