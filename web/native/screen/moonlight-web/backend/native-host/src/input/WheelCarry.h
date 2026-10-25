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

namespace mw::native::input {

/// Wheel travel in the wire's 120-unit notches, turned into whole notches for
/// a sink that only takes whole ones (evdev's REL_WHEEL), with the rest kept
/// for the next event.
///
/// The browser does not always send a notch at a time: a free-spinning or
/// high-resolution wheel, a touchpad, or Chrome's smooth scrolling hand over a
/// notch in pieces of 30 or 40 units. Divided one event at a time, every piece
/// was 0 and was thrown away, and only the events that happened to carry a
/// whole notch scrolled — about one in four on the UM790Pro streamed from
/// DualRTX (12/10/2026). Windows keeps the leftover itself (SendInput adds
/// partial deltas up); this does the same for Linux.
///
/// A change of direction starts over: what was left of the other way is not a
/// part of the notch the user is now turning.
class WheelCarry
{
public:
    static constexpr int32_t kNotch = 120;

    /// Add an amount from the wire and return the whole notches it completes.
    int32_t add(int32_t amount)
    {
        if ((m_Pending > 0 && amount < 0) || (m_Pending < 0 && amount > 0)) m_Pending = 0;
        m_Pending += amount;
        const int32_t notches = m_Pending / kNotch;
        m_Pending -= notches * kNotch;
        return notches;
    }

    int32_t pending() const { return m_Pending; }

private:
    int32_t m_Pending = 0; ///< always within (-kNotch, kNotch)
};

} // namespace mw::native::input
