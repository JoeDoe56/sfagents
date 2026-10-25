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
 * ContentAgeProbe — how old what this client shows is, image by image, on the
 * host's clock (plan framerate-hote, design §33.3).
 *
 * The per-frame end-to-end the overlay shows starts when the host captured a
 * frame. It cannot see how long the picture waited BEFORE the capture — for a
 * present the cadence gate skipped, or for the compositor of a 60 Hz display —
 * and that wait is exactly what a stream at the host's own rate is meant to
 * remove. So the content carries its own time:
 *
 *   - the bench page (scripts/bench/content/scroll.html?band=time) codes, at
 *     each of its frames, the host's steady clock in a band across the top of
 *     the screen — calibrated against the host by the bench driver over CDP,
 *     and absent until it is;
 *   - this probe reads the band out of the decoded frame (VideoFrame.copyTo of
 *     that strip alone, where reading the canvas back cost the main thread
 *     13 ms a read on an iGPU), and notes when the renderer drew that same
 *     frame (VideoRenderer.afterDraw). The copy runs in a worker
 *     (bandReadWorker.js): on the main thread it still held the frame's draw
 *     12.2 ms a read on DualRTX's AMD iGPU (03/10/2026) — every age read
 *     carried it. `readCost` in the summary is what is left of it;
 *   - the draw is put on the host's clock with an estimate made from the
 *     ping/pong, whose pong carries the host's time; the difference is the
 *     content's age when it was shown.
 *
 * The frame's own capture time (backendTs, the host's steady clock too) gives
 * the capture's age on the same estimate: it should read what the overlay's
 * end-to-end reads, which checks the clocks; content minus capture is the time
 * the picture spent on the host before the capture took it.
 *
 * ── The band ─────────────────────────────────────────────────────────────────
 *
 * 40 blocks, each a hundredth of the frame's width square, from the top-left
 * corner: 32 bits of the host's steady clock in units of 10 µs (least
 * significant first; it wraps every 11.9 hours), then 8 bits of check
 * (bandCheck). White is 1. The row of blocks under it holds the complement,
 * so a block the encoder smeared reads as invalid rather than as a wrong bit.
 * Sized on the width, it lands on the same blocks at any scale the stream
 * is decoded at. A band that fails any of this is counted, never guessed.
 *
 * ── What it sees ─────────────────────────────────────────────────────────────
 *
 * The main-thread decode path, drawn by the Canvas2D or WebGL renderer; not
 * the decode worker, not WebGPU, not <video>. The age is taken at the end of
 * the draw: on a canvas that tears (Chromium desktop's default) the picture
 * is on screen then; on one presenting on vsync, the compositor adds up to
 * one refresh of the client that the age does not see. A frame decoded but
 * never drawn (drop-to-latest) is not an age: it is counted as `undrawn`.
 *
 * ── Drawn, and shown ─────────────────────────────────────────────────────────
 *
 * The age at the draw says how fresh each frame was when it arrived. What the
 * viewer looks at is the frame on screen at any moment, which keeps ageing
 * until the next one replaces it: 16.7 ms more at 60 frames a second, 2 ms at
 * 500. So the summary also gives the age of what is SHOWN:
 *   - `shown`, over time — every half millisecond from the first draw to the
 *     last, the frame drawn last and how old it is by then (what a canvas that
 *     tears puts on screen);
 *   - `atRefresh`, at each of this client's refreshes (requestAnimationFrame) —
 *     what a canvas presenting on vsync shows, give or take the compositor.
 * Both need every frame read (`every: 1`): a moment whose frame was not read
 * is left out. `shownSinceCapture` is `shown` counted from the frame's present
 * on the host rather than from the page's frame: what the stream adds, without
 * the page's own way to the host's screen — which varies from one launch of
 * the page to the next (5 to 22 ms on the same virtual display at 60 Hz).
 */

import { ClockEstimator } from '../util/ClockEstimator.js';

export { ClockEstimator };

/** Blocks across the frame's width: a block is 1/BAND_BLOCKS of it. */
export const BAND_BLOCKS = 100;
/** 32 bits of time and 8 of check. */
export const BAND_BITS = 40;
/** The band's clock unit, in microseconds. */
export const BAND_UNIT_US = 10;
const WRAP = 2 ** 32;
/** Luma a block must clear to read as white, and stay under to read as black. */
const WHITE = 160;
const BLACK = 96;
/** A frame read but not drawn within this long never will be. */
const PENDING_MS = 1000;

/**
 * The check byte of @p value: the sum of its four bytes, xor 0xA5. The bench
 * page computes it the same way (scroll.html).
 * @param {number} value unsigned 32-bit
 */
export function bandCheck(value) {
    const v = value >>> 0;
    return (((v & 255) + ((v >>> 8) & 255) + ((v >>> 16) & 255) + (v >>> 24)) ^ 0xa5) & 255;
}

/**
 * The strip to read out of a frame whose visible part is @p width wide, from
 * @p x, @p y (VideoFrame.visibleRect): the band's two rows of blocks. Even
 * everywhere, as a 4:2:0 frame's copyTo wants it.
 * @returns {{x: number, y: number, w: number, h: number, block: number}}
 */
export function bandRegion(width, x = 0, y = 0) {
    const block = width / BAND_BLOCKS;
    const even = (v) => Math.ceil(v / 2) * 2;
    return {
        x: x & ~1,
        y: y & ~1,
        w: Math.min(width & ~1, even(BAND_BITS * block)),
        h: even(2 * block),
        block,
    };
}

/**
 * Read the band out of a strip of luma.
 * @param {Uint8Array|Uint8ClampedArray|Float32Array} luma one value per pixel,
 *        top-down, @p w × @p h
 * @param {number} w
 * @param {number} h
 * @param {number} block the block's size in these pixels (bandRegion)
 * @returns {{ok: boolean, value?: number, why?: string}}
 */
export function decodeBand(luma, w, h, block) {
    if (!luma || !(block >= 2) || w < Math.floor(BAND_BITS * block) || h < Math.floor(2 * block))
        return { ok: false, why: 'size' };
    const mean = (x0, x1, y0, y1) => {
        let sum = 0;
        let n = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++, n++) sum += luma[y * w + x];
        return n ? sum / n : 0;
    };
    // The middle half of a block: its edges are where compression and a
    // non-integer scale blur one block into the next.
    const span = (lo, hi, limit) => {
        const a = Math.min(limit - 1, Math.ceil(lo));
        const b = Math.min(limit - 1, Math.max(a, Math.floor(hi)));
        return [a, b];
    };
    const [a0, a1] = span(0.25 * block, 0.75 * block, h);
    const [b0, b1] = span(1.25 * block, 1.75 * block, h);
    let value = 0;
    let check = 0;
    for (let bit = 0; bit < BAND_BITS; bit++) {
        const [x0, x1] = span((bit + 0.25) * block, (bit + 0.75) * block, w);
        const top = mean(x0, x1, a0, a1);
        const under = mean(x0, x1, b0, b1);
        const one = top > WHITE && under < BLACK;
        const zero = top < BLACK && under > WHITE;
        if (!one && !zero) return { ok: false, why: 'block' };
        if (!one) continue;
        if (bit < 32) value += 2 ** bit;
        else check |= 1 << (bit - 32);
    }
    if (bandCheck(value) !== check) return { ok: false, why: 'check' };
    return { ok: true, value };
}

