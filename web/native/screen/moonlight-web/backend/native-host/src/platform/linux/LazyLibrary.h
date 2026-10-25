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

// A system library the Linux backend uses but the program must not need to
// START. Linked the ordinary way, libpipewire or libva is a NEEDED entry, and
// a machine without it refuses the whole binary before main() — the Sunshine
// client, the web UI, everything, for want of the native host's sound or its
// hardware encoder. That is what the AppImage catalog's test hit (29/09/2026:
// "libpipewire-0.3.so.0: cannot open shared object file"), and what a headless
// box or a minimal container would hit too.
//
// So these libraries are opened with dlopen on first use, like libX11 and the
// Vulkan loader already are, and the functions the module calls are defined
// here as forwarders with the headers' own prototypes (the compiler rejects a
// forwarder whose signature drifts from the library's). Absent library → each
// forwarder returns the library's own failure value, which every caller
// already handles: no display, no loop, an error status.
//
// They are never bundled either, for the reason release.yml gives: their
// driver and module paths are compiled in, so a copy from the build host looks
// in the wrong place on another distribution.

#include "../../core/Log.h"

#include <dlfcn.h>
#include <mutex>
#include <string>

namespace mw::native::platform {

class LazyLibrary
{
public:
    /// @param soname the ABI name (libva.so.2), never the -dev symlink.
    /// @param purpose what is lost without it, for the one log line.
    LazyLibrary(const char* soname, const char* purpose)
        : m_Soname(soname)
        , m_Purpose(purpose)
    {}

    LazyLibrary(const LazyLibrary&) = delete;
    LazyLibrary& operator=(const LazyLibrary&) = delete;

    /// Opens the library on the first call, and says so once if it cannot.
    bool available()
    {
        std::call_once(m_Once, [this] {
            // RTLD_LOCAL keeps its symbols out of the global scope, where they
            // would meet the forwarders of the same name; RTLD_NOW makes a
            // truncated library fail here rather than mid-session.
            m_Handle = ::dlopen(m_Soname, RTLD_NOW | RTLD_LOCAL);
            if (m_Handle) {
                log::debug(std::string("[native] ") + m_Soname + " loaded");
            } else {
                const char* why = ::dlerror();
                log::info(std::string("[native] ") + m_Soname + " is not installed — " + m_Purpose +
                          (why ? std::string(" (") + why + ")" : std::string()));
            }
        });
        return m_Handle != nullptr;
    }

    /// nullptr when the library or the symbol is missing.
    void* symbol(const char* name) { return available() ? ::dlsym(m_Handle, name) : nullptr; }

    const char* soname() const { return m_Soname; }

private:
    const char* m_Soname;
    const char* m_Purpose;
    std::once_flag m_Once;
    void* m_Handle = nullptr;
};

} // namespace mw::native::platform

// A forwarder for `name`, resolved once, on its first call. `params` is the
// parenthesised parameter list with names, `args` the same names in a call,
// `fallback` what the library itself returns on failure. The static is a
// magic static, so two threads calling first at once resolve it once.
#define MW_LAZY_FORWARD(lib, ret, name, params, args, fallback)                                    \
    extern "C" ret name params                                                                     \
    {                                                                                              \
        static const auto fn = reinterpret_cast<decltype(&::name)>((lib).symbol(#name));           \
        return fn ? fn args : fallback;                                                            \
    }

#define MW_LAZY_FORWARD_VOID(lib, name, params, args)                                              \
    extern "C" void name params                                                                    \
    {                                                                                              \
        static const auto fn = reinterpret_cast<decltype(&::name)>((lib).symbol(#name));           \
        if (fn) fn args;                                                                           \
    }
