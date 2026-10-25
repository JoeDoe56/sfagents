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

#include "SharedMonitor.h"

#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>

namespace mw::native::capture {
namespace {

/// The user's runtime directory: one desktop's, gone at logout. The worker
/// reads it as usual — its capabilities came over an exec that gained
/// nothing, so it is not AT_SECURE (PortalScreenCast.h).
std::string runtimeDir()
{
    const char* dir = std::getenv("XDG_RUNTIME_DIR");
    if (dir && *dir) return dir;
    return "/run/user/" + std::to_string(::getuid());
}

std::string recordPath()
{
    return runtimeDir() + "/moonlightweb-virtual-display";
}

std::string readFile(const std::string& path)
{
    std::string text;
    if (FILE* f = std::fopen(path.c_str(), "re")) {
        char buffer[512];
        size_t n = 0;
        while ((n = std::fread(buffer, 1, sizeof(buffer), f)) > 0)
            text.append(buffer, n);
        std::fclose(f);
    }
    return text;
}

uint64_t startTimeOf(int pid)
{
    return startTimeFromStat(readFile("/proc/" + std::to_string(pid) + "/stat"));
}

/// The record as it stands, whoever made it, alive or not.
bool readRecord(SharedMonitor& out)
{
    return parseSharedMonitor(readFile(recordPath()), out);
}

} // namespace

bool SharedMonitorLock::take(int waitMs, std::string& why)
{
    release();
    const std::string path = recordPath() + ".lock";
    m_Fd = ::open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (m_Fd < 0) {
        why = path + ": " + std::strerror(errno);
        return false;
    }
    // flock's is the open file's: two streams of one process, each with its
    // own descriptor, wait on each other as two processes do.
    for (int waited = 0;; waited += 50) {
        if (::flock(m_Fd, LOCK_EX | LOCK_NB) == 0) return true;
        if (errno != EWOULDBLOCK && errno != EINTR) {
            why = path + ": " + std::strerror(errno);
            break;
        }
        if (waited >= waitMs) {
            why = "another stream held it for " + std::to_string(waitMs / 1000) + " s";
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    ::close(m_Fd);
    m_Fd = -1;
    return false;
}

void SharedMonitorLock::release()
{
    if (m_Fd < 0) return;
    ::flock(m_Fd, LOCK_UN);
    ::close(m_Fd);
    m_Fd = -1;
}

bool readSharedMonitor(SharedMonitor& out)
{
    if (!readRecord(out)) return false;
    // Its maker still running: the same pid, started at the same moment.
    const bool alive = ::kill(out.pid, 0) == 0 || errno == EPERM;
    if (!alive || startTimeOf(out.pid) != out.started) {
        out = SharedMonitor{};
        return false;
    }
    return true;
}

SharedMonitor ownSharedMonitor(const std::string& connector, bool owner)
{
    SharedMonitor m;
    m.connector = connector;
    m.pid = static_cast<int>(::getpid());
    m.started = startTimeOf(m.pid);
    m.owner = owner;
    return m;
}

bool publishSharedMonitor(const SharedMonitor& monitor)
{
    // Whole or not at all: written aside, then renamed over the record.
    const std::string path = recordPath();
    const std::string aside = path + "." + std::to_string(::getpid());
    const std::string text = formatSharedMonitor(monitor);
    const int fd = ::open(aside.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    const bool written = ::write(fd, text.data(), text.size()) == static_cast<ssize_t>(text.size());
    ::close(fd);
    if (!written || ::rename(aside.c_str(), path.c_str()) != 0) {
        ::unlink(aside.c_str());
        return false;
    }
    return true;
}

void withdrawSharedMonitor(const std::string& connector)
{
    SharedMonitor recorded;
    if (!readRecord(recorded)) return;
    const SharedMonitor mine = ownSharedMonitor(connector, recorded.owner);
    if (sameSharedMonitor(recorded, mine)) ::unlink(recordPath().c_str());
}

} // namespace mw::native::capture
