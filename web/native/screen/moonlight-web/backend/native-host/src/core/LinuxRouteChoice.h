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

// Which chain a build of a Linux session runs its pictures through (plan
// pipeline-video-d3d12-v2, Phase 13). Pure, so that it is tested everywhere.
//
// Two questions, in this order. The encoder: Vulkan Video (AMD's since
// 05/10/2026, in HEVC and AV1), VA-API, or the CPU — the bench key over the
// setting over the vendor table. Then, in front of VA-API, the conversion:
// GL, or Vulkan on a compute queue (the split route, plan §9-17) — the bench
// key, then VA-API asked for by name (GL in front, the chain as it always
// ran: the way back from whatever the table moved), then the vendor table.
//
// Whatever cannot carry THIS build is refused, by name, and the chain drops to
// the next one down — Vulkan Video → VA-API → the CPU, Vulkan compute → GL —
// never forced onto a machine that cannot run it (Bruno, 28/09/2026: a
// firmware or a driver that does not encode reliably in Vulkan gets VA-API,
// on its own). What refuses is asked again at the next build; what the
// session learned while streaming (a Vulkan device lost, a pixel proof that
// failed) comes in as a refusal it carries for the rest of the session.
//
// The vendor table is where defaults change, one line per vendor, after a
// bench and on Bruno's word — never on a measurement alone.

#include "mw/native/Capabilities.h"
#include "mw/native/EncoderTuning.h"
#include "mw/native/VideoPipeline.h"

#include <cstdint>
#include <string>

namespace mw::native {

/// What one build of a Linux session knows when it picks its chain.
struct LinuxRouteFacts
{
    /// The bench's keys (EncoderTuning::pipeline, convertLinux) and the setting
    /// (SessionConfig::videoPipeline). Auto — and Windows' values — are no
    /// opinion.
    VideoPipeline benchKey = VideoPipeline::Auto;
    VideoPipeline setting = VideoPipeline::Auto;
    EncoderTuning::ConvertLinux convertKey = EncoderTuning::ConvertLinux::Default;

    /// What the Selector picked: VaApi when the GPU encodes through VA-API,
    /// Software (OpenH264) when nothing on the machine does.
    EncoderApi encoder = EncoderApi::None;
    Codec codec = Codec::H264;
    /// PCI vendor of the GPU the display scans out of (0x1002 AMD, 0x8086
    /// Intel, 0x10DE NVIDIA); 0 when unknown. The vendor table's key.
    uint32_t vendorId = 0;

    // ── What rules a chain out for this build ───────────────────────────────

    /// The pictures come through the portal (PipeWire), not off the scanout.
    bool portal = false;
    /// The portal hands shared memory, not a DMA-BUF: GL cannot read it, the
    /// Vulkan conversion (C13.10) and the CPU can.
    bool sharedMemory = false;
    /// VA-API encodes but writes no parameter sets (VaapiEncoder::
    /// kNoParameterSets), learned by an earlier build of this session.
    bool vaapiUnusable = false;

    /// The Vulkan conversion is compiled in (MW_NATIVE_LINUX_VULKAN), and why
    /// it was given up on for this session — its device lost, an import
    /// refused, a device missing what it needs — or "" while it is not.
    bool vulkanConvertBuilt = false;
    std::string vulkanConvertRefusal;

