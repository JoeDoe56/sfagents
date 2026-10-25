/*
 * MoonlightWeb — does UDP get out of this network?
 * Copyright (C) 2026 Bruno Martin. GPLv3 — see repository LICENSE.
 */

import { defaultIceServers } from './IceServers.js';

/**
 * Ask STUN, briefly, whether this browser can reach the internet over UDP.
 *
 * A network that blocks outgoing UDP (a corporate Wi-Fi, a hotel, a guest
 * network) lets every UDP rung of the transport chain run to its ICE deadline
 * before the chain moves on — about ten seconds each, twenty before a single
 * frame. One STUN binding answers the question in a few hundred milliseconds
 * where UDP works: a server-reflexive candidate is a UDP packet that went out
 * and came back. Nothing within the window is the answer too.
 *
 * The verdict is advice, never a verdict on the session: the backend drops the
 * UDP rungs only for a browser it plans for the internet — on a LAN, STUN may
 * fail (no internet at all) while the host is one UDP hop away.
 *
 * @param {number} [timeoutMs] how long to wait for the first answer
 * @returns {Promise<boolean|null>} true: UDP gets out; false: no STUN answer in
 *   time; null: this browser cannot ask (no WebRTC, or the probe threw).
 */
export async function probeUdp(timeoutMs = 1500) {
    const PC = globalThis.RTCPeerConnection;
    if (typeof PC !== 'function') return null;
    let pc;
    try {
        pc = new PC({ iceServers: defaultIceServers() });
    } catch (_e) {
        return null;
    }
    return new Promise((resolve) => {
        let done = false;
        const finish = (verdict) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                pc.close();
            } catch (_e) {
                /* already closed */
            }
            resolve(verdict);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        pc.onicecandidate = (ev) => {
            const c = ev.candidate;
            // A null candidate ends gathering: every server was asked and none
            // answered in time.
            if (!c) return finish(false);
            const type = c.type || (/ typ (\w+)/.exec(c.candidate || '') || [])[1];
            const udp = (c.protocol || '').toLowerCase() === 'udp' || / udp /i.test(c.candidate);
            if (type === 'srflx' && udp) finish(true);
        };
        try {
            pc.createDataChannel('probe');
            pc.createOffer()
                .then((offer) => pc.setLocalDescription(offer))
                .catch(() => finish(null));
        } catch (_e) {
            finish(null);
        }
    });
}
