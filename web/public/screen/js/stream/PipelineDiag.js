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
 * PipelineDiag — observations of the browser-side WebCodecs pipeline.
 *
 * The overlay's three latency legs (decode / render queue / render) say how
 * long each stage took, but not WHY. They all inflate together as soon as the
 * host framerate rises (static desktop → moving mouse or a video playing),
 * which has two very different explanations that the legs alone cannot tell
 * apart:
 *
 *   - the browser is slower per frame (bigger frames to decode, heavier draw), or
 *   - the pipeline is BACK-PRESSURED: the presentation path (canvas swap chain /
 *     GPU) can't retire frames at the incoming rate, the render guard stays busy,
 *     decoded frames pile up, the decoder's output pool starves and its
 *     submit→output latency grows as a consequence.
 *
 * Under back-pressure the decode leg is a symptom, not a cause — and the fps
 * shown is the DECODED rate, so a pipeline presenting only two thirds of what
 * it decodes still reads "60 fps".
 *
 * This class records the quantities that separate the two:
 *   - frame arrival interval (what the host actually sends),
 *   - VideoDecoder.decodeQueueSize at submit (decoder input pressure),
 *   - decoded-frame queue depth at pump (render can't keep up),
 *   - the draw split into submit vs wait (see VideoRenderer.lastDraw): a high
 *     WAIT with a low submit is presentation back-pressure, not draw cost,
 *   - drops by cause, so the presented-vs-decoded gap is attributable.
 *
 * Instantiated once per pipeline: the worker owns one (its own clock, posted in
 * the counters message) and StreamView owns one for the main-thread path. Pure
 * bookkeeping — no DOM, no WebCodecs — so both contexts can import it.
 */

/** Sliding-window samples, mirroring StreamView's SlidingStats (avg + max). */
class DiagWindow {
    constructor(windowMs) {
        this._windowMs = windowMs;
        this._samples = []; // [{ time, value }]
    }

    /**
     * @param {number} value
     * @param {number} [max] Reject above this — the default is the same sanity
     *   bound as the latency legs (a clock jump or a stream-long stall must not
     *   poison a millisecond window forever). Pass Infinity for a magnitude
     *   that legitimately has no bound, like a frame size.
     */
    push(value, max = 5000) {
        if (!(value >= 0) || value > max) return;
        this._samples.push({ time: performance.now(), value });
    }

    _prune() {
        const cutoff = performance.now() - this._windowMs;
        let i = 0;
        while (i < this._samples.length && this._samples[i].time <= cutoff) i++;
        if (i > 0) this._samples.splice(0, i);
    }

    get avg() {
        this._prune();
        if (this._samples.length === 0) return 0;
        let sum = 0;
        for (const s of this._samples) sum += s.value;
        return sum / this._samples.length;
    }

    get max() {
        this._prune();
        let m = 0;
        for (const s of this._samples) {
            if (s.value > m) m = s.value;
        }
        return m;
    }

    /** Samples still inside the window — a rate, once divided by its length. */
    get count() {
        this._prune();
        return this._samples.length;
    }

    get sum() {
        this._prune();
        let sum = 0;
        for (const s of this._samples) sum += s.value;
        return sum;
    }

    /** The value under which a fraction @p q of the window lies (0 if empty). */
    quantile(q) {
        this._prune();
        if (this._samples.length === 0) return 0;
        const sorted = this._samples.map((s) => s.value).sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    }
}

export class PipelineDiag {
    constructor(windowMs = 2000) {
        this._arrival = new DiagWindow(windowMs);
        this._frameBytes = new DiagWindow(windowMs);
        this._decodeQueue = new DiagWindow(windowMs);
        this._frameQueue = new DiagWindow(windowMs);
        this._renderSubmit = new DiagWindow(windowMs);
        this._renderWait = new DiagWindow(windowMs);
        this._drawConcurrency = new DiagWindow(windowMs);
        this._lastArrival = 0;
        this._renderPath = '';
        // Cumulative, by cause — deltas are computed by the reader so the
        // display can show a per-second rate without resetting shared state.
        this._drops = { stale: 0, queueFull: 0, backpressure: 0 };
        // Recoveries, cumulative too. A collapse that feeds itself — a drop asks
        // for a keyframe, the keyframe flushes or resets the decoder, the
        // decoder restarts late and the queue fills again — reads in the
        // queues exactly like a decoder that is simply too slow; only the
        // count of what was done about it tells them apart.
        this._recoveries = { idr: 0, flush: 0, reset: 0 };
    }

    /**
     * A recovery action was taken.
     * @param {'idr'|'flush'|'reset'} kind keyframe requested / decode queue
     *   flushed at a keyframe / decoder torn down and rebuilt
     */
    noteRecovery(kind) {
        if (this._recoveries[kind] !== undefined) this._recoveries[kind]++;
    }

    /**
     * One encoded frame entered the pipeline: records the arrival interval and,
     * when the size is known, how big the frame is. A still desktop sends tiny
     * deltas while motion sends full-size frames, so the encoded size is the
     * competing explanation for a growing decode leg ("the frames are simply
     * heavier") against back-pressure — the queue depths tell them apart.
     * @param {number} [bytes]
     */
    noteArrival(bytes) {
        const now = performance.now();
        if (this._lastArrival > 0) this._arrival.push(now - this._lastArrival);
        this._lastArrival = now;
        if (bytes !== undefined) this._frameBytes.push(bytes, Infinity);
    }

    /** Average interval between frames over the window, 0 before the second. */
    get arrivalAvgMs() {
        return this._arrival.avg;
    }

    /** VideoDecoder.decodeQueueSize, sampled at decode() submit. */
    noteDecodeQueue(size) {
        this._decodeQueue.push(size);
    }

    /** Decoded frames waiting to be drawn, sampled when the pump runs. */
    noteFrameQueue(depth) {
        this._frameQueue.push(depth);
    }

    /**
     * Timing of the draw that just completed, as reported by the renderer.
     * @param {{submitMs?: number, waitMs?: number, path?: string}|null} lastDraw
     * @param {number} [inFlight] Draws running concurrently with this one — a
     *   draw's duration is a LATENCY, and once the pipeline overlaps two of
     *   them the time each frame actually costs the pipeline is that latency
     *   divided by the concurrency (Little's law). Without this, doubling the
     *   in-flight cap would look like the draw got twice as expensive.
     */
    noteDraw(lastDraw, inFlight) {
        if (!lastDraw) return;
        this._renderSubmit.push(lastDraw.submitMs);
        this._renderWait.push(lastDraw.waitMs);
        this._drawConcurrency.push(inFlight === undefined ? 1 : inFlight);
        if (lastDraw.path) this._renderPath = lastDraw.path;
    }

    /**
     * A frame was dropped.
     * @param {'stale'|'queueFull'|'backpressure'} cause
     *   stale        — superseded in the render queue (drop-to-latest)
     *   queueFull    — decoder output arrived with the queue already full
     *   backpressure — never submitted: decoder input queue saturated / no reference
     */
    noteDrop(cause, count = 1) {
        if (this._drops[cause] !== undefined) this._drops[cause] += count;
    }

    /** Flat snapshot — postMessage-safe (structured clone of plain numbers). */
    snapshot() {
        // Per-frame cost of the render stage: the whole draw latency spread
        // over the draws that were overlapping. This — not the raw wait — is
        // what has to fit inside a frame interval, so it is what the enhancer
        // ladder is fed.
        const concurrency = Math.max(1, this._drawConcurrency.avg);
        const drawLatency = this._renderSubmit.avg + this._renderWait.avg;
        return {
            drawConcurrency: concurrency,
            renderServiceMs: drawLatency / concurrency,
            arrivalAvgMs: this._arrival.avg,
            arrivalMaxMs: this._arrival.max,
            frameBytesAvg: this._frameBytes.avg,
            frameBytesMax: this._frameBytes.max,
            decodeQueueAvg: this._decodeQueue.avg,
            decodeQueueMax: this._decodeQueue.max,
            frameQueueAvg: this._frameQueue.avg,
            frameQueueMax: this._frameQueue.max,
            renderSubmitMs: this._renderSubmit.avg,
            renderWaitMs: this._renderWait.avg,
            renderPath: this._renderPath,
            dropStale: this._drops.stale,
            dropQueueFull: this._drops.queueFull,
            dropBackpressure: this._drops.backpressure,
            recoverIdr: this._recoveries.idr,
            recoverFlush: this._recoveries.flush,
            recoverReset: this._recoveries.reset,
        };
    }
}

/**
 * MainThreadProbe — what else the main thread is busy with while it streams.
 *
 * The pipeline above is fed, and by default drawn, on the main thread — the
 * same one that handles the mouse. Against a native host the mouse goes out at
 * its own report rate (pointerrawupdate, 1000 a second for a gaming mouse),
 * each report a handler run and a message; a frame interval at 120fps is 8.3ms.
 * Whether the two get in each other's way is a question for a measurement, and
 * nothing in PipelineDiag can answer it: a late frame reads the same there
 * whether the network, the decoder or a busy event loop held it up.
 *
 * Four observations, all windowed like the rest:
 *   - input messages sent, and the time their handlers took,
 *   - event-loop lag: how late a 10ms timer fires. It fires late only when the
 *     thread was busy with something else, so its max is the longest stretch
 *     during which a frame that had arrived could not be touched,
 *   - long tasks (>50ms), as the browser reports them,
 *   - the gamepads: how often a forwarded pad is read, how far apart two reads
 *     are (a pad is seen only when read, so the gap is what a stick or a
 *     button waits at worst), and how many states went out,
 *   - the mouse: how old a report is when its motion goes out (now minus the
 *     event's timeStamp) and how far apart two motions go. A report waits on
 *     average about age + gap / 2 — what tells the per-report cadence
 *     (pointerrawupdate) from the per-frame one (mousemove).
 *
 * Diagnostics only (mw_perf_diag): the timer runs only between start() and
 * stop(), and each note costs a push.
 */
/**
 * Two mouse motions further apart than this belong to two movements: even
 * coalesced to the frame at 30 Hz, a hand still moving reports every 33 ms.
 */
const MOUSE_IDLE_MS = 50;

export class MainThreadProbe {
    constructor(windowMs = 2000) {
        this._windowMs = windowMs;
        this._inputMs = new DiagWindow(windowMs);
        this._lag = new DiagWindow(windowMs);
        this._longTasks = new DiagWindow(windowMs);
        this._padGapMs = new DiagWindow(windowMs);
        this._padSends = new DiagWindow(windowMs);
        this._mouseAgeMs = new DiagWindow(windowMs);
        this._mouseGapMs = new DiagWindow(windowMs);
        this._lastMouseSendAt = 0;
        this._timer = null;
        this._observer = null;
    }

    start() {
        if (this._timer !== null) return;
        const PERIOD_MS = 10;
        let expected = performance.now() + PERIOD_MS;
        this._timer = setInterval(() => {
            const now = performance.now();
            this._lag.push(Math.max(0, now - expected));
            expected = now + PERIOD_MS;
        }, PERIOD_MS);
        if (typeof PerformanceObserver !== 'undefined') {
            try {
                this._observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) this._longTasks.push(entry.duration);
                });
                this._observer.observe({ entryTypes: ['longtask'] });
            } catch (e) {
                this._observer = null;
            }
        }
    }

    stop() {
        if (this._timer !== null) clearInterval(this._timer);
        this._timer = null;
        if (this._observer) this._observer.disconnect();
        this._observer = null;
    }

    /** One input message left; its handler ran for @p handlerMs. */
    noteInput(handlerMs) {
        this._inputMs.push(handlerMs);
    }

    /** A forwarded pad was read, @p gapMs after the previous read. */
    notePadRead(gapMs) {
        this._padGapMs.push(gapMs);
    }

    /** One gamepad state went out. */
    notePadSend() {
        this._padSends.push(0);
    }

    /**
     * One mouse motion went out, for a report @p ageMs old. The gap to the
     * previous motion counts only inside one movement: past MOUSE_IDLE_MS the
     * hand had stopped, and a pause is not a gap between two reports.
     */
    noteMouseSend(ageMs) {
        const now = performance.now();
        this._mouseAgeMs.push(ageMs);
        const gap = now - this._lastMouseSendAt;
        if (this._lastMouseSendAt && gap < MOUSE_IDLE_MS) this._mouseGapMs.push(gap);
        this._lastMouseSendAt = now;
    }

    snapshot() {
        const seconds = this._windowMs / 1000;
        return {
            inputsPerSec: this._inputMs.count / seconds,
            inputMsPerSec: this._inputMs.sum / seconds,
            loopLagAvgMs: this._lag.avg,
            loopLagMaxMs: this._lag.max,
            longTasks: this._longTasks.count,
            longTaskMaxMs: this._longTasks.max,
            padReadsPerSec: this._padGapMs.count / seconds,
            padSendsPerSec: this._padSends.count / seconds,
            padGapP95Ms: this._padGapMs.quantile(0.95),
            padGapMaxMs: this._padGapMs.max,
            mouseSendsPerSec: this._mouseAgeMs.count / seconds,
            mouseAgeAvgMs: this._mouseAgeMs.avg,
            mouseAgeMaxMs: this._mouseAgeMs.max,
            mouseGapAvgMs: this._mouseGapMs.avg,
            mouseGapP95Ms: this._mouseGapMs.quantile(0.95),
        };
    }
}

