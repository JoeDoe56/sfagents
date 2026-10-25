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

#include "SctpCounters.h"

#include <cstring>

#include <usrsctp.h>

namespace mw::sctp {

Counters readCounters()
{
    struct sctpstat st;
    std::memset(&st, 0, sizeof st);
    usrsctp_get_stat(&st);
    Counters c;
    c.sent = st.sctps_senddata;
    c.retrans = st.sctps_sendretransdata;
    c.fast = st.sctps_sendfastretrans;
    c.t3 = st.sctps_timodata;
    c.multFast = st.sctps_sendmultfastretrans;
    c.fastInRtt = st.sctps_fastretransinrtt;
    c.sacks = st.sctps_recvsacks;
    c.cwndHeld = st.sctps_send_cwnd_avoid;
    c.burstHeld = st.sctps_maxburstqueued;
    c.packetsOut = st.sctps_sendpackets;
    c.dupIn = st.sctps_recvdupdata;
    return c;
}

bool setStreamScheduler(int module)
{
    if (module < 0) return false;
    return usrsctp_sysctl_set_sctp_default_ss_module(static_cast<uint32_t>(module)) == 0;
}

} // namespace mw::sctp
