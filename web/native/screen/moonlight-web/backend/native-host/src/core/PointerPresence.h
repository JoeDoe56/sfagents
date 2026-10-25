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

#include "mw/native/MouseKeys.h"

#include <cstdint>

namespace mw::native {

/// What PointerPresence asks of the OS, apart so that its decisions can be
/// tested without one (Win32PointerSystem on Windows).
class PointerSystem
{
public:
    virtual ~PointerSystem() = default;
    /// Whether the OS counts a pointing device (SM_MOUSEPRESENT). Mouse Keys
    /// turned on count as one.
    virtual bool mousePresent() = 0;
    virtual bool readMouseKeys(MouseKeysState& out) = 0;
    /// For the session only: never written to the user's profile, so whatever
    /// happens to the process, signing out puts them back.
    virtual bool writeMouseKeys(const MouseKeysState& state) = 0;
};

/// Makes Windows show its pointer on a host with no pointing device, for the
/// length of a stream.
///
/// Such a host draws no pointer at all: GetCursorInfo says hidden, with no
/// cursor handle, and Desktop Duplication and WGC agree — so the stream has
/// nothing to composite, the client nothing to draw, and the viewer steers
/// blind (N95 bench, 16/10/2026; Parsec shows none either). Injected input
/// moves the position and changes nothing else: SendInput is not a device.
/// Mouse Keys are one. Turned on, they make SM_MOUSEPRESENT true at once and
/// the pointer shows within two seconds; put back, it is gone again.
///
/// What Sunshine has done since 2023 (enable_mouse_keys), with three things
/// more: the settings a stream writes are recognisable, so what the user
/// changed meanwhile is left alone; they are re-checked every second, which
/// covers a mouse unplugged mid-stream and a second stream on the same host
/// (the first to end puts them back, the other turns them on again); and the
/// session reports what it holds, so the server can put them back after a
/// worker that died holding them (restoreMouseKeys).
///
/// The cost, on such a host and during the stream only: with Num Lock off, the
/// numeric keypad moves the pointer and its 5 clicks. The host's Num Lock
/// follows the client's.
class PointerPresence
{
public:
    /// MKF_MOUSEKEYSON, MKF_AVAILABLE: on, and nothing else — no icon in the
    /// notification area, no sound, no shortcut to toggle them.
    static constexpr uint32_t kOn = 0x00000001;
    static constexpr uint32_t kAvailable = 0x00000002;
    /// Slowest, as Sunshine sets them: a keypad pressed by mistake creeps.
    static constexpr uint32_t kMaxSpeed = 10;
    static constexpr uint32_t kTimeToMaxSpeed = 1000;
    /// How often the loop's calls actually look. Two system calls each time.
    static constexpr int64_t kIntervalUs = 1000 * 1000;

    enum class Step
    {
        /// Nothing done: not due, a pointing device is there, or Mouse Keys
        /// are already on (the user's, or another stream's).
        None,
        /// Turned on; saved() holds what was there before.
        TurnedOn,
        /// Could not be read or turned on; nothing changed.
        Failed,
        /// Turned off by someone else during the stream (another stream that
        /// ended, the user): no longer ours. The same poll may turn them on
        /// again — see poll().
        Lost,
        /// Put back as they were.
        Restored,
        /// Changed since they were turned on: left as they are.
        LeftAlone,
    };

    explicit PointerPresence(PointerSystem& system)
        : m_System(system)
    {}

    /// The settings a stream writes.
    static MouseKeysState ours()
    {
        MouseKeysState s;
        s.flags = kOn | kAvailable;
        s.maxSpeed = kMaxSpeed;
        s.timeToMaxSpeed = kTimeToMaxSpeed;
        return s;
    }

    /// Whether @p current is on as a stream sets them. The flags are not
    /// compared whole: Windows adds bits of its own (MKF_LEFTBUTTONSEL), and
    /// the user's own settings differ in the speeds anyway.
    static bool isOurs(const MouseKeysState& current)
    {
        return (current.flags & kOn) != 0 && current.maxSpeed == kMaxSpeed &&
               current.timeToMaxSpeed == kTimeToMaxSpeed;
    }

    /// Put @p saved back if Mouse Keys are still on as a stream sets them.
    static Step restoreIfOurs(PointerSystem& system, const MouseKeysState& saved)
    {
        MouseKeysState current;
        if (!system.readMouseKeys(current)) return Step::Failed;
        if (!isOurs(current)) return Step::LeftAlone;
        return system.writeMouseKeys(saved) ? Step::Restored : Step::Failed;
    }

    /// From the session's loop, as often as it likes: looks once per
    /// kIntervalUs, the first call at once. When it reports Lost, the caller
    /// polls again with the same clock to turn them back on.
    Step poll(int64_t nowUs)
    {
        if (m_Looked && nowUs - m_LastUs < kIntervalUs) return Step::None;
        m_Looked = true;
        m_LastUs = nowUs;

        if (m_Engaged) {
            MouseKeysState current;
            if (!m_System.readMouseKeys(current) || (current.flags & kOn) != 0) return Step::None;
            m_Engaged = false;
            // Looked at again straight away by the caller: due now.
            m_Looked = false;
            return Step::Lost;
        }

        if (m_System.mousePresent()) return Step::None;
        MouseKeysState current;
        if (!m_System.readMouseKeys(current)) return failedOnce();
        if ((current.flags & kOn) != 0) return Step::None;
        if (!m_System.writeMouseKeys(ours())) return failedOnce();
        m_Saved = current;
        m_Engaged = true;
        return Step::TurnedOn;
    }

    /// At the end of the stream. Idempotent.
    Step release()
    {
        if (!m_Engaged) return Step::None;
        m_Engaged = false;
        return restoreIfOurs(m_System, m_Saved);
    }

    bool engaged() const { return m_Engaged; }
    const MouseKeysState& saved() const { return m_Saved; }

private:
    /// A refusal is said once a session: it would be the same every second.
    Step failedOnce()
    {
        if (m_FailedOnce) return Step::None;
        m_FailedOnce = true;
        return Step::Failed;
    }

    PointerSystem& m_System;
    MouseKeysState m_Saved;
    bool m_Engaged = false;
    bool m_Looked = false;
    bool m_FailedOnce = false;
    int64_t m_LastUs = 0;
};

} // namespace mw::native
