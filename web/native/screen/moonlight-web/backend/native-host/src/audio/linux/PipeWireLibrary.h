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

namespace mw::native::audio {

/// Whether libpipewire-0.3 could be opened (on the first call, then cached).
/// The audio tap, the host mute and the portal capture ask before pw_init:
/// without it they fail with a message that names the missing library,
/// instead of the loop that could not be created.
bool pipeWireAvailable();

/// The message those three give when it is not.
constexpr const char* kPipeWireMissing = "libpipewire-0.3 is not installed on this machine";

} // namespace mw::native::audio
