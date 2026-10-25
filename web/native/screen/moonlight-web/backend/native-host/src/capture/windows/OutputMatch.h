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

// Which of its adapter's outputs a session's display is, NOW.
//
// DXGI opens an output by its index on the adapter, and that index is not the
// display's: DXGI lists the output holding the primary desktop first, so the
// index of every screen moves when another one becomes primary. Found on the
// N95 bench (16/10/2026): a Mac streaming "Display 1" while an iPhone started
// on MoonlightWeb's virtual display, which the server makes primary. The
// virtual display's outputs are listed under the GPU that renders them — the
// same UHD Graphics as Display 1 — so it took index 0, Display 1 went to 1, the
// Mac's duplication was lost, and the restart reopened index 0: the Mac's
// stream jumped to the iPhone's display.
//
// So the session holds on to the display itself — DisplayInfo::key, the
// monitor device path QueryDisplayConfig reports (it does not move when Windows
// renumbers), or the GDI name ("\\.\DISPLAY1") when the probe had no path —
// and looks its index up again each time the capture opens.
//
// Pure, no Windows: tested on every OS, like PaintedPointer.h.

#include <cctype>
#include <string>
#include <vector>

namespace mw::native::capture {

/// One output of the capture's adapter, as it stands right now.
struct OutputIdentity
{
    /// DXGI_OUTPUT_DESC::DeviceName, e.g. "\\.\DISPLAY1".
    std::string gdiName;
    /// The monitor device path of each monitor this output scans out to, as
    /// QueryDisplayConfig reports them — DisplayInfo::key's spelling. More
    /// than one for a clone group, none when Windows did not say.
    std::vector<std::string> monitorPaths;
};

/// Case-insensitive, ASCII: device paths and GDI names are both, and Windows
/// does not promise one case for them.
inline bool sameDeviceName(const std::string& a, const std::string& b)
{
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i)
        if (std::tolower(static_cast<unsigned char>(a[i])) !=
            std::tolower(static_cast<unsigned char>(b[i])))
            return false;
    return true;
}

/// The index, in @p outputs (DXGI's order), of the display the session was
/// started on: the one whose monitor is @p key. The GDI name @p gdiName stands
/// in only where no path can tell — the probe had none (@p key is then the GDI
/// name itself), or Windows gave none for that output now. An output whose
/// paths are known and do not include @p key is never taken by its name: a
/// GDI name can pass to another monitor, and taking it would be the jump this
/// exists to prevent. -1 when the display is not among them — gone, or away
/// for a moment: the capture then waits for it, as for a locked screen.
inline int outputIndexOf(const std::vector<OutputIdentity>& outputs, const std::string& key,
                         const std::string& gdiName)
{
    const bool keyIsPath = !key.empty() && !sameDeviceName(key, gdiName);
    if (keyIsPath) {
        for (size_t i = 0; i < outputs.size(); ++i)
            for (const std::string& path : outputs[i].monitorPaths)
                if (sameDeviceName(path, key)) return static_cast<int>(i);
    }
    const std::string& name = gdiName.empty() ? key : gdiName;
    if (name.empty()) return -1;
    for (size_t i = 0; i < outputs.size(); ++i) {
        if (keyIsPath && !outputs[i].monitorPaths.empty()) continue;
        if (sameDeviceName(outputs[i].gdiName, name)) return static_cast<int>(i);
    }
    return -1;
}

} // namespace mw::native::capture
