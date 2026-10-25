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

// libpipewire-0.3, opened on first use (platform/linux/LazyLibrary.h says
// why). Only the library's real exports are forwarded: pw_core_*, pw_registry_*,
// pw_node_*, pw_loop_* and friends are SPA interface macros that call through
// the objects these return, so they need no forwarder. The list is `nm -u` on
// libmw-native-host.a against libpipewire's exports; a call added without its
// forwarder fails the link, since nothing links libpipewire any more.
//
// Built against the headers of 0.3.48 (Ubuntu 22.04, the release build) and
// of 1.x alike; where a prototype changed between them, PW_CHECK_VERSION picks.

#include "PipeWireLibrary.h"

#include "../../platform/linux/LazyLibrary.h"

#include <pipewire/pipewire.h>
#include <pipewire/version.h>

#include <cerrno>
#include <cstdarg>

namespace {

mw::native::platform::LazyLibrary g_PipeWire("libpipewire-0.3.so.0",
                                             "the native host streams without sound and cannot "
                                             "capture through the ScreenCast portal");

} // namespace

namespace mw::native::audio {

bool pipeWireAvailable()
{
    return g_PipeWire.available();
}

} // namespace mw::native::audio

// 0.3.66 made the deadline const.
#if PW_CHECK_VERSION(0, 3, 66)
#define MW_PW_DEADLINE const struct timespec
#else
#define MW_PW_DEADLINE struct timespec
#endif

// clang-format off
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_init, (int* argc, char** argv[]), (argc, argv))
MW_LAZY_FORWARD(g_PipeWire, const char*, pw_get_library_version, (void), (), nullptr)

MW_LAZY_FORWARD(g_PipeWire, struct pw_thread_loop*, pw_thread_loop_new, (const char* name, const struct spa_dict* props), (name, props), nullptr)
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_thread_loop_destroy, (struct pw_thread_loop* loop), (loop))
MW_LAZY_FORWARD(g_PipeWire, int, pw_thread_loop_start, (struct pw_thread_loop* loop), (loop), -ENOSYS)
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_thread_loop_stop, (struct pw_thread_loop* loop), (loop))
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_thread_loop_lock, (struct pw_thread_loop* loop), (loop))
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_thread_loop_unlock, (struct pw_thread_loop* loop), (loop))
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_thread_loop_signal, (struct pw_thread_loop* loop, bool wait_for_accept), (loop, wait_for_accept))
MW_LAZY_FORWARD(g_PipeWire, struct pw_loop*, pw_thread_loop_get_loop, (struct pw_thread_loop* loop), (loop), nullptr)
MW_LAZY_FORWARD(g_PipeWire, int, pw_thread_loop_get_time, (struct pw_thread_loop* loop, struct timespec* abstime, int64_t timeout), (loop, abstime, timeout), -ENOSYS)
MW_LAZY_FORWARD(g_PipeWire, int, pw_thread_loop_timed_wait_full, (struct pw_thread_loop* loop, MW_PW_DEADLINE* abstime), (loop, abstime), -ENOSYS)

MW_LAZY_FORWARD(g_PipeWire, struct pw_context*, pw_context_new, (struct pw_loop* main_loop, struct pw_properties* props, size_t user_data_size), (main_loop, props, user_data_size), nullptr)
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_context_destroy, (struct pw_context* context), (context))
MW_LAZY_FORWARD(g_PipeWire, struct pw_core*, pw_context_connect, (struct pw_context* context, struct pw_properties* properties, size_t user_data_size), (context, properties, user_data_size), nullptr)
MW_LAZY_FORWARD(g_PipeWire, struct pw_core*, pw_context_connect_fd, (struct pw_context* context, int fd, struct pw_properties* properties, size_t user_data_size), (context, fd, properties, user_data_size), nullptr)
MW_LAZY_FORWARD(g_PipeWire, int, pw_core_disconnect, (struct pw_core* core), (core), -ENOSYS)
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_proxy_destroy, (struct pw_proxy* proxy), (proxy))

MW_LAZY_FORWARD_VOID(g_PipeWire, pw_properties_free, (struct pw_properties* properties), (properties))

MW_LAZY_FORWARD(g_PipeWire, struct pw_stream*, pw_stream_new, (struct pw_core* core, const char* name, struct pw_properties* props), (core, name, props), nullptr)
MW_LAZY_FORWARD(g_PipeWire, struct pw_stream*, pw_stream_new_simple, (struct pw_loop* loop, const char* name, struct pw_properties* props, const struct pw_stream_events* events, void* data), (loop, name, props, events, data), nullptr)
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_stream_destroy, (struct pw_stream* stream), (stream))
MW_LAZY_FORWARD_VOID(g_PipeWire, pw_stream_add_listener, (struct pw_stream* stream, struct spa_hook* listener, const struct pw_stream_events* events, void* data), (stream, listener, events, data))
MW_LAZY_FORWARD(g_PipeWire, int, pw_stream_connect, (struct pw_stream* stream, enum pw_direction direction, uint32_t target_id, enum pw_stream_flags flags, const struct spa_pod** params, uint32_t n_params), (stream, direction, target_id, flags, params, n_params), -ENOSYS)
MW_LAZY_FORWARD(g_PipeWire, int, pw_stream_update_params, (struct pw_stream* stream, const struct spa_pod** params, uint32_t n_params), (stream, params, n_params), -ENOSYS)
MW_LAZY_FORWARD(g_PipeWire, struct pw_buffer*, pw_stream_dequeue_buffer, (struct pw_stream* stream), (stream), nullptr)
MW_LAZY_FORWARD(g_PipeWire, int, pw_stream_queue_buffer, (struct pw_stream* stream, struct pw_buffer* buffer), (stream, buffer), -ENOSYS)
// clang-format on

// Variadic, so it cannot be forwarded as it stands: the pairs are read here
// and set one by one on an empty set, which is what the library itself does
// with them (an empty key or a null value is skipped there too).
extern "C" struct pw_properties* pw_properties_new(const char* key, ...)
{
    using New = struct pw_properties* (*)(const char*, ...);
    using Set = int (*)(struct pw_properties*, const char*, const char*);
    static const auto create = reinterpret_cast<New>(g_PipeWire.symbol("pw_properties_new"));
    static const auto set = reinterpret_cast<Set>(g_PipeWire.symbol("pw_properties_set"));
    if (!create || !set) return nullptr;

    struct pw_properties* properties = create(nullptr);
    if (!properties) return nullptr;
    va_list pairs;
    va_start(pairs, key);
    while (key != nullptr) {
        const char* value = va_arg(pairs, const char*);
        if (value && key[0] != '\0') set(properties, key, value);
        key = va_arg(pairs, const char*);
    }
    va_end(pairs);
    return properties;
}
