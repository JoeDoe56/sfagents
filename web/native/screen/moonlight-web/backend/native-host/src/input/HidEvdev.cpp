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

#include "input/HidEvdev.h"

#include <algorithm>
#include <climits>
#include <cstdlib>

namespace mw::native::input::hid {

namespace {

constexpr uint32_t kDesktop = 0x01;
constexpr uint32_t kSimulation = 0x02;
constexpr uint32_t kButton = 0x09;

bool isGameApplication(uint32_t application)
{
    const uint32_t page = application >> 16, usage = application & 0xFFFF;
    if (page == kSimulation) return true;
    return page == kDesktop && (usage == 0x04 || usage == 0x05 || usage == 0x08);
}

// hid-input's first choice for an axis usage; 0xFFFF for none.
uint16_t axisCode(uint32_t usage)
{
    const uint32_t page = usage >> 16, id = usage & 0xFFFF;
    if (page == kDesktop) {
        switch (id) {
        case 0x30: return ev::AbsX;
        case 0x31: return ev::AbsY;
        case 0x32: return ev::AbsZ;
        case 0x33: return ev::AbsRx;
        case 0x34: return ev::AbsRy;
        case 0x35: return ev::AbsRz;
        case 0x36: return ev::AbsThrottle; // Slider
        case 0x37: return ev::AbsRudder;   // Dial
        case 0x38: return ev::AbsWheel;
        default: return 0xFFFF;
        }
    }
    if (page == kSimulation) {
        switch (id) {
        case 0xBA: return ev::AbsRudder;
        case 0xBB: return ev::AbsThrottle;
        case 0xC4: return ev::AbsGas;
        case 0xC5: return ev::AbsBrake;
        case 0xC8: return ev::AbsWheel; // Steering
        default: return ev::AbsMisc;    // Clutch and the rest: the next free
        }
    }
    return 0xFFFF;
}

uint32_t bitsAt(const uint8_t* body, size_t size, uint32_t offset, uint16_t width)
{
    uint32_t v = 0;
    for (uint16_t b = 0; b < width && b < 32; ++b) {
        const uint32_t bit = offset + b;
        if (bit / 8 >= size) break;
        if ((body[bit / 8] >> (bit % 8)) & 1u) v |= 1u << b;
    }
    return v;
}

int32_t clampLevel(int32_t v, int32_t lo, int32_t hi)
{
    return std::max(lo, std::min(hi, v));
}

// s16 force or level (±0x7FFF) to ±10000.
int32_t force(int32_t v)
{
    return clampLevel(static_cast<int32_t>((static_cast<int64_t>(v) * 10000) / 0x7FFF), -10000,
                      10000);
}
// u16 0..0xFFFF to 0..10000.
int32_t fraction(uint32_t v)
{
    return static_cast<int32_t>((static_cast<uint64_t>(v) * 10000) / 0xFFFF);
}
// Linux angle (0x10000 a turn) to 1/100°.
int32_t angle(uint32_t v)
{
    return static_cast<int32_t>((static_cast<uint64_t>(v & 0xFFFF) * 36000) / 0x10000);
}

HidFfb op(const char* name, int effect)
{
    HidFfb o;
    o.op = name;
    o.effect = effect;
    return o;
}

} // namespace

EvdevMap evdevMap(const Parsed& parsed)
{
    EvdevMap map;
    map.numbered = !(parsed.reportIds.size() == 1 && parsed.reportIds.front() == 0);
    bool absUsed[ev::AbsMax + 1] = {};
    int hats = 0;
    auto takeAbs = [&](uint16_t want) -> uint16_t {
        if (want <= ev::AbsMax && !absUsed[want] && want != ev::AbsMisc) return want;
        for (uint16_t c = ev::AbsMisc; c <= ev::AbsMax; ++c)
            if (!absUsed[c] && (c < ev::AbsHat0X || c > ev::AbsHat0X + 7)) return c;
        return 0xFFFF;
    };
    for (const Field& f : parsed.fields) {
        if (f.kind != Kind::Input || f.isConstant() || !f.isVariable()) continue;
        if (!isGameApplication(f.application)) continue;
        for (uint32_t i = 0; i < f.count; ++i) {
            uint32_t usage = 0;
            if (f.range)
                usage = f.usageMinimum + i;
            else if (!f.usages.empty())
                usage = f.usages[std::min<size_t>(i, f.usages.size() - 1)];
            if (f.range && usage > f.usageMaximum) break;
            EvdevMap::Item it;
            it.reportId = f.reportId;
            it.bitOffset = f.bitOffset + i * f.size;
            it.size = f.size;
            it.isSigned = f.logicalMinimum < 0;
            it.logicalMinimum = f.logicalMinimum;
            it.logicalMaximum = f.logicalMaximum;
            const uint32_t page = usage >> 16, id = usage & 0xFFFF;
            if (page == kButton && id >= 1) {
                const bool pad = (f.application & 0xFFFF) == 0x05 && (f.application >> 16) == 1;
                const uint32_t n = id - 1;
                const uint32_t code = n <= 0xF ? (pad ? ev::BtnGamepad : ev::BtnJoystick) + n
                                               : ev::BtnTriggerHappy + (n - 0x10);
                if (code > ev::BtnTriggerHappy + 0x27) continue;
                it.kind = EvdevMap::Kind::Key;
                it.code = static_cast<uint16_t>(code);
                if (std::find(map.keys.begin(), map.keys.end(), it.code) != map.keys.end())
                    continue;
                map.keys.push_back(it.code);
            } else if (page == kDesktop && id == 0x39) {
                if (hats >= 4) continue;
                it.kind = EvdevMap::Kind::Hat;
                it.code = static_cast<uint16_t>(ev::AbsHat0X + 2 * hats++);
                absUsed[it.code] = absUsed[it.code + 1] = true;
                map.axes.push_back({it.code, -1, 1});
                map.axes.push_back({static_cast<uint16_t>(it.code + 1), -1, 1});
            } else {
                const uint16_t want = axisCode(usage);
                if (want == 0xFFFF) continue;
                const uint16_t code = takeAbs(want);
                if (code == 0xFFFF) continue;
                absUsed[code] = true;
                it.kind = EvdevMap::Kind::Abs;
                it.code = code;
                map.axes.push_back({code, f.logicalMinimum, f.logicalMaximum});
            }
            map.items.push_back(it);
        }
    }
    return map;
}

void evdevDecode(const EvdevMap& map, const uint8_t* report, size_t size,
                 std::vector<int32_t>& state, std::vector<EvdevEvent>& out)
{
    if (state.size() != map.items.size()) state.assign(map.items.size(), INT32_MIN);
    uint8_t id = 0;
    const uint8_t* body = report;
    size_t bodySize = size;
    if (map.numbered) {
        if (size == 0) return;
        id = report[0];
        ++body;
        --bodySize;
    }
    for (size_t i = 0; i < map.items.size(); ++i) {
        const EvdevMap::Item& it = map.items[i];
        if (it.reportId != id) continue;
        uint32_t raw = bitsAt(body, bodySize, it.bitOffset, it.size);
        int32_t v = static_cast<int32_t>(raw);
        if (it.isSigned && it.size < 32 && ((raw >> (it.size - 1)) & 1u))
            v = static_cast<int32_t>(raw | (~0u << it.size));
        if (state[i] == v) continue;
        state[i] = v;
        if (it.kind == EvdevMap::Kind::Key) {
            out.push_back({ev::Key, it.code, v ? 1 : 0});
        } else if (it.kind == EvdevMap::Kind::Abs) {
            out.push_back({ev::Abs, it.code, v});
        } else {
            // Eight directions from north, clockwise; anything else is centred.
            static const int8_t kX[8] = {0, 1, 1, 1, 0, -1, -1, -1};
            static const int8_t kY[8] = {-1, -1, 0, 1, 1, 1, 0, -1};
            const int32_t span = it.logicalMaximum - it.logicalMinimum + 1;
            int x = 0, y = 0;
            if (v >= it.logicalMinimum && v <= it.logicalMaximum && span > 0) {
                const int dir = static_cast<int>(((v - it.logicalMinimum) * 8) / span);
                x = kX[dir & 7];
                y = kY[dir & 7];
            }
            out.push_back({ev::Abs, it.code, x});
            out.push_back({ev::Abs, static_cast<uint16_t>(it.code + 1), y});
        }
    }
}

std::vector<HidFfb> ffbUpload(const LinuxFfEffect& e)
{
    const int effect = e.id + 1;
    const char* kind = nullptr;
    switch (e.type) {
    case ev::FfConstant: kind = "constant"; break;
    case ev::FfRamp: kind = "ramp"; break;
    case ev::FfSpring: kind = "spring"; break;
    case ev::FfDamper: kind = "damper"; break;
    case ev::FfFriction: kind = "friction"; break;
    case ev::FfInertia: kind = "inertia"; break;
    case ev::FfPeriodic:
        switch (e.waveform) {
        case ev::FfSquare: kind = "square"; break;
        case ev::FfTriangle: kind = "triangle"; break;
        case ev::FfSine: kind = "sine"; break;
        case ev::FfSawUp: kind = "sawtoothUp"; break;
        case ev::FfSawDown: kind = "sawtoothDown"; break;
        default: return {}; // custom waveforms
        }
        break;
    default: return {}; // rumble
    }
    std::vector<HidFfb> ops;
    const bool condition = e.type >= ev::FfSpring && e.type <= ev::FfInertia;
    HidFfb h = op("effect", effect);
    h.kind = kind;
    // The X component of a Linux force is level * sin(direction), as
    // hid-logitech-hidpp computes it: the page's polar convention.
    h.fields = {{"duration", e.length ? static_cast<int32_t>(e.length) : -1},
                {"delay", e.delay},
                {"gain", 255},
                {"direction", angle(e.direction)},
                {"directionEnable", condition ? 0 : 1},
                {"axes", 1}};
    ops.push_back(h);
    if (!condition) {
        HidFfb env = op("envelope", effect);
        env.fields = {{"attackLevel", force(e.attackLevel)},
                      {"attackTime", e.attackLength},
                      {"fadeLevel", force(e.fadeLevel)},
                      {"fadeTime", e.fadeLength}};
        ops.push_back(env);
    }
    if (e.type == ev::FfConstant) {
        HidFfb c = op("constant", effect);
        c.fields = {{"magnitude", force(e.level)}};
        ops.push_back(c);
    } else if (e.type == ev::FfRamp) {
        HidFfb r = op("ramp", effect);
        r.fields = {{"start", force(e.startLevel)}, {"end", force(e.endLevel)}};
        ops.push_back(r);
    } else if (e.type == ev::FfPeriodic) {
        // A negative magnitude is the same wave half a turn later.
        const int32_t phase = angle(e.phase) + (e.magnitude < 0 ? 18000 : 0);
        HidFfb p = op("periodic", effect);
        p.fields = {{"magnitude", std::abs(force(e.magnitude))},
                    {"offset", force(e.offset)},
                    {"phase", phase % 36000},
                    {"period", e.period}};
        ops.push_back(p);
    } else {
        HidFfb c = op("condition", effect);
        c.fields = {{"axis", 0},
                    {"offset", force(e.center)},
                    {"positiveCoefficient", force(e.rightCoeff)},
                    {"negativeCoefficient", force(e.leftCoeff)},
                    {"positiveSaturation", fraction(e.rightSaturation)},
                    {"negativeSaturation", fraction(e.leftSaturation)},
                    {"deadBand", fraction(e.deadband)}};
        ops.push_back(c);
    }
    return ops;
}

HidFfb ffbPlay(int id, int32_t value)
{
    HidFfb o = op(value > 0 ? "start" : "stop", id + 1);
    if (value > 0) o.fields = {{"loops", std::min<int32_t>(value, 255)}};
    return o;
}

HidFfb ffbErase(int id)
{
    return op("free", id + 1);
}

HidFfb ffbGain(int32_t value)
{
    HidFfb o = op("gain", 0);
    o.fields = {
        {"gain",
         clampLevel(static_cast<int32_t>((static_cast<int64_t>(value) * 255) / 0xFFFF), 0, 255)}};
    return o;
}

} // namespace mw::native::input::hid
