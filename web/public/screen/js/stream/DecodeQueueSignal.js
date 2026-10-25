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
 * DecodeQueueSignal — tells a native host when the decoder has more than one
 * frame waiting, and when it is back to one, so that a host streaming at its
 * own display's rate skips presents instead of queuing them here.
 *
 * A host at 240 or 500 Hz can send frames faster than a phone decodes them.
 * On this side nothing can be done about a frame once it has arrived: an HEVC
 * delta can only be dropped by paying a keyframe for the ones after it. The
 * host, on the other hand, skips a present for free — the next one it sends
 * is simply a delta against the last one it did. DecodeRateGovernor answers a
 * queue that STANDS, over seconds, with a lower rate; this answers the first
 * frame too many, within one trip across the link (cadence=host-guarded,
 * design §33). A host that does not run that cadence ignores the message.
 *
 * The message says the queue's depth. The host stops at two and resumes at
 * one or less; while the queue stays full the signal is said again every
 * REFRESH_MS, because the host stops believing a "full" it has not heard
 * repeated — a lost "clear", or a page gone, must not stop the stream.
 *
 * Pure: the caller reads VideoDecoder.decodeQueueSize and the clock.
 */

/** Frames waiting at the decoder input that make it full. */
export const QUEUE_FULL = 2;
/** …and the depth it has to be back to before the host may send again. */
export const QUEUE_CLEAR = 1;
/** How often a queue that stays full is said again (the host forgets it after five times this). */
export const REFRESH_MS = 50;

export class DecodeQueueSignal {
    constructor() {
        this._full = false;
        this._sentMs = 0;
    }

    /** True while the host has last been told the queue is full. */
    get full() {
        return this._full;
    }

    /**
     * The decoder's queue as it stands now.
     * @param {number} queued VideoDecoder.decodeQueueSize
     * @param {number} now performance.now()
     * @returns {{type: string, depth: number}|null} the message to send, or null
     */
    observe(queued, now) {
        const depth = queued > 0 ? queued : 0;
        if (depth >= QUEUE_FULL) {
            if (this._full && now - this._sentMs < REFRESH_MS) return null;
            this._full = true;
            this._sentMs = now;
            return { type: 'decodequeue', depth };
        }
        if (this._full && depth <= QUEUE_CLEAR) {
            this._full = false;
            this._sentMs = now;
            return { type: 'decodequeue', depth };
        }
        return null;
    }
}

/**
 * The decode queue measured as a delay rather than as a count (bench variant
 * `mw_decodequeue=delay`, plan framerate-hote).
 *
 * A count cannot be right for every decoder. decodeQueueSize sees only what
 * waits in front of the decoder: under a 500 Hz host, DualRTX's iGPU held
 * eight frames inside it behind a depth of two. The frames given to decode()
 * and not yet out of it count those too, but an Apple M1 keeps more than one
 * in flight while it keeps up with 240 a second — counted, it read as a
 * queue and held the stream back for nothing.
 *
 * A queue is time: the oldest frame still in the decoder has waited longer
 * than a decode usually takes. That excess, in frames of the stream, plus
 * the one being decoded, is the depth this gives — 1 while the decoder keeps
 * up, whatever its own pipeline, 2 once a whole frame interval is standing.
 */
export class DecodeDelay {
    /** @param {number} [windowMs] how far back the usual decode time is looked for */
    constructor(windowMs = 2000) {
        this._windowMs = windowMs;
        /** @type {Array<[number, number]>} [output time, latency], latencies increasing */
        this._mins = [];
    }

    /** A frame came out of the decoder @p latencyMs after decode(), at @p now. */
    noteLatency(latencyMs, now) {
        if (!(latencyMs >= 0)) return;
        // A sliding minimum: a later, faster decode makes every slower one
        // before it irrelevant.
        while (this._mins.length && this._mins[this._mins.length - 1][1] >= latencyMs)
            this._mins.pop();
        this._mins.push([now, latencyMs]);
        while (this._mins.length && this._mins[0][0] < now - this._windowMs) this._mins.shift();
    }

    /** The usual decode time: the fastest over the window, 0 before any. */
    get usualMs() {
        return this._mins.length ? this._mins[0][1] : 0;
    }

    /**
     * The queue's depth, in frames, when the oldest frame still in the
     * decoder was given to it @p oldestAgeMs ago (0: none) and frames arrive
     * every @p intervalMs.
     */
    depth(oldestAgeMs, intervalMs) {
        if (!(oldestAgeMs > 0)) return 0;
        const interval = intervalMs > 0.5 ? intervalMs : 16.7;
        return 1 + Math.max(0, Math.floor((oldestAgeMs - this.usualMs) / interval));
    }
}