/**
 * The host's time, in µs, of a band @p value read when the host's clock was
 * about @p nearUs: the band keeps only the low 32 bits of its 10 µs units.
 */
export function unwrapBand(value, nearUs) {
    return unwrap32(value, Math.floor(nearUs / BAND_UNIT_US)) * BAND_UNIT_US;
}

/** The whole number whose low 32 bits are @p value, nearest to @p near. */
export function unwrap32(value, near) {
    let diff = (near - value) % WRAP;
    if (diff < 0) diff += WRAP;
    if (diff > WRAP / 2) diff -= WRAP;
    return near - diff;
}

/**
 * One frame's luma strip out of copyTo's bytes: the first plane of a 4:2:0
 * frame is luma already; a packed RGB frame is weighed into it.
 * @returns {Uint8Array|Float32Array|null}
 */
export function lumaOf(format, data, layout, w, h) {
    const plane = layout && layout[0];
    if (!plane) return null;
    const { offset, stride } = plane;
    if (format === 'NV12' || format === 'I420' || format === 'I420A' || format === 'NV12A') {
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++)
            out.set(data.subarray(offset + y * stride, offset + y * stride + w), y * w);
        return out;
    }
    const rgb = { RGBA: [0, 1, 2], RGBX: [0, 1, 2], BGRA: [2, 1, 0], BGRX: [2, 1, 0] }[format];
    if (!rgb) return null;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = offset + y * stride + x * 4;
            out[y * w + x] =
                0.299 * data[i + rgb[0]] + 0.587 * data[i + rgb[1]] + 0.114 * data[i + rgb[2]];
        }
    }
    return out;
}

