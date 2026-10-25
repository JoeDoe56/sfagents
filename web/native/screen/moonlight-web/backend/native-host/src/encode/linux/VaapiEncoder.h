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

#include "../../convert/linux/GlConvert.h"
#include "../EncoderOutput.h"
#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// Hardware encoding on Linux through VA-API — AMD and Intel behind one API,
// which is the reason it exists. The Linux counterpart of NvencEncoder/AmfEncoder.
//
// ── The same latency decisions as the other three ───────────────────────────
//
// No B-frames (one reference, one frame in flight), an effectively infinite GOP
// with keyframes only on demand, CBR with a one-frame VBV that has the same
// floor RateControl.h gives every other encoder, and intra-refresh where the
// driver offers it. Every one of those was measured on Windows and none of
// them is negotiable here.
//
// ── The surface the encoder owns ────────────────────────────────────────────
//
// On D3D11 the converter writes an NV12 texture and the encoder registers it.
// Here it is the other way round, because VA-API allocates its own surfaces:
// the encoder creates the NV12 input surface, EXPORTS it as two DMA-BUF planes,
// and GlConvert renders into those. Same zero-copy result, opposite ownership —
// and the reason inputTarget() exists.
//
// ── What the driver writes for us ───────────────────────────────────────────
//
// VPS/SPS/PPS and slice headers are the driver's: Mesa's radeonsi (and Intel's iHD)
// generate them from the sequence and picture parameters, and re-emit the
// parameter sets on every IDR — which is what a browser that joins late or
// loses the first keyframe needs. Packed headers supplied by the application
// are supported by both and used by FFmpeg; here they are sent only to a
// driver that has shown it needs them.
//
// ⚠️ And on one machine they were missing EVERYTHING. Measured 16/09/2026 on a
// Radeon 610M (radeonsi "raphael_mendocino", Mesa 25.2.8): every IDR came out as
// the picture alone — `00 00 00 01 26 01 …`, one start code in 39 920 bytes, no
// VPS, no SPS, no PPS. The same binary on a 780M writes all four. A browser
// cannot configure a decoder from that, so it asks for another IDR, gets another
// headless one, and gives up 15 seconds later with "decoder_unsupported": a
// stream that never starts and says nothing useful about why.
//
// It was not the GPU but the Mesa: from 25.x its VA-API frontend (radeonsi, and
// anything else behind it) writes the parameter sets only when the application
// hands them in as packed headers — and reads frame_num and the reference
// picture set from the application's packed slice header, leaving them at zero
// without one. Every AMD host on a current distribution, not one laptop.
//
// So init() encodes ONE throwaway IDR and looks. A driver that writes its
// parameter sets is used exactly as before — no GPU that works today changes
// path. One that does not, and says it takes packed headers, is opened again
// with every header written here (ParameterSets.h): sequence and picture sets
// with each IDR, a slice header with every picture. Mesa parses them and
// re-writes them itself, so they must say exactly what the parameter buffers
// say. A driver that still writes none is refused by name, and the session
// falls back to the CPU pair, which always works.

namespace mw::native::encode {

/// Whether an Annex-B run carries the parameter sets a decoder must have before
/// it can be configured: SPS and PPS, plus the VPS HEVC puts in front of them.
///
/// Walks start codes rather than parsing: the NAL type is the only field read,
/// and both codecs put it in the first byte after the code (H.264: bits 0-4 of
/// one byte; HEVC: bits 1-6 of the first of two). Three- and four-byte start
/// codes both occur — a four-byte one simply has a zero where the loop is
/// already looking. AV1 answers true: it has no NAL units, and its sequence
/// header is an OBU inside the frame.
///
/// Out here rather than inside the encoder because it is the one piece of this
/// file that can be tested without a GPU.
bool carriesParameterSets(const std::vector<uint8_t>& bitstream, Codec codec);

/// Whether @p bitstream carries its sequence parameters more than once — a
/// driver that writes its own on top of the ones we handed it as packed
/// headers. Same walk as carriesParameterSets().
bool doublesParameterSets(const std::vector<uint8_t>& bitstream, Codec codec);

class VaapiEncoder
{
public:
    VaapiEncoder();
    ~VaapiEncoder();

    VaapiEncoder(const VaapiEncoder&) = delete;
    VaapiEncoder& operator=(const VaapiEncoder&) = delete;

    /// How init() names the one failure a caller can do something about: this
    /// driver encodes, but writes no parameter sets, so no client can decode it.
    /// The Linux session matches on this to fall back to the CPU pair rather
    /// than end the stream — see LinuxSession::buildPipeline.
    static constexpr const char* kNoParameterSets = "writes no parameter sets";

