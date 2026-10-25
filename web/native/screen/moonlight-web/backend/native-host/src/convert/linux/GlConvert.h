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
#include "../../capture/linux/KmsCapture.h"
#include "../CursorDraw.h"
#include "../ResampleCost.h"
#include "../ScaleFilter.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// Turns a scanout DMA-BUF into the NV12 surface the encoder owns, on the GPU,
// without touching system memory. The Linux counterpart of ColorConvert.
//
// ── Why GL sits between KMS and VA-API ──────────────────────────────────────
//
// The scanout buffer is tiled — on AMD with DCC compression metadata in two
// extra planes — and radeonsi's VA-API refuses to import that modifier (it
// accepts linear and nothing else, measured on a 780M on 04/09/2026). EGL on
// the same driver lists the very same modifier among its supported imports.
// So the frame goes KMS → EGLImage → a fragment shader → the encoder's surface,
// and the GPU never copies it: the shader READS the tiled buffer in place and
// WRITES the encoder's planes in place.
//
// ── The same trick as D3D11, one API over ───────────────────────────────────
//
// NV12 is planar and GL cannot render into "an NV12 texture" any more than
// D3D11 can. What both allow is a view per plane: the VA surface is exported as
// two DMA-BUF layers, R8 (luma) and GR88 (interleaved chroma), each imported as
// its own EGLImage and attached to its own framebuffer. Two small draws — a
// full-screen triangle, no vertex buffer — and the shader math is ColorConvert's
// transcribed from HLSL to GLSL, BT.709 limited range, cursor composited on the
// way through.

namespace mw::native::convert {

/// The encoder's NV12 surface, as vaExportSurfaceHandle describes it with
/// VA_EXPORT_SURFACE_SEPARATE_LAYERS: one layer per plane.
struct Nv12Target
{
    int width = 0;
    int height = 0;
    uint64_t modifier = 0; ///< of the VA allocation; GL imports it as-is
    int fdY = -1;
    uint32_t offsetY = 0;
    uint32_t pitchY = 0;
    int fdUV = -1;
    uint32_t offsetUV = 0;
    uint32_t pitchUV = 0;
};

class GlConvert
{
public:
    GlConvert();
    ~GlConvert();

    GlConvert(const GlConvert&) = delete;
    GlConvert& operator=(const GlConvert&) = delete;

    /// Bring up EGL on @p renderNode (the GPU that scans the display out — the
    /// same one the encoder runs on) and compile the shaders for a source of
    /// @p sourceFourcc at @p sourceWidth × @p sourceHeight, scaled to
    /// @p outputWidth × @p outputHeight. Output dimensions are rounded down to
    /// even, as NV12 requires.
    ///
    /// @p filter is how a smaller output is made (ScaleFilter.h): the plain
    /// linear fetch of the conversion pass, or a Lanczos-2 resample in linear
    /// light first. Lanczos-2 needs a float-renderable intermediate
    /// (GL_EXT_color_buffer_float); a driver without it falls back to
    /// bilinear, and the log says so. scaleFilter() tells what is in effect.
    bool init(const std::string& renderNode, uint32_t sourceFourcc, int sourceWidth,
              int sourceHeight, int outputWidth, int outputHeight, ScaleFilter filter,
              std::string& error);

    /// The filter in effect: Bilinear at 1:1 whatever was asked.
    ScaleFilter scaleFilter() const { return m_Filter; }
    /// Give up the resample pass for the rest of the session: the conversion
    /// samples the scanout again, bilinear, as a Bilinear init() would have
    /// set it up. False when there is none, or when the picture is
    /// letterboxed — the bilinear pass would stretch it instead. Called on
    /// the thread that converts.
    bool dropResample();
    /// What the resample costs this GPU (ResampleCost.h), once: true the first
    /// time the measurement is complete, with its median in @p costUs.
    bool takeResampleCost(int64_t& costUs);
    /// Whether the picture sits between black bars (a source of another
    /// shape, on the resample path; the bilinear path stretches instead).
    bool letterboxed() const { return m_Letterboxed; }

    /// Attach the encoder's surface as the render target. Done once per
    /// session, not per frame: the planes are imported and their framebuffers
    /// built here, and convert() then only draws.
    bool bindTarget(const Nv12Target& target, std::string& error);

    /// Convert one frame into the bound target. Imports @p frame's planes as an
    /// EGLImage, draws luma then chroma, and waits for the GPU — the encoder
    /// reads the surface next, on a queue GL knows nothing about, so the wait is
    /// what makes the hand-off correct.
    bool convert(const capture::KmsFrame& frame, const capture::CursorState& cursor,
                 const CursorDraw& draw, std::string& error);

    int outputWidth() const { return m_OutputWidth; }
    int outputHeight() const { return m_OutputHeight; }

    /// Whether the context runs above normal priority on the GPU: asked for
    /// only when this process holds CAP_SYS_NICE (see createContext), and
    /// then true only when the context was made with it effective.
    bool highPriority() const { return m_HighPriority; }
    /// The same, said for the log: "high (CAP_SYS_NICE)", or normal and why.
    const std::string& priority() const { return m_Priority; }

    /// For the session's line: which API converts (VulkanConvert has its own).
    static const char* apiName() { return "EGL"; }

    /// The DRM format modifiers EGL on @p renderNode imports a @p fourcc
    /// buffer with, external-only ones left out: what the portal offers the
    /// compositor for DMA-BUF (PortalCapture::offerDmabuf). GL takes over from
    /// every other conversion, so its list is the one to ask for.
    static bool importableModifiers(const std::string& renderNode, uint32_t fourcc,
                                    std::vector<uint64_t>& modifiers, std::string& error);

    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> d;

    bool createContext(const std::string& renderNode, std::string& error);
    bool createShaders(std::string& error);
    /// The resample pass: two programs, the intermediate and the scaled
    /// picture. Only when scaling with Lanczos2.
    bool createScaler(std::string& error);
    /// Delete the resample pass's objects. Only with the context current —
    /// otherwise stop() gets them.
    void releaseScaler();
    /// Read the frame's resample timing into m_ResampleCost. After the finish,
    /// when the result is in.
    void collectResampleTiming();
    /// Bind the context to the calling thread if it is not already. convert()
    /// runs on the capture thread, init() on whoever built the session.
    bool makeCurrent(std::string& error);

public:
    /// Release the context from the calling thread. A thread that converted
    /// calls this before it ends, so stop() — on another thread — can bind
    /// the context to tear it down. Harmless when nothing is current.
    void detachThread();

private:
    bool updateCursorTextures(const capture::CursorState& cursor, std::string& error);

    uint32_t m_SourceFourcc = 0;
    int m_SourceWidth = 0;
    int m_SourceHeight = 0;
    int m_OutputWidth = 0;
    int m_OutputHeight = 0;
    uint64_t m_CursorShapeVersion = 0;
    bool m_HighPriority = false;
    std::string m_Priority;
    ScaleFilter m_Filter = ScaleFilter::Bilinear;
    bool m_Letterboxed = false;
    ResampleCost m_ResampleCost;
    bool m_ResampleCostTaken = false;
    /// Where the picture lands in the scaled texture: all of it, or the
    /// fitted rectangle between the bars.
    int m_PictureX = 0;
    int m_PictureY = 0;
    int m_PictureWidth = 0;
    int m_PictureHeight = 0;
};

} // namespace mw::native::convert
