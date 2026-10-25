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

#include "MonitorLayout.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// GNOME's monitor layout, read and changed over Mutter's DisplayConfig D-Bus
// interface — the one GNOME's own Settings use. It serves the virtual display
// alone (MonitorLayout.h says why it is made primary), whether Mutter's own
// screen cast made it (MutterScreenCast.h) or the portal did, and so lives on
// the portal's route: sd-bus, behind MW_NATIVE_LINUX_PORTAL, under the
// exception LICENSE.md § "L'exception sd-bus" bounds.
//
// Not GNOME — KDE, wlroots, X11 — and nobody answers: every call returns
// false with the reason, and the monitor stays where its compositor put it.
//
// No capability is needed, and none is in the way: Mutter does not look at
// who calls, and the package's worker reads its bus address as usual (no
// AT_SECURE, PortalScreenCast.h). A binary setcap'd directly cannot find the
// bus, and says so.

namespace mw::native::capture {

class MutterDisplayConfig
{
public:
    /// The layout as Mutter has it now, with the serial a change must quote.
    static bool read(DisplayLayout& out, uint32_t& serial, std::string& why);

    /// The connectors Mutter knows now. False, with @p why, when nobody answers.
    static bool connectors(std::vector<std::string>& out, std::string& why);

    /// Make @p connector the desktop's primary, on the left of every other
    /// monitor, until it goes (Mutter's temporary configuration). @p how says
    /// what was done, or why nothing was.
    static bool makePrimary(const std::string& connector, std::string& how);

    /// Wait, at most @p budgetMs, for Mutter to be done rebuilding its
    /// monitors: @p gone out of the layout when one is named, then the
    /// layout's serial still across two reads. A monitor added, removed or
    /// laid out returns its D-Bus call while gnome-shell is still at it, and a
    /// change landing then crashed it (Punktfunk). The milliseconds waited;
    /// nothing is waited for when nobody answers.
    static int settle(const std::string& gone, int budgetMs);
};

/// Mutter's word that its monitors changed (DisplayConfig's MonitorsChanged):
/// a monitor came or went — another stream's, a screen plugged in — or the
/// layout moved, and an absolute pointer mapped on the old one lands beside
/// its mark.
class MutterLayoutWatch
{
public:
    MutterLayoutWatch();
    ~MutterLayoutWatch();
    MutterLayoutWatch(const MutterLayoutWatch&) = delete;
    MutterLayoutWatch& operator=(const MutterLayoutWatch&) = delete;

    /// Listen. False, with @p why, when nobody answers (not GNOME).
    bool start(std::string& why);
    /// Whether the monitors changed since the last call: what the bus has
    /// brought, without a wait.
    bool changed();

private:
    struct Impl;
    std::unique_ptr<Impl> d;
};

} // namespace mw::native::capture
