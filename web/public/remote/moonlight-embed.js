/*
 * MoonlightWeb — embedded mode for SF Agents.
 * Copyright (C) 2026 SF Agents contributors
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

/**
 * SF Agents shows this computer's screen in a sheet: it serves this frontend
 * through its own address (as an application under /apps/remote/) and opens
 * it in a frame with `?embed=sfagents`. In that mode:
 *
 * - there is no host list: the page goes straight to this PC's virtual
 *   display ("MoonlightWeb Virtual Display") and streams it;
 * - the stream is the frame's own size, in physical pixels, fitted to 16:9
 *   (or 9:16 when the frame is taller than wide), so turning a phone turns
 *   the stream, and resizing the sheet resizes the display;
 * - the device is the one SF Agents knows (`client=`), so each device keeps
 *   its own virtual display, and the host its settings for it (its scaling);
 * - the page tells the frame's parent what it is doing with postMessage
 *   ({source: 'mw-embed', type: 'state', state, message}) and takes
 *   {type: 'reconnect'} and {type: 'stop'} back.
 */

const params = new URLSearchParams(window.location.search);

/** Whether the page runs inside SF Agents. Read once: the app may rewrite the URL. */
export const EMBED = params.get('embed') === 'sfagents' && window.parent !== window;

/** Physical pixels per CSS pixel the stream asks for (a lighter stream when < 1). */
const SCALE = (() => {
    const s = Number(params.get('scale'));
    return s >= 0.25 && s <= 2 ? s : 1;
})();

const CLIENT = /^[A-Za-z0-9_-]{1,64}$/.test(params.get('client') || '') ? params.get('client') : null;

// The device id comes before anything reads it (BackendClient.clientUniqueId).
if (EMBED && CLIENT) {
    try {
        localStorage.setItem('mw_client_uniqueid', 'sfa-' + CLIENT);
    } catch (e) {
        /* storage blocked: the app makes its own */
    }
}
if (EMBED) document.documentElement.classList.add('mw-embed');

// SF Agents serves the page under a prefix (/apps/remote/) and tells its own
// requests from this page's by that address, so the app's own addresses
// ("/", "/settings"…) stay under it, with the embed parameters kept.
if (EMBED) {
    const base = window.location.pathname.replace(/[^/]*$/, '');
    const keep = window.location.search;
    const wrap = (fn) =>
        function (state, title, url) {
            if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(base)) {
                const u = new URL(url, window.location.origin);
                url = base + u.pathname.slice(1) + (u.search || keep) + u.hash;
            }
            return fn.call(this, state, title, url);
        };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
}

/** Largest stream side: 4K. */
const MAX_LONG = 3840;
/** Smallest: 640x360. */
const MIN_LONG = 640;

/**
 * The frame's size in physical pixels, fitted to 16:9 (or 9:16), even in
 * both dimensions. Portrait when the frame is taller than wide.
 * @param {{innerWidth:number, innerHeight:number, devicePixelRatio?:number}} [win]
 * @param {number} [scale]
 * @returns {{width:number, height:number}|null}
 */
export function embedPixelSize(win, scale) {
    const w = win || window;
    const k = (w.devicePixelRatio > 0 ? w.devicePixelRatio : 1) * (scale || SCALE);
    const W = w.innerWidth * k;
    const H = w.innerHeight * k;
    if (!(W > 0) || !(H > 0)) return null;
    const portrait = H > W;
    const long = portrait ? H : W;
    const short = portrait ? W : H;
    // 16:9 in steps of 32x18, so both sides stay even.
    let units = Math.floor(Math.min(long / 32, short / 18));
    units = Math.min(units, Math.floor(MAX_LONG / 32));
    units = Math.max(units, Math.ceil(MIN_LONG / 32));
    const a = units * 32;
    const b = units * 18;
    return portrait ? { width: b, height: a } : { width: a, height: b };
}

function post(type, extra) {
    if (!EMBED) return;
    try {
        window.parent.postMessage({ source: 'mw-embed', type, ...extra }, window.location.origin);
    } catch (e) {
        /* parent gone */
    }
}

/** Tells SF Agents what the page is doing. */
export function embedState(state, message) {
    post('state', { state, message: message || null });
}

const handlers = { reconnect: null, stop: null };

/** The app's answers to the parent's requests. */
export function onEmbedRequest(name, fn) {
    handlers[name] = fn;
}

if (EMBED) {
    window.addEventListener('message', (e) => {
        if (e.source !== window.parent || e.origin !== window.location.origin) return;
        const d = e.data;
        if (!d || d.target !== 'mw-embed') return;
        const fn = handlers[d.type];
        if (fn) fn(d);
    });
}
