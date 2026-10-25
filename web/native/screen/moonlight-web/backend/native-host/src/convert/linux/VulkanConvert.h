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

#include "../../capture/CaptureTypes.h"
#include "../CursorDraw.h"
#include "../ResampleCost.h"
#include "../ScaleFilter.h"
#include "GlConvert.h" // Nv12Target

#include <cstdint>
#include <memory>
#include <string>

// The split route's conversion (plan pipeline-video-d3d12-v2, §9-17): the
// scanout DMA-BUF into the NV12 surface VA-API encodes from, in Vulkan, on a
// compute queue. GlConvert's twin — same interface, same shaders transcribed,
// same pixels — for one reason: where the work waits.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// GL renders on the graphics ring, behind whatever the GPU is drawing. Under a
// game that saturates it, the conversion waits for the game's frame in flight
// and, at the game's priority, for the next one: 46 ms on a Radeon 780M. A
// compute queue runs beside the game, on the units it leaves: 10.6 ms without
// any privilege, 8.0 ms at HIGH (docs/bench-native-host.md §8o.1). The encoder
// stays VA-API, today's: only the conversion moves.
//
// ── The two ends, both proven before a line of this was written ─────────────
//
// The scanout buffer — tiled, on AMD with DCC in three planes — imports into
// Vulkan with its modifier and all its planes, its implicit fence waited on as
// a sync_file; what Vulkan reads is what EGL reads, pixel for pixel (§8o.2).
// The encoder's surface is linear, and Vulkan writes its two planes as R8 and
// RG8 storage images, which VA-API reads back sample for sample (§8o.4). So the
// shader READS the tiled buffer in place and WRITES the encoder's planes in
// place, as GlConvert does: one copy in the whole chain, the bitstream.
//
// ── The hand-off ────────────────────────────────────────────────────────────
//
// The surface is released to the foreign queue family and the CPU waits for
// the queue before VA-API is called — GlConvert's glFinish. The source waits
// on the DMA-BUF's implicit fence (DMA_BUF_IOCTL_EXPORT_SYNC_FILE, Linux 6.0),
// where the kernel and the driver offer it.
//
// ── When it cannot ──────────────────────────────────────────────────────────
//
// No loader, no Vulkan 1.3, a modifier it cannot import, a device lost: init()
// or convert() fails, says why, and lost() tells the session to convert through
// GL instead for the rest of the stream (LinuxSession). Never a stream that
// ends because Vulkan could not do its part.

namespace mw::native::vulkan {
class VulkanDevice;
}
namespace mw::native::encode {
struct VulkanPicture;
}

namespace mw::native::convert {

class VulkanConvert
{
public:
    VulkanConvert();
    ~VulkanConvert();

    VulkanConvert(const VulkanConvert&) = delete;
    VulkanConvert& operator=(const VulkanConvert&) = delete;

    /// The queue's priority: HIGH (the engine's own, where CAP_SYS_NICE is held
    /// and a submission proves it) or normal. Before init().
    void setWantHighPriority(bool high) { m_WantHigh = high; }

    /// GlConvert::init's contract: Vulkan on the GPU behind @p renderNode, the
    /// pipelines for a source of @p sourceFourcc at @p sourceWidth ×
    /// @p sourceHeight scaled to @p outputWidth × @p outputHeight (rounded down
    /// to even), with @p filter for a smaller output.
    bool init(const std::string& renderNode, uint32_t sourceFourcc, int sourceWidth,
              int sourceHeight, int outputWidth, int outputHeight, ScaleFilter filter,
              std::string& error);
    /// The same on @p device, the one the Vulkan Video encoder is on: the
    /// whole chain in one API (the route "Vulkan compute → Vulkan Video").
    bool init(const std::shared_ptr<vulkan::VulkanDevice>& device, uint32_t sourceFourcc,
              int sourceWidth, int sourceHeight, int outputWidth, int outputHeight,
              ScaleFilter filter, std::string& error);

    ScaleFilter scaleFilter() const { return m_Filter; }
    /// Give up the resample pass for the rest of the session (GlConvert's).
    bool dropResample();
    bool takeResampleCost(int64_t& costUs);
    bool letterboxed() const { return m_Letterboxed; }

    /// The encoder's surface as the target, imported once per session.
    bool bindTarget(const Nv12Target& target, std::string& error);
    /// The Vulkan Video encoder's input as the target: an image of this very
    /// device, written through its plane views, nothing imported. It rests
    /// in VIDEO_ENCODE_SRC between pictures; convert() takes it to GENERAL
    /// and back, after the encode that read it last.
    bool bindTarget(const encode::VulkanPicture& target, std::string& error);

    /// Convert one frame into the bound target and wait for the GPU.
    bool convert(const capture::KmsFrame& frame, const capture::CursorState& cursor,
                 const CursorDraw& draw, std::string& error);

    int outputWidth() const { return m_OutputWidth; }
    int outputHeight() const { return m_OutputHeight; }

    /// The queue as it was obtained, for the log (VulkanDevice).
    bool highPriority() const;
    const std::string& priority() const { return m_Priority; }
    /// The device is gone, or refused a buffer it must import: the session
    /// converts through GL from here on.
    bool lost() const;

    /// Vulkan has no current-context rule: nothing to hand back.
    void detachThread() {}

    /// For the session's line: which API converts.
    static const char* apiName() { return "Vulkan compute"; }

    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> d;

    bool setUp(uint32_t sourceFourcc, int sourceWidth, int sourceHeight, int outputWidth,
               int outputHeight, ScaleFilter filter, std::string& error);
    bool start(std::string& error);
    bool createPipelines(std::string& error);
    bool createScaler(std::string& error);
    void releaseScaler();
    bool updateCursor(const capture::CursorState& cursor, std::string& error);

    bool m_WantHigh = true;
    uint32_t m_SourceFourcc = 0;
    int m_SourceWidth = 0;
    int m_SourceHeight = 0;
    int m_OutputWidth = 0;
    int m_OutputHeight = 0;
    uint64_t m_CursorShapeVersion = 0;
    std::string m_Priority;
    ScaleFilter m_Filter = ScaleFilter::Bilinear;
    bool m_Letterboxed = false;
    ResampleCost m_ResampleCost;
    bool m_ResampleCostTaken = false;
    int m_PictureX = 0;
    int m_PictureY = 0;
    int m_PictureWidth = 0;
    int m_PictureHeight = 0;
};

} // namespace mw::native::convert
