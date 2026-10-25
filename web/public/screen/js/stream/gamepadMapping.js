/*
 * MoonlightWeb — Browser-based Moonlight streaming client.
 * Copyright (C) 2026 Bruno Martin.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * gamepadMapping — turns a controller the browser cannot lay out into one
 * GamepadManager can read as a W3C "standard" pad.
 *
 * The browser says `mapping: 'standard'` when it knows which raw button is A;
 * otherwise it hands over bare `buttons[]` / `axes[]` indices. A mapping is a
 * set of BINDINGS, one per standard control, each naming the raw input that
 * drives it:
 *
 *   { t: 'b', i }            raw button i
 *   { t: 'a', i, s, inv }    raw axis i — s = +1/-1 for one half of it, 0 for
 *                            the whole axis; inv flips it
 *   { t: 'h', i, bit }       a d-pad packed into ONE axis, as Chrome reports a
 *                            HID hat switch on Windows/macOS (bit: 1 up,
 *                            2 right, 4 down, 8 left — SDL's hat bits)
 *
 * Bindings come from, in this order (resolveMapping):
 *   1. the user's own mapping for this pad (gamepadMappingsStore);
 *   2. the browser's standard layout;
 *   3. a profile built in here (BUILTIN_PADS, desktop only) for a device SDL
 *      does not know: EdgeTX / OpenTX radios, Logitech's G923 for Xbox;
 *   4. Chrome Android: an unknown pad is reported without a mapping, but
 *      Chromium (UnknownGamepadMappings) has already put its buttons and axes
 *      in the standard slots — read it as standard;
 *   5. SDL_GameControllerDB (gamepadDb.js, desktop only, loaded on demand);
 *   6. nothing: the pad is not forwarded until the user maps it.
 *
 * Bindings are plain JSON so the user's mapping is stored as is.
 */

/** Standard control names, in W3C standard button order (index = button). */
export const BUTTON_TARGETS = [
    'a',
    'b',
    'x',
    'y',
    'leftshoulder',
    'rightshoulder',
    'lefttrigger',
    'righttrigger',
    'back',
    'start',
    'leftstick',
    'rightstick',
    'dpup',
    'dpdown',
    'dpleft',
    'dpright',
    'guide',
];

/** Stick axes, in W3C standard axis order (index = axis). */
export const AXIS_TARGETS = ['leftx', 'lefty', 'rightx', 'righty'];

// A HID hat switch on Chrome Windows/macOS: logical 0..7 (up, then clockwise)
// normalised to -1..1 in steps of 2/7; the null state (8) lands at 9/7.
const HAT_BITS = [1, 3, 2, 6, 4, 12, 8, 9];
const HAT_NEUTRAL_MIN = 1.1;
// Chrome puts the hat usage (0x39) at axis 0x39 - 0x30.
const CHROME_HAT_AXIS = 9;

/** Pressed threshold for an axis read as a button, and for the wizard. */
const AXIS_PRESS = 0.5;

/** Which d-pad bits a hat axis value holds (0 when centred). */
export function hatBits(v) {
    if (typeof v !== 'number' || v > HAT_NEUTRAL_MIN || v < -1.05) return 0;
    const pos = Math.round((v + 1) * 3.5);
    return pos >= 0 && pos <= 7 ? HAT_BITS[pos] : 0;
}

/**
 * Name and USB ids from a Gamepad id, whatever the browser:
 *   Chrome desktop  "Name (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"
 *   Firefox         "054c-09cc-Name"
 *   Safari macOS    "54c-9cc-Name"  (not zero-padded)
 *   Chrome Android  "Name"          (no ids at all)
 */
export function parsePadId(id) {
    const s = String(id || '').trim();
    let m =
        /^(.*?)\s*\((?:.*?)Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})\s*\)\s*$/i.exec(
            s,
        );
    if (m) return { name: m[1].trim() || s, vid: pad4(m[2]), pid: pad4(m[3]) };
    m = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.*)$/i.exec(s);
    if (m) return { name: m[3].trim() || s, vid: pad4(m[1]), pid: pad4(m[2]) };
    // Chrome desktop without ids ("Name (STANDARD GAMEPAD)").
    m = /^(.*?)\s*\([^)]*\)\s*$/.exec(s);
    return { name: (m ? m[1] : s).trim() || s, vid: null, pid: null };
}

