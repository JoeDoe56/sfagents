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

namespace mw::native::capture {

/// Where a display's picture sits in the buffer its primary plane scans out.
///
/// ── Why a display may read only part of its buffer ──────────────────────────
///
/// A Wayland compositor gives every output a buffer of its own, and a lone
/// screen under X11 scans out the root window, which is its size: buffer and
/// picture are one. An X11 desktop spread over several screens is the case that
/// is not: the root window spans all of them, and each screen's plane reads its
/// window of that one buffer, from where the screen sits on the desktop. A
/// 1920×1080 screen beside a 2560×1440 one scans out a 4480×1440 buffer from
/// (0,0); its neighbour reads the same buffer from (1920,0). Taken whole, it was
/// read as a mode change at every frame, and no screen of such a desktop was
/// ever captured (UM790Pro, 30/09/2026).
///
/// The plane says which window: SRC_X/Y/W/H. Only a window at the display's own
/// size is taken — a plane that scales its source (SRC smaller or larger than
/// the mode) shows a picture this capture would have to scale back, which no
/// desktop does, and is refused as the mode change it most likely is.
///
/// Pure, like the other geometry the capture decides on, so every platform's
/// test run exercises it.
struct ScanoutWindow
{
    /// The buffer can be captured for this display.
    bool usable = false;
    /// The picture is a window of a bigger buffer, at (x, y).
    bool windowed = false;
    int x = 0;
    int y = 0;
};

/// @param bufferWidth/Height the framebuffer's size (GETFB2)
/// @param modeWidth/Height   the display's mode
/// @param srcX..srcH         the primary plane's SRC rectangle, in whole pixels
///                           (the property is 16.16 fixed point: shifted by the
///                           caller); all 0 where the driver has no such
///                           properties, and then only a buffer of the mode's
///                           size is usable.
inline ScanoutWindow scanoutWindow(int bufferWidth, int bufferHeight, int modeWidth, int modeHeight,
                                   int64_t srcX, int64_t srcY, int64_t srcW, int64_t srcH)
{
    ScanoutWindow window;
    if (bufferWidth <= 0 || bufferHeight <= 0 || modeWidth <= 0 || modeHeight <= 0) return window;
    if (bufferWidth == modeWidth && bufferHeight == modeHeight && srcX == 0 && srcY == 0) {
        window.usable = true;
        return window;
    }
    if (srcW != modeWidth || srcH != modeHeight || srcX < 0 || srcY < 0 ||
        srcX + srcW > bufferWidth || srcY + srcH > bufferHeight)
        return window;
    window.usable = true;
    window.windowed = true;
    window.x = static_cast<int>(srcX);
    window.y = static_cast<int>(srcY);
    return window;
}

} // namespace mw::native::capture