/**
 * The age of what is on screen at each of @p times (sorted): the last frame
 * drawn by then, aged by the time since its draw. @p draws: [drawn at, frame
 * timestamp], sorted; @p ageOf: frame timestamp → its age at the draw. A time
 * before the first draw, or whose frame's age is unknown, is left out.
 */
export function shownAges(draws, ageOf, times) {
    const out = [];
    let i = -1;
    for (const t of times) {
        while (i + 1 < draws.length && draws[i + 1][0] <= t) i++;
        if (i < 0) continue;
        const age = ageOf.get(draws[i][1]);
        if (age === undefined) continue;
        out.push(age + (t - draws[i][0]));
    }
    return out;
}

/**
 * What the client's refreshes showed (sorted @p draws: [drawn at, frame]; @p
 * ticks: its refreshes): `repeats`, refreshes with no frame drawn since the
 * one before — the picture shown twice; `unseen`, frames replaced before any
 * refresh came — drawn for nothing on vsync, a band of the screen when the
 * canvas tears; `refreshes`, those counted, from the first draw on.
 */
export function refreshCounts(draws, ticks) {
    let i = 0;
    let started = false;
    let repeats = 0;
    let unseen = 0;
    let refreshes = 0;
    for (const t of ticks) {
        let j = i;
        while (j < draws.length && draws[j][0] <= t) j++;
        const fresh = j - i;
        i = j;
        if (!started) {
            started = j > 0;
            continue;
        }
        refreshes++;
        if (fresh === 0) repeats++;
        else unseen += fresh - 1;
    }
    return { repeats, unseen, refreshes };
}

/** @p n events from @p first to @p last (ms), per second; null without a span. */
function rate(n, first, last) {
    return n > 1 && last > first ? Math.round(((n - 1) * 10000) / (last - first)) / 10 : null;
}

/** Percentile @p p (0..1) of a sorted array. */
function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
}

function describe(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const round = (x) => (x === null ? null : Math.round(x * 100) / 100);
    return {
        n: sorted.length,
        medianMs: round(percentile(sorted, 0.5)),
        p90Ms: round(percentile(sorted, 0.9)),
        p99Ms: round(percentile(sorted, 0.99)),
        meanMs: round(sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : null),
        minMs: round(percentile(sorted, 0)),
        maxMs: round(percentile(sorted, 1)),
    };
}

/**
 * The console handle, `mwContentAge`:
 *
 *   mwContentAge.start({every: 1})   // read the band of every decoded frame
 *   ... the page scrolls on the host ...
 *   mwContentAge.stop()              // → summary, also pushed to mwContentAgeResults
 *
 * While it runs it pings the host ten times a second for the clock estimate.
 */
