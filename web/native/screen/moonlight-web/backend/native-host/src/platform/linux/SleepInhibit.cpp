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

#include "SleepInhibit.h"

#include "../../core/Log.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <spawn.h>
#include <string>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

namespace mw::native {

void SleepInhibit::engage()
{
    if (m_Child > 0) return;

    int fds[2];
    if (::pipe2(fds, O_CLOEXEC) != 0) {
        log::info(std::string("[native] priority: cannot keep the machine awake (pipe: ") +
                  std::strerror(errno) + ")");
        return;
    }

    // The child's stdin is the read end; everything else it would inherit —
    // the capture's DRM descriptors, the server's sockets — is closed, so the
    // inhibitor holds nothing of ours but the pipe.
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, fds[0], STDIN_FILENO);
    posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addclosefrom_np(&actions, STDERR_FILENO + 1);

    char* argv[] = {const_cast<char*>("systemd-inhibit"),
                    const_cast<char*>("--what=sleep:idle"),
                    const_cast<char*>("--who=MoonlightWeb"),
                    const_cast<char*>("--why=Streaming this display"),
                    const_cast<char*>("--mode=block"),
                    const_cast<char*>("cat"),
                    nullptr};
    pid_t child = -1;
    const int rc = ::posix_spawnp(&child, "systemd-inhibit", &actions, nullptr, argv, environ);
    posix_spawn_file_actions_destroy(&actions);
    ::close(fds[0]);

    if (rc != 0) {
        ::close(fds[1]);
        log::info(std::string("[native] priority: no systemd-inhibit (") + std::strerror(rc) +
                  ") — the machine keeps its own sleep policy");
        return;
    }
    m_Child = child;
    m_Pipe = fds[1];
    log::info("[native] priority: logind asked to hold off sleep while streaming");
}

void SleepInhibit::release()
{
    if (m_Child <= 0) return;
    ::close(m_Pipe);
    m_Pipe = -1;

    int status = 0;
    pid_t done;
    do {
        done = ::waitpid(m_Child, &status, 0);
    } while (done < 0 && errno == EINTR);
    m_Child = -1;

    // cat ends at end of input with 0, and systemd-inhibit passes that on. A
    // refusal — polkit, no logind — ends it early with its own error.
    if (done > 0 && WIFEXITED(status) && WEXITSTATUS(status) != 0)
        log::info("[native] priority: logind refused to hold off sleep (systemd-inhibit exit " +
                  std::to_string(WEXITSTATUS(status)) + ")");
}

} // namespace mw::native
