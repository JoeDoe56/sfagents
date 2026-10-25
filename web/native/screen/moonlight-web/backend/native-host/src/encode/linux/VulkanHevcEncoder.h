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

#include "../EncoderOutput.h"
#include "../HevcDpb.h"
#include "../HevcSliceParser.h"
#include "../IntraRefreshSweep.h"
#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"

#ifndef VK_NO_PROTOTYPES
#define VK_NO_PROTOTYPES
#endif
#include <vulkan/vulkan_core.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// HEVC through Vulkan Video (plan pipeline-video-d3d12-v2, Phase 13, C13.5):
// the Linux twin of the D3D12 chain's VideoEncode12, on the same device as
// the Vulkan conversion, so that the whole chain is one API on one GPU.
//
// ── One picture ─────────────────────────────────────────────────────────────
//
// The conversion writes the encoder's own input image, in place, through two
// plane views (R8, RG8) it takes as storage images; one command buffer on the
// encode queue waits for the conversion's submission on the GPU — a semaphore,
// which is what makes the compute queue's writes visible to the encoder — and
// encodes; the CPU waits for that and nothing else. HevcDpb says what the
// picture is, what it keeps and what it predicts from: every picture kept is
// listed in the slice's reference set, one is used.
//
// ── The headers ─────────────────────────────────────────────────────────────
//
// Ours as StdVideo structures, the bytes the driver's: it writes the VPS, SPS
// and PPS it stands by (vkGetEncodedVideoSessionParametersKHR), and they go
// out in front of every IDR, laid in the bitstream buffer right before the
// offset the slices land at — an IDR is one run, not a copy. The first
// pictures' slice headers are read back with those very sets (the D3D12
// chain's guard).
//
// ⚠️ The transform tree's depth is written at the full depth the CTB allows
// (CtbLog2SizeY − MinTbLog2SizeY): AMD's firmware splits that far whatever the
// SPS says, RADV passes the application's value through, and at 2 every P
// picture with motion decoded wrong on the 780M (bench §8o.3). Nothing in the
// Vulkan capabilities says it; the pixel proof (VulkanHevcProof) is what
// catches a driver that codes something other than its SPS.
//
// ── The rate control ────────────────────────────────────────────────────────
//
// The driver's CBR, the VBV the other encoders keep (RateControl.h), moved in
// flight by a control command — no reset, no keyframe.
//
// ── The queue ───────────────────────────────────────────────────────────────
//
// At the default priority: on the 780M under Linux 6.8 an encode queue at
// HIGH is created and its first submission refused (§8o.3). The encode runs
// on a block no game uses; the conversion is what needs the priority.
//
// ── Intra refresh (C13.9) ───────────────────────────────────────────────────
//
// Where the driver has VK_KHR_video_encode_intra_refresh, a stream whose
// receiver rides out a loss is refreshed by sweeps rather than keyframes, as
// on the other encoders: IntraRefreshSweep says which picture refreshes which
// region, the driver splits the picture into them — columns first, which a
// vertical scroll crosses without leaving its band. A sweep every four
// periods, the engine's gap (RateControl.h).

namespace mw::native::vulkan {
class VulkanDevice;
}

namespace mw::native::encode {

/// The encoder's input as the conversion writes it: one NV12 image at the
/// coded size, and a view per plane. Between two pictures it rests in
/// VK_IMAGE_LAYOUT_VIDEO_ENCODE_SRC_KHR; the conversion takes it to GENERAL,
/// writes the visible part, and hands it back in that layout. The rows and
/// columns past the visible picture are black, written once by the encoder.
struct VulkanPicture
{
    VkImage image = VK_NULL_HANDLE;
    VkImageView luma = VK_NULL_HANDLE;   ///< R8, plane 0, storage
    VkImageView chroma = VK_NULL_HANDLE; ///< RG8, plane 1, storage
    int width = 0;                       ///< the picture the conversion writes
    int height = 0;
    int codedWidth = 0; ///< the image: whole CTBs
    int codedHeight = 0;
};

/// What the pixel proof varies; the product never sets it. Out of the class:
/// a default argument inside it cannot use a nested type's initialisers yet.
struct VulkanEncodeWitness
{
    /// max_transform_hierarchy_depth_inter/intra; -1 = the full depth. The
    /// proof's witness sets 2 — the depth that coded wrong (§8o.3).
    int transformDepth = -1;
    /// The driver's rate control at the bitrate asked (the product), or a
    /// constant QP.
    int constantQp = -1;
    /// Sweeps this many pictures long, back to back, where the stream asks
    /// for intra refresh: the proof's, which covers them in a dozen
    /// pictures. 0 = the stream's own (two seconds, every four periods).
    int sweepPictures = 0;
};

class VulkanHevcEncoder
{
public:
    using Witness = VulkanEncodeWitness;

