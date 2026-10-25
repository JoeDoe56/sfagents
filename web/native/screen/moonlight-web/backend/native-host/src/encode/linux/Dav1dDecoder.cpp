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

#include "Dav1dDecoder.h"

#if defined(MW_NATIVE_LINUX_DAV1D)
#include <dav1d/dav1d.h>
#include <dlfcn.h>

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstring>
#endif

namespace mw::native::encode {

#if defined(MW_NATIVE_LINUX_DAV1D)

namespace {

/// The functions the proof calls, looked up by name.
struct Library
{
    void* handle = nullptr;
    decltype(&dav1d_version) version = nullptr;
    decltype(&dav1d_default_settings) defaultSettings = nullptr;
    decltype(&dav1d_open) open = nullptr;
    decltype(&dav1d_close) close = nullptr;
    decltype(&dav1d_data_create) dataCreate = nullptr;
    decltype(&dav1d_data_unref) dataUnref = nullptr;
    decltype(&dav1d_send_data) sendData = nullptr;
    decltype(&dav1d_get_picture) getPicture = nullptr;
    decltype(&dav1d_picture_unref) pictureUnref = nullptr;
};

/// ⚠️ The headers are the build machine's (dav1d 0.9 on the CI's Ubuntu
/// 22.04), the library the user's (1.4 on 24.04, with another soname). Every
/// version from 0.9 on starts its settings with n_threads and max_frame_delay,
/// its data with the pointer and the size, and its picture with the headers,
/// the planes, the strides and the parameters — the only fields read or
/// written here. Each structure is handed a room larger than any version's,
/// so a newer library writes its own tail into it and nothing past it.
template <typename T> union Room
{
    T value;
    unsigned char bytes[4096];
    Room() { std::memset(bytes, 0, sizeof(bytes)); }
};
static_assert(sizeof(Dav1dSettings) < 2048 && sizeof(Dav1dPicture) < 2048 &&
                  sizeof(Dav1dData) < 2048,
              "a room for the structures of a newer dav1d");

/// The sonames tried, newest first: 1.x and 0.9.
const char* const kSonames[] = {"libdav1d.so.7", "libdav1d.so.6", "libdav1d.so.5"};

} // namespace

struct Dav1dDecoder::Impl
{
    Library lib;
    Dav1dContext* context = nullptr;
};

Dav1dDecoder::Dav1dDecoder()
    : d(std::make_unique<Impl>())
{}

Dav1dDecoder::~Dav1dDecoder()
{
    close();
}

bool Dav1dDecoder::built()
{
    return true;
}

bool Dav1dDecoder::open(std::string& error)
{
    close();
    Library& lib = d->lib;
    const char* name = nullptr;
    for (const char* soname : kSonames) {
        lib.handle = ::dlopen(soname, RTLD_NOW | RTLD_LOCAL);
        if (lib.handle) {
            name = soname;
            break;
        }
    }
    if (!lib.handle) {
        error = "no AV1 decoder for the pixel proof (libdav1d.so.7, .6 or .5: install libdav1d7)";
        return false;
    }
#define MW_DAV1D_LOAD(field, symbol)                                                               \
    lib.field = reinterpret_cast<decltype(lib.field)>(::dlsym(lib.handle, #symbol));               \
    if (!lib.field) {                                                                              \
        error = std::string(name) + " has no " #symbol;                                            \
        close();                                                                                   \
        return false;                                                                              \
    }
    MW_DAV1D_LOAD(version, dav1d_version)
    MW_DAV1D_LOAD(defaultSettings, dav1d_default_settings)
    MW_DAV1D_LOAD(open, dav1d_open)
    MW_DAV1D_LOAD(close, dav1d_close)
    MW_DAV1D_LOAD(dataCreate, dav1d_data_create)
    MW_DAV1D_LOAD(dataUnref, dav1d_data_unref)
    MW_DAV1D_LOAD(sendData, dav1d_send_data)
    MW_DAV1D_LOAD(getPicture, dav1d_get_picture)
    MW_DAV1D_LOAD(pictureUnref, dav1d_picture_unref)
#undef MW_DAV1D_LOAD
    m_Version = std::string("dav1d ") + lib.version();

    Room<Dav1dSettings> settings;
    lib.defaultSettings(&settings.value);
    // A picture per temporal unit, at once: what a stream's receiver does.
#if DAV1D_API_VERSION_MAJOR >= 6
    settings.value.n_threads = 1;
    settings.value.max_frame_delay = 1;
#else
    // dav1d before 1.0 (Ubuntu 22.04's, which the release packages build
    // against) names the same two leading ints this way, so a newer library
    // opened at run time reads the very values above.
    settings.value.n_frame_threads = 1;
    settings.value.n_tile_threads = 1;
#endif
    const int r = lib.open(&d->context, &settings.value);
    if (r < 0 || !d->context) {
        error = m_Version + " does not open: " + std::strerror(-r);
        d->context = nullptr;
        close();
        return false;
    }
    return true;
}

bool Dav1dDecoder::decode(const uint8_t* data, size_t size, int width, int height,
                          std::vector<uint8_t>& nv12, int& frameWidth, int& frameHeight,
                          std::string& error)
{
    if (!d->context) {
        error = "the decoder is not open";
        return false;
    }
    Library& lib = d->lib;
    Room<Dav1dData> in;
    uint8_t* buffer = lib.dataCreate(&in.value, size);
    if (!buffer) {
        error = "dav1d_data_create failed";
        return false;
    }
    std::memcpy(buffer, data, size);
    Room<Dav1dPicture> picture;
    bool got = false;
    // Data in until it is all taken, a picture out whenever there is one; a
    // decoder with no frame delay has it once the unit is in.
    for (int round = 0; round < 64 && !got; ++round) {
        if (in.value.sz > 0) {
            const int sent = lib.sendData(d->context, &in.value);
            if (sent < 0 && sent != -EAGAIN) {
                lib.dataUnref(&in.value);
                error = "dav1d refuses the data: " + std::string(std::strerror(-sent));
                return false;
            }
        }
        const int r = lib.getPicture(d->context, &picture.value);
        if (r == 0) {
            got = true;
        } else if (r != -EAGAIN) {
            if (in.value.sz > 0) lib.dataUnref(&in.value);
            error = "dav1d does not decode it: " + std::string(std::strerror(-r));
            return false;
        } else if (in.value.sz == 0) {
            break;
        }
    }
    if (in.value.sz > 0) lib.dataUnref(&in.value);
    if (!got) {
        error = "dav1d gave no picture back for it";
        return false;
    }
    const Dav1dPicture& p = picture.value;
    frameWidth = p.p.w;
    frameHeight = p.p.h;
    if (p.p.layout != DAV1D_PIXEL_LAYOUT_I420 || p.p.bpc != 8 || width > p.p.w || height > p.p.h ||
        width <= 0 || height <= 0 || (width | height) & 1) {
        lib.pictureUnref(&picture.value);
        error = "dav1d decoded a " + std::to_string(p.p.w) + "x" + std::to_string(p.p.h) +
                (p.p.bpc != 8 || p.p.layout != DAV1D_PIXEL_LAYOUT_I420 ? " picture not 8-bit 4:2:0"
                                                                       : " frame") +
                ", where " + std::to_string(width) + "x" + std::to_string(height) + " was asked";
        return false;
    }
    // The picture as shown: the size asked, from the frame's top left.
    const size_t w = static_cast<size_t>(width), h = static_cast<size_t>(height);
    nv12.resize(w * h * 3 / 2);
    const auto* y = static_cast<const uint8_t*>(p.data[0]);
    const auto* u = static_cast<const uint8_t*>(p.data[1]);
    const auto* v = static_cast<const uint8_t*>(p.data[2]);
    for (size_t row = 0; row < h; ++row)
        std::memcpy(nv12.data() + row * w, y + static_cast<ptrdiff_t>(row) * p.stride[0], w);
    uint8_t* uv = nv12.data() + w * h;
    for (size_t row = 0; row < h / 2; ++row) {
        const uint8_t* ur = u + static_cast<ptrdiff_t>(row) * p.stride[1];
        const uint8_t* vr = v + static_cast<ptrdiff_t>(row) * p.stride[1];
        for (size_t col = 0; col < w / 2; ++col) {
            uv[row * w + 2 * col] = ur[col];
            uv[row * w + 2 * col + 1] = vr[col];
        }
    }
    lib.pictureUnref(&picture.value);
    return true;
}

void Dav1dDecoder::close()
{
    if (!d) return;
    if (d->context && d->lib.close) d->lib.close(&d->context);
    d->context = nullptr;
    if (d->lib.handle) ::dlclose(d->lib.handle);
    d->lib = Library{};
}

#else // no dav1d headers at build time

struct Dav1dDecoder::Impl
{};

Dav1dDecoder::Dav1dDecoder()
    : d(std::make_unique<Impl>())
{}

Dav1dDecoder::~Dav1dDecoder() = default;

bool Dav1dDecoder::built()
{
    return false;
}

bool Dav1dDecoder::open(std::string& error)
{
    error = "this build has no AV1 decoder for the pixel proof (libdav1d-dev was not there)";
    return false;
}

bool Dav1dDecoder::decode(const uint8_t*, size_t, int, int, std::vector<uint8_t>&, int&, int&,
                          std::string& error)
{
    error = "the decoder is not open";
    return false;
}

void Dav1dDecoder::close() {}

#endif

} // namespace mw::native::encode
