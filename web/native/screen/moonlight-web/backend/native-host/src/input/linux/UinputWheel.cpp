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
#include "input/VirtualHid.h"

#include <cerrno>
#include <cstring>
#include <mutex>
#include <thread>

#include <fcntl.h>
#include <linux/uinput.h>
#include <poll.h>
#include <sys/eventfd.h>
#include <sys/ioctl.h>
#include <unistd.h>

namespace mw::native::input {

namespace {

constexpr int kMaxEffects = 16;

hid::LinuxFfEffect fromKernel(const ff_effect& k)
{
    hid::LinuxFfEffect e;
    e.type = k.type;
    e.id = k.id;
    e.direction = k.direction;
    e.length = k.replay.length;
    e.delay = k.replay.delay;
    const ff_envelope* env = nullptr;
    switch (k.type) {
    case FF_CONSTANT:
        e.level = k.u.constant.level;
        env = &k.u.constant.envelope;
        break;
    case FF_RAMP:
        e.startLevel = k.u.ramp.start_level;
        e.endLevel = k.u.ramp.end_level;
        env = &k.u.ramp.envelope;
        break;
    case FF_PERIODIC:
        e.waveform = k.u.periodic.waveform;
        e.period = k.u.periodic.period;
        e.magnitude = k.u.periodic.magnitude;
        e.offset = k.u.periodic.offset;
        e.phase = k.u.periodic.phase;
        env = &k.u.periodic.envelope;
        break;
    case FF_SPRING:
    case FF_DAMPER:
    case FF_FRICTION:
    case FF_INERTIA: {
        const ff_condition_effect& c = k.u.condition[0];
        e.rightSaturation = c.right_saturation;
        e.leftSaturation = c.left_saturation;
        e.rightCoeff = c.right_coeff;
        e.leftCoeff = c.left_coeff;
        e.deadband = c.deadband;
        e.center = c.center;
        break;
    }
    default: break;
    }
    if (env) {
        e.attackLength = env->attack_length;
        e.attackLevel = env->attack_level;
        e.fadeLength = env->fade_length;
        e.fadeLevel = env->fade_level;
    }
    return e;
}

/// A wheel recreated through /dev/uinput (HidEvdev.h says why not uhid): its
/// axes and buttons from the descriptor, and force feedback serviced here.
/// One thread per device answers the kernel's effect uploads and erases (a
/// game's EVIOCSFF waits on them) and reads its plays; input() writes events
/// from the caller's thread.
class UinputWheel final : public IVirtualHid
{
public:
    ~UinputWheel() override { destroy(); }

    bool forceFeedbackByPid() const override { return false; }

    bool create(const VirtualHidIdentity& id, std::string& error) override
    {
        m_map = hid::evdevMap(hid::parse(id.descriptor));
        if (m_map.items.empty()) {
            error = "nothing to recreate through uinput (no axis, button or hat)";
            return false;
        }
        m_fd = ::open("/dev/uinput", O_RDWR | O_NONBLOCK | O_CLOEXEC);
        if (m_fd < 0) {
            error = std::string("cannot open /dev/uinput: ") + std::strerror(errno);
            return false;
        }
        bool ok = true;
        auto set = [&](unsigned long request, int value) {
            ok = ok && ::ioctl(m_fd, request, value) == 0;
        };
        if (!m_map.keys.empty()) set(UI_SET_EVBIT, EV_KEY);
        for (uint16_t k : m_map.keys)
            set(UI_SET_KEYBIT, k);
        set(UI_SET_EVBIT, EV_ABS);
        for (const hid::EvdevAxis& a : m_map.axes) {
            set(UI_SET_ABSBIT, a.code);
            uinput_abs_setup abs{};
            abs.code = a.code;
            abs.absinfo.minimum = a.minimum;
            abs.absinfo.maximum = a.maximum;
            // No fuzz, no flat: a wheel's centre is the game's to judge.
            ok = ok && ::ioctl(m_fd, UI_ABS_SETUP, &abs) == 0;
        }
        set(UI_SET_EVBIT, EV_FF);
        for (int f : {FF_CONSTANT, FF_PERIODIC, FF_SQUARE, FF_TRIANGLE, FF_SINE, FF_SAW_UP,
                      FF_SAW_DOWN, FF_RAMP, FF_SPRING, FF_DAMPER, FF_FRICTION, FF_INERTIA, FF_GAIN})
            set(UI_SET_FFBIT, f);
        uinput_setup setup{};
        setup.id.bustype = BUS_USB;
        setup.id.vendor = id.vendorId;
        setup.id.product = id.productId;
        setup.id.version = id.version;
        std::strncpy(setup.name, id.name.c_str(), sizeof(setup.name) - 1);
        setup.ff_effects_max = kMaxEffects;
        ok = ok && ::ioctl(m_fd, UI_DEV_SETUP, &setup) == 0;
        ok = ok && ::ioctl(m_fd, UI_DEV_CREATE) == 0;
        if (!ok) {
            error = std::string("uinput refused the wheel: ") + std::strerror(errno);
            destroy();
            return false;
        }
        m_stop = ::eventfd(0, EFD_CLOEXEC);
        m_reader = std::thread([this] { readLoop(); });
        return true;
    }

