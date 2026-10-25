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

#include "KwinVirtualOutput.h"

#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <dlfcn.h>
#include <poll.h>
#include <unistd.h>

namespace mw::native::capture {
namespace {

constexpr const char* kSoname = "libwayland-client.so.0";

// ── libwayland's ABI, spelled out (WaylandLayout.cpp says why) ─────────────

struct WlInterface;

struct WlMessage
{
    const char* name;
    const char* signature;
    const WlInterface** types;
};

struct WlInterface
{
    const char* name;
    int version;
    int methodCount;
    const WlMessage* methods;
    int eventCount;
    const WlMessage* events;
};

using WlProxy = void;

// KWin's screencast protocol (plasma-wayland-protocols,
// zkde-screencast-unstable-v1.xml), its two interfaces as the XML lists their
// messages: libwayland marshals by opcode, so the order is the protocol's.

const WlInterface* kNoTypes[8] = {nullptr, nullptr, nullptr, nullptr,
                                  nullptr, nullptr, nullptr, nullptr};

extern const WlInterface kStreamInterface;
const WlInterface* g_streamOutputTypes[3] = {&kStreamInterface, nullptr, nullptr};
const WlInterface* g_streamWindowTypes[3] = {&kStreamInterface, nullptr, nullptr};
const WlInterface* g_virtualOutputTypes[6] = {&kStreamInterface, nullptr, nullptr,
                                              nullptr,           nullptr, nullptr};
const WlInterface* g_regionTypes[7] = {&kStreamInterface, nullptr, nullptr, nullptr,
                                       nullptr,           nullptr, nullptr};
const WlInterface* g_describedTypes[7] = {&kStreamInterface, nullptr, nullptr, nullptr,
                                          nullptr,           nullptr, nullptr};

const WlMessage kScreencastRequests[] = {
    {"stream_output", "nou", g_streamOutputTypes},
    {"stream_window", "nsu", g_streamWindowTypes},
    {"destroy", "", kNoTypes},
    {"stream_virtual_output", "2nsiifu", g_virtualOutputTypes},
    {"stream_region", "3niiuufu", g_regionTypes},
    {"stream_virtual_output_with_description", "4nssiifu", g_describedTypes},
};
const WlInterface kScreencastInterface = {"zkde_screencast_unstable_v1", 6, 6,
                                          kScreencastRequests,           0, nullptr};

const WlMessage kStreamRequests[] = {{"close", "", kNoTypes}};
const WlMessage kStreamEvents[] = {
    {"closed", "", kNoTypes},
    {"created", "u", kNoTypes},
    {"failed", "s", kNoTypes},
    {"serial", "6uu", kNoTypes},
};
const WlInterface kStreamInterface = {
    "zkde_screencast_stream_unstable_v1", 6, 1, kStreamRequests, 4, kStreamEvents};

constexpr uint32_t kDisplayGetRegistry = 1;
constexpr uint32_t kRegistryBind = 0;
constexpr uint32_t kScreencastDestroy = 2;
constexpr uint32_t kScreencastVirtualOutput = 3;
constexpr uint32_t kStreamClose = 0;

/// stream_virtual_output arrived in version 2. Bound at 5 at most: version 6
/// adds the serial event, which this side does not need — the node id it
/// replaces is what pw_stream_connect takes.
constexpr uint32_t kMinScreencastVersion = 2;
constexpr uint32_t kMaxScreencastVersion = 5;
constexpr uint32_t kPointerMetadata = 4;
/// wl_fixed_t: 24.8 fixed point.
constexpr int32_t kScaleOne = 256;

struct RegistryListener
{
    void (*global)(void*, WlProxy*, uint32_t, const char*, uint32_t);
    void (*globalRemove)(void*, WlProxy*, uint32_t);
};

struct StreamListener
{
    void (*closed)(void*, WlProxy*);
    void (*created)(void*, WlProxy*, uint32_t);
    void (*failed)(void*, WlProxy*, const char*);
    void (*serial)(void*, WlProxy*, uint32_t, uint32_t);
};

struct Lib
{
    void* handle = nullptr;

