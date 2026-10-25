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

#include "input/HidDescriptor.h"

#include "mw/native/HidPassthrough.h"

#include <cstdint>
#include <vector>

/// A recreated wheel's force feedback on a Linux host (plan « Passthrough
/// HID », P4 under Linux, Bruno's go of 05/10).
///
/// ── Why not uhid ────────────────────────────────────────────────────────────
///
/// A uhid device gets no force feedback from the kernel: hid-pidff and
/// hid-logitech-hidpp's 0x8123 setup both refuse a device that is not usbhid
/// ("device is not USB", seen at the bench on 05/10). So a wheel whose motor
/// the page can drive is recreated through /dev/uinput instead: one evdev
/// device with the wheel's axes and buttons, named as hid-input would name
/// them, and the force feedback effects of the Linux input API. Games (SDL,
/// Proton, native) upload effects to it; the host services the uploads from
/// userspace and turns them into the same neutral HidFfb operations the PID
/// block gives on Windows, which the page plays on the real wheel.
///
/// The pieces here are pure, so mw-native-tests checks them on any OS:
/// evdevMap() and evdevDecode() for the input side, ffbUpload() and friends
/// for the effects. linux/UinputWheel.cpp does the system calls.
namespace mw::native::input::hid {

// evdev codes used here (linux/input-event-codes.h), spelled out so the
// mapping builds and is tested everywhere.
namespace ev {
constexpr uint16_t Syn = 0x00, Key = 0x01, Abs = 0x03, Ff = 0x15;
constexpr uint16_t AbsX = 0x00, AbsY = 0x01, AbsZ = 0x02, AbsRx = 0x03, AbsRy = 0x04, AbsRz = 0x05,
                   AbsThrottle = 0x06, AbsRudder = 0x07, AbsWheel = 0x08, AbsGas = 0x09,
                   AbsBrake = 0x0a, AbsHat0X = 0x10, AbsMisc = 0x28, AbsMax = 0x3f;
constexpr uint16_t BtnJoystick = 0x120, BtnGamepad = 0x130, BtnTriggerHappy = 0x2c0;
// Force feedback effect types, waveforms and controls.
constexpr uint16_t FfRumble = 0x50, FfPeriodic = 0x51, FfConstant = 0x52, FfSpring = 0x53,
                   FfFriction = 0x54, FfDamper = 0x55, FfInertia = 0x56, FfRamp = 0x57,
                   FfSquare = 0x58, FfTriangle = 0x59, FfSine = 0x5a, FfSawUp = 0x5b,
                   FfSawDown = 0x5c, FfGain = 0x60, FfAutocenter = 0x61;
} // namespace ev

/// One evdev axis the device declares.
struct EvdevAxis
{
    uint16_t code = 0;
    int32_t minimum = 0;
    int32_t maximum = 0;
};

/// Where each input field of the game collection lands in evdev.
struct EvdevMap
{
    enum class Kind : uint8_t
    {
        Abs,
        Key,
        Hat, // code is the X axis, code + 1 the Y axis
    };
    struct Item
    {
        uint8_t reportId = 0;
        uint32_t bitOffset = 0; // in the report body, after the id byte
        uint16_t size = 0;
        bool isSigned = false;
        Kind kind = Kind::Abs;
        uint16_t code = 0;
        int32_t logicalMinimum = 0;
        int32_t logicalMaximum = 0;
    };
    std::vector<Item> items;
    std::vector<EvdevAxis> axes;
    std::vector<uint16_t> keys;
    bool numbered = false;
};

/// The evdev layout of a descriptor's game collection, the way hid-input
/// maps it: Generic Desktop X..Rz, Slider (throttle), Dial (rudder), Wheel
/// and hats; Simulation steering, accelerator, brake, throttle, rudder;
/// buttons from BTN_JOYSTICK (BTN_GAMEPAD on a game pad), the 17th on from
/// BTN_TRIGGER_HAPPY. A usage whose code is taken goes to the next free one
/// from ABS_MISC, as hid-input does with a second Slider. Vendor fields are
/// left out.
EvdevMap evdevMap(const Parsed& parsed);

struct EvdevEvent
{
    uint16_t type = 0;
    uint16_t code = 0;
    int32_t value = 0;
};

/// The events one input report means, against the values last sent
/// (`state`, one per item, sized by the first call). `report` starts with its
/// id when the map is numbered. No SYN: the caller ends the batch.
void evdevDecode(const EvdevMap& map, const uint8_t* report, size_t size,
                 std::vector<int32_t>& state, std::vector<EvdevEvent>& out);

/// struct ff_effect, the fields the translation reads.
struct LinuxFfEffect
{
    uint16_t type = 0;
    int16_t id = 0;
    uint16_t direction = 0;
    uint16_t length = 0; // ms, 0 = infinite
    uint16_t delay = 0;
    int16_t level = 0;                    // constant
    int16_t startLevel = 0, endLevel = 0; // ramp
    uint16_t attackLength = 0, attackLevel = 0, fadeLength = 0, fadeLevel = 0;
    uint16_t waveform = 0, period = 0; // periodic
    int16_t magnitude = 0, offset = 0;
    uint16_t phase = 0;
    uint16_t rightSaturation = 0, leftSaturation = 0; // condition[0]
    int16_t rightCoeff = 0, leftCoeff = 0;
    uint16_t deadband = 0;
    int16_t center = 0;
};

/// The HidFfb operations an upload means: the effect's header then its
/// parameters (envelope, constant, periodic, ramp or condition), in the
/// host's neutral ranges (forces -10000..10000, saturations 0..10000, times
/// in ms, angles in 1/100°). The effect number is the kernel's id + 1. Empty
/// for what a wheel cannot play (rumble, custom waveforms).
std::vector<HidFfb> ffbUpload(const LinuxFfEffect& effect);
/// EV_FF on an effect: value > 0 starts it (that many times), 0 stops it.
HidFfb ffbPlay(int id, int32_t value);
HidFfb ffbErase(int id);
/// EV_FF FF_GAIN: 0..0xFFFF.
HidFfb ffbGain(int32_t value);

} // namespace mw::native::input::hid
