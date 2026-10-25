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

#include <cstdint>
#include <string>
#include <vector>

// What this machine can actually do, established by asking the OS — never by
// asking the user. See NativeHost::probe().
//
// Everything here is plain C++17 with no Qt and no GPL dependency: this module
// is kept separable on purpose (see LICENSE.md next to this tree).

namespace mw::native {

/// Video codecs the engine can produce. Ordered by preference, best first —
/// Selector walks this enum in order, so the ordering is load-bearing.
enum class Codec
{
    Av1,  ///< royalty-free patent licence (AOMedia), best quality per bit
    Hevc, ///< today's default for MoonlightWeb streams
    H264, ///< universal floor
};

const char* toString(Codec c);

/// Which vendor API an encoder is reached through. Never shown to the user as a
/// choice (§11 of the mission: no NVIDIA/AMD/Intel/Software selector) — it is
/// surfaced read-only in the stats overlay so a user can report what ran.
enum class EncoderApi
{
    None,
    Nvenc,           ///< NVIDIA Video Codec SDK
    Amf,             ///< AMD Advanced Media Framework
    Vpl,             ///< Intel oneVPL / libvpl
    VaApi,           ///< Linux, AMD + Intel
    VideoToolbox,    ///< Apple
    MediaFoundation, ///< Windows, whatever encoder the OS exposes without a vendor SDK
    Software,        ///< OpenH264, on the CPU
};

const char* toString(EncoderApi a);

/// Which capture API a display is grabbed through.
enum class CaptureApi
{
    None,
    DxgiDuplication,        ///< Windows, primary
    WindowsGraphicsCapture, ///< Windows, automatic fallback
    PipeWire,               ///< Linux, via the ScreenCast portal (fallback)
    ScreenCaptureKit,       ///< macOS 12.3+
    Kms,                    ///< Linux, DRM/KMS scanout framebuffer (primary)
};

const char* toString(CaptureApi a);

/// A packed driver version (GpuInfo::driverVersion) as Windows writes it:
/// "32.0.101.7088". Empty for 0, a version nobody gave.
inline std::string driverVersionText(uint64_t driverVersion)
{
    if (driverVersion == 0) return {};
    return std::to_string((driverVersion >> 48) & 0xffff) + "." +
           std::to_string((driverVersion >> 32) & 0xffff) + "." +
           std::to_string((driverVersion >> 16) & 0xffff) + "." +
           std::to_string(driverVersion & 0xffff);
}

/// The same four parts packed, for the list of excluded drivers and its tests.
constexpr uint64_t driverVersionOf(uint16_t a, uint16_t b, uint16_t c, uint16_t d)
{
    return (static_cast<uint64_t>(a) << 48) | (static_cast<uint64_t>(b) << 32) |
           (static_cast<uint64_t>(c) << 16) | static_cast<uint64_t>(d);
}

/// A GPU, as the OS enumerates it.
struct GpuInfo
{
    /// Stable within one process run; the index into Capabilities::gpus.
    int id = -1;
    std::string name;      ///< e.g. "NVIDIA GeForce RTX 4070"
    uint32_t vendorId = 0; ///< PCI vendor id (0x10DE NVIDIA, 0x1002 AMD, 0x8086 Intel)
    uint32_t deviceId = 0;

    /// The user-mode driver's version, packed as Windows gives it — four
    /// 16-bit parts, the first in the top bits — so that versions compare as
    /// numbers: what the D3D12 route's list of excluded drivers reads
    /// (VideoPipelineChoice.h). 0 where the platform does not say;
    /// driverVersionText() writes it as Windows does.
    uint64_t driverVersion = 0;

    /// Opaque, platform-specific handle to the adapter this describes: a
    /// DXGI LUID on Windows, a DRM render-node path hash on Linux, a Metal
    /// registry id on macOS. The engine uses it to re-open the exact same
    /// adapter the display is attached to (see DisplayInfo::gpuId); nothing
    /// outside the module should interpret it.
    uint64_t nativeHandle = 0;

    /// Which encoder APIs answered on this GPU, best first. Empty means the GPU
    /// is present but has no usable encoder — a real case (very old cards,
    /// virtualized adapters) and the reason software fallback exists at all.
    std::vector<EncoderApi> encoders;

