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
 * RemoteNav — getting around the pages with a TV remote.
 *
 * ── What a TV browser hands the page ────────────────────────────────────────
 *
 * Measured 01/10/2026 on a Mi TV (IR remote) and a Freebox Player POP
 * (Bluetooth remote "B16C"), both on the Android System WebView 153:
 *
 * - TV Bro and TCL Browser start with a virtual cursor: the arrows move it,
 *   OK clicks under it, and the page sees mouse events only. Nothing to do
 *   for that case beyond big enough targets.
 * - TV Bro's "Direct navigation" mode hides the cursor and passes the keys:
 *   ArrowUp…ArrowRight with their code, OK as Enter with an EMPTY code. The
 *   WebView then moves the focus itself (Chromium's spatial navigation is on
 *   where there is no touchscreen) and clicks the focused element on Enter.
 * - Back never reaches the page, in either browser: it opens the browser's
 *   own menu, or leaves the direct mode. So nothing here waits for it.
 * - The Freebox remote is classed a joystick by Android (it has a volume
 *   axis). As soon as the page reads navigator.getGamepads() — any stream
 *   does — Chromium hands its arrows to the Gamepad API (buttons 12-15)
 *   instead of the keyboard, for the rest of the page's life. The WebView's
 *   own navigation never sees them then.
 *
 * ── What this module does ───────────────────────────────────────────────────
 *
 * On a TV only (IS_TV, or `localStorage.mw_remote_nav = 'on'` to try it on a
 * desktop; `'off'` turns it off everywhere), it takes the arrows over:
 *
 * - its own spatial move, for the keys and for the pads' direction pad alike,
 *   so the arrows behave the same whichever way they arrive — and so a
 *   controller paired to the TV gets around the pages too (A clicks, B is
 *   Escape). The browser's move is cancelled (preventDefault), or each press
 *   would move twice.
 * - a scope: with a dialog or a menu open, the arrows stay inside it, and its
 *   main action gets the focus when it opens; when it closes the focus goes
 *   back where it was.
 * - a memory: the host list is rebuilt every few seconds, the settings page
 *   on every change, and a rebuilt element loses the focus to <body>. The
 *   focused element's key (navKey) is noted and the focus put back on the
 *   element that has it after the rebuild.
 *
 * During a stream the keys belong to the host (StreamView) and the pads to
 * GamepadManager; RemoteNav only acts there inside a layer — the stream's
 * own menu (StreamRemoteMenu) — and nothing of it runs per video frame.
 */

import { IS_TV } from '../util/BrowserDetect.js';

/** Everything that opens over a page and owns the arrows while it is up. */
export const LAYER_SELECTOR = [
    '.pairing-overlay',
    '.share-popin-overlay',
    '.share-board-overlay',
    '.gamepad-remap-overlay',
    '.stream-remote-menu',
    '.mw-confirm-overlay',
    '.host-menu:not([hidden])',
    '.instance-panel:not([hidden])',
].join(', ');

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
].join(', ');

const KEY_DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Standard-mapping buttons: the direction pad, then A and B. */
const PAD_DIRS = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
const PAD_A = 0;
const PAD_B = 1;

/** A pad is read this often outside a stream: enough to feel immediate. */
const PAD_POLL_MS = 50;
/** A direction held this long starts repeating, then every PAD_REPEAT_MS. */
const PAD_REPEAT_DELAY_MS = 420;
const PAD_REPEAT_MS = 140;

const state = {
    /** @type {boolean|null} null = decided from IS_TV and the override */
    forced: null,
    started: false,
    /** view key → navKey of the element focused last in it */
    memory: new Map(),
    /** the layer the focus was moved into, and who had it before */
    layer: /** @type {Element|null} */ (null),
    opener: /** @type {string|null} */ (null),
    observer: /** @type {MutationObserver|null} */ (null),
    bodyObserver: /** @type {MutationObserver|null} */ (null),
    headerObserver: /** @type {ResizeObserver|null} */ (null),
    restoreQueued: false,
    pollTimer: /** @type {ReturnType<typeof setInterval>|null} */ (null),
    /** pad index → { pressed: Set<number>, heldDir, nextRepeatAt } */
    pads: new Map(),
    /** a colour key ("back") is down: its repeats do nothing (backKeyFresh) */
    backHeld: false,
    log: /** @type {string[]} */ ([]),
};