    WlProxy* (*displayConnect)(const char*) = nullptr;
    void (*displayDisconnect)(WlProxy*) = nullptr;
    int (*displayRoundtrip)(WlProxy*) = nullptr;
    int (*displayFlush)(WlProxy*) = nullptr;
    int (*displayGetFd)(WlProxy*) = nullptr;
    int (*displayPrepareRead)(WlProxy*) = nullptr;
    void (*displayCancelRead)(WlProxy*) = nullptr;
    int (*displayReadEvents)(WlProxy*) = nullptr;
    int (*displayDispatchPending)(WlProxy*) = nullptr;
    WlProxy* (*marshalConstructor)(WlProxy*, uint32_t, const WlInterface*, ...) = nullptr;
    WlProxy* (*marshalConstructorVersioned)(WlProxy*, uint32_t, const WlInterface*, uint32_t,
                                            ...) = nullptr;
    void (*marshal)(WlProxy*, uint32_t, ...) = nullptr;
    int (*addListener)(WlProxy*, void (**)(void), void*) = nullptr;
    void (*proxyDestroy)(WlProxy*) = nullptr;
    const WlInterface* registryInterface = nullptr;

    ~Lib()
    {
        if (handle) ::dlclose(handle);
    }

    template <typename T> void find(T& slot, const char* symbol)
    {
        slot = reinterpret_cast<T>(::dlsym(handle, symbol));
    }

