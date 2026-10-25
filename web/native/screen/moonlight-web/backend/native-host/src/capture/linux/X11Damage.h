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

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>

namespace mw::native::capture {

/// An X server's own word that the picture changed, where the scanout cannot
/// say it.
///
/// ── Why the scanout is not enough under X11 ─────────────────────────────────
///
/// KmsCapture wakes on a new buffer: a compositor flips between two or three,
/// and a new one on the plane is a new picture. An X server does not always
/// flip. It COPIES into the buffer it scans out whenever a flip cannot show the
/// picture: a window presented without waiting for the vblank (a game with its
/// sync off), or any window on a desktop spread over several screens, where the
/// one root buffer covers them all and no window can be flipped onto it alone.
/// The buffer then stays the same while its content changes, and the capture —
/// seeing the same buffer at every vblank — handed out one picture for the
/// whole session: Rise of the Tomb Raider in full screen, sync off, buffer 451
/// all along, one frame captured in five seconds (UM790Pro, 30/09/2026).
///
/// The X server knows exactly what it drew: DAMAGE reports every rendering
/// operation, and one damage object on the root window hears all of them. The
/// same game raised 80 events a second on the captured screen, a still desktop
/// none. This watches the captured display's rectangle of the root and raises
/// a flag the capture takes at its next vblank: the same buffer, read again.
///
/// ── Loaded, not linked ──────────────────────────────────────────────────────
///
/// libX11 and libXdamage through dlopen, as X11Pointer loads libX11: one binary
/// for the X desktop, the Wayland one and the headless KMS host, no -dev
/// package to build it, and nothing loaded where there is no X server to ask.
/// A Wayland session's DISPLAY is Xwayland's, which sees only its own windows —
/// and a Wayland compositor flips anyway: not watched there.
///
/// ── Threads ─────────────────────────────────────────────────────────────────
///
/// A connection of its own, used by its own thread alone — the one X11Pointer
/// holds belongs to the input side — so no Xlib call is ever shared. libX11 has
/// initialised its locks itself since 1.8; this needs none of them anyway.
class X11Damage
{
public:
    X11Damage() = default;
    ~X11Damage();

    X11Damage(const X11Damage&) = delete;
    X11Damage& operator=(const X11Damage&) = delete;

    /// Watch the root of $DISPLAY for changes inside [left, right) × [top,
    /// bottom), in root coordinates — the captured display's rectangle. On a
    /// second call the rectangle is replaced and the watch goes on. False, with
    /// why, where there is no X server to ask: no DISPLAY, Xwayland, no library,
    /// a refused connection, no DAMAGE extension.
    bool watch(int left, int top, int right, int bottom, std::string& why);
    void stop();
    bool watching() const { return m_Thread.joinable(); }

    /// Whether anything was drawn on the rectangle since the last call.
    bool takeChanged() { return m_Changed.exchange(false, std::memory_order_acq_rel); }

    /// Damage events on the rectangle so far, for the session's closing line.
    uint64_t events() const { return m_Events.load(std::memory_order_relaxed); }

private:
    void run();
    void unload();

    // Xlib's own types, spelled out so no X header is needed (X11Pointer).
    using Display = void;
    using XID = unsigned long;

    void* m_X11 = nullptr;
    void* m_Xdamage = nullptr;
    Display* m_Display = nullptr;
    int m_EventBase = 0;

    Display* (*m_XOpenDisplay)(const char*) = nullptr;
    int (*m_XCloseDisplay)(Display*) = nullptr;
    XID (*m_XDefaultRootWindow)(Display*) = nullptr;
    int (*m_XConnectionNumber)(Display*) = nullptr;
    int (*m_XPending)(Display*) = nullptr;
    int (*m_XNextEvent)(Display*, void*) = nullptr;
    int (*m_XFlush)(Display*) = nullptr;
    int (*m_XDamageQueryExtension)(Display*, int*, int*) = nullptr;
    XID (*m_XDamageCreate)(Display*, XID, int) = nullptr;

    std::thread m_Thread;
    std::atomic<bool> m_Stop{false};
    /// The connection died under us (the X server went away): see the .cpp.
    std::atomic<bool> m_Dead{false};
    std::atomic<bool> m_Changed{false};
    std::atomic<uint64_t> m_Events{0};
    std::atomic<int> m_Left{0};
    std::atomic<int> m_Top{0};
    std::atomic<int> m_Right{0};
    std::atomic<int> m_Bottom{0};
};

} // namespace mw::native::capture