function pad4(h) {
    return h.toLowerCase().padStart(4, '0');
}

/**
 * The key a pad's user mapping is stored under. USB ids when the browser
 * gives them — the same pad then keeps its mapping across Chrome and Firefox
 * — the name otherwise (Android, iOS). A pad switched to another mode
 * reports other ids, and rightly gets its own mapping.
 */
export function padKey(gpOrId) {
    const id = typeof gpOrId === 'string' ? gpOrId : gpOrId && gpOrId.id;
    const { name, vid, pid } = parsePadId(id);
    if (vid && pid) return `usb:${vid}:${pid}`;
    return `name:${name.toLowerCase()}`;
}

/**
 * Names Windows gives a HID pad whose firmware has no product string —
 * Chrome passes them on as the pad's name. An Xbox pad over Bluetooth, or an
 * 8BitDo in XInput mode, then shows up as "HID-compliant game controller".
 */
const GENERIC_NAME =
    /^(hid-compliant game controller|contrôleur de jeu compatible hid|hid 兼容游戏控制器|unknown gamepad)$/i;

/** Well-known pads by USB ids, to name the ones reported with a generic name. */
const KNOWN_PADS = {
    '045e:028e': 'Xbox 360 Controller',
    '045e:02d1': 'Xbox One Controller',
    '045e:02dd': 'Xbox One Controller',
    '045e:02e0': 'Xbox One S Controller',
    '045e:02ea': 'Xbox One S Controller',
    '045e:02fd': 'Xbox One S Controller',
    '045e:0b00': 'Xbox Elite Series 2 Controller',
    '045e:0b05': 'Xbox Elite Series 2 Controller',
    '045e:0b12': 'Xbox Series Controller',
    '045e:0b13': 'Xbox Series Controller',
    '045e:0b20': 'Xbox Series Controller',
    '045e:0b22': 'Xbox Elite Series 2 Controller',
    '054c:05c4': 'DualShock 4',
    '054c:09cc': 'DualShock 4',
    '054c:0ce6': 'DualSense',
    '054c:0df2': 'DualSense Edge',
    '057e:2009': 'Switch Pro Controller',
    '046d:c24f': 'Logitech G29',
    '046d:c26e': 'Logitech G923 for Xbox',
    '1209:4f54': 'EdgeTX / OpenTX radio',
};

/**
 * Profiles built in for devices SDL_GameControllerDB does not know, by USB ids,
 * for desktop browsers (their raw indices follow the HID usage order). Each
 * lays the device out the way it is held onto the Xbox pad the host presents:
 * the game sees an Xbox 360 controller, never the device itself.
 *
 * EdgeTX and OpenTX radios share the pid.codes ids 1209:4f54 — Radiomaster,
 * Jumper, BetaFPV, FrSky or Flysky under EdgeTX — in their default USB mode
 * ("Classic"): channels 1-8 are the axes X, Y, Z, Rx, Ry, Rz and two Sliders,
 * channels 9-32 the buttons 0-23 (pressed above 0). The profile reads Mode 2
 * in the usual AETR channel order — roll CH1, pitch CH2, throttle CH3, yaw CH4
 * — as a Radiomaster TX12 reports it in Chrome on Windows (measured 01/10/2026
 * with scripts/bench/gamepad/pad-probe.html):
 *   - yaw → left X, throttle → left Y, roll → right X, pitch → right Y. Both
 *     verticals read +1 at the top, so they are flipped: stick up is up;
 *   - CH5 → LT and CH6 → RT as whole axes: a switch at -100, 0 and +100 gives
 *     the trigger 0, 128 and 255. A channel the model leaves unmixed sits at
 *     0, a trigger half pressed — mix it on the radio, or remap;
 *   - CH9-16 (buttons 0-7) → A, B, X, Y, LB, RB, Back, Start;
 *   - CH7-8 go nowhere: the Xbox pad has six analog channels. Chrome on
 *     Windows even folds the radio's two Sliders onto one axis (6).
 * Mode 1, another channel order or the "Advanced" USB mode: the wizard.
 *
 * Logitech's G923 for Xbox One and PC reports 046d:c26e once G HUB has put it
 * in its PC mode. Plugged in without G HUB it stays an Xbox device (046d:c26d)
 * that no browser sees. The profile lays it out the way a racing game reads an
 * Xbox pad, as it reports in Chrome on Windows (measured 02/10/2026 with
 * pad-probe.html?dev=g923x):
 *   - the wheel → left X (-1 at the left stop);
 *   - accelerator → RT and brake → LT, whole axes. The pedals rest at +1 and
 *     read -1 floored, so they are flipped;
 *   - the right paddle → RB, the left one → LB; A, B, X, Y, Menu → Start,
 *     View → Back, LSB, RSB and the Xbox button where an Xbox pad has them;
 *     the d-pad is the hat on axis 9;
 *   - the clutch (axis 5) goes nowhere: the Xbox pad has no third trigger.
 *     Neither do + and − (buttons 18, 19), the dial (20, 21) and its Enter,
 *     nor a shifter's gears: it has no button left.
 */
