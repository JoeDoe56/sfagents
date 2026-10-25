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
 * VsyncGrid — this screen's refreshes, told to the host so that it sends each
 * frame to land just before one (plan framerate-hote §13, cadence=deadline).
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * A screen shows a new picture once per refresh. A frame that arrives at any
 * other moment waits for the next one — for the whole picture on vsync, for
 * the part of it already scanned when the canvas tears — so a stream whose
 * frames fall anywhere in the refresh wastes half of one on average. A host
 * that captures faster than this screen refreshes can instead pick, for each
 * refresh, the freshest picture that can still make it, and send that one
 * alone: the latency of sending everything, the decodes of today's cadence.
 * The host can only do it if it knows when this screen refreshes, on its own
 * clock, and how long a frame takes to get ready here.
 *
 * A canvas that tears is another matter (Bruno's cases, 30/09): it shows a
 * frame the moment it is drawn, on the part of the screen the scan has not
 * reached yet, so any wait on the host is lost on every line — a game at 50
 * frames a second on a 60 Hz screen would pay half a refresh for nothing.
 * There the host sends each new picture at once and the grid only caps how
 * many: `budgetFps`, this screen's refresh times the bench switch
 * `mw_vsyncgrid_budget` (1 by default). A picture over the budget is skipped,
 * never held.
 *
 * ── What goes up ─────────────────────────────────────────────────────────────
 *
 * Every SEND_EVERY_MS, a `vsyncgrid` message:
 *   - periodUs: the refresh period, fitted over the last TICKS_KEPT
 *     requestAnimationFrame timestamps (vsync-aligned in Chromium);
 *   - phaseUs: the latest refresh, on the host's steady clock (ClockEstimator,
 *     fed by pongs that carry it);
 *   - leadUs: how long before a refresh the host must have captured a frame
 *     for it to be ready here in time;
 *   - tearing, and budgetFps: see above.
 * On vsync, the host aims each frame at the refresh R where capture + leadUs
 * ≤ R.
 * Ready means drawn when the canvas tears (the picture reaches the screen as
 * it is drawn, so it must be there before the scan starts), and decoded on
 * vsync (the render loop draws the freshest frame at the refresh).
 *
 * ── The lead ─────────────────────────────────────────────────────────────────
 *
 * The median of capture → ready over TRANSIT_WINDOW_MS, plus a margin set on
 * the result. It starts wide: the p95's distance to the median and a quarter
 * period. A frame ready after the refresh it was sent for is a miss — on
 * vsync the old picture stays up one refresh more, when tearing a few lines
 * at the top stay old — and each one widens the margin by MARGIN_UP_MS. Every
 * MARGIN_CALM_MS without one narrows it by half of what the spell's
 * tightest frames (the 1st percentile of their slack before the refresh)
 * had to spare beyond MARGIN_FLOOR_MS, and by MARGIN_DOWN_MS at least, never
 * under MARGIN_FLOOR_MS. The target is under half a percent of refreshes
 * missed (a simulated link with a 4 ms tail settles near a tenth of one).
 * The clock estimate's own error cancels out: the refresh and the ready time
 * both go through it, and the host only subtracts one from the other.
 *
 * ── A link too uneven to aim through ─────────────────────────────────────────
 *
 * Aiming needs frames to be ready when the lead says. When capture → ready
 * wanders by more than half a refresh — its 95th percentile past the median,
 * over TRANSIT_WINDOW_MS — or the margin has grown to a whole refresh, no
 * margin holds: an N95 on Wi-Fi at 60 Hz missed 11 to 22 % of its refreshes
 * and drew 35 frames a second instead of 50, two frames landing in one
 * refresh and none in the next (plan §13, P3, 30/09/2026). The grid then says
 * `steady: false`; the host sends each picture as it comes, and the render
 * loop keeps its reserve, which is what such a link needs. Aiming comes back
 * after STEADY_FOR_MS with the spread under a third of a refresh, the margin
 * started afresh.
 *
 * ── The host's side ──────────────────────────────────────────────────────────
 *
 * A pong carries `grid: true` while the host would use a grid (it is asked
 * for, nothing is sent otherwise), and `deadline: {presentUs, aimed}` while it
 * is following this one — presentUs its own display's refresh period, aimed
 * whether its frames are aimed at refreshes (vsync) or sent as they come
 * (tearing, an uneven link). While it aims, the render loop drops its
 * reserve: frames aimed at a refresh never arrive on its edge, which is all
 * the reserve was for. Misses are counted only while frames are aimed.
 */

import { ClockEstimator } from '../util/ClockEstimator.js';