    VulkanHevcEncoder();
    ~VulkanHevcEncoder();

    VulkanHevcEncoder(const VulkanHevcEncoder&) = delete;
    VulkanHevcEncoder& operator=(const VulkanHevcEncoder&) = delete;

    /// HEVC Main of @p width × @p height at @p fps and @p bitrateKbps on
    /// @p device, which must have been opened with an encode queue
    /// (DeviceOptions::encodeHevc). Refused, with the reason, where the
    /// driver cannot: no HEVC encoder, a size out of range, an input the
    /// conversion cannot write, a first picture that does not come back.
    /// @p intraRefresh is asked, not promised: a driver without it encodes
    /// keyframes on demand, and intraRefreshEnabled() says so.
    bool init(const std::shared_ptr<vulkan::VulkanDevice>& device, Codec codec, int width,
              int height, int fps, int bitrateKbps, bool intraRefresh, const EncoderTuning& tuning,
              std::string& error, const Witness& witness = Witness());

    /// The input image: valid from init() to stop().
    const VulkanPicture& input() const { return m_Input; }

    /// A picture from the CPU into the input, NV12 at the visible size (the
    /// proof's pictures; the product's come from the conversion).
    bool upload(const uint8_t* nv12, std::string& error);

    /// Encode what the input holds. Blocking: returns with the bitstream in
    /// hand. @p frameNumber is the number the frame goes out under, the one a
    /// loss report names.
    bool encode(bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out, std::string& error);

    /// Release the buffer handed out by the last encode().
    void releaseOutput() { m_OutputHeld = false; }

    bool supportsReferenceInvalidation() const { return m_Dpb.capacity() > 1; }
    /// Frame @p frameNumber never arrived: the next pictures predict from an
    /// older one. False when none is kept — the caller forces a keyframe.
    bool invalidateReference(uint32_t frameNumber, std::string& error);

    /// A new target from the next picture, said to the driver in flight.
    bool setBitrate(int bitrateKbps, std::string& error);

    /// Sweeps instead of keyframes (C13.9), and how many pictures a loss may
    /// take to heal by them — the gap plus one sweep: the receiver's ride-out
    /// watchdog waits that long. 0 without intra refresh.
    bool intraRefreshEnabled() const { return m_Sweep.enabled(); }
    int intraRefreshFrames() const { return static_cast<int>(m_Sweep.horizon()); }

    /// VPS, SPS and PPS as the driver writes them, Annex-B.
    const std::vector<uint8_t>& parameterSets() const { return m_Headers; }
    const HevcSpsFields& sps() const { return m_SpsFields; }
    /// For the session's line: "Vulkan Video (…)".
    std::string describe() const;
    /// The device is gone, or refused a picture: the session encodes through
    /// VA-API from here on.
    bool lost() const { return m_Failed; }

    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> d;

    bool createResources(std::string& error);
    bool createSession(std::string& error);
    bool readParameterSets(std::string& error);
    bool submit(const HevcDpb::Plan& plan, uint32_t& offset, uint32_t& bytes, std::string& error);
    bool guard(const uint8_t* data, size_t size, const HevcDpb::Plan& plan, std::string& error);
    int reportedQp(const uint8_t* slices, size_t size);
    /// The intra refresh in force, or why there is none, for the log line.
    std::string refreshText(const std::string& noRefresh) const;

    int m_Width = 0;
    int m_Height = 0;
    int m_Fps = 60;
    int m_BitrateKbps = 20000;
    int m_VbvFrames = 0;
    Witness m_Witness;
    VulkanPicture m_Input;
    HevcDpb m_Dpb;
    /// The sweeps, and the step the picture being submitted takes in one.
    IntraRefreshSweep m_Sweep;
    IntraRefreshSweep::Step m_Step;
    std::vector<uint8_t> m_Headers;
    HevcSpsFields m_SpsFields;
    HevcPpsFields m_PpsFields;
    int m_GuardLeft = 0;
    bool m_SliceQpMoves = false;
    bool m_RateChanged = false;
    bool m_FirstPicture = true;
    bool m_OutputHeld = false;
    bool m_Failed = false;
    int m_TransformDepth = 0;
    /// The driver's filler, stripped from the pictures before the link: said
    /// on the first one and in total at stop().
    uint64_t m_FillerBytes = 0;
    uint64_t m_FillerPictures = 0;
};

} // namespace mw::native::encode