    bool open(std::string& why)
    {
        handle = ::dlopen(kSoname, RTLD_NOW | RTLD_LOCAL);
        if (!handle) {
            why = std::string(kSoname) + " not available";
            return false;
        }
        find(displayConnect, "wl_display_connect");
        find(displayDisconnect, "wl_display_disconnect");
        find(displayRoundtrip, "wl_display_roundtrip");
        find(displayFlush, "wl_display_flush");
        find(displayGetFd, "wl_display_get_fd");
        find(displayPrepareRead, "wl_display_prepare_read");
        find(displayCancelRead, "wl_display_cancel_read");
        find(displayReadEvents, "wl_display_read_events");
        find(displayDispatchPending, "wl_display_dispatch_pending");
        find(marshalConstructor, "wl_proxy_marshal_constructor");
        find(marshalConstructorVersioned, "wl_proxy_marshal_constructor_versioned");
        find(marshal, "wl_proxy_marshal");
        find(addListener, "wl_proxy_add_listener");
        find(proxyDestroy, "wl_proxy_destroy");
        registryInterface =
            static_cast<const WlInterface*>(::dlsym(handle, "wl_registry_interface"));
        if (!displayConnect || !displayDisconnect || !displayRoundtrip || !displayFlush ||
            !displayGetFd || !displayPrepareRead || !displayCancelRead || !displayReadEvents ||
            !displayDispatchPending || !marshalConstructor || !marshalConstructorVersioned ||
            !marshal || !addListener || !proxyDestroy || !registryInterface) {
            why = std::string(kSoname) + " loaded but does not export the client calls";
            return false;
        }
        return true;
    }
};

/// What the registry lists that matters here.
struct Globals
{
    Lib* lib = nullptr;
    bool kwin = false;
    uint32_t screencastName = 0;
    uint32_t screencastVersion = 0;
};

void onGlobal(void* data, WlProxy*, uint32_t name, const char* interface, uint32_t version)
{
    auto* globals = static_cast<Globals*>(data);
    if (!interface) return;
    // KWin's output devices are advertised to every client: the compositor
    // is KWin whether or not it trusts this one.
    if (std::strcmp(interface, "kde_output_device_v2") == 0 ||
        std::strcmp(interface, "kde_output_management_v2") == 0)
        globals->kwin = true;
    if (std::strcmp(interface, kScreencastInterface.name) == 0) {
        globals->kwin = true;
        globals->screencastName = name;
        globals->screencastVersion = version;
    }
}

void onGlobalRemove(void*, WlProxy*, uint32_t) {}

const RegistryListener kRegistryListener = {onGlobal, onGlobalRemove};

/// The stream's answer.
struct Answer
{
    bool created = false;
    bool failed = false;
    bool closed = false;
    uint32_t node = 0;
    std::string error;
};

void onStreamClosed(void* data, WlProxy*)
{
    static_cast<Answer*>(data)->closed = true;
}

void onStreamCreated(void* data, WlProxy*, uint32_t node)
{
    auto* answer = static_cast<Answer*>(data);
    answer->node = node;
    answer->created = true;
}

void onStreamFailed(void* data, WlProxy*, const char* error)
{
    auto* answer = static_cast<Answer*>(data);
    answer->error = error ? error : "";
    answer->failed = true;
}

void onStreamSerial(void*, WlProxy*, uint32_t, uint32_t) {}

const StreamListener kStreamListener = {onStreamClosed, onStreamCreated, onStreamFailed,
                                        onStreamSerial};

/// The session's compositor: WAYLAND_DISPLAY when there is one, else a socket
/// in this user's runtime directory — the host may run as a service with no
/// session environment (WaylandLayout does the same, for every user).
WlProxy* connectSession(Lib& lib, std::string& why)
{
    const char* env = std::getenv("WAYLAND_DISPLAY");
    if (env && *env) {
        if (WlProxy* display = lib.displayConnect(nullptr)) return display;
        why = std::string("WAYLAND_DISPLAY=") + env + " refused the connection";
    }
    const std::string dir = "/run/user/" + std::to_string(::getuid());
    if (DIR* entries = ::opendir(dir.c_str())) {
        WlProxy* found = nullptr;
        while (dirent* e = ::readdir(entries)) {
            const std::string file = e->d_name;
            if (file.rfind("wayland-", 0) != 0) continue;
            if (file.size() >= 5 && file.compare(file.size() - 5, 5, ".lock") == 0) continue;
            found = lib.displayConnect((dir + "/" + file).c_str());
            if (found) break;
        }
        ::closedir(entries);
        if (found) return found;
    }
    if (why.empty()) why = "no Wayland socket in " + dir;
    return nullptr;
}

/// Dispatch the connection's events until @p done, the connection fails, or
/// @p timeoutMs runs out. libwayland's read protocol: prepare, flush, poll,
/// read, dispatch — which never blocks past the deadline.
template <typename Done> bool dispatchUntil(Lib& lib, WlProxy* display, Done&& done, int timeoutMs)
{
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    const int fd = lib.displayGetFd(display);
    while (!done()) {
        while (lib.displayPrepareRead(display) != 0) {
            if (lib.displayDispatchPending(display) < 0) return false;
            if (done()) return true;
        }
        if (lib.displayFlush(display) < 0 && errno != EAGAIN) {
            lib.displayCancelRead(display);
            return false;
        }
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                              deadline - std::chrono::steady_clock::now())
                              .count();
        if (left <= 0) {
            lib.displayCancelRead(display);
            return false;
        }
        pollfd ready = {fd, POLLIN, 0};
        const int r = ::poll(&ready, 1, static_cast<int>(left));
        if (r <= 0) {
            lib.displayCancelRead(display);
            if (r < 0 && errno == EINTR) continue;
            if (r < 0) return false;
            continue; // the deadline, checked above
        }
        if (lib.displayReadEvents(display) < 0) return false;
        if (lib.displayDispatchPending(display) < 0) return false;
    }
    return true;
}

} // namespace

struct KwinVirtualOutput::Impl
{
    Lib lib;
    WlProxy* display = nullptr;
    WlProxy* registry = nullptr;
    WlProxy* screencast = nullptr;
    WlProxy* stream = nullptr;
    Globals globals;
    Answer answer;

    /// Everything told it is going, in protocol order, then the socket.
    void close()
    {
        if (stream) {
            lib.marshal(stream, kStreamClose);
            lib.proxyDestroy(stream);
            stream = nullptr;
        }
        if (screencast) {
            lib.marshal(screencast, kScreencastDestroy);
            lib.proxyDestroy(screencast);
            screencast = nullptr;
        }
        if (registry) {
            lib.proxyDestroy(registry);
            registry = nullptr;
        }
        if (display) {
            lib.displayFlush(display);
            lib.displayDisconnect(display);
            display = nullptr;
        }
    }

