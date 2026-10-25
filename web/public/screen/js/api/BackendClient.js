/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 * Trimmed for SF Agents' screen mirroring, 2026 SF Agents contributors.
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
 * The stream's calls to SF Agents' server (web/src/server.ts, /api/screen/*).
 * MoonlightWeb's own client, cut to what a stream of this computer asks: start,
 * quit, how a stream ended. There is one host, this computer, so the host id
 * the stream code passes is ignored. SF Agents' sign-in cookie goes with every
 * request (same origin); there is no admin key, pairing or sharing.
 */

import { t } from '../i18n/i18n.js';
import {
    CANVAS_TEARING_IS_REAL,
    decoderRidesOutGaps,
    decoderTakesReferenceRepairs,
    resolveTearing,
} from '../util/BrowserDetect.js';
import { currentRefreshMilliHz } from '../util/RefreshRate.js';
import { canCropFrames } from '../stream/FrameCrop.js';
import { STREAM_STATE_TIMEOUT_MS } from '../stream/CrashRelaunch.js';

/** Ride out a gap with intra-refresh instead of asking for a keyframe (see MoonlightWeb's BackendClient). */
const RIDE_OUT_LOSS = true;

const BASE = '/api/screen';

/**
 * @typedef {Error & {
 *   statusCode?: number,
 *   responseBody?: any,
 *   aborted?: boolean,
 * }} BackendError
 */

export class BackendClient {
    /** SF Agents has no booth mode: whoever is signed in owns the computer. */
    static adminLocked = false;

    static async _handleError(resp) {
        let msg = '';
        let body = null;
        try {
            body = await resp.json();
            msg = body.message || body.error || '';
        } catch (_) {
            /* not JSON */
        }
        // Signed out elsewhere: SF Agents' own page takes the device back to sign-in.
        if (resp.status === 401 && body && body.signIn) {
            try {
                window.parent.postMessage({ source: 'mw-embed', type: 'signIn' }, window.location.origin);
            } catch (_) {
                /* parent gone */
            }
        }
        const error = /** @type {BackendError} */ (new Error(msg || `Request failed (${resp.status})`));
        error.statusCode = resp.status;
        error.responseBody = body;
        throw error;
    }

    static async _json(resp) {
        try {
            return await resp.json();
        } catch (_) {
            const e = /** @type {BackendError} */ (new Error(t('appError.serverUnreadable')));
            e.statusCode = resp.status;
            throw e;
        }
    }

    static async get(path) {
        const resp = await fetch(BASE + path, { cache: 'no-store' });
        if (!resp.ok) return this._handleError(resp);
        return this._json(resp);
    }

    static async post(path, body = {}, { timeoutMs = 0 } = {}) {
        const controller = timeoutMs > 0 ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const resp = await fetch(BASE + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller ? controller.signal : undefined,
            });
            if (!resp.ok) return this._handleError(resp);
            return this._json(resp);
        } catch (err) {
            if (err && err.name === 'AbortError') {
                const e = /** @type {BackendError} */ (new Error('server_timeout'));
                e.statusCode = 0;
                e.aborted = true;
                throw e;
            }
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** This computer and what it can stream (sfagents-screen --info). */
    static async getHost() {
        return this.get('/host');
    }

    /** A per-browser id, 16 hex characters, kept in localStorage. */
    static clientUniqueId() {
        let id = null;
        try {
            id = localStorage.getItem('mw_client_uniqueid');
        } catch (_) {
            /* storage blocked */
        }
        if (!id || !/^[0-9A-F]{16}$/.test(id)) {
            const bytes = new Uint8Array(8);
            crypto.getRandomValues(bytes);
            id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase();
            try {
                localStorage.setItem('mw_client_uniqueid', id);
            } catch (_) {
                /* storage blocked: a new id each load */
            }
        }
        return id;
    }

    /** Slot 1 of a dual stream (never offered here: one stream at a time). */
    static clientUniqueIdForSlot(slot) {
        const id = this.clientUniqueId();
        if (!slot) return id;
        const last = parseInt(id.slice(14, 16), 16) ^ 0xff;
        return id.slice(0, 14) + last.toString(16).padStart(2, '0').toUpperCase();
    }

    static async launchApp(_hostId, appId, streamingSettings = {}) {
        return this.post(
            '/start',
            {
                appId,
                client_uniqueid: this.clientUniqueId(),
                ride_out_loss: RIDE_OUT_LOSS && decoderRidesOutGaps(),
                ref_invalidation: decoderTakesReferenceRepairs(),
                crops_to_frame: canCropFrames(),
                client_refresh_mhz: currentRefreshMilliHz(),
                client_vsync: !resolveTearing(streamingSettings),
                client_tearing_real: CANVAS_TEARING_IS_REAL,
                ...streamingSettings,
            },
            { timeoutMs: 60000 },
        );
    }

    /** How the stream ended: "crashed", "live", "ended", "stopped" or "unknown". */
    static async streamState(_hostId, streamId) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STREAM_STATE_TIMEOUT_MS);
        try {
            const resp = await fetch(`${BASE}/stream-state?stream=${encodeURIComponent(streamId)}`, {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!resp.ok) return 'unknown';
            const body = await resp.json();
            return typeof body.state === 'string' ? body.state : 'unknown';
        } catch (_) {
            return 'unknown';
        } finally {
            clearTimeout(timer);
        }
    }

    static async quitApp(_hostId, extra = {}) {
        return this.post('/quit', { client_uniqueid: this.clientUniqueId(), ...extra }, { timeoutMs: 5000 });
    }

    static async getRunningApp() {
        return { currentGameId: 0 };
    }

    static async stopHostSession() {
        return this.post('/stop-session', { client_uniqueid: this.clientUniqueId() }, { timeoutMs: 10000 });
    }

    /** No MultiSeat: one desktop. */
    static async getHostSeats() {
        return { seats: [] };
    }

    // Asked by help panels for hosts SF Agents never streams (Sunshine, macOS
    // capture rights): refused, so the panel says it could not.
    static async openScreenRecordingSettings() {
        throw new Error('unsupported');
    }
    static async stopSunshine() {
        throw new Error('unsupported');
    }
    static async startSunshine() {
        throw new Error('unsupported');
    }
    static async playerLeave() {
        return { ok: true };
    }
}
