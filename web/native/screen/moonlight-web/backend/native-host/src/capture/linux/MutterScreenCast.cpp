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

#include "MutterScreenCast.h"

#include <systemd/sd-bus.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>

namespace mw::native::capture {
namespace {

constexpr const char* kService = "org.gnome.Mutter.ScreenCast";
constexpr const char* kPath = "/org/gnome/Mutter/ScreenCast";
constexpr const char* kInterface = "org.gnome.Mutter.ScreenCast";
constexpr const char* kSessionInterface = "org.gnome.Mutter.ScreenCast.Session";
constexpr const char* kStreamInterface = "org.gnome.Mutter.ScreenCast.Stream";

/// cursor-mode 1: the pointer painted into the picture.
constexpr uint32_t kCursorEmbedded = 1;
/// cursor-mode 2: the pointer beside the picture, as metadata.
constexpr uint32_t kCursorMetadata = 2;

constexpr uint64_t kCallTimeoutUs = 5ULL * 1000 * 1000;
/// The node comes in 30 to 190 ms (bench §8s.1); a shell busy rebuilding its
/// monitors may take longer.
constexpr int kNodeWaitMs = 10000;

std::string errorText(const sd_bus_error& error, int r)
{
    if (error.message) return error.message;
    if (error.name) return error.name;
    return std::strerror(r < 0 ? -r : 0);
}

/// Mutter did not take the call at all, as opposed to taking it and failing.
bool outright(const sd_bus_error& error)
{
    static const char* const kNames[] = {
        "org.freedesktop.DBus.Error.ServiceUnknown",   "org.freedesktop.DBus.Error.UnknownObject",
        "org.freedesktop.DBus.Error.UnknownInterface", "org.freedesktop.DBus.Error.UnknownMethod",
        "org.freedesktop.DBus.Error.AccessDenied",     "org.freedesktop.DBus.Error.NotSupported",
    };
    for (const char* name : kNames)
        if (sd_bus_error_has_name(&error, name)) return true;
    return false;
}

int onStreamAdded(sd_bus_message* m, void* userdata, sd_bus_error*)
{
    uint32_t node = 0;
    if (sd_bus_message_read(m, "u", &node) > 0) *static_cast<uint32_t*>(userdata) = node;
    return 0;
}

int onClosed(sd_bus_message*, void* userdata, sd_bus_error*)
{
    *static_cast<bool*>(userdata) = true;
    return 0;
}

/// RecordVirtual's or RecordMonitor's properties: the pointer as metadata or
/// painted in and, for a virtual monitor faster than 60 Hz, its one mode.
int appendProperties(sd_bus_message* m, const MutterScreenCast::Request& request)
{
    int r = sd_bus_message_open_container(m, 'a', "{sv}");
    if (r < 0) return r;
    const uint32_t cursorMode = request.embedCursor ? kCursorEmbedded : kCursorMetadata;
    if ((r = sd_bus_message_append(m, "{sv}", "cursor-mode", "u", cursorMode)) < 0) return r;
    if (request.connector.empty() && request.refreshHz > 60 && request.width > 0 &&
        request.height > 0) {
        if ((r = sd_bus_message_open_container(m, 'e', "sv")) < 0) return r;
        if ((r = sd_bus_message_append(m, "s", "modes")) < 0) return r;
        if ((r = sd_bus_message_open_container(m, 'v', "aa{sv}")) < 0) return r;
        if ((r = sd_bus_message_open_container(m, 'a', "a{sv}")) < 0) return r;
        if ((r = sd_bus_message_open_container(m, 'a', "{sv}")) < 0) return r;
        r = sd_bus_message_append(m, "{sv}", "size", "(uu)", static_cast<uint32_t>(request.width),
                                  static_cast<uint32_t>(request.height));
        if (r < 0) return r;
        r = sd_bus_message_append(m, "{sv}", "refresh-rate", "d",
                                  static_cast<double>(request.refreshHz));
        if (r < 0) return r;
        if ((r = sd_bus_message_append(m, "{sv}", "is-preferred", "b", 1)) < 0) return r;
        for (int i = 0; i < 4; ++i)
            if ((r = sd_bus_message_close_container(m)) < 0) return r;
    }
    return sd_bus_message_close_container(m);
}

} // namespace

struct MutterScreenCast::Impl
{
    sd_bus* bus = nullptr;
    sd_bus_slot* added = nullptr;
    sd_bus_slot* closedSlot = nullptr;
    std::string session;
    uint32_t node = 0;
    bool closed = false;
    /// The last start() was refused outright (refused()).
    bool refused = false;

