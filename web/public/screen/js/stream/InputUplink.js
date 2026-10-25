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
 * How long an input takes to reach the host (plan "Radios, joysticks et
 * volants", T7).
 *
 * On Wi-Fi a click → flag costs 25 to 60 ms more than the age of the picture
 * shown; on Ethernet 3 to 10. The click → flag alone cannot say where that
 * goes: up to the host, on the host, or back down with the picture. So an
 * input message may carry a `stamp`; the relay answers it with `inputstamp`
 * — when the message came off the channel (`recv`) and when its handling, the
 * injection, ended (`done`), both on the host's steady clock (µs). Put on this
 * client's clock by an estimate of its own, fed by the pongs like the
 * detection's (stream/CadenceStepper.js), `recv` gives the way up.
 *
 * Two users:
 *  - the click → flag probe (stream/LatencyProbe.js) stamps its press, and each
 *    entry of `mwLatencyResults` gains `upMs` (click sent → arrived on the
 *    host), `hostInMs` (arrived → injected) and `restMs` (the remainder: flag,
 *    capture, encode, the way down, decode, draw);
 *  - a bench of its own, `mwUplink.run({ hz, secs })`: dated messages that do
 *    nothing on the host (`uprobe`), at a fixed rate, to measure the way up
 *    alone — while the video streams or stands still, on Ethernet or Wi-Fi.
 *    Results in `mwUplinkResults`.
 *
 * Measurement only: nothing is stamped unless one of the two asks, and a
 * stamped message is the same input as an unstamped one.
 *
 * What a two-way estimate cannot see, a path slower one way than the other,
 * skews the offset by half the difference; the estimate keeps only exchanges
 * near the best round trip, where both ways are at their fastest, so the error
 * is at most half that round trip (a few ms on a LAN).
 */
import { ClockEstimator } from '../util/ClockEstimator.js';

/** A stamp nobody answered within this is counted lost and forgotten. */
const STAMP_TTL_MS = 5000;

/** Pings while measuring: enough for the estimate within a few seconds. */
const PING_MS = 200;

function quantile(sorted, q) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function round1(v) {
    return v === null || v === undefined ? null : Math.round(v * 10) / 10;
}

/** Median, p90, p99 and max of a list of ms, rounded to 0.1 ms. */
export function summarise(values) {
    const s = values.filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
    return {
        n: s.length,
        median: round1(quantile(s, 0.5)),
        p90: round1(quantile(s, 0.9)),
        p99: round1(quantile(s, 0.99)),
        max: round1(s.length ? s[s.length - 1] : null),
    };
}

export class InputUplink {
    /**
     * @param {object} deps
     * @param {(msg: object) => void} deps.send — send on the input channel
     * @param {(seq: number, ts: number) => void} deps.sendPing
     * @param {() => number} [deps.bufferedAmount] — the input channel's queue
     *        in bytes when a bench message leaves (0 when unknown)
     * @param {any[]} [deps.results] — bench runs are appended here
     * @param {() => number} [deps.now]
     * @param {object} [deps.timers] — setInterval/clearInterval/setTimeout, for tests
     */
    constructor({
        send,
        sendPing,
        bufferedAmount = () => 0,
        results = [],
        now = () => performance.now(),
        timers = globalThis,
    }) {
        this._send = send;
        this._sendPing = sendPing;
        this._buffered = bufferedAmount;
        this.results = results;
        this._now = now;
        this._timers = timers;
        this._clock = new ClockEstimator();
        this._seq = 0;
        this._pingSeq = 1 << 30; // apart from the view's own ping numbers
        /** @type {Map<number, {sentMs: number, onReply: Function|null}>} */
        this._pending = new Map();
        this._pingTimer = null;
        this._pingHolds = 0;
        this._run = null;
    }

    /** The estimate, for a bench's report. */
    get clock() {
        return this._clock.summary;
    }

    /** A pong: the host's clock. */
    notePong(msg, recvMs) {
        if (msg && typeof msg.host === 'number' && typeof msg.ts === 'number')
            this._clock.note(msg.ts, msg.host, recvMs);
    }

    /**
     * Ping fast while something measures, so the estimate is ready before the
     * first answer comes back. Paired with release().
     */
    hold() {
        if (this._pingHolds++ > 0) return;
        const ping = () => this._sendPing(this._pingSeq++, this._now());
        ping();
        this._pingTimer = this._timers.setInterval(ping, PING_MS);
    }

    release() {
        if (this._pingHolds === 0 || --this._pingHolds > 0) return;
        this._timers.clearInterval(this._pingTimer);
        this._pingTimer = null;
    }

    /**
     * A stamp for a message about to leave at @p sentMs; @p onReply gets the
     * split once the host answers: {upMs, hostInMs, rttMs}, upMs null while
     * the estimate is not ready.
     */
    stamp(sentMs, onReply = null) {
        const id = ++this._seq;
        this._pending.set(id, { sentMs, onReply });
        for (const [k, v] of this._pending) {
            if (sentMs - v.sentMs <= STAMP_TTL_MS) break;
            this._pending.delete(k);
        }
        return id;
    }

    /** The host's `inputstamp`. */
    noteReply(msg, recvMs) {
        if (!msg || typeof msg.id !== 'number') return null;
        const p = this._pending.get(msg.id);
        if (!p) return null;
        this._pending.delete(msg.id);
        const split = {
            upMs: this._clock.ready ? this._clock.toClientMs(msg.recv) - p.sentMs : null,
            hostInMs:
                typeof msg.done === 'number' && typeof msg.recv === 'number'
                    ? (msg.done - msg.recv) / 1000
                    : null,
            rttMs: recvMs - p.sentMs,
        };
        if (p.onReply) p.onReply(split);
        return split;
    }

    /**
     * The way up alone: @p hz dated messages a second for @p secs seconds.
     * Resolves with the run's summary, also appended to `results`.
     * @param {{hz?: number, secs?: number, label?: string}} [opts]
     */
    run({ hz = 50, secs = 20, label = '' } = {}) {
        if (this._run) return this._run.promise;
        const samples = [];
        let sent = 0;
        const run = { promise: null };
        this._run = run;
        this.hold();
        run.promise = new Promise((resolve) => {
            // A second of pings first: the estimate needs a few exchanges.
            this._timers.setTimeout(() => {
                const startMs = this._now();
                const tick = this._timers.setInterval(
                    () => {
                        const t = this._now();
                        const buffered = this._buffered() || 0;
                        const id = this.stamp(t, (split) =>
                            samples.push({ t: t - startMs, buffered, ...split }),
                        );
                        sent++;
                        this._send({ type: 'uprobe', stamp: id });
                    },
                    Math.max(1, Math.round(1000 / hz)),
                );
                this._timers.setTimeout(() => {
                    this._timers.clearInterval(tick);
                    // The last answers are still on their way.
                    this._timers.setTimeout(() => {
                        this.release();
                        const entry = {
                            label,
                            at: new Date().toISOString(),
                            hz,
                            secs,
                            sent,
                            answered: samples.length,
                            up: summarise(samples.map((s) => s.upMs)),
                            rtt: summarise(samples.map((s) => s.rttMs)),
                            hostIn: summarise(samples.map((s) => s.hostInMs)),
                            queuedSends: samples.filter((s) => s.buffered > 0).length,
                            clock: this.clock,
                            samples,
                        };
                        this.results.push(entry);
                        this._run = null;
                        console.log(
                            `[InputUplink] ${label || 'run'}: ${entry.answered}/${sent} answered, up median ` +
                                `${entry.up.median} ms p90 ${entry.up.p90} p99 ${entry.up.p99} max ${entry.up.max}` +
                                ` (rtt median ${entry.rtt.median})`,
                        );
                        resolve(entry);
                    }, 1500);
                }, secs * 1000);
            }, 1000);
        });
        return run.promise;
    }
}
