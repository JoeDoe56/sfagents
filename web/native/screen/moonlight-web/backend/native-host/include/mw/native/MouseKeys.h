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
#include <functional>
#include <string>

namespace mw::native {

/// Windows' Mouse Keys, the fields of MOUSEKEYS a stream changes and puts back
/// (SPI_GETMOUSEKEYS / SPI_SETMOUSEKEYS).
///
/// A Windows host with no pointing device at all — a mini-PC, a living-room
/// PC — does not draw the pointer: GetCursorInfo says hidden, with no cursor
/// handle, and every capture agrees, so no viewer ever sees one. Mouse Keys
/// count as a pointing device: turned on, they make Windows show the pointer
/// within two seconds (N95 bench, 16/10/2026). A stream on such a host turns
/// them on and puts them back at its end — see core/PointerPresence.h.
struct MouseKeysState
{
    uint32_t flags = 0;
    uint32_t maxSpeed = 0;
    uint32_t timeToMaxSpeed = 0;
    uint32_t ctrlSpeed = 0;

    bool operator==(const MouseKeysState& other) const
    {
        return flags == other.flags && maxSpeed == other.maxSpeed &&
               timeToMaxSpeed == other.timeToMaxSpeed && ctrlSpeed == other.ctrlSpeed;
    }
};

/// A session turned Mouse Keys on (@p on, with the settings it found before,
/// @p saved) or no longer holds them (@p on false, @p saved empty).
using MouseKeysCallback = std::function<void(bool on, const MouseKeysState& saved)>;

#ifdef _WIN32
/// Put back the Mouse Keys a session turned on and could not put back itself:
/// its process died. The server calls it when such a worker is gone; it must
/// run in the console session, where the setting lives.
///
/// Leaves them alone unless they are still on as a stream sets them: a
/// session that did put them back, the user who changed them since. Another
/// stream running on the same host turns them on again within a second. @p how
/// gets one sentence for the log either way.
bool restoreMouseKeys(const MouseKeysState& saved, std::string& how);
#endif

} // namespace mw::native
