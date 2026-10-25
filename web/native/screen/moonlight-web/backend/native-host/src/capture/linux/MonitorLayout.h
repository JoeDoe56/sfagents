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

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

// The portal's virtual monitor as the desktop's primary, on GNOME: which
// monitor it is, and where the layout puts it. Pure arithmetic — Mutter's
// D-Bus side is MutterDisplayConfig — so every platform's run covers it.
//
// Windows and macOS make their virtual display the primary for the stream
// (VirtualDisplayApply, MacVirtualDisplay): the taskbar and the menu bar are
// where the viewer is. GNOME adds the portal's monitor at the right end of the
// desktop, an extension with no top bar and no dock — a wallpaper to stream.
// Made primary, the shell comes to it (bench §8s.5). The rules:
//  - nothing is switched off: every logical monitor stays, with its modes,
//    scale and transform. ⛔ Switching the physical screens off crashed
//    gnome-shell 46 on the UM790Pro when they came back (01/10/2026);
//  - the other monitors keep their places relative to one another, moved
//    right by the virtual monitor's width, and it sits on their left, level
//    with the topmost of the leftmost column;
//  - the change is Mutter's TEMPORARY kind: nothing is stored, and Mutter
//    puts the previous layout back by itself when the virtual monitor goes.

namespace mw::native::capture {

/// One monitor as Mutter's DisplayConfig describes it.
struct LayoutMonitor
{
    std::string connector; ///< "Meta-0", "DP-1"…
    std::string vendor;    ///< "MetaVendor" for Mutter's own virtual monitors
    std::string product;
    /// The mode it shows (or prefers), as ApplyMonitorsConfig names it.
    std::string modeId;
    int width = 0;
    int height = 0;
    /// What ApplyMonitorsConfig would reset if not handed back: Mutter 47+'s
    /// colour mode (an HDR screen would drop to SDR) and RGB range, -1 when
    /// the compositor reports none; underscanning when it is on.
    int colorMode = -1;
    int rgbRange = -1;
    bool underscanning = false;
};

/// One logical monitor: a place in the layout and the monitors shown there
/// (several when mirrored).
struct LayoutLogical
{
    int x = 0;
    int y = 0;
    double scale = 1.0;
    uint32_t transform = 0; ///< 1, 3, 5 and 7 turn it a quarter: width and height swap
    bool primary = false;
    std::vector<std::string> connectors;
};

struct DisplayLayout
{
    std::vector<LayoutMonitor> monitors;
    std::vector<LayoutLogical> logical;
    /// Mutter's layout mode 2: positions in physical pixels. Mode 1, the
    /// default, lays logical monitors out at their size divided by the scale.
    bool physicalLayout = false;
};

inline const LayoutMonitor* findLayoutMonitor(const DisplayLayout& layout,
                                              const std::string& connector)
{
    for (const LayoutMonitor& m : layout.monitors)
        if (m.connector == connector) return &m;
    return nullptr;
}

/// Mutter's own virtual monitors — "Meta-<n>", made by a screen cast.
inline bool isMutterVirtual(const LayoutMonitor& monitor)
{
    return monitor.vendor == "MetaVendor";
}

/// The real monitor "Screen" means when GNOME records it itself, with no
/// dialog: the primary when it is a real one, else the first real monitor of
/// the layout. Empty when every monitor is one of Mutter's virtual ones.
inline std::string screenToRecord(const DisplayLayout& layout)
{
    std::string first;
    for (const LayoutLogical& logical : layout.logical) {
        for (const std::string& connector : logical.connectors) {
            const LayoutMonitor* monitor = findLayoutMonitor(layout, connector);
            if (!monitor || isMutterVirtual(*monitor)) continue;
            if (logical.primary) return connector;
            if (first.empty()) first = connector;
        }
    }
    return first;
}

/// The monitor this session made: the virtual monitor of @p width × @p height
/// that was not among @p before — or, when the only one there is was (Mutter
/// gave a freed name to the new one), that one. Empty when none fits, or more
/// than one does: a guess could move another stream's monitor.
inline std::string findSessionVirtual(const DisplayLayout& now,
                                      const std::vector<std::string>& before, int width, int height)
{
    std::vector<std::string> fits;
    std::vector<std::string> fresh;
    for (const LayoutMonitor& m : now.monitors) {
        if (!isMutterVirtual(m) || m.width != width || m.height != height) continue;
        fits.push_back(m.connector);
        bool seen = false;
        for (const std::string& b : before)
            seen = seen || b == m.connector;
        if (!seen) fresh.push_back(m.connector);
    }
    if (fresh.size() == 1) return fresh.front();
    if (fresh.empty() && fits.size() == 1) return fits.front();
    return {};
}

/// The space a logical monitor takes in the layout: its first monitor's mode,
/// turned by its transform, divided by its scale unless the layout counts
/// physical pixels. Zero when its monitor is unknown.
inline void logicalExtent(const DisplayLayout& layout, const LayoutLogical& logical, int& width,
                          int& height)
{
    width = height = 0;
    const LayoutMonitor* m =
        logical.connectors.empty() ? nullptr : findLayoutMonitor(layout, logical.connectors[0]);
    if (!m) return;
    width = m->width;
    height = m->height;
    if (logical.transform % 2 == 1) std::swap(width, height);
    if (!layout.physicalLayout && logical.scale > 0) {
        width = static_cast<int>(std::lround(width / logical.scale));
        height = static_cast<int>(std::lround(height / logical.scale));
    }
}

/// Mutter's word for two rectangles that share a stretch of edge — a corner
/// alone does not count (meta_rectangle_is_adjacent_to).
inline bool layoutAdjacent(int ax, int ay, int aw, int ah, int bx, int by, int bw, int bh)
{
    const bool overlapY = ay < by + bh && by < ay + ah;
    const bool overlapX = ax < bx + bw && bx < ax + aw;
    return ((ax == bx + bw || bx == ax + aw) && overlapY) ||
           ((ay == by + bh || by == ay + ah) && overlapX);
}

/// The layout with @p connector primary on the left of everything else. False
/// with @p why when it cannot be made: the monitor is not in the layout on its
/// own, or the others would no longer touch without it (it sat between them).
/// @p unchanged is set when it is already primary at the origin — nothing to
/// apply.
inline bool primaryLayout(const DisplayLayout& now, const std::string& connector,
                          std::vector<LayoutLogical>& out, bool& unchanged, std::string& why)
{
    out.clear();
    unchanged = false;
    const LayoutLogical* mine = nullptr;
    std::vector<LayoutLogical> others;
    for (const LayoutLogical& l : now.logical) {
        bool holds = false;
        for (const std::string& c : l.connectors)
            holds = holds || c == connector;
        if (!holds) {
            others.push_back(l);
            continue;
        }
        if (l.connectors.size() != 1) {
            why = connector + " mirrors another monitor";
            return false;
        }
        mine = &l;
    }
    if (!mine) {
        why = connector + " is not in the layout";
        return false;
    }
    if (mine->primary && mine->x == 0 && mine->y == 0) {
        unchanged = true;
        out = now.logical;
        return true;
    }
    int width = 0;
    int height = 0;
    logicalExtent(now, *mine, width, height);
    if (width <= 0 || height <= 0) {
        why = connector + " has no mode";
        return false;
    }

    LayoutLogical virt = *mine;
    virt.x = 0;
    virt.y = 0;
    virt.primary = true;
    if (!others.empty()) {
        // The others as they were among themselves, from the origin.
        int minX = others.front().x;
        int minY = others.front().y;
        for (const LayoutLogical& l : others) {
            minX = std::min(minX, l.x);
            minY = std::min(minY, l.y);
        }
        int level = -1;
        for (LayoutLogical& l : others) {
            l.x -= minX;
            l.y -= minY;
            l.primary = false;
            if (l.x == 0 && (level < 0 || l.y < level)) level = l.y;
        }
        virt.y = level;
        for (LayoutLogical& l : others)
            l.x += width;
    }
    out.push_back(virt);
    out.insert(out.end(), others.begin(), others.end());

    // Mutter's own checks (meta_verify_logical_monitor_config_list): every
    // logical monitor touches another, and none overlaps another.
    if (out.size() > 1) {
        for (size_t i = 0; i < out.size(); ++i) {
            int iw = 0, ih = 0;
            logicalExtent(now, out[i], iw, ih);
            bool touches = false;
            for (size_t j = 0; j < out.size(); ++j) {
                if (i == j) continue;
                int jw = 0, jh = 0;
                logicalExtent(now, out[j], jw, jh);
                if (out[i].x < out[j].x + jw && out[j].x < out[i].x + iw &&
                    out[i].y < out[j].y + jh && out[j].y < out[i].y + ih) {
                    why = "the layout would overlap";
                    out.clear();
                    return false;
                }
                touches = touches ||
                          layoutAdjacent(out[i].x, out[i].y, iw, ih, out[j].x, out[j].y, jw, jh);
            }
            if (!touches) {
                why = "the other monitors would not touch without " + connector;
                out.clear();
                return false;
            }
        }
    }
    return true;
}

} // namespace mw::native::capture
