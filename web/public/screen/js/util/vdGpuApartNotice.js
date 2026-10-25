/*
 * MoonlightWeb — the virtual display drawn by another GPU than the apps.
 * Copyright (C) 2026 Bruno Martin. GPLv3 — see repository LICENSE.
 */

/**
 * "MoonlightWeb Virtual Display" takes the primary role when it comes on, and
 * an app picks its GPU from the primary display when it starts. An app opened
 * before the stream therefore stays on the GPU of the display it was opened
 * on, and when the virtual display is drawn by another one, every picture that
 * app paints crosses from one GPU to the other. Seen 04/10/2026 on the
 * UM790Pro: Steam on the Radeon 780M, the virtual display on a GTX 1050, the
 * host's encode at 130 ms per frame while the pointer hovered Steam's cards —
 * and 5 ms once Steam was restarted. The host says when the two GPUs differ
 * (`vd_gpu_apart` in the launch result); this says it to the user, once per
 * host and pair of GPUs — and only once the stream shows it: the host's
 * encode stage stuck far above its usual few milliseconds (vdGpuApartWatch).
 * Two GPUs apart cost nothing until such an app repaints a large area, and a
 * warning at every launch would be a warning about nothing.
 */

const SEEN_KEY = 'mw_vd_gpu_apart_seen';
const SEEN_MAX = 20;

/**
 * The notice to show for this launch result, or null: none when the GPUs are
 * the same, or when this browser was already told about this host's pair.
 * Marks it as told.
 *
 * @param {{vd_gpu_apart?: {display?: string, apps?: string}}} result
 * @param {string} hostUuid
 * @returns {{display: string, apps: string} | null}
 */
export function takeVdGpuApartNotice(result, hostUuid) {
    const apart = result?.vd_gpu_apart;
    if (!apart || typeof apart.display !== 'string' || typeof apart.apps !== 'string') {
        return null;
    }
    if (!apart.display || !apart.apps) return null;
    const id = `${hostUuid}|${apart.display}|${apart.apps}`;
    let seen = [];
    try {
        const stored = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
        if (Array.isArray(stored)) seen = stored;
    } catch {
        /* storage unavailable or corrupt: tell the user, it costs one toast */
    }
    if (seen.includes(id)) return null;
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, id].slice(-SEEN_MAX)));
    } catch {
        /* told now, maybe again next time */
    }
    return { display: apart.display, apps: apart.apps };
}

/**
 * The host's encode stage, mean over its one-second window, above which the
 * stream is in the state this notice is about. 3 to 13 ms normally, on the
 * GTX 1050 of the UM790Pro included; 110 to 160 ms through the whole hover.
 */
const ENCODE_STALLED_US = 50_000;

/** Consecutive one-second windows above it: a single slow frame is not it. */
const STALLED_WINDOWS = 2;

/**
 * Watches the native host's stage stats for the sign of an app on the other
 * GPU: the encode stage waiting behind the copies between them. `note()`
 * returns true once, the first time the encode stage has stayed above the
 * threshold for STALLED_WINDOWS windows in a row; never again after that.
 */
export class VdGpuApartWatch {
    constructor() {
        this._run = 0;
        this._fired = false;
    }

    /**
     * @param {Record<string, {n?: number, avg?: number}>|null|undefined} stages
     *   the `stages` of one host stats message (µs)
     * @returns {boolean} true the one time the stall is confirmed
     */
    note(stages) {
        if (this._fired) return false;
        const encode = stages?.encode;
        if (!encode || !(encode.n > 0)) return false;
        this._run = encode.avg > ENCODE_STALLED_US ? this._run + 1 : 0;
        if (this._run < STALLED_WINDOWS) return false;
        this._fired = true;
        return true;
    }
}