    /// One call on the session object, with a deadline of our own: sd-bus's
    /// default waits 25 s on a shell that hangs. @p outrightOut, when given,
    /// says whether a failure was a refusal outright.
    int callSession(const char* method, std::string& error, bool* outrightOut = nullptr)
    {
        sd_bus_message* call = nullptr;
        sd_bus_message* reply = nullptr;
        sd_bus_error busError = SD_BUS_ERROR_NULL;
        int r = sd_bus_message_new_method_call(bus, &call, kService, session.c_str(),
                                               kSessionInterface, method);
        if (r >= 0) r = sd_bus_call(bus, call, kCallTimeoutUs, &busError, &reply);
        if (r < 0) {
            error = std::string(method) + ": " + errorText(busError, r);
            if (outrightOut) *outrightOut = outright(busError);
        }
        sd_bus_error_free(&busError);
        sd_bus_message_unref(reply);
        sd_bus_message_unref(call);
        return r;
    }

    /// Everything of the session let go; refused stays, for the caller.
    void release()
    {
        added = sd_bus_slot_unref(added);
        closedSlot = sd_bus_slot_unref(closedSlot);
        if (bus) bus = sd_bus_flush_close_unref(bus);
        session.clear();
        node = 0;
        closed = false;
    }
};

MutterScreenCast::MutterScreenCast()
    : d(std::make_unique<Impl>())
{}

MutterScreenCast::~MutterScreenCast()
{
    stop();
}

int MutterScreenCast::version(std::string& why)
{
    sd_bus* bus = nullptr;
    int r = sd_bus_open_user(&bus);
    if (r < 0) {
        why = std::string("no session bus (") + std::strerror(-r) + ")";
        return 0;
    }
    // Read through Properties.Get rather than as a trivial property: the
    // variant's own type is taken, whichever integer Mutter declares.
    sd_bus_message* reply = nullptr;
    sd_bus_error error = SD_BUS_ERROR_NULL;
    r = sd_bus_call_method(bus, kService, kPath, "org.freedesktop.DBus.Properties", "Get", &error,
                           &reply, "ss", kInterface, "Version");
    int version = 0;
    if (r < 0) {
        why = "no GNOME screen cast on the session bus (" + errorText(error, r) + ")";
    } else {
        const char* contents = nullptr;
        char type = 0;
        if (sd_bus_message_peek_type(reply, &type, &contents) > 0 && contents) {
            if (std::strcmp(contents, "i") == 0) {
                int32_t value = 0;
                if (sd_bus_message_read(reply, "v", "i", &value) > 0) version = value;
            } else if (std::strcmp(contents, "u") == 0) {
                uint32_t value = 0;
                if (sd_bus_message_read(reply, "v", "u", &value) > 0)
                    version = static_cast<int>(value);
            }
        }
        if (version <= 0) why = "GNOME's screen cast names no version";
    }
    sd_bus_error_free(&error);
    sd_bus_message_unref(reply);
    sd_bus_unref(bus);
    return version > 0 ? version : 0;
}

int MutterScreenCast::shellMajor()
{
    sd_bus* bus = nullptr;
    if (sd_bus_open_user(&bus) < 0) return 0;
    sd_bus_error error = SD_BUS_ERROR_NULL;
    char* version = nullptr;
    const int r = sd_bus_get_property_string(bus, "org.gnome.Shell", "/org/gnome/Shell",
                                             "org.gnome.Shell", "ShellVersion", &error, &version);
    int major = 0;
    if (r >= 0 && version) major = std::atoi(version);
    std::free(version);
    sd_bus_error_free(&error);
    sd_bus_unref(bus);
    return major > 0 ? major : 0;
}

bool MutterScreenCast::start(const Request& request, uint32_t& node, std::string& error)
{
    stop();
    node = 0;
    d->refused = false;
    int r = sd_bus_open_user(&d->bus);
    if (r < 0) {
        d->bus = nullptr;
        error = std::string("no session bus: ") + std::strerror(-r);
        return false;
    }

    sd_bus_message* reply = nullptr;
    sd_bus_error busError = SD_BUS_ERROR_NULL;
    r = sd_bus_call_method(d->bus, kService, kPath, kInterface, "CreateSession", &busError, &reply,
                           "a{sv}", 0);
    if (r < 0) {
        error = "GNOME's screen cast opened no session (" + errorText(busError, r) + ")";
        d->refused = outright(busError);
        sd_bus_error_free(&busError);
        d->release();
        return false;
    }
    sd_bus_error_free(&busError);
    const char* path = nullptr;
    if (sd_bus_message_read(reply, "o", &path) > 0 && path) d->session = path;
    sd_bus_message_unref(reply);
    reply = nullptr;
    if (d->session.empty()) {
        error = "GNOME's screen cast named no session";
        d->release();
        return false;
    }
    // Before anything can close it.
    r = sd_bus_match_signal(d->bus, &d->closedSlot, nullptr, d->session.c_str(), kSessionInterface,
                            "Closed", onClosed, &d->closed);
    if (r < 0) {
        error = std::string("cannot listen for the session's end: ") + std::strerror(-r);
        stop();
        return false;
    }

    const bool virtualMonitor = request.connector.empty();
    const std::string asked =
        virtualMonitor ? std::string("RecordVirtual") : "RecordMonitor(" + request.connector + ")";
    sd_bus_message* call = nullptr;
    r = sd_bus_message_new_method_call(d->bus, &call, kService, d->session.c_str(),
                                       kSessionInterface,
                                       virtualMonitor ? "RecordVirtual" : "RecordMonitor");
    if (r >= 0 && !virtualMonitor) r = sd_bus_message_append(call, "s", request.connector.c_str());
    if (r >= 0) r = appendProperties(call, request);
    if (r >= 0) r = sd_bus_call(d->bus, call, kCallTimeoutUs, &busError, &reply);
    sd_bus_message_unref(call);
    if (r < 0) {
        error = asked + " refused: " + errorText(busError, r);
        d->refused = outright(busError);
        sd_bus_error_free(&busError);
        stop();
        return false;
    }
    sd_bus_error_free(&busError);
    std::string stream;
    if (sd_bus_message_read(reply, "o", &path) > 0 && path) stream = path;
    sd_bus_message_unref(reply);
    if (stream.empty()) {
        error = "GNOME's screen cast named no stream";
        stop();
        return false;
    }

    // The node is announced once the session starts: listened for first.
    r = sd_bus_match_signal(d->bus, &d->added, nullptr, stream.c_str(), kStreamInterface,
                            "PipeWireStreamAdded", onStreamAdded, &d->node);
    if (r >= 0) r = d->callSession("Start", error, &d->refused);
    if (r < 0) {
        if (error.empty())
            error = std::string("cannot listen for the stream: ") + std::strerror(-r);
        stop();
        return false;
    }
    for (int waited = 0; d->node == 0 && !d->closed && waited < kNodeWaitMs; waited += 100) {
        const int processed = sd_bus_process(d->bus, nullptr);
        if (processed > 0) {
            waited -= 100; // work done; not the budget's
            continue;
        }
        if (processed < 0) break;
        sd_bus_wait(d->bus, 100ULL * 1000);
    }
    if (d->node == 0) {
        error = d->closed ? "GNOME closed the screen cast before it named a stream"
                          : "GNOME's screen cast named no PipeWire stream within 10 s";
        stop();
        return false;
    }
    node = d->node;
    return true;
}

bool MutterScreenCast::refused() const
{
    return d->refused;
}

bool MutterScreenCast::closed()
{
    if (!d->bus) return false;
    if (d->closed) return true;
    // What has arrived, without a wait; a bound in case it never stops.
    for (int i = 0; i < 64; ++i) {
        const int r = sd_bus_process(d->bus, nullptr);
        if (r < 0) d->closed = true;
        if (r <= 0) break;
    }
    if (sd_bus_is_open(d->bus) <= 0) d->closed = true;
    return d->closed;
}

void MutterScreenCast::stop()
{
    if (!d->bus) return;
    // Said rather than left to the connection's end, so the monitor goes now,
    // not whenever the process does. Never on a session Mutter closed itself.
    if (!d->session.empty() && !d->closed) {
        std::string ignored;
        d->callSession("Stop", ignored);
    }
    d->release();
}

} // namespace mw::native::capture
