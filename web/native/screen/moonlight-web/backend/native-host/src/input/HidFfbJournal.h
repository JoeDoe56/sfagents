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

#include "mw/native/HidPassthrough.h"

#include <cstdint>
#include <map>
#include <optional>
#include <vector>

namespace mw::native::input::hid {

/// A recreated wheel's force feedback as the game left it, kept from the
/// operations that made it (plan « garder le volant », 11/10/2026).
///
/// A game sends an effect's header once, when it creates the effect, and
/// afterwards only what changes: a constant force's magnitude, a start, a
/// stop. When the wheel outlives a stream, the next page meets a game that
/// will never send those headers again, and its player would drop every
/// update for an effect it does not know. replay() gives that page the
/// operations that rebuild the state from nothing: the device's gain, every
/// effect with its last parameters, started again when it still plays.
class FfbJournal
{
public:
    /// One operation as the device decoded it (slot ignored).
    void record(const HidFfb& op, int64_t nowMs);

    /// What a fresh player needs to reach the same state, in order: gain,
    /// then each effect (header, envelope, conditions by axis, periodic,
    /// constant, ramp, start when it still plays), then a pause if the game
    /// paused the device. Slots are left at 0.
    std::vector<HidFfb> replay(int64_t nowMs) const;

    /// Effects known, played or not.
    size_t effects() const { return m_effects.size(); }

private:
    struct Effect
    {
        std::optional<HidFfb> header;
        std::optional<HidFfb> envelope;
        std::optional<HidFfb> periodic;
        std::optional<HidFfb> constant;
        std::optional<HidFfb> ramp;
        std::map<int32_t, HidFfb> conditions; // by axis
        bool playing = false;
        int64_t startedAtMs = 0;
        int32_t loops = 1;
    };
    bool stillPlays(const Effect& e, int64_t nowMs) const;

    std::map<int, Effect> m_effects;
    std::optional<HidFfb> m_gain;
    bool m_paused = false;
};

} // namespace mw::native::input::hid
