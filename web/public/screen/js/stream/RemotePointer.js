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
 * RemotePointer — a TV remote's arrows steering the host's mouse.
 *
 * A remote has no pointer of its own once a stream runs: the Freebox's is a
 * pad then (its arrows reach the page through the Gamepad API), and TV Bro's
 * direct navigation hides its cursor. So the host's desktop could not be
 * clicked from the couch (03/10/2026). In the stream menu's "Mouse" mode the
 * arrows move the host's pointer instead of pressing arrows there.
 *
 * Held, an arrow moves it every frame, slowly at first for aim and faster the
 * longer it is held, to cross a screen in a couple of seconds. A press moves
 * it one small step at once, so a quick tap is a fine adjustment. Two arrows
 * held together go diagonally at the same speed.
 *
 * This class only turns held directions into movement; StreamView decides
 * what a movement does on the host (StreamView._remotePointerMove).
 */

/** Speed when an arrow goes down, host desktop pixels a second (~4 a frame). */
export const POINTER_MIN_SPEED = 240;
/** Speed once it has been held POINTER_RAMP_MS (~32 a frame). */
export const POINTER_MAX_SPEED = 1920;
/** From the slow speed to the fast one. */
export const POINTER_RAMP_MS = 1000;
/** The step a press takes at once. */
export const POINTER_NUDGE = 4;

const DIRS = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
};

export class RemotePointer {
    /**
     * @param {{ move: (dx: number, dy: number) => void,
     *           now?: () => number,
     *           schedule?: (cb: () => void) => any,
     *           cancel?: (id: any) => void }} opts
     */
    constructor({ move, now, schedule, cancel }) {
        this._move = move;
        this._now = now || (() => performance.now());
        this._schedule = schedule || ((cb) => requestAnimationFrame(cb));
        this._cancel = cancel || ((id) => cancelAnimationFrame(id));
        /** @type {Set<string>} */
        this._held = new Set();
        this._since = 0;
        this._last = 0;
        this._frame = null;
        this._carryX = 0;
        this._carryY = 0;
    }

    /** Whether an arrow is held, the pointer moving. */
    get moving() {
        return this._held.size > 0;
    }

    /** Whether this arrow is one of those held. */
    isHeld(dir) {
        return this._held.has(dir);
    }

    /** An arrow went down. A repeat of a held one changes nothing. */
    press(dir) {
        const d = DIRS[dir];
        if (!d || this._held.has(dir)) return;
        const t = this._now();
        if (this._held.size === 0) {
            this._since = t;
            this._carryX = 0;
            this._carryY = 0;
        }
        this._held.add(dir);
        this._last = t;
        this._move(d[0] * POINTER_NUDGE, d[1] * POINTER_NUDGE);
        if (this._frame === null) this._frame = this._schedule(() => this._tick());
    }

    /** An arrow came back up. */
    release(dir) {
        this._held.delete(dir);
        if (this._held.size === 0) this._stop();
    }

    /** Everything let go: the menu opened, the mode went off, the stream ended. */
    releaseAll() {
        this._held.clear();
        this._stop();
    }

    _stop() {
        if (this._frame !== null) this._cancel(this._frame);
        this._frame = null;
    }

    _tick() {
        this._frame = null;
        if (this._held.size === 0) return;
        const t = this._now();
        // A frame that came late (a busy TV page) moves by its own length, but
        // never more than a few frames' worth at once.
        const dt = Math.min(Math.max(t - this._last, 0), 50);
        this._last = t;
        const ramp = Math.min(1, (t - this._since) / POINTER_RAMP_MS);
        const speed = POINTER_MIN_SPEED + (POINTER_MAX_SPEED - POINTER_MIN_SPEED) * ramp;
        let vx = 0;
        let vy = 0;
        for (const dir of this._held) {
            vx += DIRS[dir][0];
            vy += DIRS[dir][1];
        }
        const len = Math.hypot(vx, vy);
        if (len > 0) {
            const step = (speed * dt) / 1000;
            const x = (vx / len) * step + this._carryX;
            const y = (vy / len) * step + this._carryY;
            const dx = Math.trunc(x);
            const dy = Math.trunc(y);
            this._carryX = x - dx;
            this._carryY = y - dy;
            if (dx || dy) this._move(dx, dy);
        }
        this._frame = this._schedule(() => this._tick());
    }
}
