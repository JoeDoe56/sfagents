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
 * When a keyframe arriving behind a deep decode queue is worth a decoder flush.
 *
 * A flush is reset() + configure(): the frames waiting ahead of the keyframe go,
 * and so does the hardware decoder, which is rebuilt. That is the right trade
 * when the queue holds a third of a second — it was written for a queue of 348 —
 * and the wrong one when it holds a few frames, because the rebuild costs more
 * than decoding them would have.
 *
 * Counting frames hid that. At 120fps eight frames are 66ms; the rebuild takes
 * longer, the stream keeps arriving meanwhile, the queue is past eight again
 * before the decoder is back, the deltas behind it are dropped, another keyframe
 * is asked for, and it finds a queue deep enough to flush. Measured on an Arc
 * A380 at 1440p120: 35 flushes in 12 seconds, two or three a second, with the
 * network and the host both flat and the decoder delivering 40 to 60 of the 120
 * frames it sustains when left alone.
 *
 * So the depth is judged as TIME — frames waiting times the interval they
 * arrive at — and a flush that did not settle things is not repeated at once.
 */

/** Backlog, in stream time, under which the frames are cheaper to decode. */
export const FLUSH_MIN_BACKLOG_MS = 250;

/** A flush within this long of the last one is the loop, not a recovery. */
export const FLUSH_COOLDOWN_MS = 3000;

/** Interval assumed before any arrival has been measured (60fps). */
const DEFAULT_ARRIVAL_MS = 1000 / 60;

/**
 * @param {{queued: number, arrivalMs: number, sinceLastFlushMs: number}} obs
 *   queued           — VideoDecoder.decodeQueueSize as the keyframe arrives
 *   arrivalMs        — average interval between frames, 0 when unknown
 *   sinceLastFlushMs — Infinity when there has been none
 */
export function shouldFlushAtKeyframe(obs) {
    const arrivalMs = obs.arrivalMs > 0 ? obs.arrivalMs : DEFAULT_ARRIVAL_MS;
    if (obs.queued * arrivalMs < FLUSH_MIN_BACKLOG_MS) return false;
    return obs.sinceLastFlushMs >= FLUSH_COOLDOWN_MS;
}