function override() {
    try {
        return localStorage.getItem('mw_remote_nav');
    } catch (e) {
        return null;
    }
}

/** True when the remote navigation is on for this page. */
export function isActive() {
    if (state.forced !== null) return state.forced;
    const o = override();
    if (o === 'off') return false;
    return IS_TV || o === 'on';
}

function note(line) {
    state.log.push(Math.round(performance.now()) + ' ' + line);
    if (state.log.length > 100) state.log.shift();
}

function streaming() {
    return document.body.classList.contains('streaming-active');
}

function inHiddenTree(el) {
    return !!el.closest('[hidden], [inert], [aria-hidden="true"]');
}

/** On screen and not hidden away: zero-sized boxes are display:none. */
function isShown(el) {
    if (inHiddenTree(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
}

/** The dialog or menu on top, or null. */
export function topLayer() {
    const all = document.querySelectorAll(LAYER_SELECTOR);
    for (let i = all.length - 1; i >= 0; i--) {
        if (isShown(all[i])) return all[i];
    }
    return null;
}

/** The element the arrows move within: the top layer, else the page. */
function scopeRoot() {
    const layer = topLayer();
    if (layer) return layer;
    return streaming() ? null : document.body;
}

/** Focusable elements of a scope, layers excluded when the scope is the page. */
function candidates(root) {
    const out = [];
    for (const el of root.querySelectorAll(FOCUSABLE)) {
        if (!isShown(el)) continue;
        if (root === document.body && el.closest(LAYER_SELECTOR)) continue;
        out.push(el);
    }
    return out;
}

/**
 * A key that names an element across a rebuild: its own data-nav-key or id,
 * else the data attributes of its ancestors up to the nearest id. An app card
 * is "div.app-card|data-app-id=7|data-uuid=…" whatever replaced it in between.
 * @param {Element|null} el
 * @returns {string|null}
 */
export function navKey(el) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    const own = el.getAttribute('data-nav-key');
    if (own) return own;
    if (el.id) return '#' + el.id;
    const parts = [el.tagName.toLowerCase() + '.' + (el.classList[0] || '')];
    let n = /** @type {Element|null} */ (el);
    for (let depth = 0; n && n !== document.body && depth < 8; depth++) {
        for (const a of ['data-app-id', 'data-uuid', 'data-key', 'data-sort', 'data-id']) {
            const v = n.getAttribute(a);
            if (v) parts.push(a + '=' + v);
        }
        if (n !== el && n.id) {
            parts.push('#' + n.id);
            break;
        }
        n = n.parentElement;
    }
    return parts.join('|');
}

function rangeGap(a0, a1, b0, b1) {
    if (b1 < a0) return a0 - b1;
    if (b0 > a1) return b0 - a1;
    return 0;
}

function overlapRatio(a0, a1, b0, b1) {
    const o = Math.min(a1, b1) - Math.max(a0, b0);
    const smaller = Math.min(a1 - a0, b1 - b0);
    return o > 0 && smaller > 0 ? o / smaller : 0;
}

function contains(a, b) {
    return a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom;
}

/**
 * The element to move to from `from` in direction `dir`, or null.
 *
 * Only what lies beyond the current element counts — its centre past ours in
 * that direction — and not what shares our column when moving sideways (or
 * our row when moving up and down): more than half of the smaller one
 * overlapping on the axis of the move. Unless one holds the other, so the
 * Quit button inside an app card stays reachable from the card.
 *
 * The score is the gap along the move, five times the gap across it (zero
 * when the two overlap across), and a tenth of the distance between the
 * centres to break the ties. The heavy weight across is what makes Down in a
 * grid of app cards land on the card below, not on a nearer one off to the
 * side; with nothing lined up, the nearest diagonal still wins. No
 * wrap-around: at the edge, nothing.
 * @param {{left:number, top:number, right:number, bottom:number}} from
 * @param {'up'|'down'|'left'|'right'} dir
 * @param {{el: any, rect: {left:number, top:number, right:number, bottom:number}}[]} list
 * @returns {any}
 */
export function pickNext(from, dir, list) {
    const sideways = dir === 'left' || dir === 'right';
    const sign = dir === 'right' || dir === 'down' ? 1 : -1;
    const fx = (from.left + from.right) / 2;
    const fy = (from.top + from.bottom) / 2;
    let best = null;
    let bestScore = Infinity;
    for (const c of list) {
        const r = c.rect;
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        const along = (sideways ? cx - fx : cy - fy) * sign;
        if (along <= 1) continue;
        const nested = contains(from, r) || contains(r, from);
        const sameLine = sideways
            ? overlapRatio(from.left, from.right, r.left, r.right) > 0.5
            : overlapRatio(from.top, from.bottom, r.top, r.bottom) > 0.5;
        if (sameLine && !nested) continue;
        let gap = sideways
            ? sign > 0
                ? r.left - from.right
                : from.left - r.right
            : sign > 0
              ? r.top - from.bottom
              : from.top - r.bottom;
        gap = Math.max(0, gap);
        const across = sideways
            ? rangeGap(from.top, from.bottom, r.top, r.bottom)
            : rangeGap(from.left, from.right, r.left, r.right);
        const score = gap + 5 * across + 0.1 * Math.hypot(cx - fx, cy - fy);
        if (score < bestScore) {
            bestScore = score;
            best = c.el;
        }
    }
    return best;
}

/** @param {any} el */
function isRange(el) {
    return !!(el && typeof el.matches === 'function' && el.matches('input[type="range"]'));
}

/** @param {any} el */
function isArmed(el) {
    return !!(el && el.dataset && el.dataset.navArmed === '1');
}

/**
 * OK on a slider: it takes the arrows (armed), or gives them back. Leaving it
 * disarms it (onFocusOut).
 * @param {HTMLElement} el
 */
function armRange(el) {
    if (isArmed(el)) delete el.dataset.navArmed;
    else el.dataset.navArmed = '1';
}

/**
 * True when an arrow belongs to the element itself: a caret to move inside a
 * text, a slider's value, a list's choice. Up and Down still leave a one-line
 * text field (it has nowhere to go with them), and Left/Right leave it at its
 * ends; a list is left with Up and Down only when closed — a TV opens it on OK.
 * A slider takes Left/Right only once OK armed it (armRange): passing over the
 * bitrate on the way to the next setting used to change it.
 * @param {any} el
 * @param {string} key
 */
export function arrowStaysNative(el, key) {
    if (!el || typeof el.matches !== 'function') return false;
    const vertical = key === 'ArrowUp' || key === 'ArrowDown';
    if (el.matches('textarea, [contenteditable="true"]')) {
        if (!vertical) return true;
        const v = el.value || '';
        const at = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
        // Up leaves from the first line only, Down from the last.
        return key === 'ArrowUp' ? v.lastIndexOf('\n', at - 1) !== -1 : v.indexOf('\n', at) !== -1;
    }
    if (el.matches('input')) {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'range') return !vertical && isArmed(el);
        if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') {
            return false;
        }
        if (vertical) return false;
        const v = el.value || '';
        const s = el.selectionStart;
        const e = el.selectionEnd;
        if (typeof s !== 'number') return true;
        if (s !== e) return true;
        return key === 'ArrowLeft' ? s > 0 : s < v.length;
    }
    return false;
}

