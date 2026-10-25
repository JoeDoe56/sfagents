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

#include <cstdint>

namespace mw::sctp {

/// usrsctp's own counters. Process-wide — usrsctp keeps none per association —
/// which in worker mode is one session. Subtract two readings for a window.
struct Counters
{
    uint32_t sent = 0;       ///< DATA chunks sent, first time and again
    uint32_t retrans = 0;    ///< DATA chunks sent again
    uint32_t fast = 0;       ///< of which by fast retransmit (3 SACKs missing it)
    uint32_t t3 = 0;         ///< retransmission timer expiries (the slow repair)
    uint32_t multFast = 0;   ///< a chunk fast-retransmitted more than once
    uint32_t fastInRtt = 0;  ///< losses inside a recovery already under way: the
                             ///< window would have been cut again, RFC 2582 spared it
    uint32_t sacks = 0;      ///< SACK chunks received
    uint32_t cwndHeld = 0;   ///< sends queued because the flight was above the window
    uint32_t burstHeld = 0;  ///< windows trimmed to max burst after a send
    uint32_t packetsOut = 0; ///< SCTP packets sent
    uint32_t dupIn = 0;      ///< duplicate DATA chunks received (the client's way up)

    Counters operator-(const Counters& o) const
    {
        Counters d;
        d.sent = sent - o.sent;
        d.retrans = retrans - o.retrans;
        d.fast = fast - o.fast;
        d.t3 = t3 - o.t3;
        d.multFast = multFast - o.multFast;
        d.fastInRtt = fastInRtt - o.fastInRtt;
        d.sacks = sacks - o.sacks;
        d.cwndHeld = cwndHeld - o.cwndHeld;
        d.burstHeld = burstHeld - o.burstHeld;
        d.packetsOut = packetsOut - o.packetsOut;
        d.dupIn = dupIn - o.dupIn;
        return d;
    }
};

/// Kept apart from DataChannelRelay.cpp: usrsctp.h brings windows.h with it,
/// and its min/max macros break every std::max of that file.
Counters readCounters();

/// usrsctp's stream scheduler for the associations made from now on (the
/// bench's `sctpss=`, plan Wi-Fi W2.3): 0 its default, 1 round robin, 2 round
/// robin by packet, 3 priority, 4 fair bandwidth, 5 first come. A sysctl, read
/// when an SCTP socket is made and reset by usrsctp_init: set it after the
/// peer connection, which initialises usrsctp, and before its SCTP transport.
/// @returns false for a module usrsctp refused
bool setStreamScheduler(int module);

} // namespace mw::sctp
