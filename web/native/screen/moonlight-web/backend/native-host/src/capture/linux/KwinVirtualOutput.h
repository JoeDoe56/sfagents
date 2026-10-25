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
#include <memory>
#include <string>

// A virtual output KWin makes for one stream, streamed to PipeWire — KDE
// Plasma 6's virtual display, whose portal offers none (Plasma 6.3 lists
// source types 3: monitor and window, plan Idées Punktfunk C3, 01/10/2026).
//
// KWin's own protocol, zkde_screencast_unstable_v1: stream_virtual_output
// (name, width, height, scale, pointer) makes an output of that LOGICAL size,
// and the stream object answers with the PipeWire node it fills. The output
// lives as long as this Wayland connection holds the stream: stop() — or the
// process ending — removes it.
//
// ⚠️ A restricted protocol. KWin advertises it only to a client it trusts: one
// whose executable (/proc/<pid>/exe, read by KWin itself) is the Exec of an
// installed .desktop file that lists zkde_screencast_unstable_v1 under
// X-KDE-Wayland-Interfaces — the grant krfb and krdp ship. Two consequences:
//  - a process holding a capability cannot be read by KWin, and is never
//    trusted: the package's worker asks through PortalScreenCast's helper,
//    which runs the same binary with every capability dropped;
//  - KWin reads the grant when the session starts: a grant installed later
//    counts from the next login.
//
// libwayland-client is opened with dlopen, as WaylandLayout opens it: one
// binary for every desktop, and nothing to load on a host that has none.

namespace mw::native::capture {

class KwinVirtualOutput
{
public:
    KwinVirtualOutput();
    ~KwinVirtualOutput();

    KwinVirtualOutput(const KwinVirtualOutput&) = delete;
    KwinVirtualOutput& operator=(const KwinVirtualOutput&) = delete;

    /// What this process finds on the session's Wayland socket: @p kwin when
    /// the compositor is KWin (its output-device global is there for anyone),
    /// @p granted when KWin also hands this process the screencast protocol at
    /// a version that makes virtual outputs. False, with @p why, when there is
    /// no compositor to ask.
    static bool probe(bool& kwin, bool& granted, std::string& why);

    /// Ask KWin for an output of @p width × @p height logical pixels at scale
    /// 1, named after @p name, and wait for the PipeWire @p node it streams
    /// to. The pointer comes as metadata beside the picture. Held until stop().
    bool start(const std::string& name, int width, int height, uint32_t& node, std::string& error);

    /// The output goes, and the stream with it.
    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> d;
};

} // namespace mw::native::capture
