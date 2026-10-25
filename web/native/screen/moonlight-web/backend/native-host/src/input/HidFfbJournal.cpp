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

#include "input/HidFfbJournal.h"

namespace mw::native::input::hid {

namespace {

int32_t field(const HidFfb& op, const char* name, int32_t fallback)
{
    for (const auto& [n, v] : op.fields)
        if (n == name) return v;
    return fallback;
}

/// PID's loop count: 255 is DirectInput's INFINITE.
constexpr int32_t kLoopsForever = 255;

} // namespace

void FfbJournal::record(const HidFfb& op, int64_t nowMs)
{
    if (op.op == "gain") {
        m_gain = op;
        return;
    }
    if (op.op == "control") {
        if (op.kind == "reset") {
            m_effects.clear();
            m_paused = false;
        } else if (op.kind == "stopAll" || op.kind == "disable") {
            // The page's player stops every effect on both (hidppFfb.js).
            for (auto& [id, e] : m_effects)
                e.playing = false;
        } else if (op.kind == "pause") {
            m_paused = true;
        } else if (op.kind == "continue") {
            m_paused = false;
        }
        return;
    }
    if (op.effect <= 0) return;
    if (op.op == "free") {
        m_effects.erase(op.effect);
        return;
    }
    Effect& e = m_effects[op.effect];
    HidFfb kept = op;
    kept.slot = 0;
    if (op.op == "effect")
        e.header = kept;
    else if (op.op == "envelope")
        e.envelope = kept;
    else if (op.op == "condition")
        e.conditions[field(op, "axis", 0)] = kept;
    else if (op.op == "periodic")
        e.periodic = kept;
    else if (op.op == "constant")
        e.constant = kept;
    else if (op.op == "ramp")
        e.ramp = kept;
    else if (op.op == "start" || op.op == "solo") {
        if (op.op == "solo")
            for (auto& [id, other] : m_effects)
                if (id != op.effect) other.playing = false;
        e.playing = true;
        e.startedAtMs = nowMs;
        e.loops = field(op, "loops", 1);
    } else if (op.op == "stop")
        e.playing = false;
}

bool FfbJournal::stillPlays(const Effect& e, int64_t nowMs) const
{
    if (!e.playing) return false;
    if (!e.header || e.loops >= kLoopsForever) return true;
    const int32_t duration = field(*e.header, "duration", -1);
    if (duration < 0) return true;
    const int64_t loops = e.loops > 0 ? e.loops : 1;
    const int64_t endsAt = e.startedAtMs + field(*e.header, "delay", 0) + duration * loops;
    return nowMs < endsAt;
}

std::vector<HidFfb> FfbJournal::replay(int64_t nowMs) const
{
    std::vector<HidFfb> out;
    if (m_gain) out.push_back(*m_gain);
    for (const auto& [id, e] : m_effects) {
        for (const std::optional<HidFfb>* part : {&e.header, &e.envelope})
            if (*part) out.push_back(**part);
        for (const auto& [axis, c] : e.conditions)
            out.push_back(c);
        for (const std::optional<HidFfb>* part : {&e.periodic, &e.constant, &e.ramp})
            if (*part) out.push_back(**part);
        if (stillPlays(e, nowMs)) {
            HidFfb start;
            start.op = "start";
            start.effect = id;
            start.fields = {{"loops", e.loops}};
            out.push_back(start);
        }
    }
    if (m_paused) {
        HidFfb pause;
        pause.op = "control";
        pause.kind = "pause";
        out.push_back(pause);
    }
    for (HidFfb& op : out)
        op.slot = 0;
    return out;
}

} // namespace mw::native::input::hid