const BUILTIN_PADS = {
    '1209:4f54': {
        leftx: { t: 'a', i: 3, s: 0 },
        lefty: { t: 'a', i: 2, s: 0, inv: true },
        rightx: { t: 'a', i: 0, s: 0 },
        righty: { t: 'a', i: 1, s: 0, inv: true },
        lefttrigger: { t: 'a', i: 4, s: 0 },
        righttrigger: { t: 'a', i: 5, s: 0 },
        a: { t: 'b', i: 0 },
        b: { t: 'b', i: 1 },
        x: { t: 'b', i: 2 },
        y: { t: 'b', i: 3 },
        leftshoulder: { t: 'b', i: 4 },
        rightshoulder: { t: 'b', i: 5 },
        back: { t: 'b', i: 6 },
        start: { t: 'b', i: 7 },
    },
    '046d:c26e': {
        leftx: { t: 'a', i: 0, s: 0 },
        lefttrigger: { t: 'a', i: 2, s: 0, inv: true },
        righttrigger: { t: 'a', i: 1, s: 0, inv: true },
        a: { t: 'b', i: 0 },
        b: { t: 'b', i: 1 },
        x: { t: 'b', i: 2 },
        y: { t: 'b', i: 3 },
        rightshoulder: { t: 'b', i: 4 },
        leftshoulder: { t: 'b', i: 5 },
        start: { t: 'b', i: 6 },
        back: { t: 'b', i: 7 },
        rightstick: { t: 'b', i: 8 },
        leftstick: { t: 'b', i: 9 },
        guide: { t: 'b', i: 10 },
        dpup: { t: 'h', i: 9, bit: 1 },
        dpright: { t: 'h', i: 9, bit: 2 },
        dpdown: { t: 'h', i: 9, bit: 4 },
        dpleft: { t: 'h', i: 9, bit: 8 },
    },
};

/**
 * Display name of a pad: its id without the browser's decorations. A generic
 * name is replaced by the pad's model when its USB ids are known, by the ids
 * otherwise — two such pads stay tellable apart.
 */
export function padName(gpOrId) {
    const id = typeof gpOrId === 'string' ? gpOrId : gpOrId && gpOrId.id;
    const { name, vid, pid } = parsePadId(id);
    if (vid && pid && GENERIC_NAME.test(name)) {
        return KNOWN_PADS[`${vid}:${pid}`] || `Controller ${vid}:${pid}`;
    }
    return name || '?';
}

/** The platform whose raw layout the browser reports. */
export function detectPlatform(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
    const s = String(ua || '');
    if (/Android/i.test(s)) return 'android';
    if (/iPhone|iPad|iPod/i.test(s)) return 'ios';
    if (/Windows/i.test(s)) return 'win';
    if (/Macintosh|Mac OS X/i.test(s)) return 'mac';
    if (/Linux|CrOS|X11/i.test(s)) return 'linux';
    return 'other';
}

