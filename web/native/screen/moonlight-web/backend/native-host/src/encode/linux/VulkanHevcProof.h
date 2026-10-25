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

#include "VulkanHevcEncoder.h"
#include "mw/native/EncoderTuning.h"

#include <cstdint>
#include <string>

// The pixel proof of the Vulkan Video encoder (plan pipeline-video-d3d12-v2,
// C13.5; Bruno, 28/09/2026: a firmware or a driver that does not encode
// reliably in Vulkan gets VA-API, on its own).
//
// ── Why pixels ──────────────────────────────────────────────────────────────
//
// On the 780M, headers read back said everything right — the QP asked, the
// reference set asked — and the stream was wrong from its first P picture:
// the SPS said one transform depth, AMD's firmware coded another (bench
// §8o.3). Neither the firmware's number nor Mesa's version said "reliable":
// only a decoder that reads the stream as a browser would.
//
// ── What it does ────────────────────────────────────────────────────────────
//
// A short sequence that moves (the lab's pictures, the ones that caught the
// fault), through the product's own encoder — the same parameter sets, the
// same rate control, at the stream's size — with a loss healed by a delta
// and a keyframe asked for on the way; decoded by Vulkan Video on the same
// GPU; compared picture by picture and CTB row by CTB row. A stream that
// decodes to what went in is trusted; any other outcome, and a proof that
// cannot run at all (no decoder, a device lost), is a refusal with its
// reason, and the session encodes through VA-API.
//
// ── Once ────────────────────────────────────────────────────────────────────
//
// A proof is a few hundred milliseconds. Its verdict is kept in the user's
// cache under what could change it — the GPU, its driver, the kernel, the
// VCN firmware on AMD, the size, and this engine's own encoder revision — so
// that a session opens without it the next time. Only a comparison is kept:
// a proof that could not run is asked again.

namespace mw::native::encode {

struct VulkanHevcProof
{
    /// Pixels were compared: the verdict is the GPU's, not an accident's.
    bool ran = false;
    /// Every picture came back as it went in.
    bool passed = false;
    /// Why the encoder is not trusted; when it is, the numbers.
    std::string summary;
    double worstPicturePsnr = 0.0;
    double worstBandPsnr = 0.0;
    int pictures = 0;
    /// Read from the cache, not run now.
    bool cached = false;
    int64_t tookMs = 0;
};

/// The Vulkan Video encoder of the GPU behind @p renderNode, proven at the
/// pixel for a @p width × @p height stream at @p fps (see above).
VulkanHevcProof proveVulkanHevc(const std::string& renderNode, int width, int height, int fps,
                                const EncoderTuning& tuning,
                                const VulkanHevcEncoder::Witness& witness = {});

/// The proof for this GPU, driver, kernel, firmware and size: from the cache
/// when one was compared before, run and kept otherwise. MW_VK_PROOF_CACHE=0
/// neither reads nor writes the cache (the tests).
VulkanHevcProof vulkanHevcVerdict(const std::string& renderNode, int width, int height, int fps,
                                  const EncoderTuning& tuning);

/// The same proof for the AV1 encoder (C13.12, VulkanAv1Encoder): the same
/// pictures, the same loss and keyframe, decoded by dav1d (Dav1dDecoder) —
/// the GPU's own AV1 decoder would need a frame header parser this engine has
/// no other use for, and dav1d is what Chrome reads AV1 with when its GPU
/// cannot. No dav1d on the machine, or none in the build: the proof cannot
/// run, and no session is offered AV1 through Vulkan.
VulkanHevcProof proveVulkanAv1(const std::string& renderNode, int width, int height, int fps,
                               const EncoderTuning& tuning,
                               const VulkanEncodeWitness& witness = {});

/// The AV1 proof's verdict, cached as the HEVC one is, under its own key.
VulkanHevcProof vulkanAv1Verdict(const std::string& renderNode, int width, int height, int fps,
                                 const EncoderTuning& tuning);

/// The witness the environment asks for: MW_VK_ENCODE_DEPTH=N codes the
/// transform depth N — 2 is the one that coded wrong on the 780M — so that a
/// test shows the proof failing and the session falling back. Never set by
/// the product.
VulkanHevcEncoder::Witness witnessFromEnvironment();

/// PSNR of @p decoded against @p reference, both NV12 at @p width ×
/// @p height: the luma over the picture, the worst luma band of @p bandRows
/// rows, the chroma over the picture. Pure, for the tests.
struct PicturePsnr
{
    double luma = 0.0;
    double worstBand = 0.0;
    double chroma = 0.0;
};
PicturePsnr comparePictures(const uint8_t* reference, const uint8_t* decoded, int width, int height,
                            int bandRows);

} // namespace mw::native::encode