/**
 * Render a MainThreadProbe snapshot as the tail of the [perf] line. Two parts
 * appear only while they have something to say, so a quiet session's line is
 * unchanged:
 *   - pad: reads/s, states sent/s, gap between reads p95/max;
 *   - mouse: motions sent/s, report age avg/max, gap avg/p95, and the
 *     average wait of a report, age + gap / 2.
 * @param {ReturnType<MainThreadProbe['snapshot']>|null} load
 */
export function formatMainThread(load) {
    if (!load) return '';
    const n1 = (v) => (v || 0).toFixed(1);
    let line =
        'input ' +
        Math.round(load.inputsPerSec) +
        '/s ' +
        n1(load.inputMsPerSec) +
        'ms/s · loop lag ' +
        n1(load.loopLagAvgMs) +
        '/' +
        n1(load.loopLagMaxMs) +
        'ms · longtask ' +
        load.longTasks +
        '/' +
        Math.round(load.longTaskMaxMs) +
        'ms';
    if (load.padReadsPerSec > 0) {
        line +=
            ' · pad read ' +
            Math.round(load.padReadsPerSec) +
            '/s sent ' +
            Math.round(load.padSendsPerSec) +
            '/s gap ' +
            n1(load.padGapP95Ms) +
            '/' +
            n1(load.padGapMaxMs) +
            'ms';
    }
    if (load.mouseSendsPerSec > 0) {
        line +=
            ' · mouse ' +
            Math.round(load.mouseSendsPerSec) +
            '/s age ' +
            n1(load.mouseAgeAvgMs) +
            '/' +
            n1(load.mouseAgeMaxMs) +
            'ms gap ' +
            n1(load.mouseGapAvgMs) +
            '/' +
            n1(load.mouseGapP95Ms) +
            'ms wait ' +
            n1(load.mouseAgeAvgMs + load.mouseGapAvgMs / 2) +
            'ms';
    }
    return line;
}