/**
 * SDL mapping string → bindings, translated to the browser's raw indices.
 *
 * Buttons are the same on both sides (HID button order). Axes keep SDL's
 * index when the browser has that axis — SDL's DirectInput/IOKit indices
 * follow the usage order Chrome uses — and are dropped otherwise, leaving the
 * control for the user to map. Hats differ: Chrome Windows/macOS packs one
 * into axis 9; Linux (joydev) reports it as an axis pair, after the others.
 *
 * @param {string} str   "a:b0,b:b1,dpup:h0.1,lefttrigger:a2,…"
 * @param {{platform: string, axesLength: number}} ctx
 */
export function parseSdlMapping(str, ctx) {
    const platform = ctx.platform;
    const axesLength = ctx.axesLength || 0;
    const out = {};
    for (const field of String(str || '').split(',')) {
        const m = /^([a-z]+):([+-]?)([abh])(\d+)(?:\.(\d+))?(~?)$/.exec(field.trim());
        if (!m) continue;
        const [, target, half, kind, num, hatBit, tilde] = m;
        if (!BUTTON_TARGETS.includes(target) && !AXIS_TARGETS.includes(target)) continue;
        const i = Number(num);
        if (kind === 'b') {
            out[target] = { t: 'b', i };
        } else if (kind === 'a') {
            if (i >= axesLength) continue;
            const b = { t: 'a', i, s: half === '+' ? 1 : half === '-' ? -1 : 0 };
            if (tilde) b.inv = true;
            out[target] = b;
        } else {
            const bit = Number(hatBit);
            if (Number(num) !== 0) continue; // a second hat has no home here
            if (platform === 'linux') {
                // joydev: HAT0X then HAT0Y, normally the last two axes.
                if (axesLength < 2) continue;
                const hx = axesLength - 2;
                const hy = axesLength - 1;
                if (bit === 1) out[target] = { t: 'a', i: hy, s: -1 };
                else if (bit === 4) out[target] = { t: 'a', i: hy, s: 1 };
                else if (bit === 8) out[target] = { t: 'a', i: hx, s: -1 };
                else if (bit === 2) out[target] = { t: 'a', i: hx, s: 1 };
            } else if (axesLength > CHROME_HAT_AXIS) {
                out[target] = { t: 'h', i: CHROME_HAT_AXIS, bit };
            }
        }
    }
    return out;
}

/** A binding read as a button: {pressed, value 0..1}. */
function readButton(gp, b) {
    if (!b) return { pressed: false, value: 0 };
    if (b.t === 'b') {
        const btn = gp.buttons[b.i];
        return btn ? { pressed: !!btn.pressed, value: btn.value || (btn.pressed ? 1 : 0) } : REST;
    }
    const raw = gp.axes[b.i];
    if (typeof raw !== 'number') return REST;
    if (b.t === 'h') {
        const on = (hatBits(raw) & b.bit) !== 0;
        return { pressed: on, value: on ? 1 : 0 };
    }
    const v = b.inv ? -raw : raw;
    let value;
    if (b.s > 0) value = Math.max(0, v);
    else if (b.s < 0) value = Math.max(0, -v);
    else value = (v + 1) / 2; // a whole axis as a trigger: -1 at rest, +1 full
    value = Math.min(1, value);
    return { pressed: value > AXIS_PRESS, value };
}

const REST = { pressed: false, value: 0 };

/** A binding read as a stick axis, -1..1. */
function readAxis(gp, b) {
    if (!b) return 0;
    if (b.t === 'a') {
        const raw = gp.axes[b.i];
        if (typeof raw !== 'number') return 0;
        const v = b.inv ? -raw : raw;
        if (b.s > 0) return Math.max(0, v);
        if (b.s < 0) return Math.min(0, v);
        return v;
    }
    return readButton(gp, b).pressed ? 1 : 0;
}

/**
 * The pad as a standard one: 17 buttons and 4 axes in W3C order, read
 * through `bindings`. Unbound controls read as released / centred.
 */
export function readVirtualPad(gp, bindings) {
    const buttons = BUTTON_TARGETS.map((t) => readButton(gp, bindings[t]));
    const axes = AXIS_TARGETS.map((t) => readAxis(gp, bindings[t]));
    return { buttons, axes };
}

