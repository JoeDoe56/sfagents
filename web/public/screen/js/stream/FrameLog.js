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
 * FrameLog — each drawn frame's way from the host to the end of its draw, on
 * one clock (POC Ultra U0.2, docs/design/ultra-lan-poc.md §6.1).
 *
 * The overlay's latency is a sum of legs, each timed on its own clock and
 * averaged on its own window: a leg nobody measures (the host's wait for the
 * wire, a one-way link slower than half the ping) is missing from it. This
 * measures the whole way frame by frame instead: the frame's stamp
 * (backendTs, the host's steady clock in ms) is put on this client's clock by
 * the estimate the ping/pong makes (util/ClockEstimator.js), and taken from
 * the end of the draw.
 *
 * Where the way starts depends on the host:
 *   - the native host stamps the frame's display present, to the millisecond
 *     (NativeMediaEngine::onEncodedFrame): the whole way, read 0 to 2 ms high
 *     (both halves of the stamp are whole milliseconds);
 *   - a GameStream host's frames are counted from the arrival of the stream's
 *     FIRST frame at the backend (DataChannelRelay): its capture, encode and
 *     way to the backend are left out, the same amount on every frame.
 * The estimate is wrong by half the difference on a link slower one way than
 * the other (Wi-Fi uplink): the age reads that much off, on every frame.
 *
 * Every frame is kept, in a ring of columns (no allocation per frame), for the
 * bench to fetch over CDP: `mwFrameLog.csv()`. The main-thread path only: the
 * decode worker (opt-in) draws where this cannot see.
 */

import { ClockEstimator } from '../util/ClockEstimator.js';
import { unwrap32 } from './ContentAgeProbe.js';

/** Frames kept: a minute at 240 frames a second. */
export const FRAME_LOG_FRAMES = 16384;
/** The pongs the estimate keeps: the plan's 60 s, for a drift to show. */
export const FRAME_LOG_CLOCK_MS = 60000;

/**
 * The CSV's columns. Times are this client's performance.now() in ms, except
 * `hostMs` (the frame's stamp on the host's steady clock); `captureMs` is that
 * stamp on this client's clock. NaN (empty in the CSV) where unknown — every
 * clock column before the estimate is ready.
 */
export const FRAME_LOG_COLUMNS = [
    'drawnMs',
    'hostMs',
    'captureMs',
    'arrivedMs',
    'decodedMs',
    'drawStartMs',
    'e2eMs',
    'bytes',
    'key',
];

/** An age past this is a wrong estimate, not a latency. */
const AGE_MAX_MS = 10000;
const AGE_MIN_MS = -100;

export class FrameLog {
    /** @param {{frames?: number, clockMs?: number}} [opts] */
    constructor({ frames = FRAME_LOG_FRAMES, clockMs = FRAME_LOG_CLOCK_MS } = {}) {
        this.clock = new ClockEstimator({ windowMs: clockMs });
        this._size = frames;
        /** @type {Object<string, Float64Array>|null} allocated at the first frame */
        this._cols = null;
        this._next = 0;
        this._count = 0;
        /** Frames noted since the start, and those given an age. */
        this.frames = 0;
        this.measured = 0;
    }

    /** A pong: the host's clock as it answered (`host`, µs) for our `ts`. */
    notePong(msg, recvMs) {
        if (msg && typeof msg.host === 'number' && typeof msg.ts === 'number')
            this.clock.note(msg.ts, msg.host, recvMs);
    }

    /**
     * A frame drawn. Times in this client's ms; 0 where unknown.
     * @param {{backendTs: number, drawnMs: number, arrivedMs?: number,
     *          decodedMs?: number, drawStartMs?: number, bytes?: number,
     *          key?: boolean}} f
     * @returns {number} its age at the end of the draw, ms — NaN while the
     *          host's clock is not known, or for a frame with no stamp
     */
    noteDrawn(f) {
        if (!f || !(f.backendTs > 0) || !(f.drawnMs > 0)) return NaN;
        let hostMs = NaN;
        let captureMs = NaN;
        let e2e = NaN;
        if (this.clock.ready) {
            const drawnHostMs = this.clock.toHostUs(f.drawnMs) / 1000;
            hostMs = unwrap32(f.backendTs, Math.floor(drawnHostMs));
            const age = drawnHostMs - hostMs;
            if (age > AGE_MIN_MS && age < AGE_MAX_MS) {
                e2e = age;
                captureMs = f.drawnMs - age;
            }
        }
        if (!this._cols) {
            this._cols = {};
            for (const c of FRAME_LOG_COLUMNS) this._cols[c] = new Float64Array(this._size);
        }
        const i = this._next;
        const cols = this._cols;
        const orNaN = (v) => (v > 0 ? v : NaN);
        cols.drawnMs[i] = f.drawnMs;
        cols.hostMs[i] = hostMs;
        cols.captureMs[i] = captureMs;
        cols.arrivedMs[i] = orNaN(f.arrivedMs);
        cols.decodedMs[i] = orNaN(f.decodedMs);
        cols.drawStartMs[i] = orNaN(f.drawStartMs);
        cols.e2eMs[i] = e2e;
        cols.bytes[i] = f.bytes > 0 ? f.bytes : 0;
        cols.key[i] = f.key ? 1 : 0;
        this._next = (i + 1) % this._size;
        if (this._count < this._size) this._count++;
        this.frames++;
        if (e2e === e2e) this.measured++;
        return e2e;
    }

    /** Frames held now (at most the ring's size). */
    get length() {
        return this._count;
    }

    /** The frames held, oldest first, one object each. */
    rows() {
        const out = [];
        if (!this._cols) return out;
        const start = (this._next - this._count + this._size) % this._size;
        for (let k = 0; k < this._count; k++) {
            const i = (start + k) % this._size;
            const row = {};
            for (const c of FRAME_LOG_COLUMNS) row[c] = this._cols[c][i];
            out.push(row);
        }
        return out;
    }

    /** The frames held as CSV, a header first; NaN left empty. */
    csv() {
        const lines = [FRAME_LOG_COLUMNS.join(',')];
        for (const row of this.rows()) {
            lines.push(
                FRAME_LOG_COLUMNS.map((c) => {
                    const v = row[c];
                    if (v !== v) return '';
                    return c === 'bytes' || c === 'key' ? String(v) : v.toFixed(3);
                }).join(','),
            );
        }
        return lines.join('\n');
    }

    /** Forget the frames (the estimate stays). */
    clear() {
        this._next = 0;
        this._count = 0;
        this.frames = 0;
        this.measured = 0;
    }

    /** The frames held, summed up, with what the estimate stands on. */
    summary() {
        const ages = [];
        if (this._cols) {
            const e2e = this._cols.e2eMs;
            const start = (this._next - this._count + this._size) % this._size;
            for (let k = 0; k < this._count; k++) {
                const v = e2e[(start + k) % this._size];
                if (v === v) ages.push(v);
            }
        }
        ages.sort((a, b) => a - b);
        const at = (p) =>
            ages.length ? ages[Math.min(ages.length - 1, Math.floor(p * ages.length))] : null;
        return {
            frames: this._count,
            measured: ages.length,
            medianMs: at(0.5),
            p90Ms: at(0.9),
            p99Ms: at(0.99),
            clock: this.clock.summary,
        };
    }
}