/**
 * Render one snapshot as a single compact line, for the overlay's expanded
 * detail and the periodic console trace. `rates` carries the values the
 * snapshot cannot know (they live on the main thread): decoded/presented fps
 * and the drop deltas of the last interval.
 *
 * @param {ReturnType<PipelineDiag['snapshot']>|null} diag
 * @param {{decodedFps?: number, presentedFps?: number, dropsPerSec?: number}} rates
 */
export function formatDiag(diag, rates) {
    if (!diag) return '';
    const r = rates || {};
    const n1 = (v) => (v || 0).toFixed(1);
    return (
        'fps in/out ' +
        Math.round(r.decodedFps || 0) +
        '/' +
        Math.round(r.presentedFps || 0) +
        ' · arrival ' +
        n1(diag.arrivalAvgMs) +
        '/' +
        n1(diag.arrivalMaxMs) +
        'ms · frame ' +
        n1(diag.frameBytesAvg / 1024) +
        '/' +
        n1(diag.frameBytesMax / 1024) +
        'KB · decQ ' +
        n1(diag.decodeQueueAvg) +
        '/' +
        Math.round(diag.decodeQueueMax) +
        ' · frmQ ' +
        n1(diag.frameQueueAvg) +
        '/' +
        Math.round(diag.frameQueueMax) +
        ' · draw ' +
        n1(diag.renderSubmitMs) +
        '+' +
        n1(diag.renderWaitMs) +
        'ms ×' +
        n1(diag.drawConcurrency) +
        '→' +
        n1(diag.renderServiceMs) +
        'ms' +
        (diag.renderPath ? ' [' + diag.renderPath + ']' : '') +
        ' · drop ' +
        n1(r.dropsPerSec) +
        '/s (stale ' +
        diag.dropStale +
        ' full ' +
        diag.dropQueueFull +
        ' bp ' +
        diag.dropBackpressure +
        ') · idr ' +
        (diag.recoverIdr || 0) +
        ' flush ' +
        (diag.recoverFlush || 0) +
        ' reset ' +
        (diag.recoverReset || 0)
    );
}
