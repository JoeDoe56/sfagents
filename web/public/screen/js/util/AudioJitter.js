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
 * The audio jitter buffer, told what to aim for.
 *
 * The host sends one Opus frame every 5 ms and the browser decodes the track
 * itself — its NetEq buffer is the whole of what stands between the two, and
 * nothing here used to say a word about it. Left alone it sizes itself on the
 * arrival jitter it sees, and the overlay's "Audio buffer" read 129 ms on a
 * LAN with no network jitter to speak of: 200 packets a second leave the host
 * in bursts rather than in a steady stream, and NetEq reads a burst exactly as
 * it reads a congested link.
 *
 * From September a target of 60 ms was set on every stream. But libwebrtc
 * applies `jitterBufferTarget` as a MINIMUM delay (NetEq's base minimum): it
 * can raise the buffer, never take it below what NetEq wants, so on a clean
 * link every sound waited for the floor. Measured (plan « le son et la priorité
 * des paquets », A2-A3 L1): Chrome on a Mac −37 ms without it; Bruno's blind
 * listening on Wi-Fi, 11/10, heard the same with and without, and without it
 * NetEq concealed nothing that was not a lost packet. Since then the default is
 * no floor at all: NetEq sizes itself.
 *
 * The bench key `mw_audio_target` in localStorage still sets one (a whole
 * number of ms, 60 for the old default), or `off` none.
 *
 * Chrome 124 and later, Firefox 115 and later and Safari 27 have the property
 * (MDN); a browser without it is a no-op here rather than a fallback.
 *
 * Only the stream's sound: the audio road's tracks (`vaudio`, `uaudio`, POC
 * Ultra U1.4 ter) are audio tracks that carry video, and their receivers are
 * kept at 0 by RtpVideo.
 */

/** What the audio buffer aims for by default: nothing, NetEq sizes itself. */
export const AUDIO_JITTER_TARGET_MS = null;

/** The bench key: a floor in ms (0-4000), or `off` to leave NetEq alone. */
export const AUDIO_TARGET_KEY = 'mw_audio_target';

/** The audio road's transceivers, which are not the stream's sound. */
const AUDIO_ROAD_MID = /^[vu]audio$/;

/**
 * The floor the bench asks for, read once per stream: the default (none) without
 * the key, `null` for `off` (no target at all), or a whole number of ms.
 *
 * @param {{getItem: (k: string) => string|null}} [storage]
 * @returns {number|null}
 */
export function audioJitterTargetMs(storage) {
    let raw = null;
    try {
        const s = storage || globalThis.localStorage;
        raw = s ? s.getItem(AUDIO_TARGET_KEY) : null;
    } catch {
        raw = null;
    }
    if (raw === null || raw === undefined || String(raw).trim() === '')
        return AUDIO_JITTER_TARGET_MS;
    const v = String(raw).trim().toLowerCase();
    if (v === 'off') return null;
    const ms = Number(v);
    if (!Number.isFinite(ms) || ms < 0 || ms > 4000) return AUDIO_JITTER_TARGET_MS;
    return Math.floor(ms);
}

/** Whether this browser's receivers take `jitterBufferTarget` at all. */
export function jitterBufferTargetSupported() {
    return (
        typeof RTCRtpReceiver !== 'undefined' &&
        !!RTCRtpReceiver.prototype &&
        'jitterBufferTarget' in RTCRtpReceiver.prototype
    );
}

/**
 * The receivers of the stream's sound: every audio receiver but the audio
 * road's, told apart by their transceiver's mid.
 *
 * @param {RTCPeerConnection} pc
 * @returns {RTCRtpReceiver[]}
 */
export function streamAudioReceivers(pc) {
    if (!pc || typeof pc.getReceivers !== 'function') return [];
    const roads = new Set();
    if (typeof pc.getTransceivers === 'function') {
        for (const t of pc.getTransceivers()) {
            if (t && t.receiver && AUDIO_ROAD_MID.test(t.mid || '')) roads.add(t.receiver);
        }
    }
    return pc
        .getReceivers()
        .filter((r) => r && r.track && r.track.kind === 'audio' && !roads.has(r));
}

/**
 * Aim the stream's audio receiver of @p pc at @p ms milliseconds.
 *
 * @param {RTCPeerConnection} pc
 * @param {number|null} [ms] target in milliseconds; the default is the bench
 *        key's, or none; `null` touches nothing
 * @returns {number} how many receivers took it (0 on a browser without the
 *          property, or with no target, which is not a failure)
 */
export function setAudioJitterBufferTarget(pc, ms = audioJitterTargetMs()) {
    if (!pc || typeof pc.getReceivers !== 'function') return 0;
    if (ms === null) return 0;
    const targetMs = Math.max(0, ms | 0);
    console.info(
        '[Audio] jitter buffer target ' + targetMs + ' ms (bench key ' + AUDIO_TARGET_KEY + ')',
    );
    let applied = 0;
    try {
        for (const receiver of streamAudioReceivers(pc)) {
            if (receiver.jitterBufferTarget === undefined) continue;
            receiver.jitterBufferTarget = targetMs;
            applied++;
        }
    } catch (e) {
        console.warn('[Audio] jitter buffer target refused:', e.message);
    }
    return applied;
}
