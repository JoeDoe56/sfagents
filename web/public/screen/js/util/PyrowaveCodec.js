/**
 * PyrowaveCodec — « PyroWave (Wired LAN only) », a codec of the Settings menu.
 *
 * PyroWave is the intra-only wavelet codec of POC Ultra
 * (docs/design/ultra-lan-poc.md §6.43): every frame whole, about 130 Mbit/s at
 * 120 fps, for a device on Ethernet. The page decodes it itself
 * (stream/ultra/UltraPlayer.js, WebGPU or WebGL2), and its frames ride the
 * DataChannel. It is chosen in this browser, never for the others, and the
 * choice is kept like H.264's or AV1's.
 *
 * It streams only when everything below holds; otherwise the launch asks
 * Auto (PYROWAVE_FALLBACK), without a word, and the choice stays for the next
 * host that can:
 *   - the host codes it: a native Windows host on the D3D12 route, which says
 *     so on its card (nativeDisplay.pyrowave) — never Linux, macOS, Sunshine,
 *     Wolf, Apollo or MultiSeat;
 *   - this browser decodes it (ultraPlayerSupported);
 *   - no HDR asked from the HDR box: PyroWave is 8-bit SDR;
 *   - the transport carries it: never the <video> of webrtc-media;
 *   - not a fallback relaunch: a codec forced after a failed decode wins.
 * Auto never picks it, and a guest never gets it.
 */
import { ultraPlayerSupported } from '../stream/ultra/UltraPlayer.js';

export const CODEC_PYROWAVE = 'pyrowave';

/** Whether this host codes PyroWave, as its card says. */
export function hostCodesPyrowave(host) {
    return host?.backendType === 'native' && host?.nativeDisplay?.pyrowave === true;
}

/** Whether a host list (GET /api/hosts' `hosts`) holds one that codes it. */
export function anyHostCodesPyrowave(hosts) {
    return Array.isArray(hosts) && hosts.some(hostCodesPyrowave);
}

/**
 * Why the Settings menu cannot offer PyroWave here, or null when it can.
 * The first that applies, in the order the hint explains them:
 * 'transport' (webrtc-media is forced), 'browser', 'hdr', 'host'.
 *
 * @param {{hostCodes: boolean|null, browserDecodes?: boolean, hdr?: boolean,
 *          mediaTrackOnly?: boolean}} state  hostCodes null: not known yet
 *          (the host list has not answered), which blocks nothing.
 */
export function pyrowaveBlocker({
    hostCodes,
    browserDecodes = ultraPlayerSupported(),
    hdr = false,
    mediaTrackOnly = false,
}) {
    if (mediaTrackOnly) return 'transport';
    if (!browserDecodes) return 'browser';
    if (hdr) return 'hdr';
    if (hostCodes === false) return 'host';
    return null;
}

/**
 * The codec a PyroWave choice falls back to: HEVC, the menu's default and what
 * the server's Auto negotiates first (StreamConfig: HEVC, then H.264). The
 * decode-error chain takes a browser without HEVC on to H.264, as for anyone
 * who kept the default.
 */
export const PYROWAVE_FALLBACK = 'hevc';

/**
 * The launch's codec when this browser chose PyroWave: `video_codec` becomes
 * the fallback — what the host streams whenever PyroWave cannot run, and the
 * codec it negotiates beside it — and `ultra_codec` asks PyroWave only when
 * this host and this browser can (4:4:4 then dropped: PyroWave codes 4:2:0).
 * Any other choice passes through untouched. Mutates and returns @p settings
 * (the launch's own copy).
 *
 * @param {object} settings  the launch's streaming settings
 * @param {object} host  the host model (models/Host.js)
 * @param {{codecOverride?: string, hdrOverride?: boolean}} [opts]
 */
export function applyPyrowaveChoice(settings, host, opts = {}) {
    delete settings.ultra_codec;
    if (settings.video_codec !== CODEC_PYROWAVE) return settings;
    settings.video_codec = PYROWAVE_FALLBACK;
    const usable =
        !opts.codecOverride &&
        opts.hdrOverride !== true &&
        settings.hdr_enabled !== true &&
        settings.power_save !== true &&
        hostCodesPyrowave(host) &&
        ultraPlayerSupported();
    if (usable) {
        settings.ultra_codec = CODEC_PYROWAVE;
        settings.chroma_444_enabled = false;
    }
    console.log(
        '[MW] PyroWave ' +
            (usable ? 'asked (wired LAN)' : 'chosen but not usable here — the stream asks Auto'),
    );
    return settings;
}