function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** The element the first press lands on when nothing has the focus yet. */
function initialTarget(root, list) {
    if (root !== document.body) {
        const marked = root.querySelector('[data-nav-initial], [autofocus]');
        if (marked && list.includes(marked)) return marked;
        return list.find((el) => !el.classList.contains('btn-danger')) || list[0] || null;
    }
    const key = state.memory.get(viewKey());
    if (key) {
        const again = list.find((el) => navKey(el) === key);
        if (again) return again;
    }
    const running = list.find((el) => el.classList.contains('app-card--running'));
    if (running) return running;
    const card = list.find((el) => el.classList.contains('app-card'));
    if (card) return card;
    const main = document.getElementById('main-content');
    return (main && list.find((el) => main.contains(el))) || list[0] || null;
}

function focusEl(el) {
    try {
        el.focus({ preventScroll: true });
    } catch (e) {
        el.focus();
    }
    if (typeof el.scrollIntoView === 'function') {
        try {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) {
            /* an old engine without options */
        }
    }
}

function scrollable(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
    }
    // On a TV the document itself scrolls (layout.css, html.remote-nav).
    const root = /** @type {HTMLElement|null} */ (document.scrollingElement);
    if (
        root &&
        root.scrollHeight > root.clientHeight &&
        getComputedStyle(document.documentElement).overflowY !== 'hidden'
    ) {
        return root;
    }
    return null;
}