    bool input(const uint8_t* report, size_t size) override
    {
        std::lock_guard<std::mutex> lock(m_writeMutex);
        if (m_fd < 0) return false;
        m_events.clear();
        hid::evdevDecode(m_map, report, size, m_state, m_events);
        if (m_events.empty()) return true;
        bool ok = true;
        for (const hid::EvdevEvent& e : m_events)
            ok = emit(e.type, e.code, e.value) && ok;
        return emit(EV_SYN, SYN_REPORT, 0) && ok;
    }

    void destroy() override
    {
        if (m_stop >= 0) {
            const uint64_t one = 1;
            [[maybe_unused]] const ssize_t n = ::write(m_stop, &one, sizeof(one));
        }
        if (m_reader.joinable()) m_reader.join();
        if (m_stop >= 0) ::close(m_stop);
        m_stop = -1;
        std::lock_guard<std::mutex> lock(m_writeMutex);
        if (m_fd >= 0) {
            ::ioctl(m_fd, UI_DEV_DESTROY);
            ::close(m_fd);
        }
        m_fd = -1;
    }

private:
    bool emit(uint16_t type, uint16_t code, int32_t value)
    {
        input_event e{};
        e.type = type;
        e.code = code;
        e.value = value;
        return ::write(m_fd, &e, sizeof(e)) == static_cast<ssize_t>(sizeof(e));
    }

    void ffb(const HidFfb& op)
    {
        if (m_onFfb) m_onFfb(op);
    }

    void readLoop()
    {
        pollfd fds[2] = {{m_fd, POLLIN, 0}, {m_stop, POLLIN, 0}};
        while (::poll(fds, 2, -1) >= 0) {
            if (fds[1].revents) return;
            if (!(fds[0].revents & POLLIN)) {
                if (fds[0].revents & (POLLERR | POLLHUP)) return;
                continue;
            }
            input_event e{};
            while (::read(m_fd, &e, sizeof(e)) == static_cast<ssize_t>(sizeof(e))) {
                if (e.type == EV_UINPUT && e.code == UI_FF_UPLOAD) {
                    uinput_ff_upload up{};
                    up.request_id = static_cast<__u32>(e.value);
                    if (::ioctl(m_fd, UI_BEGIN_FF_UPLOAD, &up) != 0) continue;
                    for (const HidFfb& op : hid::ffbUpload(fromKernel(up.effect)))
                        ffb(op);
                    up.retval = 0;
                    ::ioctl(m_fd, UI_END_FF_UPLOAD, &up);
                } else if (e.type == EV_UINPUT && e.code == UI_FF_ERASE) {
                    uinput_ff_erase er{};
                    er.request_id = static_cast<__u32>(e.value);
                    if (::ioctl(m_fd, UI_BEGIN_FF_ERASE, &er) != 0) continue;
                    ffb(hid::ffbErase(static_cast<int>(er.effect_id)));
                    er.retval = 0;
                    ::ioctl(m_fd, UI_END_FF_ERASE, &er);
                } else if (e.type == EV_FF) {
                    if (e.code == FF_GAIN)
                        ffb(hid::ffbGain(e.value));
                    else if (e.code < kMaxEffects)
                        ffb(hid::ffbPlay(e.code, e.value));
                    // FF_AUTOCENTER: the page leaves the wheel free; a game
                    // that wants centring uploads a spring.
                }
            }
        }
    }

    hid::EvdevMap m_map;
    std::vector<int32_t> m_state;
    std::vector<hid::EvdevEvent> m_events;
    int m_fd = -1;
    int m_stop = -1;
    std::thread m_reader;
    std::mutex m_writeMutex;
};

} // namespace

std::unique_ptr<IVirtualHid> makeUinputWheel()
{
    return std::make_unique<UinputWheel>();
}

} // namespace mw::native::input