    /// Open the library, connect, and read the registry.
    bool connect(std::string& why)
    {
        if (!lib.handle && !lib.open(why)) return false;
        display = connectSession(lib, why);
        if (!display) return false;
        globals = Globals{};
        globals.lib = &lib;
        registry =
            lib.marshalConstructor(display, kDisplayGetRegistry, lib.registryInterface, nullptr);
        if (!registry) {
            why = "could not reach the Wayland registry";
            return false;
        }
        lib.addListener(
            registry,
            reinterpret_cast<void (**)(void)>(const_cast<RegistryListener*>(&kRegistryListener)),
            &globals);
        if (lib.displayRoundtrip(display) < 0) {
            why = "the compositor dropped the connection";
            return false;
        }
        return true;
    }
};

KwinVirtualOutput::KwinVirtualOutput()
    : d(std::make_unique<Impl>())
{}

KwinVirtualOutput::~KwinVirtualOutput()
{
    stop();
}

bool KwinVirtualOutput::probe(bool& kwin, bool& granted, std::string& why)
{
    kwin = granted = false;
    Impl probe;
    const bool ok = probe.connect(why);
    if (ok) {
        kwin = probe.globals.kwin;
        granted = probe.globals.screencastVersion >= kMinScreencastVersion;
    }
    probe.close();
    return ok;
}

bool KwinVirtualOutput::start(const std::string& name, int width, int height, uint32_t& node,
                              std::string& error)
{
    stop();
    node = 0;
    if (!d->connect(error)) {
        d->close();
        return false;
    }
    if (d->globals.screencastVersion < kMinScreencastVersion) {
        error = !d->globals.kwin ? "the compositor is not KWin"
                : d->globals.screencastVersion == 0
                    ? "KWin does not grant its screencast protocol to this program — its .desktop "
                      "grant (X-KDE-Wayland-Interfaces) is missing, was installed after the "
                      "session started, or this process holds a capability KWin cannot see past"
                    : "KWin's screencast protocol is too old to make a virtual output";
        d->close();
        return false;
    }
    const uint32_t version = d->globals.screencastVersion < kMaxScreencastVersion
                                 ? d->globals.screencastVersion
                                 : kMaxScreencastVersion;
    d->screencast = d->lib.marshalConstructorVersioned(
        d->registry, kRegistryBind, &kScreencastInterface, version, d->globals.screencastName,
        kScreencastInterface.name, version, nullptr);
    if (!d->screencast) {
        error = "could not bind KWin's screencast protocol";
        d->close();
        return false;
    }
    d->answer = Answer{};
    // stream_virtual_output(new_id, name, width, height, scale, pointer): the
    // new id is the NULL, filled in by libwayland.
    d->stream = d->lib.marshalConstructor(
        d->screencast, kScreencastVirtualOutput, &kStreamInterface, nullptr, name.c_str(),
        static_cast<int32_t>(width), static_cast<int32_t>(height), kScaleOne, kPointerMetadata);
    if (!d->stream) {
        error = "KWin's virtual output could not be asked for";
        d->close();
        return false;
    }
    d->lib.addListener(
        d->stream, reinterpret_cast<void (**)(void)>(const_cast<StreamListener*>(&kStreamListener)),
        &d->answer);
    const bool answered = dispatchUntil(
        d->lib, d->display,
        [this] { return d->answer.created || d->answer.failed || d->answer.closed; }, 5000);
    if (!d->answer.created) {
        error = d->answer.failed   ? "KWin refused the virtual output: " + d->answer.error
                : d->answer.closed ? "KWin closed the virtual output's stream at once"
                : answered         ? "KWin's virtual output came without a stream"
                                   : "KWin did not answer for the virtual output within 5 s";
        d->close();
        return false;
    }
    node = d->answer.node;
    return true;
}

void KwinVirtualOutput::stop()
{
    d->close();
}

} // namespace mw::native::capture