export class ContentAgeProbe {
    /**
     * @param {object} deps
     * @param {() => any} deps.renderer the view's current VideoRenderer
     * @param {(seq: number, ts: number) => void} deps.sendPing a `ping` the
     *        host answers with a `pong` carrying `host` (its steady µs)
     * @param {any[]} [deps.results] where finished runs go
     *        (window.mwContentAgeResults)
     * @param {boolean} [deps.worker] read the band in a worker where there
     *        is one (the default); false reads it on the main thread
     */
    constructor({ renderer, sendPing, results = [], worker = true }) {
        this._renderer = renderer;
        this._sendPing = sendPing;
        this.results = results;
        this._noWorker = !worker;
        this._readWorker = null;
        this._workerState = '';
        /** @type {Map<number, {resolve: Function, reject: Function, format: string}>} */
        this._reads = new Map();
        this._readSeq = 0;
        this._run = null;
        this._clock = new ClockEstimator();
        this._pingTimer = null;
        this._seq = 1 << 20; // apart from the view's own pings
        this._onDraw = (_r, ts) => this.onDrawn(ts, performance.now());
    }

    get running() {
        return this._run !== null;
    }

    /**
     * Start reading. @p every: read one decoded frame in that many (each read
     * holds a clone of the frame until its strip is copied out). @p inline:
     * copy on the main thread, as before the worker — for a bench to measure
     * what that costs (scripts/bench/content-age/age.py, MW_BENCH_INLINE_READ).
     */
    start({ every = 1, inline = false } = {}) {
        if (this._run) this.stop();
        this._run = {
            every: Math.max(1, Math.floor(every) || 1),
            inline: inline === true,
            decoded: 0,
            read: 0,
            /** The main thread's time in each read, ms; and where the copy ran. */
            readMs: [],
            reader: null,
            startedMs: performance.now(),
            /** @type {Map<number, {at: number, backendTs: number, value: number|null, drawnMs: number|null}>} */
            pending: new Map(),
            content: [],
            capture: [],
            before: [],
            samples: [],
            invalid: { size: 0, block: 0, check: 0, copy: 0, clock: 0, undrawn: 0 },
            /** Every draw, read or not: [drawn at, frame timestamp]. */
            draws: [],
            /** Frame timestamp → its content age at the draw. */
            ageOf: new Map(),
            /** Frame timestamp → its capture age at the draw. */
            captureOf: new Map(),
            /** This client's refreshes (requestAnimationFrame stamps). */
            ticks: [],
        };
        this._pingTimer = setInterval(() => this._sendPing(this._seq++, performance.now()), 100);
        if (typeof requestAnimationFrame === 'function') {
            const run = this._run;
            const tick = (t) => {
                if (this._run !== run) return;
                run.ticks.push(t);
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        }
        this.attach(this._renderer());
        return 'content-age probe running: page scripts/bench/content/scroll.html?band=time';
    }

    /** The view changed renderer mid-run: hear its draws. */
    attach(renderer) {
        if (renderer && this._run) renderer.afterDraw = this._onDraw;
    }

    /**
     * The host's steady clock, in µs, at this client's @p clientMs, by the
     * estimate — null until there is one. For a bench to check it against a
     * clock it can read (scripts/bench/content-age/age.py).
     */
    hostUs(clientMs) {
        return this._clock.ready ? this._clock.toHostUs(clientMs) : null;
    }

    /** A pong arrived (StreamView forwards them all). */
    notePong(msg, recvMs) {
        if (!msg || typeof msg.host !== 'number' || typeof msg.ts !== 'number') return;
        this._clock.note(msg.ts, msg.host, recvMs);
    }

    /**
     * A frame came out of the decoder. @p backendTs: its capture time on the
     * host's steady clock, in ms (low 32 bits), 0 when unknown.
     * @param {VideoFrame} frame
     */
    onDecoded(frame, backendTs) {
        const run = this._run;
        if (!run) return;
        if (run.decoded++ % run.every !== 0) return;
        this._expire(performance.now());
        const vr = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth };
        const region = bandRegion(vr.width, vr.x, vr.y);
        const entry = { at: performance.now(), backendTs, value: null, drawnMs: null };
        const ts = frame.timestamp;
        run.pending.set(ts, entry);
        run.read++;
        const rect = { x: region.x, y: region.y, width: region.w, height: region.h };
        // What the read costs the frame: the main thread's share, before the
        // frame goes on to its draw. Seen in the summary as `readCost`.
        const t0 = performance.now();
        let read;
        try {
            read = this._readStrip(frame.clone(), rect);
        } catch (e) {
            read = Promise.reject(e);
        }
        run.readMs.push(performance.now() - t0);
        read.then(
            ({ format, buf, layout }) => {
                const luma = lumaOf(format, buf, layout, region.w, region.h);
                const band = luma
                    ? decodeBand(luma, region.w, region.h, region.block)
                    : { ok: false, why: 'size' };
                if (!band.ok) {
                    this._fail(ts, band.why);
                    return;
                }
                entry.value = band.value;
                this._settle(ts);
            },
            () => this._fail(ts, 'copy'),
        );
    }