    /// Codecs this GPU's best encoder can produce. The intersection with what
    /// the browser can decode is computed later, per session.
    std::vector<Codec> codecs;

    /// True when the encoder can produce 10-bit output (HEVC Main10 / AV1
    /// 10-bit), which is what HDR requires.
    bool supports10Bit = false;

    /// The subset of `codecs` whose encoder can do 4:4:4 chroma. Per codec, not
    /// per GPU: NVENC does 4:4:4 in H.264 and HEVC but not in AV1 (SDK 12), so
    /// a single bit would either deny 4:4:4 to HEVC or promise it to AV1 and
    /// fail the session. MoonlightWeb already offers this choice for external
    /// hosts, so the native engine has to answer it honestly rather than
    /// silently downgrade: 4:2:0 throws away three quarters of the colour
    /// resolution, which is invisible on video and very visible on text and
    /// thin UI lines — exactly what a desktop stream is.
    std::vector<Codec> codecs444;

    bool supports444(Codec codec) const;
    /// Any codec at all — what the host list asks before a session exists.
    bool supportsAny444() const { return !codecs444.empty(); }
};

/// An encoder that belongs to the machine rather than to a GPU.
///
/// Two very different things wear this shape, and deliberately so: an encoder
/// the OS exposes without a vendor SDK (a Media Foundation transform, which may
/// well be driving fixed-function silicon we have no SDK for — Qualcomm's, say)
/// and an encoder that runs on the CPU (OpenH264). What they have in common is
/// the only thing the Selector needs: neither is tied to an adapter, so reaching
/// one never costs a cross-GPU copy, and neither is ever *preferred* over a GPU
/// that can encode.
///
/// That last point is the whole reason this is not simply appended to
/// GpuInfo::encoders. The Selector's rule is "the display's own GPU, unless it
/// cannot encode"; a software entry on the iGPU's list would make that rule
/// choose the CPU over an NVENC sitting in the same machine. Kept apart, the
/// fallback tier is unreachable until every GPU has been ruled out, and every
/// existing selection is byte-for-byte what it was.
struct FallbackEncoder
{
    EncoderApi api = EncoderApi::None;

    /// Codecs this fallback can actually produce. Usually H.264 alone: it is the
    /// codec every browser decodes in hardware, which is the point — a host too
    /// weak to encode in hardware must not also make the client decode in
    /// software.
    std::vector<Codec> codecs;

    /// True when the OS handed us fixed-function hardware after all (a hardware
    /// Media Foundation transform). Load-bearing for ordering — hardware first,
    /// always — and worth saying out loud in the log, because "no encoder on any
    /// GPU, and yet not encoding on the CPU" is otherwise a confusing line.
    bool hardware = false;

    /// What answered, for the log and the stats overlay, e.g. "Qualcomm H.264
    /// Encoder MFT" or "OpenH264 2.6.0". English, never shown as a choice.
    std::string name;
};

/// What kind of screen a display is. The browser draws the machine a display
/// belongs to on its card — a laptop for a built-in panel, a monitor for an
/// external one, a mini-PC for a machine with no real screen — so this is
/// presentation, never a streaming decision.
enum class DisplayKind
{
    Unknown,  ///< the platform could not tell (the Linux portal's single "Screen")
    BuiltIn,  ///< the panel of a laptop or an all-in-one
    External, ///< a monitor on a cable
    Virtual,  ///< no panel at all: a virtual display driver or a dummy plug
};

const char* toString(DisplayKind k);
DisplayKind displayKindFromString(const std::string& s);

/// Windows: a DISPLAYCONFIG_OUTPUT_TECHNOLOGY value, passed as its raw integer
/// so this stays testable off Windows, and the monitor's EDID name.
DisplayKind classifyOutputTechnology(long long technology, const std::string& monitorName);

/// Linux: a DRM connector name — "eDP-1", "HDMI-A-1", "Virtual-1".
DisplayKind classifyConnectorName(const std::string& connector);

/// Whether a monitor name gives away a screen that is not one: a virtual
/// display driver ("VDD by MTT") or an HDMI dummy plug. Case-insensitive.
bool nameLooksVirtual(const std::string& monitorName);

/// A display, as the OS enumerates it. This is what the user picks from — and
/// the ONLY thing they are ever asked to pick (§13 of the mission).
struct DisplayInfo
{
    /// An enumeration index, carried in SessionConfig::displayId. Not stable:
    /// on Windows a display that appears or turns primary moves the others'.
    /// Above this module the app id the browser launches is kept per `key`.
    int id = -1;