/**
 * Move the focus one step in a direction, within the current scope.
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {boolean} whether the press was used (focus moved, or a page scrolled)
 */
export function move(dir) {
    const root = scopeRoot();
    if (!root) return false;
    const list = candidates(root);
    if (!list.length) return false;
    const current = /** @type {Element|null} */ (document.activeElement);
    const inScope = current && current !== document.body && root.contains(current);
    if (!inScope) {
        const first = initialTarget(root, list);
        if (!first) return false;
        focusEl(first);
        note('focus first ' + navKey(first));
        return true;
    }
    const next = pickNext(
        rectOf(current),
        dir,
        list.filter((el) => el !== current).map((el) => ({ el, rect: rectOf(el) })),
    );
    if (next) {
        focusEl(next);
        note('move ' + dir + ' → ' + navKey(next));
        return true;
    }
    // At the edge of what is on screen: show more of a long page instead.
    if (dir === 'up' || dir === 'down') {
        const box = scrollable(current);
        if (box) {
            box.scrollBy({ top: (dir === 'down' ? 1 : -1) * box.clientHeight * 0.6 });
            return true;
        }
    }
    // A layer keeps the press even when there is nowhere to go: it must not
    // fall through to the page or the stream underneath.
    return root !== document.body;
}

function viewKey() {
    const s = history.state;
    return (s && typeof s.view === 'string' && s.view) || 'hosts';
}

function onKeyDown(e) {
    if (!isActive()) return;
    // A colour key is "back". In a stream with nothing over it, the stream
    // view owns it (it opens the stream's menu, and never sends it on).
    if (isRemoteBackKey(e)) {
        if (streaming() && !topLayer()) return;
        e.preventDefault();
        e.stopPropagation();
        if (backKeyFresh(e)) back();
        return;
    }
    if (e.key === 'Enter' && isRange(e.target) && !(streaming() && !topLayer())) {
        armRange(/** @type {HTMLElement} */ (e.target));
        e.preventDefault();
        return;
    }
    const dir = KEY_DIRS[e.key];
    if (!dir) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // In a stream the keys are the host's, unless a layer is up over it.
    if (streaming() && !topLayer()) return;
    if (arrowStaysNative(e.target, e.key)) return;
    // A slider not armed keeps its value even with nowhere to move to: the
    // browser would step it otherwise.
    const keepSlider = isRange(e.target) && (dir === 'left' || dir === 'right');
    if (move(dir) || keepSlider) {
        e.preventDefault();
        e.stopPropagation();
    }
}

/** Keys that steer the focus: pressing one brings its ring back. */
const STEERING_KEYS = new Set(['Enter', 'Escape', 'Tab', ...Object.keys(KEY_DIRS)]);

/**
 * Which pointer the user holds: the browser's cursor (a tap, a click) or the
 * focus (keys, a pad). Only the latter draws the ring — under the cursor it
 * stayed on whatever was clicked last, away from where the cursor points.
 */
function pointerInUse(on) {
    document.documentElement.classList.toggle('nav-pointer', on);
}

function onPointerDown() {
    if (isActive()) pointerInUse(true);
}

function onSteeringKey(e) {
    if (STEERING_KEYS.has(e.key)) pointerInUse(false);
}

function onFocusOut(e) {
    const el = /** @type {HTMLElement} */ (e.target);
    if (isRange(el) && isArmed(el)) delete el.dataset.navArmed;
}

function onFocusIn(e) {
    const el = /** @type {Element} */ (e.target);
    if (!el || el === document.body || !el.closest) return;
    if (el.closest(LAYER_SELECTOR)) return;
    const key = navKey(el);
    if (key) state.memory.set(viewKey(), key);
}

/** The page changed: follow the layers, and put back a focus a rebuild took. */
function settle() {
    state.restoreQueued = false;
    if (!isActive()) return;
    const layer = topLayer();
    if (layer && layer !== state.layer) {
        // A dialog or a menu opened: its main action takes the focus.
        const prev = /** @type {Element|null} */ (document.activeElement);
        state.opener = prev && prev !== document.body ? navKey(prev) : null;
        state.layer = layer;
        if (!layer.contains(document.activeElement)) {
            const first = initialTarget(layer, candidates(layer));
            if (first) focusEl(first);
        }
        note('layer opened');
        return;
    }
    if (!layer && state.layer) {
        // It closed: back to the element that opened it, if it is still there.
        state.layer = null;
        const key = state.opener;
        state.opener = null;
        if (key && !streaming()) {
            const back = candidates(document.body).find((el) => navKey(el) === key);
            if (back) focusEl(back);
        }
        note('layer closed');
        return;
    }
    if (streaming() || layer) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    // The element that had the focus was rebuilt: the same key, if it is back.
    const key = state.memory.get(viewKey());
    if (!key) return;
    const again = candidates(document.body).find((el) => navKey(el) === key);
    if (again) {
        focusEl(again);
        note('restored ' + key);
    }
}

