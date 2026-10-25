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
 * RendererFallback — moves the plain picture between Canvas2D and WebGL2 when
 * the renderer it is on costs the main thread more than a frame can spare.
 *
 * The two renderers copy a VideoFrame in different ways, and which one is
 * cheap depends on the browser and the GPU, not on the stream. Measured on
 * 12/10/2026: Firefox on an N95 spent 38-55 ms per frame in a 2D
 * drawImage(VideoFrame) and 2-4 ms in a WebGL2 texImage2D, while Chrome on the
 * same machine drew in 0.5 ms on Canvas2D. A draw that does not fit between
 * two frames starves the decoder, its queue overflows, and every keyframe asked
 * for to clear it overflows again. createVideoRenderer routes the one case
 * known in advance (geckoPresentsOnPlainWebGl); this catches the ones that are
 * not.
 *
 * The signal is the draw's own synchronous work (VideoRenderer.lastDraw
 * submitMs, averaged over PipelineDiag's 2 s window), against the interval
 * between arriving frames. Not the wait on the GPU or the compositor, and not
 * the decode queue alone: a throttled display or a slow decoder piles frames up
 * just the same, and another renderer would not change either.
 *
 * A switch is a trial. Once the new renderer has drawn long enough to be
 * measured on its own, it stays if it costs at most half of what the old one
 * did, and the verdict is remembered on this device for the next session.
 * Otherwise the picture goes back, and nothing more is tried this session.
 */

/** The renderer's synchronous work above this share of the frame interval. */
const SWITCH_RATIO = 0.6;
/** …for this long: a single busy window (a keyframe, a resize) is not a trend. */
const SUSTAIN_MS = 2000;
/**
 * After a switch, wait this long before judging: the 2 s window still holds
 * the old renderer's draws, and the new one's first draws pay for its setup.
 */
const SETTLE_MS = 3000;
/** The new renderer must cost at most this share of the old one to stay. */
const KEEP_RATIO = 0.5;

/** Arrival intervals outside this range are not a usable frame budget. */
const MIN_BUDGET_MS = 1;
const MAX_BUDGET_MS = 200;

const MEMORY_KEY = 'mw_plain_renderer';

/** @param {'canvas2d'|'webgl'} kind */
export function otherPlainRenderer(kind) {
    return kind === 'webgl' ? 'canvas2d' : 'webgl';
}

/**
 * The renderer a previous session settled the plain picture on, in this same
 * browser version — null when there is none. A browser update may have fixed
 * what made the other renderer slow, so a verdict made under another user
 * agent is not taken.
 * @param {string} [ua]
 * @returns {'canvas2d'|'webgl'|null}
 */
export function rememberedPlainRenderer(ua = navigator.userAgent) {
    try {
        const e = JSON.parse(localStorage.getItem(MEMORY_KEY) || 'null');
        if (!e || e.ua !== ua) return null;
        return e.kind === 'webgl' || e.kind === 'canvas2d' ? e.kind : null;
    } catch (e) {
        return null;
    }
}

/**
 * @param {'canvas2d'|'webgl'} kind
 * @param {string} [ua]
 */
export function rememberPlainRenderer(kind, ua = navigator.userAgent) {
    try {
        localStorage.setItem(MEMORY_KEY, JSON.stringify({ kind, ua }));
    } catch (e) {}
}

export class RendererFallback {
    /** @param {'canvas2d'|'webgl'} kind the renderer the picture starts on */
    constructor(kind) {
        this._kind = kind;
        /** 'watch' → 'trial' → 'done'; 'done' is for the rest of the session. */
        this._state = 'watch';
        this._overSince = 0;
        this._settleUntil = 0;
        /** What the renderer left behind cost, ms per frame. */
        this._beforeMs = 0;
    }

    /** The renderer the picture is on, or being moved to. */
    get kind() {
        return this._kind;
    }

    /**
     * Feed one observation window.
     * @param {{submitMs: number, arrivalMs: number, now: number}} obs
     *   submitMs  the draw's synchronous work, ms (PipelineDiag renderSubmitMs)
     *   arrivalMs average interval between incoming frames = the frame budget
     *   now       performance.now(), passed in so the policy stays pure
     * @returns {{action: 'switch'|'keep'|'revert', kind: string, fromMs: number,
     *            toMs?: number, budgetMs: number}|null}
     *   switch — move to `kind` and measure it; keep — the trial paid off,
     *   remember `kind`; revert — it did not, move back to `kind`.
     */
    update(obs) {
        if (this._state === 'done') return null;
        const budget = obs && obs.arrivalMs;
        const cost = obs && obs.submitMs;
        const now = (obs && obs.now) || 0;
        if (!(budget >= MIN_BUDGET_MS) || budget > MAX_BUDGET_MS || !(cost > 0)) {
            this._overSince = 0;
            return null;
        }

        if (this._state === 'trial') {
            if (now < this._settleUntil) return null;
            this._state = 'done';
            if (cost <= this._beforeMs * KEEP_RATIO) {
                return {
                    action: 'keep',
                    kind: this._kind,
                    fromMs: this._beforeMs,
                    toMs: cost,
                    budgetMs: budget,
                };
            }
            this._kind = otherPlainRenderer(this._kind);
            return {
                action: 'revert',
                kind: this._kind,
                fromMs: this._beforeMs,
                toMs: cost,
                budgetMs: budget,
            };
        }

        if (cost <= budget * SWITCH_RATIO) {
            this._overSince = 0;
            return null;
        }
        if (this._overSince === 0) this._overSince = now;
        if (now - this._overSince < SUSTAIN_MS) return null;
        this._overSince = 0;
        this._state = 'trial';
        this._beforeMs = cost;
        this._settleUntil = now + SETTLE_MS;
        this._kind = otherPlainRenderer(this._kind);
        return { action: 'switch', kind: this._kind, fromMs: cost, budgetMs: budget };
    }

    /**
     * The switch could not be made (this browser refused the other renderer):
     * the picture stays where it was, and nothing more is tried.
     */
    abandon() {
        if (this._state === 'trial') this._kind = otherPlainRenderer(this._kind);
        this._state = 'done';
    }
}
