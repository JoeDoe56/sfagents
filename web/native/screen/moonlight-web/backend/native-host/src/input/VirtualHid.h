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

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "mw/native/HidPassthrough.h"

/// One device of the HID passthrough recreated on this host
/// (docs/design/hid-passthrough-study.md, plan P2): the browser reads it
/// through WebHID, the host makes the same one here, `uhid` on Linux and the
/// "MoonlightWeb Virtual HID" driver on Windows (drivers/vhid).
///
/// The descriptor handed to create() has passed hid::validate() already: the
/// engine rebuilds it from the page's collections and checks it before any
/// backend sees it. The Windows driver checks it once more.
namespace mw::native::input {

struct VirtualHidIdentity
{
    std::string name;
    uint16_t vendorId = 0;
    uint16_t productId = 0;
    uint16_t version = 0;
    std::vector<uint8_t> descriptor;
};

class IVirtualHid
{
public:
    /// What the OS asked of the device, for the page to pass to the real one.
    enum class Request
    {
        Output,     // an output report written by an application
        GetFeature, // answered by the FeatureHandler, or with an error
        SetFeature, // acknowledged at once
    };
    /// Called on a backend thread, never under a lock the caller holds; data
    /// starts with the report id when the descriptor numbers its reports.
    using RequestHandler =
        std::function<void(Request kind, uint8_t reportId, const std::vector<uint8_t>& data)>;

    virtual ~IVirtualHid() = default;

    virtual bool create(const VirtualHidIdentity& identity, std::string& error) = 0;
    /// One input report as the device sends it, report id first when the
    /// descriptor numbers its reports. Safe from any thread, never blocks long.
    virtual bool input(const uint8_t* report, size_t size) = 0;
    /// Removes the device; also done by the destructor.
    virtual void destroy() = 0;

    /// Answers a GET_FEATURE at once: the report, id first when the descriptor
    /// numbers its reports, or empty to fail the request. Called on a backend
    /// thread; the request handler still hears of the request afterwards.
    using FeatureHandler = std::function<std::vector<uint8_t>(uint8_t reportId)>;

    /// Force feedback the backend services itself (slot left at 0 for the
    /// caller), on a backend thread.
    using FfbHandler = std::function<void(const HidFfb& op)>;

    void setRequestHandler(RequestHandler handler) { m_onRequest = std::move(handler); }
    void setFeatureHandler(FeatureHandler handler) { m_onGetFeature = std::move(handler); }
    void setFfbHandler(FfbHandler handler) { m_onFfb = std::move(handler); }

    /// How force feedback reaches this backend's device: true when the OS
    /// drives a PID block in the descriptor (pid.dll on Windows), false when
    /// the backend takes effects itself and calls the FfbHandler (uinput).
    virtual bool forceFeedbackByPid() const { return true; }

    // ── Between two streams (HidParking) ─────────────────────────────────────
    // Each stream has a process of its own; a device that must outlive one is
    // carried to the next by its OS handle, which keeps it in place as long as
    // any process holds a copy (Windows: the driver removes the device when
    // the last handle to it closes).

    /// The handle another process can be given, or 0 where the device cannot
    /// cross processes (uhid, uinput: it stays in the process that made it).
    virtual uint64_t nativeHandle() const { return 0; }
    /// Stops answering the device's requests, the device left as it is: the
    /// process the handle goes to answers them from now on.
    virtual void pause() {}
    /// Answers them again: after pause(), or once handlers are set on a
    /// device made by adoptVirtualHid().
    virtual void resume() {}
    /// Lets go of the device: removed, unless another process holds it.
    virtual void release() { destroy(); }
    /// False once the thread that answers the device's requests has stopped
    /// while it should run: the game's next request would wait for nobody.
    virtual bool servicing() const { return true; }

protected:
    RequestHandler m_onRequest;
    FeatureHandler m_onGetFeature;
    FfbHandler m_onFfb;
};

/// A backend for this OS, or null where there is none (macOS). With force
/// feedback asked, Linux gives a uinput device (UinputWheel) instead of uhid:
/// the kernel gives a uhid device none (HidEvdev.h).
std::unique_ptr<IVirtualHid> makeVirtualHid(bool forceFeedback = false);

/// A device another process made and handed over: `handle` is this process's
/// copy of its nativeHandle(), owned from here on. Null with the reason (the
/// handle closed) when it is not one of the driver's devices, or where devices
/// cannot cross processes. Answers nothing until resume().
std::unique_ptr<IVirtualHid> adoptVirtualHid(uint64_t handle, std::string& error);

/// Whether this host can carry a recreated wheel's force feedback now:
/// Windows always (pid.dll), Linux when /dev/uinput is writable.
bool virtualHidForceFeedback();

/// Empty when this host can create devices now; otherwise why not, in a short
/// English sentence (no /dev/uhid access, driver not installed).
std::string virtualHidUnavailableReason();

enum class VirtualHidSupport
{
    Ready,
    DriverMissing, // Windows: MoonlightWeb Virtual HID is not installed (or not loaded)
    NotSetUp,      // Linux: /dev/uhid missing or not writable
    Unsupported,   // no backend on this OS (macOS)
};

/// The same verdict as virtualHidUnavailableReason(), as a kind the page can
/// word for itself. Asked by the server for the hosts page, which on Windows
/// may not be elevated: a driver it may not open is still installed.
VirtualHidSupport virtualHidSupport();

} // namespace mw::native::input