    /**
     * Copy @p rect out of @p clone, which this takes over (closed when done).
     * In a worker where there is one: copying out of a frame the GPU decoded
     * held the main thread 12.2 ms a read on DualRTX's AMD iGPU (03/10/2026),
     * and that frame's draw waited behind it. Here, when the worker cannot be
     * had — no Worker, or a browser that will not transfer a VideoFrame.
     * @returns {Promise<{format: string, buf: Uint8Array, layout: any}>}
     */
    _readStrip(clone, rect) {
        const worker = this._run && this._run.inline ? null : this._worker();
        if (worker) {
            const id = this._readSeq++;
            const format = clone.format;
            try {
                worker.postMessage({ id, frame: clone, rect }, [clone]);
                if (this._run) this._run.reader = 'worker';
                return new Promise((resolve, reject) =>
                    this._reads.set(id, { resolve, reject, format }),
                );
            } catch (e) {
                // Not transferable here: inline from now on.
                this._workerState = 'broken';
            }
        }
        if (this._run) this._run.reader = 'inline';
        const buf = new Uint8Array(clone.allocationSize({ rect }));
        const format = clone.format;
        return clone
            .copyTo(buf, { rect })
            .then((layout) => ({ format, buf, layout }))
            .finally(() => clone.close());
    }

    /** The read worker, made at the first read; null where there is none. */
    _worker() {
        if (this._workerState === 'broken') return null;
        if (this._readWorker) return this._readWorker;
        if (typeof Worker !== 'function' || this._noWorker) {
            this._workerState = 'broken';
            return null;
        }
        try {
            const w = new Worker(new URL('./bandReadWorker.js', import.meta.url), {
                type: 'module',
            });
            w.onmessage = (e) => {
                const { id, error } = e.data || {};
                const pending = this._reads.get(id);
                if (!pending) return;
                this._reads.delete(id);
                if (error) pending.reject(new Error(error));
                else pending.resolve(e.data);
            };
            w.onerror = () => {
                // Every read in flight is lost; the next ones go inline.
                this._workerState = 'broken';
                for (const p of this._reads.values()) p.reject(new Error('worker'));
                this._reads.clear();
                this._readWorker = null;
                w.terminate();
            };
            this._readWorker = w;
            return w;
        } catch (e) {
            this._workerState = 'broken';
            return null;
        }
    }

    /** The renderer drew the frame stamped @p ts, at @p nowMs. */
    onDrawn(ts, nowMs) {
        const run = this._run;
        if (!run) return;
        run.draws.push([nowMs, ts]);
        const entry = run.pending.get(ts);
        if (!entry || entry.drawnMs !== null) return;
        entry.drawnMs = nowMs;
        this._settle(ts);
    }

    _fail(ts, why) {
        const run = this._run;
        if (!run || !run.pending.delete(ts)) return;
        run.invalid[why] = (run.invalid[why] || 0) + 1;
    }

