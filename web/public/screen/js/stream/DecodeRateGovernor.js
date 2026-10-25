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
 * DecodeRateGovernor — asks the host for fewer frames when the decoder cannot
 * take the rate the viewer set.
 *
 * A decoder a little slower than the stream does not fail, it queues: measured
 * on an Arc A380 at 1440p120, 116 frames a second arriving and 105 decoded, the
 * decode queue sat at ten frames for eight seconds — 90ms of latency that no
 * leg owns — while the backpressure rule dropped two or three of them a second
 * and paid a keyframe each time, which never emptied it. Nothing on the client
 * can: the frames are already here. The only honest repair is upstream, and a
 * native host can re-choose its cadence between two frames (`clientfpscap`).
 *
 * Same shape as EnhancerGovernor, and for the same reasons: a verdict has to
 * hold before it counts, the window has to refill after a change before it is
 * read again, and climbing back is a bet whose stake doubles when it is lost.
 *
 * The step down aims at what the decoder has just shown it delivers, with a
 * margin, rather than at a fixed notch: a queue drains only if the stream runs
 * BELOW the decoder's pace, and that pace is the one thing measured here.
 */

/** Frames waiting at the decoder input, on average, that make a standing queue. */
const QUEUE_DEGRADE = 4;
/** …and the queue has to be back to about empty before asking for more. */
const QUEUE_RECOVER = 1;
/** A standing queue must stand this long: a burst drains by itself. */
const DEGRADE_SUSTAIN_MS = 3000;
/** Share of the decoder's measured pace the cap is set to. */
const DEGRADE_MARGIN = 0.93;
/** Each successful bet gives this share of the setting back. */
const RECOVER_STEP = 0.1;
const RECOVER_BASE_MS = 20000;
const RECOVER_MAX_MS = 300000;
/** A raise undone within this delay counts as a failed bet. */
const RECOVER_REGRET_MS = 15000;
/** PipelineDiag's window: observations made before the change are still in it. */
const SETTLE_MS = 2500;
/** Never below this share of the setting, nor below this rate. */
const FLOOR_RATIO = 0.5;
const FLOOR_FPS = 30;

export class DecodeRateGovernor {
    /** @param {number} setFps The viewer's setting — the ceiling. */
    constructor(setFps) {
        this._setFps = setFps > 0 ? setFps : 0;
        this._cap = 0; // 0 = no cap, the setting stands
        this._degradeSince = 0;
        this._recoverSince = 0;
        this._recoverAfterMs = RECOVER_BASE_MS;
        this._lastRaiseMs = 0;
        this._settleUntil = 0;
    }

    /** Frames per second asked of the host, 0 when the setting stands. */
    get cap() {
        return this._cap;
    }

    /**
     * Feed one observation window.
     * @param {{decodeQueue: number, decodedFps: number, now: number}} obs
     *   decodeQueue average VideoDecoder.decodeQueueSize (PipelineDiag)
     *   decodedFps  frames the decoder delivered over the last second
     *   now         performance.now(), passed in so the policy stays pure
     * @returns {number|null} the new cap when it changed (0 lifts it), else null
     */
    update(obs) {
        if (!this._setFps) return null;
        const now = obs.now;
        if (now < this._settleUntil) return null;
        const queue = obs.decodeQueue > 0 ? obs.decodeQueue : 0;
        const current = this._cap || this._setFps;

        if (queue > QUEUE_DEGRADE) {
            this._recoverSince = 0;
            if (!this._degradeSince) this._degradeSince = now;
            if (now - this._degradeSince < DEGRADE_SUSTAIN_MS) return null;
            const floor = Math.max(FLOOR_FPS, Math.round(this._setFps * FLOOR_RATIO));
            // The decoder's own pace when it is known and lower; the current
            // rate otherwise — either way strictly under what it failed at.
            const pace = obs.decodedFps > 0 ? Math.min(obs.decodedFps, current) : current;
            const next = Math.max(floor, Math.floor(pace * DEGRADE_MARGIN));
            if (next >= current) return null;
            // A raise that did not hold: the next bet waits twice as long.
            if (this._lastRaiseMs && now - this._lastRaiseMs < RECOVER_REGRET_MS) {
                this._recoverAfterMs = Math.min(RECOVER_MAX_MS, this._recoverAfterMs * 2);
            }
            return this._set(next, now);
        }

        this._degradeSince = 0;
        if (!this._cap || queue > QUEUE_RECOVER) {
            this._recoverSince = 0;
            return null;
        }
        if (!this._recoverSince) this._recoverSince = now;
        if (now - this._recoverSince < this._recoverAfterMs) return null;
        const step = Math.max(1, Math.round(this._setFps * RECOVER_STEP));
        const next = this._cap + step >= this._setFps ? 0 : this._cap + step;
        this._lastRaiseMs = now;
        return this._set(next, now);
    }

    _set(cap, now) {
        this._cap = cap;
        this._degradeSince = 0;
        this._recoverSince = 0;
        this._settleUntil = now + SETTLE_MS;
        return cap;
    }
}
