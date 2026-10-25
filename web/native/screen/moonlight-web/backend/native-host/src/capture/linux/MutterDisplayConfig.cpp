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

#include "MutterDisplayConfig.h"

#include <systemd/sd-bus.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <thread>

namespace mw::native::capture {
namespace {

constexpr const char* kService = "org.gnome.Mutter.DisplayConfig";
constexpr const char* kPath = "/org/gnome/Mutter/DisplayConfig";
constexpr const char* kInterface = "org.gnome.Mutter.DisplayConfig";

/// ApplyMonitorsConfig's methods: 0 verifies, 1 applies for now, 2 applies
/// and stores — and makes gnome-shell ask "keep these settings?", reverting
/// after 20 s without an answer. Only 1 is ever used.
constexpr uint32_t kTemporary = 1;

constexpr uint64_t kCallTimeoutUs = 5 * 1000 * 1000;

/// The session bus, closed with the scope.
struct Bus
{
    sd_bus* bus = nullptr;
    ~Bus()
    {
        if (bus) sd_bus_unref(bus);
    }
    bool open(std::string& why)
    {
        const int r = sd_bus_open_user(&bus);
        if (r < 0) {
            bus = nullptr;
            why = std::string("no session bus (") + std::strerror(-r) + ")";
            return false;
        }
        return true;
    }
};

std::string errorText(const sd_bus_error& error, int r)
{
    if (error.message) return error.message;
    if (error.name) return error.name;
    return std::strerror(r < 0 ? -r : 0);
}

/// Walk an a{sv}, handing each key and its variant's signature to @p onKey,
/// which reads the value and returns > 0, or returns 0 to have it skipped.
/// Keys this code does not know are the rule, not the exception: Mutter adds
/// some at every version.
template <typename OnKey> int forEachProperty(sd_bus_message* m, OnKey&& onKey)
{
    int r = sd_bus_message_enter_container(m, 'a', "{sv}");
    if (r <= 0) return r;
    while ((r = sd_bus_message_enter_container(m, 'e', "sv")) > 0) {
        const char* key = nullptr;
        r = sd_bus_message_read(m, "s", &key);
        if (r < 0) return r;
        const char* contents = nullptr;
        r = sd_bus_message_peek_type(m, nullptr, &contents);
        if (r < 0) return r;
        r = onKey(std::string(key ? key : ""), std::string(contents ? contents : ""));
        if (r < 0) return r;
        if (r == 0 && (r = sd_bus_message_skip(m, "v")) < 0) return r;
        if ((r = sd_bus_message_exit_container(m)) < 0) return r;
    }
    if (r < 0) return r;
    return sd_bus_message_exit_container(m);
}

/// One of GetCurrentState's monitors: (ssss) a(siiddada{sv}) a{sv}.
int readMonitor(sd_bus_message* m, LayoutMonitor& out)
{
    const char* connector = nullptr;
    const char* vendor = nullptr;
    const char* product = nullptr;
    const char* serial = nullptr;
    int r = sd_bus_message_read(m, "(ssss)", &connector, &vendor, &product, &serial);
    if (r < 0) return r;
    out.connector = connector ? connector : "";
    out.vendor = vendor ? vendor : "";
    out.product = product ? product : "";

    // Its modes: the current one, else the preferred one (a monitor outside
    // the layout has no current mode, and is never handed back anyway).
    if ((r = sd_bus_message_enter_container(m, 'a', "(siiddada{sv})")) < 0) return r;
    bool haveCurrent = false;
    LayoutMonitor preferredMode;
    while ((r = sd_bus_message_enter_container(m, 'r', "siiddada{sv}")) > 0) {
        const char* id = nullptr;
        int32_t width = 0;
        int32_t height = 0;
        double refresh = 0;
        double preferredScale = 0;
        r = sd_bus_message_read(m, "siidd", &id, &width, &height, &refresh, &preferredScale);
        if (r < 0) return r;
        if ((r = sd_bus_message_skip(m, "ad")) < 0) return r;
        bool current = false;
        bool preferred = false;
        r = forEachProperty(m, [&](const std::string& key, const std::string& type) {
            if ((key != "is-current" && key != "is-preferred") || type != "b") return 0;
            int value = 0;
            const int read = sd_bus_message_read(m, "v", "b", &value);
            (key == "is-current" ? current : preferred) = value != 0;
            return read < 0 ? read : 1;
        });
        if (r < 0) return r;
        if ((r = sd_bus_message_exit_container(m)) < 0) return r;
        if (current && !haveCurrent) {
            out.modeId = id ? id : "";
            out.width = width;
            out.height = height;
            haveCurrent = true;
        } else if (preferred && preferredMode.modeId.empty()) {
            preferredMode.modeId = id ? id : "";
            preferredMode.width = width;
            preferredMode.height = height;
        }
    }
    if (r < 0) return r;
    if ((r = sd_bus_message_exit_container(m)) < 0) return r;
    if (!haveCurrent) {
        out.modeId = preferredMode.modeId;
        out.width = preferredMode.width;
        out.height = preferredMode.height;
    }

    return forEachProperty(m, [&](const std::string& key, const std::string& type) {
        if (key == "is-underscanning" && type == "b") {
            int value = 0;
            const int read = sd_bus_message_read(m, "v", "b", &value);
            out.underscanning = value != 0;
            return read < 0 ? read : 1;
        }
        if ((key == "color-mode" || key == "rgb-range") && type == "u") {
            uint32_t value = 0;
            const int read = sd_bus_message_read(m, "v", "u", &value);
            (key == "color-mode" ? out.colorMode : out.rgbRange) = static_cast<int>(value);
            return read < 0 ? read : 1;
        }
        return 0;
    });
}

/// GetCurrentState's answer: u a((ssss)a(siiddada{sv})a{sv}) a(iiduba(ssss)a{sv}) a{sv}.
int readState(sd_bus_message* m, DisplayLayout& out, uint32_t& serial)
{
    int r = sd_bus_message_read(m, "u", &serial);
    if (r < 0) return r;

    if ((r = sd_bus_message_enter_container(m, 'a', "((ssss)a(siiddada{sv})a{sv})")) < 0) return r;
    while ((r = sd_bus_message_enter_container(m, 'r', "(ssss)a(siiddada{sv})a{sv}")) > 0) {
        LayoutMonitor monitor;
        if ((r = readMonitor(m, monitor)) < 0) return r;
        if ((r = sd_bus_message_exit_container(m)) < 0) return r;
        out.monitors.push_back(std::move(monitor));
    }
    if (r < 0) return r;
    if ((r = sd_bus_message_exit_container(m)) < 0) return r;

    if ((r = sd_bus_message_enter_container(m, 'a', "(iiduba(ssss)a{sv})")) < 0) return r;
    while ((r = sd_bus_message_enter_container(m, 'r', "iiduba(ssss)a{sv}")) > 0) {
        LayoutLogical logical;
        int32_t x = 0;
        int32_t y = 0;
        int primary = 0;
        r = sd_bus_message_read(m, "iidub", &x, &y, &logical.scale, &logical.transform, &primary);
        if (r < 0) return r;
        logical.x = x;
        logical.y = y;
        logical.primary = primary != 0;
        if ((r = sd_bus_message_enter_container(m, 'a', "(ssss)")) < 0) return r;
        while ((r = sd_bus_message_enter_container(m, 'r', "ssss")) > 0) {
            const char* connector = nullptr;
            const char* vendor = nullptr;
            const char* product = nullptr;
            const char* serialText = nullptr;
            r = sd_bus_message_read(m, "ssss", &connector, &vendor, &product, &serialText);
            if (r < 0) return r;
            logical.connectors.emplace_back(connector ? connector : "");
            if ((r = sd_bus_message_exit_container(m)) < 0) return r;
        }
        if (r < 0) return r;
        if ((r = sd_bus_message_exit_container(m)) < 0) return r;
        if ((r = sd_bus_message_skip(m, "a{sv}")) < 0) return r;
        if ((r = sd_bus_message_exit_container(m)) < 0) return r;
        out.logical.push_back(std::move(logical));
    }
    if (r < 0) return r;
    if ((r = sd_bus_message_exit_container(m)) < 0) return r;

    r = forEachProperty(m, [&](const std::string& key, const std::string& type) {
        if (key != "layout-mode" || type != "u") return 0;
        uint32_t mode = 0;
        const int read = sd_bus_message_read(m, "v", "u", &mode);
        out.physicalLayout = mode == 2;
        return read < 0 ? read : 1;
    });
    return r < 0 ? r : 0;
}

/// ApplyMonitorsConfig's arguments: u u a(iiduba(ssa{sv})) a{sv}. Every
/// monitor keeps its mode, and what it would lose if not handed back.
int appendConfig(sd_bus_message* m, uint32_t serial, const DisplayLayout& now,
                 const std::vector<LayoutLogical>& logical)
{
    int r = sd_bus_message_append(m, "uu", serial, kTemporary);
    if (r < 0) return r;
    if ((r = sd_bus_message_open_container(m, 'a', "(iiduba(ssa{sv}))")) < 0) return r;
    for (const LayoutLogical& l : logical) {
        if ((r = sd_bus_message_open_container(m, 'r', "iiduba(ssa{sv})")) < 0) return r;
        r = sd_bus_message_append(m, "iidub", static_cast<int32_t>(l.x), static_cast<int32_t>(l.y),
                                  l.scale, l.transform, l.primary ? 1 : 0);
        if (r < 0) return r;
        if ((r = sd_bus_message_open_container(m, 'a', "(ssa{sv})")) < 0) return r;
        for (const std::string& connector : l.connectors) {
            const LayoutMonitor* monitor = findLayoutMonitor(now, connector);
            if (!monitor || monitor->modeId.empty()) return -EINVAL;
            if ((r = sd_bus_message_open_container(m, 'r', "ssa{sv}")) < 0) return r;
            r = sd_bus_message_append(m, "ss", connector.c_str(), monitor->modeId.c_str());
            if (r < 0) return r;
            if ((r = sd_bus_message_open_container(m, 'a', "{sv}")) < 0) return r;
            if (monitor->underscanning &&
                (r = sd_bus_message_append(m, "{sv}", "underscanning", "b", 1)) < 0)
                return r;
            if (monitor->colorMode >= 0 &&
                (r = sd_bus_message_append(m, "{sv}", "color-mode", "u",
                                           static_cast<uint32_t>(monitor->colorMode))) < 0)
                return r;
            if (monitor->rgbRange >= 0 &&
                (r = sd_bus_message_append(m, "{sv}", "rgb-range", "u",
                                           static_cast<uint32_t>(monitor->rgbRange))) < 0)
                return r;
            if ((r = sd_bus_message_close_container(m)) < 0) return r;
            if ((r = sd_bus_message_close_container(m)) < 0) return r;
        }
        if ((r = sd_bus_message_close_container(m)) < 0) return r;
        if ((r = sd_bus_message_close_container(m)) < 0) return r;
    }
    if ((r = sd_bus_message_close_container(m)) < 0) return r;
    return sd_bus_message_append(m, "a{sv}", 0);
}

std::string place(const LayoutLogical& l)
{
    return std::to_string(l.x) + "," + std::to_string(l.y);
}

} // namespace

bool MutterDisplayConfig::read(DisplayLayout& out, uint32_t& serial, std::string& why)
{
    out = DisplayLayout{};
    serial = 0;
    Bus bus;
    if (!bus.open(why)) return false;
    sd_bus_message* call = nullptr;
    sd_bus_message* reply = nullptr;
    sd_bus_error error = SD_BUS_ERROR_NULL;
    int r = sd_bus_message_new_method_call(bus.bus, &call, kService, kPath, kInterface,
                                           "GetCurrentState");
    if (r >= 0) r = sd_bus_call(bus.bus, call, kCallTimeoutUs, &error, &reply);
    sd_bus_message_unref(call);
    if (r < 0) {
        why = "no GNOME display configuration to ask (" + errorText(error, r) + ")";
        sd_bus_error_free(&error);
        return false;
    }
    r = readState(reply, out, serial);
    sd_bus_message_unref(reply);
    if (r < 0) {
        why = std::string("Mutter's display state could not be read (") + std::strerror(-r) + ")";
        out = DisplayLayout{};
        return false;
    }
    return true;
}

bool MutterDisplayConfig::connectors(std::vector<std::string>& out, std::string& why)
{
    out.clear();
    DisplayLayout layout;
    uint32_t serial = 0;
    if (!read(layout, serial, why)) return false;
    for (const LayoutMonitor& m : layout.monitors)
        out.push_back(m.connector);
    return true;
}

bool MutterDisplayConfig::makePrimary(const std::string& connector, std::string& how)
{
    // A layout another client changed between the read and the change comes
    // back "based on stale information": read again, a few times.
    for (int attempt = 0; attempt < 3; ++attempt) {
        DisplayLayout now;
        uint32_t serial = 0;
        if (!read(now, serial, how)) return false;
        std::vector<LayoutLogical> wanted;
        bool unchanged = false;
        if (!primaryLayout(now, connector, wanted, unchanged, how)) return false;
        if (unchanged) {
            how = connector + " is already the primary, at the origin";
            return true;
        }

        Bus bus;
        if (!bus.open(how)) return false;
        sd_bus_message* call = nullptr;
        sd_bus_message* reply = nullptr;
        sd_bus_error error = SD_BUS_ERROR_NULL;
        int r = sd_bus_message_new_method_call(bus.bus, &call, kService, kPath, kInterface,
                                               "ApplyMonitorsConfig");
        if (r >= 0) r = appendConfig(call, serial, now, wanted);
        if (r < 0) {
            sd_bus_message_unref(call);
            how = std::string("the layout could not be written (") + std::strerror(-r) + ")";
            return false;
        }
        r = sd_bus_call(bus.bus, call, kCallTimeoutUs, &error, &reply);
        sd_bus_message_unref(call);
        sd_bus_message_unref(reply);
        if (r < 0) {
            const std::string text = errorText(error, r);
            sd_bus_error_free(&error);
            if (text.find("stale") != std::string::npos) continue;
            how = "Mutter refused the layout (" + text + ")";
            return false;
        }

        // Applied: Mutter answers once the layout is in place. Read back what
        // it made of it, for the log and the caller's pointer mapping.
        DisplayLayout after;
        std::string why;
        if (!read(after, serial, why)) {
            how = connector + " made primary (not read back: " + why + ")";
            return true;
        }
        std::string others;
        bool primary = false;
        for (const LayoutLogical& l : after.logical) {
            const bool mine = !l.connectors.empty() && l.connectors[0] == connector;
            if (mine) {
                primary = l.primary;
                continue;
            }
            for (const std::string& c : l.connectors)
                others += (others.empty() ? "" : ", ") + c + " at " + place(l);
        }
        if (!primary) {
            how = "Mutter took the layout, but " + connector + " is not the primary";
            return false;
        }
        how = connector + " is the desktop's primary at " + place(wanted.front()) +
              (others.empty() ? std::string()
                              : ", the other screens kept at its right (" + others + ")") +
              " — until it goes, Mutter then puts the layout back";
        return true;
    }
    how = "the layout kept changing under us";
    return false;
}

int MutterDisplayConfig::settle(const std::string& gone, int budgetMs)
{
    const auto start = std::chrono::steady_clock::now();
    const auto waited = [&start] {
        return static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::steady_clock::now() - start)
                                    .count());
    };
    DisplayLayout layout;
    uint32_t serial = 0;
    std::string why;
    while (!gone.empty() && waited() < budgetMs) {
        if (!read(layout, serial, why)) return waited();
        if (!findLayoutMonitor(layout, gone)) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    bool seen = false;
    uint32_t last = 0;
    while (waited() < budgetMs) {
        if (!read(layout, serial, why)) break;
        if (seen && serial == last) break;
        seen = true;
        last = serial;
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
    }
    return waited();
}

