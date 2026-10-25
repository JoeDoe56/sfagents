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
#include <sstream>
#include <string>

// The virtual monitor a desktop's streams share, on GNOME's direct route
// (MutterScreenCast.h; plan Idées Punktfunk, C2, Bruno's decision of
// 01/10/2026): every stream on the virtual display shows the same desktop, as
// every stream on Windows captures the one virtual display.
//
//  - The owner's stream makes the monitor, at its client's size, primary, and
//    records it here.
//  - A guest's records that monitor as it is (RecordMonitor).
//  - A guest with no monitor to record — nobody else streams — makes one,
//    primary too, and records it here; the owner's, when it comes, takes over,
//    and the guest moves to it.
//  - The monitor goes with the stream that made it (the screen cast is that
//    stream's): the guests recording it lose their picture, and the first of
//    them back makes the next one.
//
// Two files in the user's runtime directory, one desktop's:
//  - a lock, held while a stream makes, finds or removes the monitor. Each of
//    those makes Mutter rebuild its monitors, and concurrent rebuilds crashed
//    gnome-shell (Punktfunk: three RecordVirtual within 200 µs; two a second
//    apart; one landing during a removal). Held until the layout settles;
//  - the record: which monitor, which process made it — its pid AND its start
//    time, since a pid the kernel has given to another process is not it.
//
// This header is the record's arithmetic and the choices made on it, which
// every platform's test run covers; SharedMonitor.cpp is the files.

namespace mw::native::capture {

/// The shared monitor, as its maker recorded it.
struct SharedMonitor
{
    std::string connector; ///< "Meta-0"
    int pid = 0;           ///< the process whose screen cast holds it
    /// That process's start, in clock ticks after boot (/proc/<pid>/stat).
    uint64_t started = 0;
    /// Made by the owner's stream: a guest's monitor yields to it.
    bool owner = false;

    bool valid() const { return !connector.empty() && pid > 0; }
};

inline bool sameSharedMonitor(const SharedMonitor& a, const SharedMonitor& b)
{
    return a.connector == b.connector && a.pid == b.pid && a.started == b.started;
}

/// The record's one line: "mw1 <connector> <pid> <start> owner|guest".
inline std::string formatSharedMonitor(const SharedMonitor& m)
{
    return "mw1 " + m.connector + " " + std::to_string(m.pid) + " " + std::to_string(m.started) +
           (m.owner ? " owner\n" : " guest\n");
}

/// False on anything else: another version's record, a torn write.
inline bool parseSharedMonitor(const std::string& text, SharedMonitor& out)
{
    out = SharedMonitor{};
    std::istringstream in(text);
    std::string tag, connector, who;
    long long pid = 0;
    unsigned long long started = 0;
    if (!(in >> tag >> connector >> pid >> started >> who)) return false;
    if (tag != "mw1" || pid <= 0 || pid > 0x7fffffff || (who != "owner" && who != "guest"))
        return false;
    out.connector = connector;
    out.pid = static_cast<int>(pid);
    out.started = started;
    out.owner = who == "owner";
    return true;
}

/// What a stream starting on the virtual display does.
enum class SharedMonitorPlan
{
    Make,   ///< a monitor of its own, primary, recorded as the shared one
    Record, ///< the shared monitor, as it is
};

/// The owner's stream always makes its own — at its client's size, which is
/// the virtual display's promise to the owner. A guest's records the shared
/// monitor when one is there (@p registered, made by a process still running,
/// and @p present in the layout), and makes one only when there is none.
inline SharedMonitorPlan planSharedMonitor(bool owner, const SharedMonitor& registered,
                                           bool present)
{
    if (owner) return SharedMonitorPlan::Make;
    return registered.valid() && present ? SharedMonitorPlan::Record : SharedMonitorPlan::Make;
}

/// Whether a guest's running stream should start over on another monitor:
/// @p shown is what it shows — the record it made (@p made) or the one it
/// records — and @p now the record as it stands (invalid when there is none,
/// or its maker is gone). A guest that made the monitor moves when another
/// stream's took over: the owner's came. A guest that records it moves when
/// its maker left, or another monitor took over. The owner's stream never
/// moves: its monitor is the one the others come to.
inline bool sharedMonitorMoved(bool owner, bool made, const SharedMonitor& shown,
                               const SharedMonitor& now)
{
    if (owner || !shown.valid()) return false;
    if (made) return now.valid() && !sameSharedMonitor(now, shown);
    return !now.valid() || !sameSharedMonitor(now, shown);
}

/// The start time out of a /proc/<pid>/stat line: field 22, counted after
/// the command's closing parenthesis — a command may hold spaces and
/// parentheses of its own. 0 when the line is not one.
inline uint64_t startTimeFromStat(const std::string& stat)
{
    const size_t close = stat.rfind(')');
    if (close == std::string::npos) return 0;
    std::istringstream in(stat.substr(close + 1));
    std::string field;
    // Fields 3 (state) to 21, then 22.
    for (int i = 3; i <= 21; ++i)
        if (!(in >> field)) return 0;
    unsigned long long started = 0;
    if (!(in >> started)) return 0;
    return started;
}

// ── The files (SharedMonitor.cpp, Linux) ─────────────────────────────────────

/// The lock a stream holds while it makes, finds or removes the monitor.
class SharedMonitorLock
{
public:
    SharedMonitorLock() = default;
    ~SharedMonitorLock() { release(); }
    SharedMonitorLock(const SharedMonitorLock&) = delete;
    SharedMonitorLock& operator=(const SharedMonitorLock&) = delete;

    /// Wait at most @p waitMs for it. False, with @p why, when it could not be
    /// had — the caller goes on without, and says so: a stream is not refused
    /// for want of a lock.
    bool take(int waitMs, std::string& why);
    void release();
    bool held() const { return m_Fd >= 0; }

private:
    int m_Fd = -1;
};

/// The shared monitor recorded on this desktop, when its maker still runs.
bool readSharedMonitor(SharedMonitor& out);

/// This process's record for @p connector — what publishSharedMonitor writes.
SharedMonitor ownSharedMonitor(const std::string& connector, bool owner);

/// Record @p monitor as the shared one. False when it could not be written.
bool publishSharedMonitor(const SharedMonitor& monitor);

/// This process's @p connector is going: its record is removed, if it is
/// still the one recorded.
void withdrawSharedMonitor(const std::string& connector);

} // namespace mw::native::capture
