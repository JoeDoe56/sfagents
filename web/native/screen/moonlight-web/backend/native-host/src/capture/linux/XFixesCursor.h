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

#include "../CaptureTypes.h"

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

// The pointer of an app in its own gamescope, as gamescope's Xwayland knows it.
//
// gamescope keeps the pointer out of its PipeWire picture (it lives on a plane
// of its own) and sends no cursor metadata either (bench §8s.13), so a client
// that draws the pointer itself would draw none. Its Xwayland does know it:
// XFixes gives the shape and its hotspot, XQueryPointer the position — right
// there, unlike the desktop's rootless Xwayland (X11Pointer.h), since
// gamescope moves Xwayland's pointer itself. A game that hides the pointer
// gives X an empty shape: no ink, nothing to draw. Read on a thread of its
// own, with a connection of its own: Punktfunk's reader does the same (4 ms
// there, 8 ms here — the session's gate throttles what is sent anyway).
//
// libX11 and libXfixes are opened on first use, like X11Pointer's libX11.

namespace mw::native::capture {

class XFixesCursor
{
public:
    XFixesCursor() = default;
    ~XFixesCursor();

    XFixesCursor(const XFixesCursor&) = delete;
    XFixesCursor& operator=(const XFixesCursor&) = delete;

    /// Read the pointer of the X display @p display (":2"). @p changed runs on
    /// the reader's thread each time it moves, changes shape, shows or hides.
    bool start(const std::string& display, std::function<void(const CursorState&)> changed,
               std::string& error);
    void stop();

private:
    struct Api;
    void run();

    std::thread m_Thread;
    std::atomic<bool> m_Stopping{false};
    /// The X connection broke — gamescope went, its Xwayland with it.
    std::atomic<bool> m_Broken{false};
    void* m_Display = nullptr;
    unsigned long m_Root = 0;
    int m_EventBase = 0;
    std::function<void(const CursorState&)> m_Changed;
    CursorState m_State;
};

} // namespace mw::native::capture
