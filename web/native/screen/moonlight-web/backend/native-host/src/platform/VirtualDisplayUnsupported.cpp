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

#include "mw/native/VirtualDisplay.h"

// The in-process virtual display, on a platform that has none.
//
// Windows: by design — the display there is a driver installed by an elevated
// helper, orchestrated above this module. Linux: not yet — the ScreenCast
// portal's VIRTUAL source is the next step. Either way the honest answer is
// "not here", never a fake success, so the offer above stays consistent with
// what a click would do.

namespace mw::native::vdisplay {

bool isSupported()
{
    return false;
}

std::string unsupportedReason()
{
    return "this build has no in-process virtual display for this platform";
}

bool create(const Spec& spec, std::string* error)
{
    (void)spec;
    if (error) *error = unsupportedReason();
    return false;
}

void destroy() {}

bool isActive()
{
    return false;
}

bool isOnline()
{
    return false;
}

uint32_t mainDisplay()
{
    return 0;
}

bool setMain(uint32_t displayId, std::string* error)
{
    (void)displayId;
    if (error) *error = unsupportedReason();
    return false;
}

uint32_t displayId()
{
    return 0;
}

} // namespace mw::native::vdisplay
