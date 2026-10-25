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

// ─────────────────────────────────────────────────────────────────────────────
//  A virtual display the engine creates ITSELF, in this process.
//
//  This is the platform seam for the OSes that can conjure a display without
//  a driver: macOS today (CoreGraphics' virtual display, the mechanism behind
//  BetterDisplay and DeskPad), Linux Wayland next (the ScreenCast portal's
//  VIRTUAL source). Windows is deliberately absent: there the display is a
//  third-party IddCx driver installed by an elevated helper, orchestrated
//  above this module (backend/src/backend/VirtualDisplay*.cpp), and nothing
//  here has to know.
//
//  The display lives exactly as long as this process holds it: create() in
//  the server, and it is gone when the server exits. That is a feature — no
//  device node to clean up, nothing left behind on the machine — and it is
//  why the caller re-creates it at startup from its own settings.
//
//  One display per process. A second create() replaces the first.
// ─────────────────────────────────────────────────────────────────────────────

namespace mw::native::vdisplay {

struct Spec
{
    int width = 1920;
    int height = 1080;
    int refreshHz = 60;
    /// macOS: a display able to show HDR — Extended Dynamic Range, PQ, BT.2020
    /// primaries. Measured on mw-mac (15.6.1, 24/09/2026): the mode's transfer
    /// function 1 with BT.2020 primaries gives the display an EDR headroom of
    /// 5.0 (0 and 2 to 5 stay at 1.0, SDR), and the probe then reports it HDR
    /// like any EDR panel. Asked only for a viewer who asked for HDR: an SDR
    /// stream off a display declared in BT.2020 would come out washed.
    bool hdr = false;
    /// What the OS shows as the monitor's name. Contains "Virtual" so the
    /// probe classifies it DisplayKind::Virtual (Capabilities.h,
    /// nameLooksVirtual) — keep that word in it.
    std::string name = "MoonlightWeb Virtual Display";
};

/// Can this build, on this OS, create a virtual display? On macOS the classes
/// are private CoreGraphics ones, resolved at run time: an OS that renamed
/// them answers false here, with the reason in unsupportedReason(), rather
/// than crashing on a missing selector.
bool isSupported();
std::string unsupportedReason();

/// Create the process' virtual display with the given mode. Returns false with
/// @p error filled (English) when the OS refused. On success the display is
/// registered with the OS but may take a moment to come online: poll
/// isOnline() — the caller's event loop, not a sleep here.
bool create(const Spec& spec, std::string* error);

/// Release it. The OS removes the display at once; a stream on it ends.
void destroy();

/// A display created by this process exists (created and not destroyed).
bool isActive();

/// The OS has finished bringing the created display up: it is in the display
/// list the probe reads. False while it is still appearing, or when none.
bool isOnline();

/// The OS' identifier of the created display (a CGDirectDisplayID on macOS),
/// 0 when none. For logs and for matching the probe's list.
uint32_t displayId();

/// The OS' current main display (the one the menu bar is on), 0 when unknown.
/// Read before the created display takes the role, so it can be given back.
uint32_t mainDisplay();

/// Make a display the main one — ours once it is online, or the previous
/// main again before ours is released. Returns false with @p error filled
/// when the OS refused (a display that is not online, for one).
bool setMain(uint32_t displayId, std::string* error);

} // namespace mw::native::vdisplay