/**
 * Chrome Android pads Chromium lays out itself but still reports without a
 * mapping, whose layout is known to be off anyway. Matched on the name (the
 * only thing Android gives); value = SDL mapping string over the browser's
 * (already standardised) indices. Empty until a pad proves it needs one.
 */
export const ANDROID_NAME_FIXES = [];

/**
 * How to read this pad.
 *
 * @param {Gamepad} gp
 * @param {{ user?: (key: string) => ({bindings: object}|null),
 *           db?: object|null|undefined, platform?: string }} ctx
 *   `db` undefined = not loaded yet (the result is then 'pending' for a pad
 *   that needs it); null = unavailable.
 * @returns {{ source: 'user'|'standard'|'builtin'|'android'|'db'|'pending'|null,
 *             bindings: object|null, key: string, name: string, kind: string,
 *             dbName?: string }}
 *   bindings null with source 'standard'/'android' = read the pad as is.
 *   `kind` is what the device is (padKind), whichever source lays it out.
 */
export function resolveMapping(gp, ctx = {}) {
    const key = padKey(gp);
    const name = padName(gp);
    const saved = ctx.user ? ctx.user(key) : null;
    const base = { key, name, kind: padKind(gp, saved) };
    if (saved && saved.bindings) return { ...base, source: 'user', bindings: saved.bindings };
    if (gp.mapping === 'standard') return { ...base, source: 'standard', bindings: null };

    const platform = ctx.platform || detectPlatform();
    const desktop = platform === 'win' || platform === 'mac' || platform === 'linux';
    const builtin = desktop ? builtinFor(gp.id) : null;
    if (builtin) return { ...base, source: 'builtin', bindings: builtin };
    const axesLength = gp.axes ? gp.axes.length : 0;
    if (platform === 'android') {
        const fix = ANDROID_NAME_FIXES.find(([re]) => re.test(name));
        const bindings = fix ? parseSdlMapping(fix[1], { platform, axesLength }) : null;
        return { ...base, source: 'android', bindings };
    }
    if (desktop) {
        if (ctx.db === undefined) return { ...base, source: 'pending', bindings: null };
        const entry = ctx.db ? lookupDb(ctx.db, platform, gp.id) : null;
        if (entry) {
            const bindings = parseSdlMapping(entry[1], { platform, axesLength });
            if (Object.keys(bindings).length > 0) {
                return { ...base, source: 'db', bindings, dbName: entry[0] };
            }
        }
    }
    return { ...base, source: null, bindings: null };
}

/**
 * What a device is, for how it is drawn and how the wizard speaks to it: a
 * pad, a radio control (rc), a flight stick or a wheel. Whatever it is, the
 * host still presents an Xbox 360 controller.
 */
export const PAD_KINDS = ['gamepad', 'rc', 'flightstick', 'wheel'];

/** Devices whose kind their USB ids settle. */
const KNOWN_KINDS = { '1209:4f54': 'rc', '046d:c24f': 'wheel', '046d:c26e': 'wheel' };

/**
 * The kind a device's name suggests, tried in this order: flight gear before
 * wheels, so a Thrustmaster T.16000M or a rudder's pedals are not taken for
 * racing ones. "Joystick" says nothing — cheap pads are called that too.
 */
const KIND_HINTS = [
    ['rc', /edgetx|opentx|radiomaster|frsky|jumper|ethos|betafpv|flysky|\bzorro\b|\bboxer\b/i],
    [
        'flightstick',
        /flight|hotas|rudder|\bx5[256]\b|t\.?16000|extreme 3d|vkb|virpil|winwing|warthog|throttle/i,
    ],
    [
        'wheel',
        /wheel|racing|driving force|\bg(25|27|29|920|923)\b|fanatec|moza|simagic|simucube|thrustmaster t(80|128|150|248|300|500|818|x|s-pc|s-xw|-?gt)\b|pedals/i,
    ],
];

