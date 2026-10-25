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

#include <array>
#include <cstdlib>
#include <string>

// The DSCP our WebRTC packets leave with (plan « le son et la priorité des
// paquets », D5).
//
// AF41 for everything — sound, video, data channels — by default. On the
// Freebox's Wi-Fi every AF4x value goes to the video queue (VI), ahead of the
// house's downloads; the night of 11-12/10 measured what that buys against a
// download onto the client's own station: 32 to 40 ms off every click, where
// the unmarked stream fell under 8 Mbit/s each time. Upstream libdatachannel's
// own values (EF / AF42 / AF11) put the SCTP video, the default, in AF11: the
// Wi-Fi's background queue.
//
// libjuice sets it on the socket: Linux; Windows through our patch
// (libjuice-windows-diffserv.patch; an unelevated IP_TOS marks there, under
// the service too); macOS through another (libjuice-macos-diffserv.patch: its
// dual-stack socket marks IPv6 only, so each packet to an IPv4 peer carries
// the class itself). An installer QoS policy was set aside: Windows leaves it
// out of force after a reboot on a PC outside a domain.
//
// `packet_marking: false` in settings.json marks nothing. The bench's
// MW_DSCP="<audio>,<video>,<data>" (each 0-63) overrides both.
namespace PacketMarking {

/// AF41: Assured Forwarding class 4, low drop probability.
constexpr unsigned int kAf41 = 34;

/// Audio, video and data DSCP for the setting and an MW_DSCP value (empty, or
/// malformed, is no override).
inline std::array<unsigned int, 3> resolve(bool marking, const std::string& override_)
{
    std::array<unsigned int, 3> out{};
    size_t at = 0;
    int i = 0;
    for (; i < 3; ++i) {
        const size_t comma = override_.find(',', at);
        const std::string part =
            override_.substr(at, comma == std::string::npos ? std::string::npos : comma - at);
        if (part.empty() || part.size() > 2 ||
            part.find_first_not_of("0123456789") != std::string::npos)
            break;
        const int v = std::stoi(part);
        if (v > 63) break;
        out[i] = static_cast<unsigned int>(v);
        if (i < 2 && comma == std::string::npos) break;
        if (i == 2 && comma != std::string::npos) {
            i = -1; // a fourth value
            break;
        }
        at = comma + 1;
    }
    if (i == 3) return out;
    const unsigned int v = marking ? kAf41 : 0;
    return {v, v, v};
}

/// The bench's silent carrier (MW_DSCP_CARRIER=1, off by default): the stream's
/// sound is offered sendrecv instead of sendonly, so a browser with the bench key
/// mw_dscp_carrier (frontend DscpCarrier.js) can answer it with a sender of its
/// own at a high network priority, and mark what it sends on the way up. What
/// arrives on that track is dropped.
inline bool carrierOffered()
{
    const char* v = std::getenv("MW_DSCP_CARRIER");
    return v && std::string(v) == "1";
}

/// Apply the above to libdatachannel, process-wide. Called before each peer
/// connection is made; cheap, and logs only when the values change.
void apply();

} // namespace PacketMarking