    /// The Vulkan Video encoder (C13.5) is compiled in, and why this GPU's is
    /// not trusted — no encode queue for the codec, a driver or firmware
    /// under the minimums, the pixel proof at its opening failed — or "".
    bool vulkanEncoderBuilt = false;
    std::string vulkanEncoderRefusal;
};

struct LinuxRoute
{
    enum class Encoder
    {
        Vaapi,
        Vulkan,
        Cpu
    };
    enum class Conversion
    {
        Gl,
        Vulkan,
        Cpu
    };
    Encoder encoder = Encoder::Vaapi;
    Conversion conversion = Conversion::Gl;
    /// For SessionInfo: Vaapi or Vulkan; Auto on the CPU tier, which is no
    /// chain of either.
    VideoPipeline pipeline = VideoPipeline::Vaapi;
    /// "EGL → VA-API", "Vulkan compute → VA-API", "Vulkan compute → Vulkan
    /// Video", "CPU → OpenH264": the log's words and the bench's column.
    std::string route;
    /// Why: which of the bench key, the setting and the vendor table decided,
    /// and what refused whatever was asked for and could not run.
    std::string reason;
    /// Something was asked for — a chain or a conversion — and another runs.
    bool refused = false;
};

/// The vendor table's conversion in front of VA-API.
///
/// AMD: Vulkan on a compute queue, the split route — Bruno's decision of
/// 28/09/2026 (plan §9-20), on the bench's word (§8o.5): under a game that
/// fills the 780M, GL waited behind it and caught 16 of its 45 pictures a
/// second, 38 ms from present to encoded; the compute queue ran beside it,
/// 44 pictures in 8 ms, and 0.3 ms less at rest. Off the scanout first, and
/// on the portal's DMA-BUF too since its own bench (§8o.11, C13.3 bis,
/// 29/09/2026): under the same load the conversion there halves, on buffers
/// the compositor has to copy first. GL for the others, until a bench has
/// measured a vendor and Bruno has moved its line.
inline EncoderTuning::ConvertLinux autoLinuxConversion(uint32_t vendorId)
{
    switch (vendorId) {
    case 0x1002: return EncoderTuning::ConvertLinux::Vulkan; // AMD: §9-20, C13.3 bis
    case 0x8086: return EncoderTuning::ConvertLinux::Gl;
    default: return EncoderTuning::ConvertLinux::Gl;
    }
}

namespace linuxroute_detail {

inline const char* vendorName(uint32_t vendorId)
{
    switch (vendorId) {
    case 0x1002: return "AMD";
    case 0x8086: return "Intel";
    case 0x10DE: return "NVIDIA";
    default: return "this GPU";
    }
}

/// A Linux value of @p p, or Auto: Windows' chains are no opinion here.
inline VideoPipeline linuxValue(VideoPipeline p)
{
    return p == VideoPipeline::Vaapi || p == VideoPipeline::Vulkan ? p : VideoPipeline::Auto;
}

/// Why the Vulkan Video chain cannot carry this build, or "".
inline std::string vulkanEncoderRefusal(const LinuxRouteFacts& f)
{
    if (!f.vulkanEncoderBuilt) return "the Vulkan Video encoder is not built in";
    if (!f.vulkanEncoderRefusal.empty()) return f.vulkanEncoderRefusal;
    if (f.codec != Codec::Hevc && f.codec != Codec::Av1)
        return std::string(toString(f.codec)) + " is not done by the Vulkan Video encoder yet";
    // The chain converts in Vulkan too: what refused the conversion refuses it.
    if (!f.vulkanConvertBuilt) return "the Vulkan conversion is not built in";
    if (!f.vulkanConvertRefusal.empty()) return f.vulkanConvertRefusal;
    return {};
}

/// Why the Vulkan conversion cannot feed VA-API in this build, or "".
inline std::string vulkanConvertRefusal(const LinuxRouteFacts& f)
{
    if (!f.vulkanConvertBuilt) return "the Vulkan conversion is not built in";
    if (!f.vulkanConvertRefusal.empty()) return f.vulkanConvertRefusal;
    return {};
}

inline LinuxRoute cpuRoute(std::string reason, bool refused)
{
    LinuxRoute r;
    r.encoder = LinuxRoute::Encoder::Cpu;
    r.conversion = LinuxRoute::Conversion::Cpu;
    r.pipeline = VideoPipeline::Auto;
    r.route = "CPU → OpenH264";
    r.reason = std::move(reason);
    r.refused = refused;
    return r;
}

} // namespace linuxroute_detail

/// The chain the bench key, then the setting, then the vendor table ask for:
/// VA-API or Vulkan Video.
inline VideoPipeline linuxWantedPipeline(VideoPipeline benchKey, VideoPipeline setting,
                                         uint32_t vendorId)
{
    using namespace linuxroute_detail;
    return linuxValue(benchKey) != VideoPipeline::Auto  ? benchKey
           : linuxValue(setting) != VideoPipeline::Auto ? setting
                                                        : autoLinuxPipeline(vendorId);
}

/// Whether this build would take the Vulkan Video chain if nothing refused
/// it — the bench key, the setting or the vendor table asks for it, the
/// codec is HEVC or AV1, and nothing already learned stands in the way. The
/// one case the session runs the pixel proof for (VulkanHevcProof): a machine
/// that was not going to encode in Vulkan is never made to prove it can.
inline bool linuxRouteWantsVulkanVideo(const LinuxRouteFacts& f)
{
    using namespace linuxroute_detail;
    return linuxWantedPipeline(f.benchKey, f.setting, f.vendorId) == VideoPipeline::Vulkan &&
           vulkanEncoderRefusal(f).empty();
}

/// The codecs only Vulkan Video encodes on Linux: AV1, which Mesa's VA-API
/// lists and describes no encoder for (LinuxProbe.cpp). Offered to a session
/// only when its chain is asked to be Vulkan Video (offerSessionCodecs), so
/// that no session that would have encoded through VA-API is ever handed one.
inline bool linuxVulkanOnlyCodec(Codec codec)
{
    return codec == Codec::Av1;
}

inline LinuxRoute chooseLinuxRoute(const LinuxRouteFacts& f)
{
    using namespace linuxroute_detail;

    // ── The encoder ──
    VideoPipeline wanted = VideoPipeline::Auto;
    std::string why;
    // A chain named by the bench key or the setting, rather than the table's.
    const bool asked = linuxValue(f.benchKey) != VideoPipeline::Auto ||
                       linuxValue(f.setting) != VideoPipeline::Auto;
    if (linuxValue(f.benchKey) != VideoPipeline::Auto) {
        wanted = f.benchKey;
        why = std::string("the bench key pipeline=") + toString(f.benchKey);
    } else if (linuxValue(f.setting) != VideoPipeline::Auto) {
        wanted = f.setting;
        why = std::string("the setting (") + toString(f.setting) + ")";
    } else {
        wanted = autoLinuxPipeline(f.vendorId);
        why = std::string("auto: the vendor table has ") +
              (wanted == VideoPipeline::Vulkan ? "Vulkan Video" : "VA-API") + " for " +
              vendorName(f.vendorId);
        // The table asks only for what the chain could carry: a codec it does
        // not encode, or a build without it, is VA-API's by the table's own
        // line — nothing refused. What the proof or the stream learned is
        // still a refusal, said as one (as on Windows, VideoPipelineChoice.h).
        if (wanted == VideoPipeline::Vulkan) {
            if (f.codec != Codec::Hevc && f.codec != Codec::Av1) {
                wanted = VideoPipeline::Vaapi;
                why += std::string(" in HEVC and AV1, VA-API in ") + toString(f.codec) +
                       " (not done by the Vulkan Video encoder yet)";
            } else if (!f.vulkanEncoderBuilt) {
                wanted = VideoPipeline::Vaapi;
                why += ", not built in here: VA-API";
            }
        }
    }

    std::string refusedBecause;
    if (wanted == VideoPipeline::Vulkan) {
        const std::string no = vulkanEncoderRefusal(f);
        if (no.empty()) {
            LinuxRoute r;
            r.encoder = LinuxRoute::Encoder::Vulkan;
            r.conversion = LinuxRoute::Conversion::Vulkan;
            r.pipeline = VideoPipeline::Vulkan;
            r.route = "Vulkan compute → Vulkan Video";
            r.reason = why;
            return r;
        }
        refusedBecause =
            (asked ? why : std::string("auto: the vendor table for ") + vendorName(f.vendorId)) +
            " asks for Vulkan Video, which cannot run: " + no;
    }

    // VA-API, or the CPU when there is none to be had.
    const bool vaapi = f.encoder == EncoderApi::VaApi && !f.vaapiUnusable;
    if (!vaapi) {
        std::string cpu = f.vaapiUnusable ? "VA-API writes no parameter sets on this driver"
                                          : "no GPU encoder on this machine";
        if (!refusedBecause.empty())
            return cpuRoute(refusedBecause + "; the CPU runs: " + cpu, true);
        // Refused only when someone asked for VA-API by name; the table's
        // VA-API on a machine without it is the CPU tier doing its job.
        return cpuRoute(asked ? why + " asks for VA-API; the CPU runs: " + cpu : cpu, asked);
    }

    // ── The conversion in front of VA-API ──
    //
    // VA-API asked for by name keeps GL in front of it: the chain as it always
    // ran, and the way back — from the admin page — from whatever the table
    // moved. Vulkan Video asked for and refused is not VA-API by name: that
    // stream takes the table's conversion.
    LinuxRoute r;
    r.encoder = LinuxRoute::Encoder::Vaapi;
    r.pipeline = VideoPipeline::Vaapi;
    r.refused = !refusedBecause.empty();
    std::string convertWhy;
    std::string asker; // who asked for Vulkan compute, in a refusal's words
    EncoderTuning::ConvertLinux conversion = f.convertKey;
    if (conversion != EncoderTuning::ConvertLinux::Default) {
        convertWhy = std::string("the bench key convert=") +
                     (conversion == EncoderTuning::ConvertLinux::Vulkan ? "vulkan" : "gl");
        asker = convertWhy;
    } else if (asked && wanted == VideoPipeline::Vaapi) {
        conversion = EncoderTuning::ConvertLinux::Gl;
        convertWhy = "VA-API by name converts with GL, as it always has";
    } else {
        conversion = autoLinuxConversion(f.vendorId);
        convertWhy = std::string("the vendor table converts with ") +
                     (conversion == EncoderTuning::ConvertLinux::Vulkan ? "Vulkan compute" : "GL") +
                     " for " + vendorName(f.vendorId) + (f.portal ? " on the portal" : "");
        asker = std::string("the vendor table for ") + vendorName(f.vendorId);
    }
    // ⚠️ The portal's shared memory: GL cannot read it. The Vulkan conversion
    // can (C13.10), where the table or the key asks for it and it runs; the
    // CPU pair otherwise, as this route always went.
    if (f.sharedMemory) {
        const bool vulkan = conversion == EncoderTuning::ConvertLinux::Vulkan;
        const std::string no = vulkan ? vulkanConvertRefusal(f) : std::string();
        if (!vulkan || !no.empty()) {
            const std::string shm =
                "the portal gives shared memory, which GL cannot read" +
                (vulkan ? "; " + asker + " asks for Vulkan compute, which cannot run: " + no
                        : "; " + convertWhy) +
                "; the CPU runs";
            const bool refused = !refusedBecause.empty() || vulkan || asked;
            return cpuRoute(refusedBecause.empty() ? shm : refusedBecause + "; " + shm, refused);
        }
    }
    if (conversion == EncoderTuning::ConvertLinux::Vulkan) {
        const std::string no = vulkanConvertRefusal(f);
        if (no.empty()) {
            r.conversion = LinuxRoute::Conversion::Vulkan;
            r.route = "Vulkan compute → VA-API";
        } else {
            r.conversion = LinuxRoute::Conversion::Gl;
            r.route = "EGL → VA-API";
            r.refused = true;
            convertWhy = asker + " asks for Vulkan compute, GL converts: " + no;
        }
    } else {
        r.conversion = LinuxRoute::Conversion::Gl;
        r.route = "EGL → VA-API";
    }
    r.reason =
        (refusedBecause.empty() ? why : refusedBecause + "; VA-API runs") + "; " + convertWhy;
    return r;
}

} // namespace mw::native