/**
 * A TV remote that Android calls a joystick, by its name: the Freebox Player
 * POP's "B16C" has a volume axis, and that is enough (measured 01/10/2026); a
 * Mi TV's is "Xiaomi RC Consumer Control" (03/10/2026). Once the page reads
 * the pads, Chromium hands its arrows to the Gamepad API (buttons 12-15)
 * instead of the keyboard. It is no controller for a game: the stream takes
 * its arrows as arrow keys (GamepadManager), and the host never hears of a
 * pad. Its kind is 'remote' — not in PAD_KINDS: what it is cannot be changed.
 * @param {string|null|undefined} id
 */
export function isTvRemoteId(id) {
    return /\bB16C\b|remote|t[ée]l[ée]commande|\brcu?\b/i.test(id || '');
}

/**
 * What `gp` is: a TV remote whatever was saved (isTvRemoteId), then the
 * user's own choice (`saved.kind`), its USB ids, a hint from its name — a pad
 * otherwise, the drawing of old.
 * @param {Gamepad|string} gpOrId
 * @param {{kind?: string}|null} [saved]  the pad's entry in gamepadMappingsStore
 */
export function padKind(gpOrId, saved = null) {
    const id = typeof gpOrId === 'string' ? gpOrId : gpOrId && gpOrId.id;
    if (isTvRemoteId(id)) return 'remote';
    if (saved && PAD_KINDS.includes(saved.kind)) return saved.kind;
    const { name, vid, pid } = parsePadId(id);
    const known = vid && pid ? KNOWN_KINDS[`${vid}:${pid}`] : null;
    if (known) return known;
    const hint = KIND_HINTS.find(([, re]) => re.test(name));
    return hint ? hint[0] : 'gamepad';
}

/**
 * Whether a source laid the pad out without the user — a built-in profile,
 * Chrome Android's guess, SDL's database. Right most of the time, and worth a
 * check: the user is told, and offered the wizard.
 */
export function isAutoMapped(source) {
    return source === 'builtin' || source === 'android' || source === 'db';
}

/** The built-in profile for this pad's USB ids — a copy, the table is shared — or null. */
function builtinFor(id) {
    const { vid, pid } = parsePadId(id);
    const profile = vid && pid ? BUILTIN_PADS[`${vid}:${pid}`] : null;
    if (!profile) return null;
    return Object.fromEntries(Object.entries(profile).map(([target, b]) => [target, { ...b }]));
}

/** [name, mapping] for this pad's ids on this platform; the name breaks ties. */
function lookupDb(db, platform, id) {
    const { name, vid, pid } = parsePadId(id);
    if (!vid || !pid || !db[platform]) return null;
    const entries = db[platform][`${vid}:${pid}`];
    if (!entries || entries.length === 0) return null;
    const lower = name.toLowerCase();
    return entries.find(([n]) => n.toLowerCase() === lower) || entries[0];
}

let dbPromise = null;

/** SDL_GameControllerDB, loaded once and only when a pad needs it. */
export function loadGamepadDb() {
    if (!dbPromise) {
        dbPromise = import('./gamepadDb.js').then(
            (m) => m.default,
            () => null,
        );
    }
    return dbPromise;
}

// ── Capture (the remap wizard) ────────────────────────────────────────────

/** What the pad looks like at rest, to detect what the user moves. */
export function snapshot(gp) {
    return {
        buttons: Array.from(gp.buttons || [], (b) => !!(b && b.pressed)),
        axes: Array.from(gp.axes || [], (v) => (typeof v === 'number' ? v : 0)),
    };
}

/**
 * The raw input the user just moved, as a binding for `target`, or null.
 *
 * Triggers look at axes first (many pads report an analog trigger both as an
 * axis and a button, and the axis is the one with the travel); everything else
 * looks at buttons first. An axis resting at an extreme (a trigger at -1) is
 * taken whole; one resting at 9/7 is a packed hat; one resting at the centre
 * gives a half — or, for a stick target, the whole axis in the pushed sense.
 *
 * A stick axis PARKED at an extreme — a radio's throttle, a lever with no
 * spring — can only be moved away from where it rests, whatever the prompt
 * asks: its sense comes from that rest, not from the push. A vertical parked
 * at an end rests at the bottom, a horizontal at the left. Any other stick
 * takes the sense of the push: `dir` +1 when the prompt asks for right or
 * down (a standard stick's positive sense), -1 when it asks for up ("raise
 * the throttle").
 * Inputs in `exclude` (already bound this pass) are skipped.
 *
 * @param {{buttons:boolean[], axes:number[]}} base  snapshot at rest
 * @param {Gamepad} gp
 * @param {string} target  a BUTTON_TARGETS or AXIS_TARGETS name
 * @param {object[]} [exclude]
 * @param {1|-1} [dir]
 */