    _expire(nowMs) {
        const run = this._run;
        for (const [ts, e] of run.pending) {
            if (nowMs - e.at < PENDING_MS) break; // in decode order
            run.pending.delete(ts);
            run.invalid.undrawn++;
        }
    }

    /** Both halves known — the band and the draw: the ages. */
    _settle(ts) {
        const run = this._run;
        const e = run && run.pending.get(ts);
        if (!e || e.value === null || e.drawnMs === null) return;
        run.pending.delete(ts);
        if (!this._clock.ready) {
            run.invalid.clock++;
            return;
        }
        const nowUs = this._clock.toHostUs(e.drawnMs);
        const contentMs = (nowUs - unwrapBand(e.value, nowUs)) / 1000;
        run.content.push(contentMs);
        run.ageOf.set(ts, contentMs);
        let captureMs = null;
        if (e.backendTs > 0) {
            captureMs = nowUs / 1000 - unwrap32(e.backendTs, Math.floor(nowUs / 1000));
            // backendTs is whole milliseconds: a capture age is good to one.
            if (captureMs > -5 && captureMs < 10000) {
                run.capture.push(captureMs);
                run.captureOf.set(ts, captureMs);
                run.before.push(contentMs - captureMs);
            } else {
                captureMs = null;
            }
        }
        run.samples.push([
            Math.round(e.drawnMs * 10) / 10,
            Math.round(contentMs * 100) / 100,
            captureMs === null ? null : Math.round(captureMs * 100) / 100,
        ]);
    }

    /** Stop, and give the run's summary (kept in `results` too). */
    stop() {
        const run = this._run;
        if (!run) return null;
        this._expire(Infinity);
        this._run = null;
        clearInterval(this._pingTimer);
        this._pingTimer = null;
        const r = this._renderer();
        if (r && r.afterDraw === this._onDraw) r.afterDraw = null;
        const content = describe(run.content);
        const draws = run.draws;
        const grid = [];
        if (draws.length > 1)
            for (let t = draws[0][0]; t <= draws[draws.length - 1][0]; t += 0.5) grid.push(t);
        const ticks = run.ticks.filter((t) => draws.length && t >= draws[0][0]);
        // Repeated pictures and frames no refresh showed, per minute: the
        // fluidity side of a cadence (plan POC Ultra, gate UA).
        const seen = refreshCounts(draws, run.ticks);
        const perMinute = (n) =>
            ticks.length > 1
                ? Math.round((n * 600000) / (ticks[ticks.length - 1] - ticks[0])) / 10
                : null;
        const summary = {
            seconds: Math.round((performance.now() - run.startedMs) / 10) / 100,
            decoded: run.decoded,
            read: run.read,
            ages: content.n,
            invalid: run.invalid,
            ...content,
            shown: describe(shownAges(draws, run.ageOf, grid)),
            atRefresh: describe(shownAges(draws, run.ageOf, ticks)),
            shownSinceCapture: describe(shownAges(draws, run.captureOf, grid)),
            refreshHz: rate(run.ticks.length, run.ticks[0], run.ticks[run.ticks.length - 1]),
            drawsPerSecond: rate(
                draws.length,
                draws.length && draws[0][0],
                draws.length && draws[draws.length - 1][0],
            ),
            repeatsPerMinute: perMinute(seen.repeats),
            unseenPerMinute: perMinute(seen.unseen),
            capture: describe(run.capture),
            beforeCapture: describe(run.before),
            // What a read cost the frame it read, on the main thread: the
            // wait added to its draw (12.2 ms a read inline on DualRTX's AMD
            // iGPU, 03/10/2026). `reader`: worker, or inline.
            readCost: describe(run.readMs),
            reader: run.reader,
            clock: this._clock.summary,
            renderer: r ? r.kind : null,
            // [drawn at (client ms), content age (ms), capture age (ms)]
            samples: run.samples,
        };
        this.results.push(summary);
        return summary;
    }
}