    /// What the user sees, already formatted by the platform layer: the OS's
    /// own number and nothing else, e.g. "Display 1".
    std::string label;

    /// The same display spelled out for the log — monitor name and mode, e.g.
    /// "M27Q — 2560×1440 · 165 Hz". Never shown to the user; it is what the
    /// label used to carry before it became a card title.
    std::string detail;

    int width = 0;
    int height = 0;
    /// Refresh rate in millihertz, so 143.98 Hz survives the trip. Divide by
    /// 1000 for display; the engine uses the exact value to pace capture.
    int refreshMilliHz = 0;

    /// The GPU that physically drives this output — GpuInfo::id. This is the
    /// whole point of §12: capturing on GPU A to encode on GPU B costs a
    /// VRAM→RAM→VRAM round trip that dwarfs everything else in the pipeline.
    int gpuId = -1;

    /// True when the OS reports this output in an HDR mode right now. It is a
    /// live property, not a capability: a display that CAN do HDR but is in SDR
    /// mode reports false, because that is what capture would actually yield.
    bool hdrActive = false;

    /// True when this is the OS's primary display. Used only to pick a default
    /// ordering, never to restrict the choice.
    bool primary = false;

    /// Built-in panel, external monitor or no screen at all — see DisplayKind.
    DisplayKind kind = DisplayKind::Unknown;

    /// The monitor's own name when the OS has one — the EDID name on Windows,
    /// AppKit's on macOS ("Studio Display"). Empty on Linux, whose probe has
    /// no EDID reader.
    std::string model;

    /// What identifies this screen across restarts and re-plugs, unlike `id`
    /// (an enumeration index): the monitor device path on Windows, the card
    /// and connector on Linux, the display UUID on macOS. Opaque; the browser
    /// only hashes it, so a card keeps the same picture for as long as the
    /// screen it stands for exists.
    std::string key;
    /// The name the OS addresses a display mode change to: the GDI device
    /// name on Windows ("\\.\DISPLAY3"). Empty on the other platforms, which
    /// change no modes yet.
    std::string osName;

    /// This display's own route to a picture, when it is not the machine's
    /// (Capabilities::capture). None means the machine's. Linux's portal
    /// virtual display is the one case: it exists only inside a ScreenCast
    /// session, whatever route the monitors beside it take.
    CaptureApi capture = CaptureApi::None;
};

/// DisplayInfo::key of the display a Linux ScreenCast portal creates for the
/// stream (source type VIRTUAL): it does not exist before the session asks for
/// it, at the client's size, and goes with it. The server recognises it by
/// this key rather than by name — the probe does not know the edition's name.
constexpr const char* kPortalVirtualDisplayKey = "portal-virtual";

/// DisplayInfo::key of the screen Steam's Big Picture gets in its own
/// gamescope, on Linux (GamescopeSession.h): made at the client's size when the
/// stream starts, kept ten minutes after the last one. Recognised by this key,
/// like the portal's virtual display.
constexpr const char* kGamescopeSteamDisplayKey = "gamescope-steam";

/// DisplayInfo::key of the screen any app of the user's gets in its own
/// gamescope, on Linux: one entry for them all, never a card itself — the
/// server makes one card per app in its settings and hands the session the
/// app's name and command (SessionConfig::gamescopeApp).
constexpr const char* kGamescopeAppDisplayKey = "gamescope-app";

/// Whether @p key is a screen the stream makes for itself at the client's size
/// — the portal's virtual display, or a gamescope's — rather than a monitor.
inline bool isMadeForStreamKey(const std::string& key)
{
    return key == kPortalVirtualDisplayKey || key == kGamescopeSteamDisplayKey ||
           key == kGamescopeAppDisplayKey;
}

/// Why the native engine cannot run here. The caller maps every one of these to
/// the SAME user-facing sentence (§23: "not available on this configuration —
/// install Sunshine"), so the distinction exists for logs and telemetry only.
enum class Unavailability
{
    None, ///< the engine is usable