/** How often the grid goes up. */
export const SEND_EVERY_MS = 500;
/** How often the grid pings for the host's clock. */
export const PING_EVERY_MS = 250;
/** Refreshes the period and phase are fitted over. */
export const TICKS_KEPT = 240;
/** Fewest refreshes a fit is made from. */
export const TICKS_MIN = 30;
/** How far back capture → ready samples go into the lead. */
export const TRANSIT_WINDOW_MS = 2000;
/** Fewest capture → ready samples a lead is made from. */
export const TRANSIT_MIN = 20;
/** The margin's steps, its calm spell and its floor. */
export const MARGIN_UP_MS = 1;
export const MARGIN_DOWN_MS = 0.25;
export const MARGIN_CALM_MS = 5000;
export const MARGIN_FLOOR_MS = 0.5;
/** A pong saying the host follows the grid counts for this long. */
export const FOLLOWED_FOR_MS = 3000;
/** The budget when tearing, in refreshes' worth of frames, without the switch. */
export const BUDGET_FACTOR = 1;
/**
 * The link is too uneven to aim through above this spread of capture → ready
 * (p95 − median), in refreshes; steady again under STEADY_BELOW held for
 * STEADY_FOR_MS.
 */
export const UNSTEADY_ABOVE = 0.5;
export const STEADY_BELOW = 1 / 3;
export const STEADY_FOR_MS = 5000;

const WRAP_MS = 2 ** 32;

/**
 * The refresh grid behind @p ticks (increasing requestAnimationFrame
 * timestamps, ms): its period and the latest refresh on it. Refreshes the
 * browser skipped leave a gap of whole periods and are counted as such; a
 * tick off the grid by more than a quarter period is left out of the fit.
 * @returns {{periodMs: number, phaseMs: number}|null}
 */
export function fitGrid(ticks) {
    const n = ticks.length;
    if (n < TICKS_MIN) return null;
    const deltas = [];
    for (let i = 1; i < n; i++) deltas.push(ticks[i] - ticks[i - 1]);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (!(median > 0)) return null;
    let sum = 0;
    let count = 0;
    for (const d of deltas) {
        if (d > median * 0.5 && d < median * 1.5) {
            sum += d;
            count++;
        }
    }
    const rough = count ? sum / count : median;
    const t0 = ticks[0];
    const index = ticks.map((t) => Math.round((t - t0) / rough));
    const line = (keep) => {
        let sx = 0;
        let sy = 0;
        let sxx = 0;
        let sxy = 0;
        let m = 0;
        for (let i = 0; i < n; i++) {
            if (!keep(i)) continue;
            const x = index[i];
            const y = ticks[i] - t0;
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
            m++;
        }
        const den = m * sxx - sx * sx;
        if (m < TICKS_MIN / 2 || den === 0) return null;
        const b = (m * sxy - sx * sy) / den;
        return { a: (sy - b * sx) / m, b };
    };
    let fit = line(() => true);
    if (!fit) return null;
    const off = (i) => Math.abs(ticks[i] - t0 - (fit.a + fit.b * index[i]));
    const tol = rough / 4;
    let outliers = false;
    for (let i = 0; i < n && !outliers; i++) outliers = off(i) > tol;
    if (outliers) {
        const first = fit;
        fit = line((i) => Math.abs(ticks[i] - t0 - (first.a + first.b * index[i])) <= tol);
        if (!fit) return null;
    }
    return { periodMs: fit.b, phaseMs: t0 + fit.a + fit.b * index[n - 1] };
}

