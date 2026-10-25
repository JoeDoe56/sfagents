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

// libva and libva-drm, opened on first use (LazyLibrary.h says why). Every
// entry point the module and its tests call is forwarded here; `nm -u` on
// libmw-native-host.a against the libraries' exports is how the list was
// made, and a call added without its forwarder fails the link, since nothing
// links libva any more.
//
// Without libva the display comes back null, which LinuxProbe and
// VaapiEncoder already take as "no VA-API here": the host falls to the
// OpenH264 CPU encoder, as on a machine with no render node.

#include "LazyLibrary.h"

#include <va/va.h>
#include <va/va_drm.h>

namespace {

mw::native::platform::LazyLibrary g_Va("libva.so.2", "VA-API hardware encoding is unavailable");
mw::native::platform::LazyLibrary g_VaDrm("libva-drm.so.2",
                                          "VA-API hardware encoding is unavailable");

} // namespace

// clang-format off
MW_LAZY_FORWARD(g_VaDrm, VADisplay, vaGetDisplayDRM, (int fd), (fd), nullptr)

MW_LAZY_FORWARD(g_Va, VAStatus, vaInitialize, (VADisplay dpy, int* major_version, int* minor_version), (dpy, major_version, minor_version), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaTerminate, (VADisplay dpy), (dpy), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, const char*, vaErrorStr, (VAStatus error_status), (error_status), "libva is not installed")
MW_LAZY_FORWARD(g_Va, const char*, vaQueryVendorString, (VADisplay dpy), (dpy), nullptr)
MW_LAZY_FORWARD(g_Va, int, vaMaxNumProfiles, (VADisplay dpy), (dpy), 0)
MW_LAZY_FORWARD(g_Va, int, vaMaxNumEntrypoints, (VADisplay dpy), (dpy), 0)
MW_LAZY_FORWARD(g_Va, VAStatus, vaQueryConfigProfiles, (VADisplay dpy, VAProfile* profile_list, int* num_profiles), (dpy, profile_list, num_profiles), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaQueryConfigEntrypoints, (VADisplay dpy, VAProfile profile, VAEntrypoint* entrypoint_list, int* num_entrypoints), (dpy, profile, entrypoint_list, num_entrypoints), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaGetConfigAttributes, (VADisplay dpy, VAProfile profile, VAEntrypoint entrypoint, VAConfigAttrib* attrib_list, int num_attribs), (dpy, profile, entrypoint, attrib_list, num_attribs), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaCreateConfig, (VADisplay dpy, VAProfile profile, VAEntrypoint entrypoint, VAConfigAttrib* attrib_list, int num_attribs, VAConfigID* config_id), (dpy, profile, entrypoint, attrib_list, num_attribs, config_id), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaDestroyConfig, (VADisplay dpy, VAConfigID config_id), (dpy, config_id), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaCreateSurfaces, (VADisplay dpy, unsigned int format, unsigned int width, unsigned int height, VASurfaceID* surfaces, unsigned int num_surfaces, VASurfaceAttrib* attrib_list, unsigned int num_attribs), (dpy, format, width, height, surfaces, num_surfaces, attrib_list, num_attribs), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaDestroySurfaces, (VADisplay dpy, VASurfaceID* surfaces, int num_surfaces), (dpy, surfaces, num_surfaces), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaCreateContext, (VADisplay dpy, VAConfigID config_id, int picture_width, int picture_height, int flag, VASurfaceID* render_targets, int num_render_targets, VAContextID* context), (dpy, config_id, picture_width, picture_height, flag, render_targets, num_render_targets, context), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaDestroyContext, (VADisplay dpy, VAContextID context), (dpy, context), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaCreateBuffer, (VADisplay dpy, VAContextID context, VABufferType type, unsigned int size, unsigned int num_elements, void* data, VABufferID* buf_id), (dpy, context, type, size, num_elements, data, buf_id), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaDestroyBuffer, (VADisplay dpy, VABufferID buffer_id), (dpy, buffer_id), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaMapBuffer, (VADisplay dpy, VABufferID buf_id, void** pbuf), (dpy, buf_id, pbuf), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaUnmapBuffer, (VADisplay dpy, VABufferID buf_id), (dpy, buf_id), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaBeginPicture, (VADisplay dpy, VAContextID context, VASurfaceID render_target), (dpy, context, render_target), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaRenderPicture, (VADisplay dpy, VAContextID context, VABufferID* buffers, int num_buffers), (dpy, context, buffers, num_buffers), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaEndPicture, (VADisplay dpy, VAContextID context), (dpy, context), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaSyncSurface, (VADisplay dpy, VASurfaceID render_target), (dpy, render_target), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaExportSurfaceHandle, (VADisplay dpy, VASurfaceID surface_id, uint32_t mem_type, uint32_t flags, void* descriptor), (dpy, surface_id, mem_type, flags, descriptor), VA_STATUS_ERROR_UNIMPLEMENTED)

// The tests read surfaces back; the module itself never does.
MW_LAZY_FORWARD(g_Va, VAStatus, vaCreateImage, (VADisplay dpy, VAImageFormat* format, int width, int height, VAImage* image), (dpy, format, width, height, image), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaGetImage, (VADisplay dpy, VASurfaceID surface, int x, int y, unsigned int width, unsigned int height, VAImageID image), (dpy, surface, x, y, width, height, image), VA_STATUS_ERROR_UNIMPLEMENTED)
MW_LAZY_FORWARD(g_Va, VAStatus, vaDestroyImage, (VADisplay dpy, VAImageID image), (dpy, image), VA_STATUS_ERROR_UNIMPLEMENTED)
// clang-format on
