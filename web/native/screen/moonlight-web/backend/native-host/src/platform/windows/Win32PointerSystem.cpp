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

#include "Win32PointerSystem.h"

#include <windows.h>

namespace mw::native {

bool Win32PointerSystem::mousePresent()
{
    return ::GetSystemMetrics(SM_MOUSEPRESENT) != 0;
}

bool Win32PointerSystem::readMouseKeys(MouseKeysState& out)
{
    MOUSEKEYS keys = {};
    keys.cbSize = sizeof(keys);
    if (!::SystemParametersInfoW(SPI_GETMOUSEKEYS, sizeof(keys), &keys, 0)) return false;
    out.flags = keys.dwFlags;
    out.maxSpeed = keys.iMaxSpeed;
    out.timeToMaxSpeed = keys.iTimeToMaxSpeed;
    out.ctrlSpeed = keys.iCtrlSpeed;
    return true;
}

bool Win32PointerSystem::writeMouseKeys(const MouseKeysState& state)
{
    MOUSEKEYS keys = {};
    keys.cbSize = sizeof(keys);
    keys.dwFlags = state.flags;
    keys.iMaxSpeed = state.maxSpeed;
    keys.iTimeToMaxSpeed = state.timeToMaxSpeed;
    keys.iCtrlSpeed = state.ctrlSpeed;
    // No SPIF_UPDATEINIFILE: the session's setting only, never the profile's,
    // so a process that dies holding them leaves them on until sign-out at
    // most. No SPIF_SENDCHANGE either: nothing listens for this one.
    return ::SystemParametersInfoW(SPI_SETMOUSEKEYS, sizeof(keys), &keys, 0) != FALSE;
}

bool restoreMouseKeys(const MouseKeysState& saved, std::string& how)
{
    Win32PointerSystem system;
    switch (PointerPresence::restoreIfOurs(system, saved)) {
    case PointerPresence::Step::Restored:
        how = "Mouse Keys put back as they were before the stream";
        return true;
    case PointerPresence::Step::LeftAlone:
        how = "Mouse Keys already put back, or changed since — left as they are";
        return true;
    default:
        how = "Mouse Keys could not be put back (error " + std::to_string(::GetLastError()) +
              ") — they stay on until sign-out";
        return false;
    }
}

} // namespace mw::native