    /// Open VA-API on @p renderNode and configure a @p codec encoder for
    /// @p width × @p height at @p fps and @p bitrateKbps. H.264 and HEVC; AV1
    /// is refused until it has been watched on hardware.
    bool init(const std::string& renderNode, Codec codec, int width, int height, int fps,
              int bitrateKbps, bool intraRefresh, const EncoderTuning& tuning, std::string& error);

    /// The input surface, as GlConvert wants it. Valid after init(); the fds
    /// belong to the encoder and live until stop().
    const convert::Nv12Target& inputTarget() const { return m_Input; }

    /// Encode whatever the converter last wrote into the input surface.
    /// Blocking: returns with the bitstream ready.
    /// @param frameNumber the number this frame goes out under, and the name
    ///                    the receiver will use if it never gets it.
    bool encode(bool forceKeyframe, uint32_t frameNumber, EncoderOutput& out, std::string& error);

    /// Whether invalidateReference() does anything here. True wherever the
    /// reference list is ours to write, picture by picture — which HEVC is only
    /// when the slice headers are ours too: a driver that writes them (Mesa 23)
    /// keeps the lost picture in its reference set, and the decoder then looks
    /// for a picture it never had (18 wrong frames out of 41 on the 780M).
    bool supportsReferenceInvalidation() const
    {
        return m_Codec != Codec::Hevc || m_PackedHeadersUsed;
    }

    /// The frame numbered @p frameNumber never reached the receiver: encode the
    /// next pictures against older ones only, so the stream heals with an
    /// ordinary delta instead of a keyframe. Returns false when nothing old
    /// enough is still held — the caller then forces a keyframe.
    bool invalidateReference(uint32_t frameNumber, std::string& error);

    /// Release the buffer handed out by the last encode(). Must be called
    /// before the next encode().
    void releaseOutput();

    /// Change the bitrate between two frames, no restart. The VBV follows,
    /// through the same floor as init().
    bool setBitrate(int bitrateKbps, std::string& error);

    /// Whether the stream really refreshes by intra-refresh: what the driver
    /// DOES, never what was asked.
    bool intraRefreshEnabled() const { return m_IntraRefresh; }
    /// The horizon the receiver waits for: the gap plus a sweep, as Vulkan
    /// Video announces it; a sweep alone when they run back to back.
    int intraRefreshFrames() const
    {
        return m_IntraRefreshDistance > m_IntraRefreshPeriod
                   ? m_IntraRefreshDistance + m_IntraRefreshPeriod
                   : m_IntraRefreshPeriod;
    }

    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> d;

    /// Everything init() does once the parameters are known — twice when the
    /// driver's first keyframe comes out bare (see above).
    bool open(const std::string& renderNode, bool packedHeaders, std::string& error);
    bool openDisplay(const std::string& renderNode, std::string& error);
    bool chooseProfile(Codec codec, std::string& error);
    bool createSurfaces(std::string& error);
    bool exportInput(std::string& error);
    bool renderRateControl(std::string& error);
    bool refreshesThisFrame();
    bool renderH264(bool idr, std::string& error);
    bool renderHevc(bool idr, std::string& error);
    bool renderAv1(bool key, std::string& error);
    bool parameterSetsAreWritten(std::string& error);

    Codec m_Codec = Codec::H264;
    int m_Width = 0;
    int m_Height = 0;
    int m_Fps = 60;
    int m_BitrateKbps = 20000;
    EncoderTuning m_Tuning;

    convert::Nv12Target m_Input;

    bool m_WantIntraRefresh = false;
    /// The driver said it takes every header from us — kept across open()s.
    bool m_PackedHeadersOffered = false;
    /// The encoder open now writes every header itself (ParameterSets.h).
    bool m_PackedHeadersUsed = false;

    bool m_IntraRefresh = false;
    int m_IntraRefreshPeriod = 0;
    /// Which column band the rolling refresh is at, in macroblocks (H.264) or
    /// CTBs (HEVC). Advances every encoded frame.
    int m_RefreshPosition = 0;
    /// Frames from one sweep's start to the next (encode::
    /// intraRefreshDistanceFrames), and how far into that the wave is.
    int m_IntraRefreshDistance = 0;
    int m_RefreshClock = 0;

    uint32_t m_FrameNum = 0;
    uint32_t m_IdrPicId = 0;
    bool m_HaveReference = false;
    bool m_OutputHeld = false;
    bool m_RateDirty = true;

    std::vector<uint8_t> m_Bitstream;
};

} // namespace mw::native::encode