function queueSettle() {
    if (state.restoreQueued) return;
    state.restoreQueued = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(settle);
}

/**
 * The page went into a stream (or came out of one). Going in, the app card
 * that launched it lets go of the focus: still focused under the stream, it
 * would take the next OK for itself.
 */
function onBodyClass() {
    if (!isActive()) return;
    if (streaming()) {
        const a = /** @type {HTMLElement|null} */ (document.activeElement);
        const main = document.getElementById('main-content');
        if (a && a !== document.body && main && main.contains(a)) a.blur();
    }
    queueSettle();
}

/**
 * A pad's left and right on a slider: the browser only steps a range for
 * keys, so the step is taken here, with the events a key would have fired.
 * @returns {boolean} whether the press was a step
 */
function stepRange(el, dir) {
    if (dir !== 'left' && dir !== 'right') return false;
    if (!isRange(el) || !isArmed(el)) return false;
    if (dir === 'right') el.stepUp();
    else el.stepDown();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

/** One press of a pad's direction: a slider's step, a caret's move, or a move. */
function padMove(dir) {
    const el = /** @type {any} */ (document.activeElement);
    if (stepRange(el, dir)) return;
    const key = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[dir];
    // A caret has no pad equivalent, but a press must not throw the user out
    // of the text they are in the middle of either.
    if (arrowStaysNative(el, key)) return;
    move(dir);
}

/** Dispatch Escape on the focused element, as a remote's or a pad's "back". */
function sendEscape() {
    const target = document.activeElement || document.body;
    const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
    target.dispatchEvent(ev);
}

/**
 * A remote's colour keys (red, green, yellow, blue). TV browsers keep Back
 * for themselves, but the colour keys of a Mi TV's remote reach the page, as
 * ColorF0Red… with a stray code (MediaStop, Eject, BrowserSearch) and no
 * keyCode (03/10/2026). Any of them is the way back.
 * @param {{key?: string}} e
 */
export function isRemoteBackKey(e) {
    return !!e && typeof e.key === 'string' && /^ColorF[0-9]/.test(e.key);
}

/**
 * Whether this colour-key press is a new one. Android repeats a held key
 * without the repeat flag, and each repeat would go back once more — or open
 * and close the stream's menu in turn. One press, one "back", until it is
 * released (onKeyUp).
 */
export function backKeyFresh(e) {
    if (e.repeat || state.backHeld) return false;
    state.backHeld = true;
    return true;
}

function onKeyUp(e) {
    if (isRemoteBackKey(e)) state.backHeld = false;
}

/**
 * "Back": what Escape closes — a dialog, a menu — and with nothing open, the
 * view's own ✕ (Settings, Admin), which Escape does not reach.
 */
export function back() {
    const layer = topLayer();
    sendEscape();
    if (layer) return;
    for (const btn of document.querySelectorAll('.view-close-btn')) {
        if (isShown(btn)) {
            /** @type {HTMLElement} */ (btn).click();
            return;
        }
    }
}

/**
 * Read the pads: the direction pad moves, A clicks, B is Escape. Outside a
 * stream, or over the stream's menu (GamepadManager is paused then).
 */
function pollPads() {
    if (!isActive() || document.hidden) return;
    if (streaming() && !topLayer()) {
        state.pads.clear();
        return;
    }
    let pads;
    try {
        pads = navigator.getGamepads ? navigator.getGamepads() : [];
    } catch (e) {
        return;
    }
    const now = performance.now();
    for (const gp of pads) {
        if (!gp || !gp.connected) continue;
        let st = state.pads.get(gp.index);
        if (!st) {
            // A pad held at its first sight IS a press: Chromium only shows a
            // page a pad once one of its buttons went down, so that button is
            // the user's first move — ignored, every page load would eat one.
            st = { pressed: new Set(), heldDir: null, nextRepeatAt: 0 };
            state.pads.set(gp.index, st);
        }
        const down = new Set();
        gp.buttons.forEach((b, i) => {
            if (b.pressed) down.add(i);
        });
        const fresh = (i) => down.has(i) && !st.pressed.has(i);
        for (const i of down) if (!st.pressed.has(i)) pointerInUse(false);
        let dir = null;
        for (const b of Object.keys(PAD_DIRS)) if (down.has(Number(b))) dir = PAD_DIRS[b];
        if (dir && dir !== st.heldDir) {
            st.heldDir = dir;
            st.nextRepeatAt = now + PAD_REPEAT_DELAY_MS;
            padMove(dir);
        } else if (dir && now >= st.nextRepeatAt) {
            st.nextRepeatAt = now + PAD_REPEAT_MS;
            padMove(dir);
        } else if (!dir) {
            st.heldDir = null;
        }
        if (fresh(PAD_A)) {
            const el = /** @type {HTMLElement|null} */ (document.activeElement);
            if (isRange(el)) armRange(/** @type {HTMLElement} */ (el));
            else if (el && el !== document.body && typeof el.click === 'function') el.click();
        }
        if (fresh(PAD_B)) back();
        st.pressed = down;
    }
}

/** Debug view of the state (localStorage mw_remote_nav_debug = '1'). */
function exposeDebug() {
    try {
        if (localStorage.getItem('mw_remote_nav_debug') !== '1') return;
    } catch (e) {
        return;
    }
    /** @type {any} */ (window).mwRemoteNav = {
        state: () => ({
            active: isActive(),
            layer: !!topLayer(),
            focus: navKey(/** @type {Element} */ (document.activeElement)),
            memory: Object.fromEntries(state.memory),
            pads: state.pads.size,
        }),
        log: state.log,
    };
}

/** Start listening. Idempotent; costs nothing on a page where it is off. */
export function init() {
    if (state.started || typeof window === 'undefined') return;
    state.started = true;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onSteeringKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    // Elements coming and going, and menus shown through `hidden`. Classes
    // are left out: they change all the time during a stream, and the one
    // that matters — body.streaming-active — has its own observer below.
    state.observer = new MutationObserver(queueSettle);
    state.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden'],
    });
    state.bodyObserver = new MutationObserver(onBodyClass);
    state.bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    if (isActive()) {
        // The thicker focus ring and the lifted card (base.css), and the
        // document as the page's scroller (layout.css).
        document.documentElement.classList.add('remote-nav');
        state.pollTimer = setInterval(pollPads, PAD_POLL_MS);
        measureHeader();
    }
    exposeDebug();
}

