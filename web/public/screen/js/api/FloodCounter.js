/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

/**
 * Bench only (plan Idées Punktfunk, A0.3 and A0.4): the receiving end of the
 * host's flood (backend SctpFlood.h), which measures what SCTP carries to a
 * real browser — with no retransmission (the FEC channel the plan wants) or
 * with the video channel's own reliability.
 *
 * Off unless this browser's localStorage holds `mw_flood` ("fec", the
 * default, or "video": the channel's reliability, matching the host's
 * `floodchannel=`). The host floods only when its native tuning says `flood=`;
 * either side alone does nothing.
 *
 * Each message: "MWFL", its sequence number, the host's steady clock (µs) at
 * send — all big-endian. Counted per second: messages, kbps, sequence numbers
 * never seen (lost), late ones (reordered), and how much longer than the
 * session's shortest each message took (the queue's growth; the two clocks'
 * offset cancels out). Logged as `[MW-FLOOD] {…}` and kept in
 * `globalThis.__mwFlood` for a CDP driver.
 */

export const FLOOD_MAGIC = 0x4d57464c; // "MWFL"
export const FLOOD_HEADER_BYTES = 16;

/** The flood's channel reliability asked for here, or null when off. */
export function floodMode(storage = globalThis.localStorage) {
    try {
        const value = storage?.getItem('mw_flood');
        if (!value) return null;
        return value === 'video' ? 'video' : 'fec';
    } catch {
        return null;
    }
}

/** The negotiated channel matching the host's (id 3). */
export function floodChannelInit(mode) {
    return mode === 'video'
        ? { negotiated: true, id: 3, ordered: true, maxPacketLifeTime: 500 }
        : { negotiated: true, id: 3, ordered: false, maxRetransmits: 0 };
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[i];
}

export class FloodCounter {
    constructor() {
        this.totals = { msgs: 0, bytes: 0, lost: 0, reordered: 0, foreign: 0 };
        this._highest = -1;
        this._minRelUs = Infinity;
        this._startWindow();
    }

    _startWindow() {
        this._w = { msgs: 0, bytes: 0, lost: 0, reordered: 0, handlerMs: 0, delays: [] };
    }

    /**
     * One message. @param {ArrayBuffer} buf @param {number} arrivalMs on the
     * page's clock (performance.timeOrigin + performance.now()).
     */
    onMessage(buf, arrivalMs) {
        if (!(buf instanceof ArrayBuffer) || buf.byteLength < FLOOD_HEADER_BYTES) {
            this.totals.foreign++;
            return;
        }
        const view = new DataView(buf);
        if (view.getUint32(0) !== FLOOD_MAGIC) {
            this.totals.foreign++;
            return;
        }
        const seq = view.getUint32(4);
        const sendUs = Number(view.getBigUint64(8));
        const w = this._w;
        w.msgs++;
        w.bytes += buf.byteLength;
        this.totals.msgs++;
        this.totals.bytes += buf.byteLength;
        if (this._highest < 0 || seq > this._highest) {
            // Everything between the last highest and this one is missing —
            // for now: a late one gives its count back below.
            if (this._highest >= 0 && seq > this._highest + 1) {
                const gap = seq - this._highest - 1;
                w.lost += gap;
                this.totals.lost += gap;
            }
            this._highest = seq;
        } else {
            w.reordered++;
            this.totals.reordered++;
            w.lost--;
            this.totals.lost--;
        }
        const relUs = arrivalMs * 1000 - sendUs;
        if (relUs < this._minRelUs) this._minRelUs = relUs;
        w.delays.push(relUs);
    }

    /** The second just ended, in figures; a new one starts. */
    closeWindow(seconds = 1) {
        const w = this._w;
        const delays = w.delays.map((d) => (d - this._minRelUs) / 1000).sort((a, b) => a - b);
        const out = {
            msgsPerSec: Math.round(w.msgs / seconds),
            kbps: Math.round((w.bytes * 8) / 1000 / seconds),
            // A late message gives back a count its own second already had.
            lost: Math.max(0, w.lost),
            lossPct:
                w.msgs + w.lost > 0 && w.lost > 0
                    ? +((100 * w.lost) / (w.msgs + w.lost)).toFixed(2)
                    : 0,
            reordered: w.reordered,
            extraDelayMs: {
                p50: +percentile(delays, 0.5).toFixed(1),
                p95: +percentile(delays, 0.95).toFixed(1),
                max: +(delays.length ? delays[delays.length - 1] : 0).toFixed(1),
            },
            handlerMs: +w.handlerMs.toFixed(2),
        };
        this._startWindow();
        return out;
    }
}

/**
 * Open the flood's channel on @p pc and count what lands on it, once a
 * second. Returns a handle whose stop() ends the counting.
 */
export function attachFloodCounter(pc, mode, { log = console.log, intervalMs = 1000 } = {}) {
    const dc = pc.createDataChannel('flood', floodChannelInit(mode));
    dc.binaryType = 'arraybuffer';
    const counter = new FloodCounter();
    const origin = globalThis.performance?.timeOrigin ?? 0;
    dc.onmessage = (event) => {
        const t0 = performance.now();
        counter.onMessage(event.data, origin + t0);
        counter._w.handlerMs += performance.now() - t0;
    };
    const history = [];
    const timer = setInterval(() => {
        const second = counter.closeWindow(intervalMs / 1000);
        history.push(second);
        if (history.length > 600) history.shift();
        globalThis.__mwFlood = { mode, totals: { ...counter.totals }, last: second, history };
        log('[MW-FLOOD] ' + JSON.stringify(second));
    }, intervalMs);
    log('[MW-FLOOD] counting the host flood on DC#3 (' + mode + ')');
    return {
        dc,
        counter,
        stop() {
            clearInterval(timer);
        },
    };
}
