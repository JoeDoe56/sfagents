/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
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
#include <cstring>

// Filler-data NAL units removed from an Annex B access unit, in place.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// A constant-bitrate encoder pads short pictures up to its rate with filler
// NALs (H.264 type 12, HEVC type 38): bytes that exist to keep a serial link's
// buffer model honest and carry no picture. Sunshine's Vulkan Video encoders
// on RADV do it (29/09/2026, Mesa 26.2.3 on the 780M): an HEVC keyframe of
// 37 KB carried 16 KB of filler, one NAL of it placed BEFORE the IDR slice.
//
// Over WebRTC nothing downstream needs them — the browser's decoder drops
// them — so every one is bandwidth spent on nothing. And the one ahead of the
// slice is not even allowed there: the Mac's Chrome 126 refused that keyframe
// with "A key frame is required after configure()", three times, and the
// stream fell back to AV1.
//
// ── Contract ────────────────────────────────────────────────────────────────
//
// Only filler NALs are removed, each with its own start code; every other
// byte keeps its order. Nothing is written when the unit holds no filler.
// Annex B's emulation prevention guarantees no start code inside a NAL, so
// the scan cannot cut one in two. AV1 has no start codes: never call this on
// it.
namespace AnnexBFiller {

inline bool isFiller(uint8_t nalHeader, bool hevc)
{
    return hevc ? ((nalHeader >> 1) & 0x3F) == 38 : (nalHeader & 0x1F) == 12;
}

/// Removes the filler NALs of `data[0..size)` in place and returns the size
/// kept (`size` itself when there was none).
inline size_t strip(uint8_t* data, size_t size, bool hevc)
{
    static constexpr size_t kNone = static_cast<size_t>(-1);

    size_t written = 0;       // bytes kept so far, compacted at the front
    size_t pendingFrom = 0;   // start of the kept run not yet compacted
    size_t nalStart = kNone;  // start code of the NAL being walked
    size_t nalHeader = kNone; // its header byte
    bool nalIsFiller = false;
    bool removed = false;

    const auto closeNal = [&](size_t end) {
        if (nalStart == kNone || !nalIsFiller) return;
        // Keep what came before this NAL, drop the NAL itself.
        if (written != pendingFrom)
            std::memmove(data + written, data + pendingFrom, nalStart - pendingFrom);
        written += nalStart - pendingFrom;
        pendingFrom = end;
        removed = true;
    };

    size_t from = 2; // a start code's 0x01 sits at index 2 at the earliest
    while (from < size) {
        const void* hit = std::memchr(data + from, 0x01, size - from);
        if (!hit) break;
        const size_t one = static_cast<size_t>(static_cast<const uint8_t*>(hit) - data);
        from = one + 1;
        if (data[one - 1] != 0 || data[one - 2] != 0) continue;

        size_t start = one - 2;
        // The four-byte form, without eating the previous NAL's header.
        if (start > 0 && data[start - 1] == 0 && (nalHeader == kNone || start - 1 > nalHeader))
            --start;

        closeNal(start);
        nalStart = start;
        nalHeader = one + 1;
        nalIsFiller = nalHeader < size && isFiller(data[nalHeader], hevc);
        from = one + 3; // the next 0x01 needs a header byte and two zeros first
    }
    closeNal(size);

    if (!removed) return size;
    if (written != pendingFrom)
        std::memmove(data + written, data + pendingFrom, size - pendingFrom);
    return written + (size - pendingFrom);
}

} // namespace AnnexBFiller