/**
 * The sticky app header's height, for what sticks under it and for where a
 * scrolled-to element lands (--app-header-h, layout.css and settings.css).
 */
function measureHeader() {
    const header = document.querySelector('.app-header');
    if (!header) return;
    const apply = () => {
        const h = /** @type {HTMLElement} */ (header).offsetHeight;
        if (h > 0) document.documentElement.style.setProperty('--app-header-h', h + 'px');
    };
    apply();
    if (typeof ResizeObserver === 'function') {
        state.headerObserver = new ResizeObserver(apply);
        state.headerObserver.observe(header);
    }
}

/** Tests: force the mode, and forget everything. */
export function _setActiveForTest(on) {
    state.forced = on;
}

export function _resetForTest() {
    if (state.observer) state.observer.disconnect();
    if (state.bodyObserver) state.bodyObserver.disconnect();
    state.bodyObserver = null;
    if (state.headerObserver) state.headerObserver.disconnect();
    state.headerObserver = null;
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keydown', onSteeringKey, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('focusin', onFocusIn, true);
        document.removeEventListener('focusout', onFocusOut, true);
        document.documentElement.classList.remove('remote-nav', 'nav-pointer');
    }
    state.forced = null;
    state.backHeld = false;
    state.started = false;
    state.memory.clear();
    state.layer = null;
    state.opener = null;
    state.observer = null;
    state.restoreQueued = false;
    state.pollTimer = null;
    state.pads.clear();
    state.log.length = 0;
}

/** Tests: run the deferred work now. */
export function _settleForTest() {
    settle();
}

/** Tests: one pad read. */
export function _pollForTest() {
    pollPads();
}
