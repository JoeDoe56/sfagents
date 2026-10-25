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
 * This client's clock against the host's, from ping/pong: the pong carries the
 * host's steady clock at the moment it answered. Each exchange gives the
 * offset at the middle of its round trip, give or take half of it — so only
 * the exchanges near the shortest round trip are believed, and a line through
 * them over time follows a drift between the two clocks.
 *
 * What no two-way exchange can see is a link slower one way than the other:
 * the offset is then wrong by half the difference, and every age with it.
 *
 * Two users: the content-age probe (stream/ContentAgeProbe.js), which puts
 * its draws on the host's clock, and the vsync grid (stream/VsyncGrid.js),
 * which puts this screen's refreshes there for the host to aim at.
 */
export class ClockEstimator {
    /** @param {{windowMs?: number}} [opts] how much history the fit keeps */
    constructor({ windowMs = 30000 } = {}) {
        this._windowMs = windowMs;
        /** @type {{mid: number, off: number, rtt: number}[]} */
        this._samples = [];
        this._a = 0; // offset (µs) at _t0
        this._b = 0; // drift, µs of offset per ms
        this._t0 = 0;
        this._fitted = false;
        this._streak = 0;
        this.jumps = 0;
        this.rejected = 0;
    }

    /**
     * One exchange: sent at @p sendMs, answered with the host's @p hostUs,
     * back at @p recvMs (this client's performance.now()).
     * @returns {boolean} whether the sample was kept
     */
    note(sendMs, hostUs, recvMs) {
        const rtt = recvMs - sendMs;
        if (!(rtt >= 0 && rtt < 2000) || !(hostUs > 0)) return false;
        const mid = (sendMs + recvMs) / 2;
        const off = hostUs - mid * 1000;
        if (this._fitted) {
            // A sample far off the line: noise once, a clock that jumped when
            // it keeps happening — the history is then of another clock.
            const err = off - this._offsetAt(mid);
            if (Math.abs(err) > Math.max(2000, rtt * 1000)) {
                if (++this._streak < 3) {
                    this.rejected++;
                    return false;
                }
                this.jumps++;
                this._samples = [];
                this._fitted = false;
            }
            this._streak = 0;
        }
        this._samples.push({ mid, off, rtt });
        while (this._samples.length && this._samples[0].mid < mid - this._windowMs)
            this._samples.shift();
        this._refit();
        return true;
    }

    _offsetAt(ms) {
        return this._a + this._b * (ms - this._t0);
    }

    _refit() {
        const all = this._samples;
        if (!all.length) return;
        let minRtt = Infinity;
        for (const s of all) minRtt = Math.min(minRtt, s.rtt);
        // Near the best round trip: within 0.3 ms or a quarter of it.
        const good = all.filter((s) => s.rtt <= minRtt + Math.max(0.3, minRtt * 0.25));
        const t0 = good[0].mid;
        const span = good[good.length - 1].mid - t0;
        let a = 0;
        let b = 0;
        if (good.length >= 3 && span >= 5000) {
            let sx = 0;
            let sy = 0;
            let sxx = 0;
            let sxy = 0;
            for (const s of good) {
                const x = s.mid - t0;
                sx += x;
                sy += s.off;
                sxx += x * x;
                sxy += x * s.off;
            }
            const n = good.length;
            b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
            a = (sy - b * sx) / n;
        } else {
            for (const s of good) a += s.off;
            a /= good.length;
        }
        this._a = a;
        this._b = b;
        this._t0 = t0;
        this._fitted = true;
    }

    /** True once enough exchanges have been heard to put a time on the host's clock. */
    get ready() {
        return this._fitted && this._samples.length >= 3;
    }

    /** The host's steady clock, in µs, at this client's @p clientMs. */
    toHostUs(clientMs) {
        return clientMs * 1000 + this._offsetAt(clientMs);
    }

    /**
     * This client's clock, in ms, at the host's @p hostUs — toHostUs the other
     * way. The offset moves by the drift alone, a few µs a second, so one step
     * from a first guess lands within a nanosecond.
     */
    toClientMs(hostUs) {
        const guess = (hostUs - this._a) / 1000;
        return (hostUs - this._offsetAt(guess)) / 1000;
    }

    /** What the estimate stands on, for the results. */
    get summary() {
        let minRtt = Infinity;
        for (const s of this._samples) minRtt = Math.min(minRtt, s.rtt);
        return {
            samples: this._samples.length,
            rttMinMs: Number.isFinite(minRtt) ? minRtt : null,
            driftPpm: this._b * 1000,
            jumps: this.jumps,
            rejected: this.rejected,
        };
    }
}