    NoDisplay,            ///< headless: nothing attached (no virtual display in v1)
    NoCaptureApi,         ///< Windows: DDA and WGC both failed · Linux: no portal
    CapturePermission,    ///< macOS Screen Recording (TCC) not granted
    NoEncoder,            ///< no encoder at all: no GPU, and no fallback either
    NoInteractiveSession, ///< Windows service with nobody logged in (§13)
    OsTooOld,             ///< Win10 < 2004 · macOS < 12.3 · Linux without PipeWire
    ArchNotSupported,     ///< no platform backend compiled in (platform/Unimplemented.cpp)
    ProbeFailed,          ///< the probe itself threw or timed out
};

const char* toString(Unavailability u);

/// Everything probe() found. `available` is the only field callers outside this
/// module need to branch on; the rest feeds the stats overlay and the logs.
struct Capabilities
{
    bool available = false;
    Unavailability reason = Unavailability::ProbeFailed;

    std::vector<GpuInfo> gpus;
    std::vector<DisplayInfo> displays;

    /// Encoders of last resort, best first — hardware transforms before CPU
    /// ones. Empty on a machine where every GPU encodes, because nothing looks
    /// for them there: probing costs a transform enumeration or a codec
    /// instantiation, and probe() runs on every host-list refresh.
    std::vector<FallbackEncoder> fallbacks;

    /// The capture API that answered. Recorded so a session that silently fell
    /// back from DDA to WGC says so somewhere.
    CaptureApi capture = CaptureApi::None;

    /// Free-form, English, for the log line only. Never shown to a user.
    std::string diagnostic;

    /// Whether the machine runs on a battery of its own. Tells a MacBook from
    /// an iMac, and a Mac mini from a MacBook driving an external monitor, for
    /// the picture on the card. A UPS or a wireless mouse is not one.
    bool hasBattery = false;

    /// Whether the OS lets this program post keyboard and mouse events.
    ///
    /// macOS alone can say no (Accessibility, `kTCCServicePostEvent`), and it
    /// says it in the worst way there is: every `CGEventPost` is accepted and
    /// dropped, so the stream shows and does not answer. It is NOT an
    /// `Unavailability` — a host that streams a picture nobody can drive is
    /// still a host, and the machine must keep appearing in the list saying
    /// what it needs. The probe asks the OS for the grant so the question
    /// reaches the user at the install's first launch, beside Screen
    /// Recording, rather than at the first click of the first stream.
    ///
    /// True on every other platform: Windows and Linux ask nobody.
    bool inputPermission = true;

    const GpuInfo* gpuFor(const DisplayInfo& display) const;

    /// Whether any GPU can genuinely encode — an encoder API AND a codec it can
    /// produce. The condition that gates the whole fallback tier, shared between
    /// probe() and select() so the two can never disagree about which world they
    /// are in.
    bool anyGpuEncodes() const;
};

/// The fallback encoder a session would use if it got that far — hardware
/// before software, then the platform probe's own order. Null when the tier is
/// empty, and meaningless unless anyGpuEncodes() is false.
///
/// Public because two callers must agree: the Selector chooses with it, and
/// /api/native/status NAMES the result. A status page answering from its own
/// idea of the order would be a second policy, and the first machine where the
/// two disagreed would be a machine whose status page lies.
const FallbackEncoder* bestFallback(const Capabilities& caps);

/// Whether a gamepad can be presented to the OS right now.
///
/// Deliberately NOT a field of Capabilities: a missing gamepad bus never makes
/// the engine unavailable — it is a clean degradation, keyboard and mouse
/// intact — and probe() runs on every host-list refresh, which is no place to
/// open and close a driver handle.
struct VirtualGamepad
{
    /// False on a platform with no virtual-pad backend at all. Nothing the user
    /// installs would change that, so nothing must be offered to them.
    bool supported = false;

    /// The driver answered. This is the only trustworthy form of the question:
    /// a registry key or a file on disk survives a partial uninstall and lies.
    bool present = false;

    /// English, for the log line. Never shown to a user.
    std::string diagnostic;
};

} // namespace mw::native
