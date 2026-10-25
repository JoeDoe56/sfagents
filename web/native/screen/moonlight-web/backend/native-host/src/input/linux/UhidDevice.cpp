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

#include "input/VirtualHid.h"

#include <atomic>
#include <cerrno>
#include <cstring>
#include <mutex>
#include <thread>

#include <fcntl.h>
#include <linux/input.h>
#include <linux/uhid.h>
#include <poll.h>
#include <sys/eventfd.h>
#include <unistd.h>

namespace mw::native::input {

namespace {

/// A device made through /dev/uhid. One thread per device reads what the
/// kernel asks back (output reports, get/set report) and answers at once;
/// input() writes from the caller's thread, which uhid allows alongside.
class UhidDevice final : public IVirtualHid
{
public:
    ~UhidDevice() override { destroy(); }

    bool create(const VirtualHidIdentity& id, std::string& error) override
    {
        m_fd = ::open("/dev/uhid", O_RDWR | O_CLOEXEC);
        if (m_fd < 0) {
            error = std::string("cannot open /dev/uhid: ") + std::strerror(errno);
            return false;
        }
        uhid_event ev{};
        ev.type = UHID_CREATE2;
        auto& c = ev.u.create2;
        std::strncpy(reinterpret_cast<char*>(c.name), id.name.c_str(), sizeof(c.name) - 1);
        std::strncpy(reinterpret_cast<char*>(c.phys), "moonlightweb/hid", sizeof(c.phys) - 1);
        if (id.descriptor.empty() || id.descriptor.size() > sizeof(c.rd_data)) {
            error = "descriptor size out of uhid's range";
            destroy();
            return false;
        }
        c.rd_size = static_cast<__u16>(id.descriptor.size());
        std::memcpy(c.rd_data, id.descriptor.data(), id.descriptor.size());
        c.bus = BUS_USB;
        c.vendor = id.vendorId;
        c.product = id.productId;
        c.version = id.version;
        if (!send(ev)) {
            error = std::string("UHID_CREATE2 refused: ") + std::strerror(errno);
            destroy();
            return false;
        }
        m_stop = ::eventfd(0, EFD_CLOEXEC);
        m_reader = std::thread([this] { readLoop(); });
        return true;
    }

    bool input(const uint8_t* report, size_t size) override
    {
        if (m_fd < 0 || size == 0 || size > UHID_DATA_MAX) return false;
        uhid_event ev{};
        ev.type = UHID_INPUT2;
        ev.u.input2.size = static_cast<__u16>(size);
        std::memcpy(ev.u.input2.data, report, size);
        return send(ev);
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
        if (m_fd >= 0) {
            uhid_event ev{};
            ev.type = UHID_DESTROY;
            send(ev);
            ::close(m_fd);
        }
        m_fd = -1;
    }

private:
    bool send(const uhid_event& ev)
    {
        // input() and the reader's replies may write at once: one event per write().
        std::lock_guard<std::mutex> lock(m_writeMutex);
        return ::write(m_fd, &ev, sizeof(ev)) == static_cast<ssize_t>(sizeof(ev));
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
            uhid_event ev{};
            if (::read(m_fd, &ev, sizeof(ev)) <= 0) continue;
            switch (ev.type) {
            case UHID_OUTPUT: {
                const auto& o = ev.u.output;
                std::vector<uint8_t> data(o.data, o.data + o.size);
                if (m_onRequest) m_onRequest(Request::Output, data.empty() ? 0 : data[0], data);
                break;
            }
            case UHID_GET_REPORT: {
                const auto& g = ev.u.get_report;
                if (m_onRequest) m_onRequest(Request::GetFeature, g.rnum, {});
                uhid_event reply{};
                reply.type = UHID_GET_REPORT_REPLY;
                reply.u.get_report_reply.id = g.id;
                reply.u.get_report_reply.err = EIO;
                send(reply);
                break;
            }
            case UHID_SET_REPORT: {
                const auto& s = ev.u.set_report;
                if (m_onRequest)
                    m_onRequest(Request::SetFeature, s.rnum,
                                std::vector<uint8_t>(s.data, s.data + s.size));
                uhid_event reply{};
                reply.type = UHID_SET_REPORT_REPLY;
                reply.u.set_report_reply.id = s.id;
                send(reply);
                break;
            }
            default: break; // START, STOP, OPEN, CLOSE
            }
        }
    }

    int m_fd = -1;
    int m_stop = -1;
    std::thread m_reader;
    std::mutex m_writeMutex;
};

} // namespace

std::unique_ptr<IVirtualHid> makeUinputWheel(); // linux/UinputWheel.cpp

std::unique_ptr<IVirtualHid> makeVirtualHid(bool forceFeedback)
{
    if (forceFeedback) return makeUinputWheel();
    return std::make_unique<UhidDevice>();
}

std::unique_ptr<IVirtualHid> adoptVirtualHid(uint64_t, std::string& error)
{
    // A uhid or uinput device lives as long as its descriptor, in the process
    // that opened it: nothing is handed over between processes here yet.
    error = "devices do not cross processes on Linux";
    return nullptr;
}

bool virtualHidForceFeedback()
{
    return ::access("/dev/uinput", R_OK | W_OK) == 0;
}

std::string virtualHidUnavailableReason()
{
    if (::access("/dev/uhid", F_OK) != 0) return "no /dev/uhid (the uhid module is not loaded)";
    if (::access("/dev/uhid", R_OK | W_OK) != 0)
        return "/dev/uhid is not writable by this user (udev rule missing)";
    return {};
}

VirtualHidSupport virtualHidSupport()
{
    return virtualHidUnavailableReason().empty() ? VirtualHidSupport::Ready
                                                 : VirtualHidSupport::NotSetUp;
}

} // namespace mw::native::input
