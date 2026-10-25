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

#include <sys/types.h>

namespace mw::native {

/// Keeps a Linux host from suspending under a stream: a logind inhibitor on
/// "sleep:idle", held for the session. A viewer watching without touching
/// anything sends no input, and the machine would otherwise suspend under
/// the stream — which the viewer sees as the picture freezing for good.
/// Screen blanking stays the desktop's business (DisplaySleep, in the server).
///
/// ── Why a child process, not a D-Bus call ────────────────────────────────────
///
/// logind hands out inhibitors only over D-Bus, and this module's one D-Bus
/// library, sd-bus, is an LGPL exception bounded to the ScreenCast portal
/// (LICENSE.md). So the inhibitor is taken by systemd-inhibit, the host's own
/// tool, running `cat` on a pipe this process holds the other end of. Closing
/// that end ends `cat`, and with it the inhibitor. So does this process dying,
/// however it dies: the kernel closes the pipe, and no inhibitor outlives the
/// host. A machine without systemd-inhibit simply keeps its own power policy;
/// it is said in the log, never a reason to fail the session.
class SleepInhibit
{
public:
    SleepInhibit() = default;
    ~SleepInhibit() { release(); }
    SleepInhibit(const SleepInhibit&) = delete;
    SleepInhibit& operator=(const SleepInhibit&) = delete;

    /// Takes the inhibitor. Idempotent.
    void engage();

    /// Drops it, and says if logind had refused it. Idempotent.
    void release();

private:
    pid_t m_Child = -1;
    int m_Pipe = -1; // the write end; closing it ends the child
};

} // namespace mw::native