export function detectInput(base, gp, target, exclude = [], dir = 1) {
    const used = (b) => exclude.some((e) => e && sameBinding(e, b));
    const isStick = AXIS_TARGETS.includes(target);
    const isTrigger = target === 'lefttrigger' || target === 'righttrigger';

    const fromButtons = () => {
        for (let i = 0; i < gp.buttons.length; i++) {
            const btn = gp.buttons[i];
            if (!btn || base.buttons[i]) continue;
            if (btn.pressed || btn.value > AXIS_PRESS) {
                const b = { t: 'b', i };
                if (!used(b)) return b;
            }
        }
        return null;
    };
    const fromAxes = () => {
        for (let i = 0; i < gp.axes.length; i++) {
            const v = gp.axes[i];
            const rest = base.axes[i] ?? 0;
            if (typeof v !== 'number') continue;
            let b = null;
            if (rest > HAT_NEUTRAL_MIN) {
                const bits = hatBits(v);
                // Only a clean direction: a diagonal says nothing about which.
                if (bits === 1 || bits === 2 || bits === 4 || bits === 8)
                    b = { t: 'h', i, bit: bits };
            } else {
                const d = v - rest;
                if (Math.abs(d) <= AXIS_PRESS) continue;
                if (isStick) {
                    const parked = Math.abs(rest) > 0.9;
                    // Down is +1 and left -1 on a standard stick.
                    const vertical = target === 'lefty' || target === 'righty';
                    let inv;
                    if (parked) inv = vertical ? rest < 0 : rest > 0;
                    else inv = dir > 0 ? d < 0 : d > 0;
                    b = { t: 'a', i, s: 0, ...(inv ? { inv: true } : {}) };
                } else if (Math.abs(rest) > 0.9)
                    b = { t: 'a', i, s: 0, ...(rest > 0 ? { inv: true } : {}) };
                else b = { t: 'a', i, s: d > 0 ? 1 : -1 };
            }
            if (b && !used(b)) return b;
        }
        return null;
    };
    if (isStick) return fromAxes();
    if (isTrigger) return fromAxes() || fromButtons();
    return fromButtons() || fromAxes();
}

/** True once every input is back where the snapshot had it. */
export function isAtRest(base, gp) {
    for (let i = 0; i < gp.buttons.length; i++) {
        const btn = gp.buttons[i];
        if (btn && !base.buttons[i] && (btn.pressed || btn.value > 0.3)) return false;
    }
    for (let i = 0; i < gp.axes.length; i++) {
        const v = gp.axes[i];
        if (typeof v === 'number' && Math.abs(v - (base.axes[i] ?? 0)) > 0.3) return false;
    }
    return true;
}

/** Same raw input (the sense of an axis does not matter for reuse). */
export function sameBinding(a, b) {
    if (!a || !b || a.t !== b.t || a.i !== b.i) return false;
    if (a.t === 'h') return a.bit === b.bit;
    if (a.t === 'a') return (a.s || 0) === 0 || (b.s || 0) === 0 || a.s === b.s;
    return true;
}

/** Short label of the raw input: "B7", "A2+", "A5~", "H9↑". */
export function describeBinding(b) {
    if (!b) return '—';
    if (b.t === 'b') return `B${b.i}`;
    if (b.t === 'h') return `H${b.i}${{ 1: '↑', 2: '→', 4: '↓', 8: '←' }[b.bit] || '?'}`;
    return `A${b.i}${b.s > 0 ? '+' : b.s < 0 ? '−' : ''}${b.inv ? '~' : ''}`;
}
