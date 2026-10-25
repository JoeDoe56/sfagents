/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
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

/**
 * The two diagnostic modes, each switched on from either of two places.
 *
 *   debug    the options a debug build shows (the VE shader list and the
 *            rest of `debug_build`), and every browser's console sent to the
 *            server's client log.
 *   verbose  the log keeps its DEBUG lines and gains the libraries' own
 *            (libdatachannel, Qt's network categories); the browsers turn
 *            their pipeline diagnostics on.
 *
 * The admin page's boxes (Advanced) are kept in settings.json and hold across
 * restarts. --debug and --verbose turn a mode on for one run and leave the
 * file alone; the box then shows it on, and cannot turn it off.
 *
 * Read from any thread. The stream worker is told through its config line
 * (StreamWorkerHost), since some of its launchers take fixed arguments.
 */
namespace mw::run {

void setDebugFromCli(bool on);
void setDebugSetting(bool on);
bool debugFromCli();
/// Either source.
bool debug();

void setVerboseFromCli(bool on);
void setVerboseSetting(bool on);
bool verboseFromCli();
/// Either source.
bool verbose();

/// Bring the logging in line with verbose(): the Logger's threshold, Qt's
/// network categories and libdatachannel's logger. Idempotent, and cheap when
/// nothing changed; call it after either verbose setter.
void applyVerboseLogging();

} // namespace mw::run
