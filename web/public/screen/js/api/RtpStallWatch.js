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

/**
 * RtpStallWatch — the RTP video track's watchdog (POC Ultra U1.4; plan
 * « Wi-Fi », W4).
 *
 * Chrome hands the transform only frames whose references it holds: after a
 * loss it waits for a keyframe and asks for one by PLI. The host ignores
 * those PLIs (Chrome sends them in a loop, its own decoder never fed), so a
 * loss at the wrong moment left a Mac at 0 frames a second for a whole pass
 * (05/10/2026, 22:40), packets still coming in. That is the sign watched for
 * here: packets keep arriving on the track while no frame has come out of
 * the transform for `stallMs`. A desktop at rest sends nothing at all, which
 * is no stall. On a stall, `onStall` asks for a keyframe; the caller's
 * request throttle spaces the asks.
 */
export class RtpStallWatch {
    /**
     * @param {{packets: function(): Promise<number>, onStall: function(): void,
     *          stallMs?: number, now?: function(): number}} options
     *        `packets`: the RTP packets the track has received so far
     */
    constructor({ packets, onStall, stallMs = 250, now = () => performance.now() }) {
        this._packets = packets;
        this._onStall = onStall;
        this._stallMs = stallMs;
        this._now = now;
        this._lastFrameMs = now();
        this._lastPackets = -1;
        this._timer = 0;
        this.stalls = 0;
    }

    /** A frame came out of the transform. */
    noteFrame() {
        this._lastFrameMs = this._now();
    }

    /** One look: true when the track stalls (and onStall was called). */
    async check() {
        let packets;
        try {
            packets = await this._packets();
        } catch {
            return false;
        }
        const grew = this._lastPackets >= 0 && packets > this._lastPackets;
        this._lastPackets = packets;
        if (!grew || this._now() - this._lastFrameMs < this._stallMs) return false;
        this.stalls++;
        this._onStall();
        return true;
    }

    /** Looks every `periodMs` until stop(). */
    start(periodMs = 250) {
        this.stop();
        this._timer = setInterval(() => {
            this.check();
        }, periodMs);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = 0;
    }
}

/** False when the bench's localStorage says mw_rtp_stallwatch=0. */
export function rtpStallWatchOn() {
    try {
        return globalThis.localStorage?.getItem('mw_rtp_stallwatch') !== '0';
    } catch {
        return true;
    }
}

/** The RTP packets @p receiver has received so far (its inbound-rtp stats). */
export async function receivedPackets(receiver) {
    const report = await receiver.getStats();
    let packets = 0;
    report.forEach((s) => {
        if (s.type === 'inbound-rtp' && typeof s.packetsReceived === 'number')
            packets += s.packetsReceived;
    });
    return packets;
}