struct MutterLayoutWatch::Impl
{
    sd_bus* bus = nullptr;
    sd_bus_slot* slot = nullptr;
    bool changed = false;

    static int onChanged(sd_bus_message*, void* userdata, sd_bus_error*)
    {
        static_cast<Impl*>(userdata)->changed = true;
        return 0;
    }

    ~Impl()
    {
        sd_bus_slot_unref(slot);
        if (bus) sd_bus_flush_close_unref(bus);
    }
};

MutterLayoutWatch::MutterLayoutWatch()
    : d(std::make_unique<Impl>())
{}

MutterLayoutWatch::~MutterLayoutWatch() = default;

bool MutterLayoutWatch::start(std::string& why)
{
    if (d->bus) return true;
    int r = sd_bus_open_user(&d->bus);
    if (r < 0) {
        d->bus = nullptr;
        why = std::string("no session bus (") + std::strerror(-r) + ")";
        return false;
    }
    r = sd_bus_match_signal(d->bus, &d->slot, nullptr, kPath, kInterface, "MonitorsChanged",
                            &Impl::onChanged, d.get());
    if (r < 0) {
        why = std::string("cannot listen to GNOME's monitors (") + std::strerror(-r) + ")";
        d->bus = sd_bus_flush_close_unref(d->bus);
        return false;
    }
    return true;
}

bool MutterLayoutWatch::changed()
{
    if (!d->bus) return false;
    for (int i = 0; i < 64; ++i)
        if (sd_bus_process(d->bus, nullptr) <= 0) break;
    const bool was = d->changed;
    d->changed = false;
    return was;
}

} // namespace mw::native::capture
