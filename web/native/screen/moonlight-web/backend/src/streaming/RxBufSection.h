/*
 * MoonlightWeb — self-hosted web client for Moonlight game streaming.
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

#include <cctype>
#include <string>
#include <vector>

/// `rxbuf=` (plan « Gels du lien », point 1; every host's default since
/// 20/10): the codecs of the silent video section, whether a session offers
/// it, and what the browser's answer made of it.
///
/// The section is only there for Chrome's video channel, which raises the
/// bundle's UDP receive buffer from 64 to 256 KB; nothing is ever sent on it.
/// A browser keeps it only if it shares one of its codecs. H.264 alone (19/10)
/// left out a Firefox without OpenH264 and a Chromium built without the
/// proprietary codecs; VP8 is mandatory in every WebRTC browser (RFC 7742).
/// A browser that shares neither answers the section with port 0, and its
/// buffer stays where it was: the stream itself is untouched.
///
/// The payload types stay apart from the bundle's other sections: 96 the RTP
/// video, 97 Ultra's VP8, 109 to 111 the Opus tracks.
namespace mw::rxbuf {

inline constexpr int kH264Pt = 98;
inline constexpr int kVp8Pt = 99;

/// Whether a GameStream host's session offers the section, from the same
/// `native_tuning` spec as the native host's: its `rxbuf=` alone, items split
/// on commas or semicolons. On unless `rxbuf=0`; no key, or a value other than
/// 0 or 1, keeps it on. The spec's other keys are the native host's, and a
/// GameStream session takes none of them: one it cannot read changes nothing
/// here. The native host reads the whole spec (EncoderTuning::rxBufVideo).
inline bool offeredFromSpec(const std::string& spec)
{
    auto trim = [](std::string s) {
        while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front())))
            s.erase(0, 1);
        while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back())))
            s.pop_back();
        return s;
    };
    bool on = true;
    std::size_t at = 0;
    while (at <= spec.size()) {
        std::size_t end = spec.find_first_of(",;", at);
        if (end == std::string::npos) end = spec.size();
        const std::string item = spec.substr(at, end - at);
        const std::size_t eq = item.find('=');
        if (eq != std::string::npos) {
            std::string key = trim(item.substr(0, eq));
            for (char& c : key)
                c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            const std::string value = trim(item.substr(eq + 1));
            if (key == "rxbuf" && (value == "0" || value == "1")) on = value == "1";
        }
        at = end + 1;
    }
    return on;
}

/// The answer's verdict on the section, for the log. @p found false when the
/// answer has no section of that mid, @p removed for one answered with port 0,
/// @p inactive for one the page set inactive (no RTCRtpScriptTransform),
/// @p pts the payload types it kept.
inline std::string verdict(bool found, bool removed, bool inactive, const std::vector<int>& pts)
{
    if (!found) return "missing from the answer";
    if (removed) return "refused, no codec in common: the browser's buffer stays as it was";
    std::string codecs;
    for (const int pt : pts) {
        const char* name = pt == kH264Pt ? "H.264" : pt == kVp8Pt ? "VP8" : nullptr;
        if (!name) continue;
        if (!codecs.empty()) codecs += " + ";
        codecs += name;
    }
    if (codecs.empty()) codecs = "none of its codecs named";
    return std::string(inactive ? "taken, inactive, " : "taken, ") + codecs;
}

} // namespace mw::rxbuf
