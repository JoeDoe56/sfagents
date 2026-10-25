/**
 * The stream's current bitrate, from a cumulative byte counter.
 *
 * The stats card used to divide every byte since the stream began by the time
 * since then: after the quality ladder stepped down, the figure took minutes
 * to follow, and a short burst early on stayed in it for the whole session.
 * This keeps a few (time, total) points over a short window and reads the rate
 * between the oldest and the newest — what the link carries now, on the same
 * 2 s window as the framerate next to it.
 */
export class ByteRate {
    /** @param {number} [windowMs] */
    constructor(windowMs = 2000) {
        this._windowMs = windowMs;
        /** @type {Array<{t: number, bytes: number}>} */
        this._points = [];
    }

    /**
     * Record the cumulative byte count at a time (ms, any monotonic clock).
     * @param {number} now
     * @param {number} totalBytes
     */
    sample(now, totalBytes) {
        const pts = this._points;
        // A counter that went back (a new stream reusing the view) starts over.
        if (pts.length > 0 && totalBytes < pts[pts.length - 1].bytes) pts.length = 0;
        pts.push({ t: now, bytes: totalBytes });
        // Keep one point at or before the window's start, so the rate always
        // spans the whole window once there is enough history.
        const start = now - this._windowMs;
        let drop = 0;
        while (drop + 1 < pts.length && pts[drop + 1].t <= start) drop++;
        if (drop > 0) pts.splice(0, drop);
    }

    /**
     * Megabits per second over the window, or 0 before two points 0.5 s apart.
     * @returns {number}
     */
    mbps() {
        const pts = this._points;
        if (pts.length < 2) return 0;
        const a = pts[0];
        const b = pts[pts.length - 1];
        const dt = b.t - a.t;
        if (dt < 500) return 0;
        return ((b.bytes - a.bytes) * 8) / (dt / 1000) / 1e6;
    }

    reset() {
        this._points.length = 0;
    }
}
