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
 * The stream's own volume (issue #29): the level set on the header's volume
 * control, and whether it is muted.
 *
 * The two are kept differently on purpose. The level is a preference — the
 * stream turned down under a video playing next to it — so it is remembered in
 * this browser. The mute is a gesture for right now, and it lives only as long
 * as the page: a session that opens silent a day later, with nothing on screen
 * saying why until the header is looked at, would read as broken audio.
 *
 * Module state rather than view state: a quality or transport switch replaces
 * the StreamView mid-session, and the new one must come up at the same level.
 */

const LEVEL_KEY = 'mw_stream_volume';

let muted = false;
/** @type {number|null} read from storage on first use */
let level = null;

/** @param {number} v */
const clamp = (v) => Math.max(0, Math.min(1, v));

/** The remembered level, 0..1 (1 when never set). */
export function getLevel() {
    if (level === null) {
        level = 1;
        try {
            const v = parseFloat(localStorage.getItem(LEVEL_KEY) ?? '');
            if (Number.isFinite(v)) level = clamp(v);
        } catch {
            /* no storage: full level */
        }
    }
    return level;
}

/** @param {number} v 0..1 */
export function setLevel(v) {
    level = clamp(Number(v) || 0);
    try {
        localStorage.setItem(LEVEL_KEY, String(level));
    } catch {
        /* no storage: the level still holds for this page */
    }
}

export function isMuted() {
    return muted;
}

/** @param {boolean} m */
export function setMuted(m) {
    muted = m === true;
}

/** What actually reaches the speakers, 0..1. */
export function outputLevel() {
    return muted ? 0 : getLevel();
}