/** The p-th fraction of @p sorted (ascending), nearest rank. */
function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export class VsyncGrid {
    /**
     * @param {object} deps
     * @param {(msg: object) => void} deps.send a control message to the host
     * @param {(seq: number, ts: number) => void} deps.sendPing a `ping` the
     *        host answers with a `pong` carrying `host` (its steady µs)
     * @param {() => number} [deps.now] this client's clock, ms
     * @param {(cb: (t: number) => void) => void} [deps.onFrame]
     *        requestAnimationFrame, or a stand-in
     * @param {() => boolean} [deps.tearing] whether the canvas tears
     * @param {number} [deps.budgetFactor] frames per refresh the host may
     *        send a canvas that tears
     */
    constructor({ send, sendPing, now, onFrame, tearing, budgetFactor = BUDGET_FACTOR }) {
        this._send = send;
        this._sendPing = sendPing;
        this._tearing = tearing || (() => false);
        this._budgetFactor = budgetFactor > 0 ? budgetFactor : BUDGET_FACTOR;
        this._now = now || (() => performance.now());
        this._onFrame =
            onFrame ||
            ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0));
        this._clock = new ClockEstimator();
        this._running = false;
        this._pingTimer = null;
        this._seq = 1 << 21; // apart from the view's and the content-age probe's pings
        /** @type {number[]} */
        this._ticks = [];
        /** @type {{at: number, us: number}[]} */
        this._transit = [];
        this._grid = null; // the last fit
        this._marginMs = null; // set with the first lead
        this._calmSince = 0;
        /** @type {number[]} slack of the frames since the last miss or step */
        this._calmSlack = [];
        this._followedUntil = 0;
        this._aimed = false;
        this._steady = true;
        this._quietSince = null; // since when an uneven link has looked steady
        this._capped = false; // the margin reached a whole refresh
        this.unsteadySpells = 0;
        this._spreadMs = null;
        this.hostPresentUs = 0;
        /** What went up last, as the host holds it: the grid on both clocks, the lead. */
        this._sent = null;
        this._lastSendAt = -Infinity;
        this.sent = 0;
        this.frames = 0;
        this.misses = 0;
        /** @type {number[]} slack before the aimed refresh (ms), the last few seconds */
        this._slack = [];
    }

    get running() {
        return this._running;
    }

    /** True while the host says it follows this grid. */
    get followed() {
        return this._running && this._now() < this._followedUntil;
    }

    /** True while it aims its frames at refreshes (vsync), not as they come. */
    get aimed() {
        return this.followed && this._aimed;
    }

    /** The margin in use, ms (null before the first fit). */
    get marginMs() {
        return this._marginMs;
    }

    /** False while the link is too uneven to aim through. */
    get steady() {
        return this._steady;
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._pingTimer = setInterval(
            () => this._sendPing(this._seq++, this._now()),
            PING_EVERY_MS,
        );
        const tick = (t) => {
            if (!this._running) return;
            this.noteRefresh(t);
            this._onFrame(tick);
        };
        this._onFrame(tick);
    }

    stop() {
        this._running = false;
        clearInterval(this._pingTimer);
        this._pingTimer = null;
    }

    /**
     * A pong arrived (StreamView forwards them all): the host's clock, and
     * whether it follows the grid.
     */
    notePong(msg, recvMs) {
        if (!msg) return;
        if (typeof msg.host === 'number' && typeof msg.ts === 'number')
            this._clock.note(msg.ts, msg.host, recvMs);
        if (msg.deadline && typeof msg.deadline === 'object') {
            this._followedUntil = recvMs + FOLLOWED_FOR_MS;
            this._aimed = msg.deadline.aimed === true;
            if (msg.deadline.presentUs > 0) this.hostPresentUs = msg.deadline.presentUs;
        }
    }

    /** One refresh: a requestAnimationFrame timestamp. Sends the grid when due. */
    noteRefresh(t) {
        const ticks = this._ticks;
        if (ticks.length && t <= ticks[ticks.length - 1]) return;
        ticks.push(t);
        if (ticks.length > TICKS_KEPT) ticks.splice(0, ticks.length - TICKS_KEPT);
        if (t - this._lastSendAt >= SEND_EVERY_MS) this._sendGrid(t);
    }

    /**
     * A frame is ready at @p readyMs (drawn when tearing, decoded on vsync);
     * @p backendTs its capture time, the host's steady ms (32 bits).
     */
    noteReady(backendTs, readyMs) {
        if (!this._running || !(backendTs > 0) || !this._clock.ready) return;
        const readyHostUs = this._clock.toHostUs(readyMs);
        const nearMs = readyHostUs / 1000;
        const captureMs = backendTs + Math.round((nearMs - backendTs) / WRAP_MS) * WRAP_MS;
        const us = readyHostUs - captureMs * 1000;
        if (!(us > 0 && us < 1e6)) return;
        this._transit.push({ at: readyMs, us });
        while (this._transit.length && this._transit[0].at < readyMs - TRANSIT_WINDOW_MS)
            this._transit.shift();
        if (!this.aimed || !this._sent) return;

        // The refresh the host aimed this frame at: the first on the grid it
        // holds at or after capture + lead. Its own clock throughout, then back
        // onto this one through the same offset the grid went up with.
        const s = this._sent;
        const k = Math.ceil((captureMs * 1000 + s.leadUs - s.phaseUs) / s.periodUs);
        const aimedMs = s.phaseMs + (k * s.periodUs) / 1000;
        const slack = aimedMs - readyMs;
        this.frames++;
        this._slack.push(slack);
        if (this._slack.length > 1000) this._slack.shift();
        if (slack < 0) {
            this.misses++;
            this._marginMs = Math.min(this._marginMs + MARGIN_UP_MS, s.periodUs / 1000);
            if (this._marginMs >= s.periodUs / 1000) this._capped = true;
            this._calmSince = readyMs;
            this._calmSlack = [];
            return;
        }
        this._calmSlack.push(slack);
        if (readyMs - this._calmSince >= MARGIN_CALM_MS) {
            const tight = percentile(
                this._calmSlack.sort((a, b) => a - b),
                0.01,
            );
            const step = Math.max(MARGIN_DOWN_MS, (tight - MARGIN_FLOOR_MS) / 2);
            this._marginMs = Math.max(MARGIN_FLOOR_MS, this._marginMs - step);
            this._calmSince = readyMs;
            this._calmSlack = [];
        }
    }

    /** The lead in µs: median of capture → ready, plus the margin. Null until known. */
    get leadUs() {
        if (this._transit.length < TRANSIT_MIN || this._marginMs === null) return null;
        return this._transitAt(0.5) + this._marginMs * 1000;
    }

    /** The @p p-th fraction of capture → ready, µs. */
    _transitAt(p) {
        return percentile(
            this._transit.map((s) => s.us).sort((a, b) => a - b),
            p,
        );
    }

    _sendGrid(t) {
        const fit = fitGrid(this._ticks);
        if (!fit) return;
        this._grid = fit;
        if (this._transit.length >= TRANSIT_MIN) {
            this._spreadMs = (this._transitAt(0.95) - this._transitAt(0.5)) / 1000;
            this._judgeSteady(t, fit.periodMs);
        }
        if (this._marginMs === null && this._transit.length >= TRANSIT_MIN) {
            // Wide to begin with: the tail past the median, a quarter period more.
            this._marginMs = Math.max(MARGIN_FLOOR_MS, this._spreadMs + fit.periodMs / 4);
            this._calmSince = t;
        }
        const leadUs = this.leadUs;
        if (!this._clock.ready || leadUs === null) return;
        const periodUs = fit.periodMs * 1000;
        const phaseUs = this._clock.toHostUs(fit.phaseMs);
        const tearing = this._tearing() === true;
        this._send({
            type: 'vsyncgrid',
            periodUs: Math.round(periodUs * 100) / 100,
            phaseUs: Math.round(phaseUs),
            leadUs: Math.round(leadUs),
            tearing,
            steady: this._steady,
            budgetFps: Math.round((this._budgetFactor * 100000) / fit.periodMs) / 100,
        });
        this._sent = { periodUs, phaseUs, phaseMs: fit.phaseMs, leadUs };
        this._lastSendAt = t;
        this.sent++;
    }

    /**
     * Whether the link is steady enough to aim through, from the spread of
     * capture → ready and the margin (see the header). Going uneven drops the
     * margin, to be started afresh when aiming comes back.
     */
    _judgeSteady(t, periodMs) {
        if (this._steady) {
            if (this._spreadMs > periodMs * UNSTEADY_ABOVE || this._capped) {
                this._steady = false;
                this.unsteadySpells++;
                this._quietSince = null;
                this._capped = false;
                this._marginMs = null;
            }
            return;
        }
        // Started afresh at every grid while uneven, so that aiming comes
        // back with the margin of the link as it is then.
        this._marginMs = null;
        if (this._spreadMs >= periodMs * STEADY_BELOW) {
            this._quietSince = null;
        } else if (this._quietSince === null) {
            this._quietSince = t;
        } else if (t - this._quietSince >= STEADY_FOR_MS) {
            this._steady = true;
            this._capped = false;
        }
    }

    /** What the grid has been doing, for the bench. */
    get summary() {
        const slack = this._slack.slice().sort((a, b) => a - b);
        const lead = this.leadUs;
        return {
            followed: this.followed,
            aimed: this.aimed,
            tearing: this._tearing() === true,
            steady: this._steady,
            spreadMs: this._spreadMs,
            unsteadySpells: this.unsteadySpells,
            hostPresentMs: this.hostPresentUs ? this.hostPresentUs / 1000 : null,
            periodMs: this._grid ? this._grid.periodMs : null,
            leadMs: lead === null ? null : lead / 1000,
            marginMs: this._marginMs,
            sent: this.sent,
            frames: this.frames,
            misses: this.misses,
            missRate: this.frames ? this.misses / this.frames : null,
            slackMedianMs: slack.length ? percentile(slack, 0.5) : null,
            slackP5Ms: slack.length ? percentile(slack, 0.05) : null,
            clock: this._clock.summary,
        };
    }
}
