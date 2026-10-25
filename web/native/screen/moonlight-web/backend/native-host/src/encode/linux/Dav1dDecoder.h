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

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// The eyes of the Vulkan AV1 encoder's pixel proof (C13.12): dav1d, the AV1
// decoder Chrome itself falls back to when the GPU decodes no AV1 — so a
// stream it reads right is a stream the browser reads right, whatever the
// encoding GPU's own decoder would have said.
//
// Opened at run time (dlopen, libdav1d.so.7, .6 or .5, whichever the machine
// has) and never linked: a host without it still streams, HEVC and H.264,
// and its AV1 is refused by the proof that cannot run. dav1d is BSD-2-Clause;
// only its public headers are read at build time, from the system
// (libdav1d-dev), as libva's and libpipewire's are.

namespace mw::native::encode {

class Dav1dDecoder
{
public:
    Dav1dDecoder();
    ~Dav1dDecoder();

    Dav1dDecoder(const Dav1dDecoder&) = delete;
    Dav1dDecoder& operator=(const Dav1dDecoder&) = delete;

    /// Whether this build carries the decoder at all.
    static bool built();

    /// Opens the library and a decoder that hands each picture back as soon
    /// as its temporal unit is in: one thread, no frame delay.
    bool open(std::string& error);

    /// One temporal unit in, its picture out as NV12, @p width × @p height
    /// from the frame's top left (what the render size shows); the frame's
    /// own size in @p frameWidth × @p frameHeight. False, with dav1d's reason,
    /// when it does not decode or is smaller than asked.
    bool decode(const uint8_t* data, size_t size, int width, int height, std::vector<uint8_t>& nv12,
                int& frameWidth, int& frameHeight, std::string& error);

    /// "dav1d 1.4.1", for the proof's line.
    const std::string& version() const { return m_Version; }

    void close();

private:
    struct Impl;
    std::unique_ptr<Impl> d;
    std::string m_Version;
};

} // namespace mw::native::encode
