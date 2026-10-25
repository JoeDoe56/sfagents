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

#include "MacPointerAccel.h"

#include "../../core/Log.h"

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/hidsystem/IOHIDLib.h>
#include <IOKit/hidsystem/IOHIDParameter.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>

namespace mw::native::input {
namespace {

int64_t steadyNowUs()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

/// The tracking-speed value System Settings leaves on a Mac nobody has touched.
/// Only a unit: the slider is normalised by it, so a factory Mac reads 1.0.
constexpr double kFactoryScaling = 0.6875;

/// Bounds on the interval between two counts, before it becomes a speed.
///
/// The floor is the real guard. Relative moves cross a network, so a stall
/// delivers a stroke's worth of events in one burst, microseconds apart; read
/// literally, a hand moving at 20 in/s would look like one moving at 2000 and
/// the gain would go through the roof on exactly the packets a bad link
/// produces. A 1 ms floor says "no mouse reports faster than 1 kHz", which is
/// true of every mouse there is, and a burst then reads as the speed the hand
/// really had. The ceiling ends a stroke: past it the counts belong to the
/// next movement, not to a very slow version of this one.
constexpr int64_t kMinIntervalUs = 1000;
constexpr int64_t kMaxIntervalUs = 50 * 1000;

/// How much of the new speed each event is worth. One count is a tiny sample
/// and the curve is steep; without smoothing the gain would flutter between
/// neighbouring events of the same flick.
constexpr double kSpeedSmoothing = 0.3;

/// How often the tracking-speed slider is read again.
constexpr int64_t kRefreshUs = 5 * 1000 * 1000;

/// How many accelerated moves are written to the log when they are asked for.
constexpr uint64_t kLogEvents = 40;

const char* env(const char* name)
{
    const char* value = std::getenv(name);
    if (!value || !*value) return nullptr;
    return value;
}

/// An override, applied only when it is there and sane. A bench types these,
/// and a typo must not silently produce a mouse nobody can aim with.
bool envDouble(const char* name, double& target, double low, double high)
{
    const char* value = env(name);
    if (!value) return false;
    char* end = nullptr;
    const double parsed = std::strtod(value, &end);
    if (end == value || !std::isfinite(parsed) || parsed < low || parsed > high) {
        log::warning(std::string("[native] input: ") + name + "=" + value +
                     " is not a number between " + std::to_string(low) + " and " +
                     std::to_string(high) + " — ignored");
        return false;
    }
    target = parsed;
    return true;
}

/// The tracking-speed slider, as the HID system itself holds it. Returns false
/// when it cannot be read, and a NEGATIVE value when the user has turned
/// acceleration off (`defaults write -g com.apple.mouse.scaling -1`), which is
/// a setting to honour rather than a failure.
bool readMouseScaling(double& scaling)
{
    io_service_t service =
        IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching(kIOHIDSystemClass));
    if (!service) return false;
    io_connect_t connect = 0;
    bool ok = false;
    if (IOServiceOpen(service, mach_task_self(), kIOHIDParamConnectType, &connect) ==
        KERN_SUCCESS) {
        double value = 0;
        // Deprecated since 10.12 and still the only way to ask: what replaced
        // it (IOHIDEventSystemClient) is private, and the preference file
        // behind it is absent on a Mac whose slider was never moved, where
        // this call still answers with the setting in force.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        const kern_return_t asked =
            IOHIDGetAccelerationWithKey(connect, CFSTR(kIOHIDMouseAccelerationType), &value);
#pragma clang diagnostic pop
        if (asked == KERN_SUCCESS) {
            scaling = value;
            ok = true;
        }
        IOServiceClose(connect);
    }
    IOObjectRelease(service);
    return ok;
}

std::string modeName(MacPointerAccel::Mode mode)
{
    switch (mode) {
    case MacPointerAccel::Mode::Off: return "off (1 count = 1 point)";
    case MacPointerAccel::Mode::Linear: return "linear (tracking speed only)";
    case MacPointerAccel::Mode::Curve: break;
    }
    return "curve (tracking speed and ramp)";
}

/// Two decimals, without dragging <iomanip> in for it.
std::string round2(double value)
{
    std::string text = std::to_string(std::round(value * 100.0) / 100.0);
    const size_t dot = text.find('.');
    if (dot != std::string::npos && text.size() > dot + 3) text.resize(dot + 3);
    return text;
}

} // namespace

void MacPointerAccel::start()
{
    m_Mode = Mode::Curve;
    if (const char* mode = env("MW_MOUSE_ACCEL")) {
        if (std::strcmp(mode, "off") == 0 || std::strcmp(mode, "0") == 0)
            m_Mode = Mode::Off;
        else if (std::strcmp(mode, "linear") == 0)
            m_Mode = Mode::Linear;
        else if (std::strcmp(mode, "on") != 0 && std::strcmp(mode, "curve") != 0)
            log::warning(std::string("[native] input: MW_MOUSE_ACCEL=") + mode +
                         " is not off, linear or curve — the curve is used");
    }

    envDouble("MW_MOUSE_ACCEL_MAX", m_GainMax, 1.0, 40.0);
    envDouble("MW_MOUSE_ACCEL_HALF", m_HalfIps, 0.5, 200.0);
    envDouble("MW_MOUSE_ACCEL_POW", m_Power, 0.5, 6.0);
    envDouble("MW_MOUSE_ACCEL_CPI", m_Cpi, 100.0, 32000.0);

    m_Started = false;
    m_NextRefreshUs = 0;
    m_Logged = env("MW_MOUSE_ACCEL_LOG") ? 0 : kLogEvents;
    reset();
    refresh(steadyNowUs());
    m_Started = true;

    if (m_Mode == Mode::Off) {
        log::info("[native] input: pointer acceleration " + modeName(m_Mode));
        return;
    }
    std::string line = "[native] input: pointer acceleration " + modeName(m_Mode) +
                       ", host tracking speed x" + round2(m_Scale);
    if (m_Mode == Mode::Curve)
        line += ", ramp to x" + round2(m_GainMax) + " (half at " + round2(m_HalfIps) +
                " in/s, power " + round2(m_Power) + ")";
    log::info(line);
}

void MacPointerAccel::reset()
{
    m_CarryX = 0;
    m_CarryY = 0;
    m_Speed = 0;
    m_LastEventUs = 0;
}

void MacPointerAccel::refresh(int64_t nowUs)
{
    if (nowUs < m_NextRefreshUs) return;
    m_NextRefreshUs = nowUs + kRefreshUs;

    // An override wins over the system: a bench that pinned the gain does not
    // want it moving underneath between two runs.
    double forced = m_Scale;
    if (envDouble("MW_MOUSE_ACCEL_GAIN", forced, 0.05, 20.0)) {
        m_Scale = forced;
        return;
    }

    double scaling = 0;
    if (!readMouseScaling(scaling)) {
        // Nothing read: the factory setting is a far better guess than none,
        // and it is what the Mac in front of most people is on anyway.
        m_Scale = 1.0;
        return;
    }
    if (scaling < 0) {
        // The user turned acceleration off. Their own mouse is 1:1 on this
        // Mac, so ours is too — that is the whole point of following the host.
        if (m_Started && m_Mode != Mode::Off)
            log::info("[native] input: the host has pointer acceleration turned off — "
                      "relative motion goes in 1:1");
        m_Mode = Mode::Off;
        m_Scale = 1.0;
        return;
    }
    m_Scale = std::clamp(scaling / kFactoryScaling, 0.05, 20.0);
}

double MacPointerAccel::gainFor(double countsPerSecond) const
{
    if (m_Mode == Mode::Off) return 1.0;
    if (m_Mode == Mode::Linear) return m_Scale;

    // Desk speed, in inches per second: the quantity Apple's tables are read
    // at, and the only one that stays meaningful across mice.
    const double ips = countsPerSecond / m_Cpi;
    if (ips <= 0) return m_Scale;

    // A ramp that starts at 1 and saturates at m_GainMax, half-way at
    // m_HalfIps. Saturating rather than open-ended on purpose: a curve that
    // keeps climbing turns one jittery packet into a camera that spins.
    const double v = std::pow(ips, m_Power);
    const double half = std::pow(m_HalfIps, m_Power);
    return m_Scale * (1.0 + (m_GainMax - 1.0) * v / (v + half));
}

void MacPointerAccel::apply(int rawX, int rawY, int& outX, int& outY)
{
    if (m_Mode == Mode::Off) {
        outX = rawX;
        outY = rawY;
        return;
    }

    const int64_t nowUs = steadyNowUs();
    refresh(nowUs);

    const double magnitude =
        std::sqrt(static_cast<double>(rawX) * rawX + static_cast<double>(rawY) * rawY);

    if (m_Mode == Mode::Curve) {
        const int64_t sinceUs = m_LastEventUs > 0 ? nowUs - m_LastEventUs : kMaxIntervalUs;
        if (sinceUs >= kMaxIntervalUs) {
            // A new stroke: the hand starts from a stop, and so does the speed.
            // Without this the first count of a slow, careful aim would inherit
            // the gain of the flick that ended a second ago.
            m_Speed = 0;
            m_CarryX = 0;
            m_CarryY = 0;
        }
        const double intervalS =
            static_cast<double>(std::clamp(sinceUs, kMinIntervalUs, kMaxIntervalUs)) / 1e6;
        const double instant = magnitude / intervalS;
        m_Speed = m_Speed <= 0 ? instant : m_Speed + (instant - m_Speed) * kSpeedSmoothing;
    }
    m_LastEventUs = nowUs;

    const double gain = gainFor(m_Speed);

    // One gain for the pair, from the speed of the movement as a whole: per
    // axis it would bend a diagonal, which is the classic way to make a mouse
    // feel wrong without anyone being able to say why.
    const double wantX = rawX * gain + m_CarryX;
    const double wantY = rawY * gain + m_CarryY;
    outX = static_cast<int>(std::lround(wantX));
    outY = static_cast<int>(std::lround(wantY));
    m_CarryX = wantX - outX;
    m_CarryY = wantY - outY;

    if (m_Logged < kLogEvents) {
        ++m_Logged;
        log::info("[native] input: accel " + std::to_string(rawX) + "," + std::to_string(rawY) +
                  " counts at " + round2(m_Speed / m_Cpi) + " in/s -> x" + round2(gain) + " -> " +
                  std::to_string(outX) + "," + std::to_string(outY) + " pt");
    }
}

} // namespace mw::native::input
