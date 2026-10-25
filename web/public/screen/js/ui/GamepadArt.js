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
 * GamepadArt — the controller drawn in the remap dialog: an Xbox-layout pad
 * (what the host presents, whatever is in the player's hands), front view,
 * triggers and bumpers showing over the top edge.
 *
 * Pure SVG, no image. Every control is a `<g class="gp-ctl" data-ctl="…">`
 * named after gamepadMapping's targets, holding:
 *   - its drawn parts;
 *   - `.gp-hot`  — the same shape, lit when the control is pressed;
 *   - `.gp-ring` — an outline, shown when it is the wizard's current step.
 * State is classes and a couple of transforms (GamepadArtView); the look is
 * css/views/gamepad.css, so colours follow the theme tokens.
 *
 * Ids inside the SVG are suffixed per instance: two pads on one page (the
 * settings list and an open dialog) must not share gradients.
 *
 * GamepadArtView also draws DeviceArt's radio, flight stick and wheel: same
 * contract, plus parts that turn, toggle or slide (data-rotate, data-lever,
 * data-press) and a part that stands for several targets (data-ctl="leftx
 * lefty"). The pad has none of those, and draws as it always did.
 */

let seq = 0;

/** SVG markup for one controller. */
export function gamepadArtSvg() {
    const u = `gp${++seq}`;
    const id = (n) => `${u}-${n}`;
    const url = (n) => `url(#${id(n)})`;

    // Left-hand shapes; the right-hand ones are the same mirrored.
    const TRIGGER =
        'M140 100 C136 62 160 32 202 24 C236 18 262 26 268 50 L272 80 C226 78 180 86 140 100 Z';
    const BUMPER =
        'M66 178 C86 116 130 82 194 70 C226 64 252 62 274 63 L274 92 ' +
        'C250 92 224 94 198 99 C150 110 116 136 98 186 Z';

    const mirror = 'transform="translate(640 0) scale(-1 1)"';

    const trigger = (side) => `
        <g class="gp-ctl gp-trigger" data-ctl="${side}trigger" ${side === 'right' ? mirror : ''}>
            <path d="${TRIGGER}" fill="${url('trigger')}" stroke="rgba(0,0,0,.6)" stroke-width="1.5"/>
            <g clip-path="${url(`clip-${side}t`)}">
                <rect class="gp-trigger-fill" x="130" y="20" width="150" height="90"/>
            </g>
            <path d="M162 58 C170 42 190 32 212 30" class="gp-sheen" fill="none"/>
            <path class="gp-hot" d="${TRIGGER}"/>
            <path class="gp-ring" d="${TRIGGER}"/>
        </g>`;

    const bumper = (side) => `
        <g class="gp-ctl gp-bumper" data-ctl="${side}shoulder" ${side === 'right' ? mirror : ''}>
            <path d="${BUMPER}" fill="${url('bumper')}" stroke="rgba(0,0,0,.7)" stroke-width="1.5"/>
            <path d="M74 170 C94 116 136 86 196 75 C228 69 252 67 270 67" class="gp-sheen" fill="none"/>
            <path class="gp-hot" d="${BUMPER}"/>
            <path class="gp-ring" d="${BUMPER}"/>
        </g>`;

    // Thumbstick: a recessed well, and the cap that moves inside it.
    const stick = (side, cx, cy) => `
        <g class="gp-ctl gp-stick" data-ctl="${side}stick" data-stick="${side}">
            <circle cx="${cx}" cy="${cy}" r="46" fill="${url('well')}"/>
            <circle cx="${cx}" cy="${cy}" r="46" fill="none" class="gp-well-rim"/>
            <g class="gp-stick-cap">
                <circle cx="${cx}" cy="${cy + 4}" r="33" fill="rgba(0,0,0,.55)"/>
                <circle cx="${cx}" cy="${cy}" r="32" fill="${url('capside')}"/>
                <circle cx="${cx}" cy="${cy}" r="25" fill="${url('capface')}"/>
                <circle cx="${cx}" cy="${cy}" r="25" fill="none" class="gp-cap-grip"/>
                <circle cx="${cx}" cy="${cy}" r="20.5" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1"/>
                <ellipse cx="${cx - 7}" cy="${cy - 10}" rx="11" ry="6" class="gp-spec"/>
                <circle class="gp-hot" cx="${cx}" cy="${cy}" r="32"/>
            </g>
            <circle class="gp-ring" cx="${cx}" cy="${cy}" r="50"/>
            <g class="gp-arrows">
                <path class="gp-arrow" data-dir="x" d="M${cx + 56} ${cy - 9} l12 9 l-12 9 z"/>
                <path class="gp-arrow" data-dir="y" d="M${cx - 9} ${cy + 56} l9 12 l9 -12 z"/>
            </g>
        </g>`;

    // D-pad: four arms, each its own control.
    const dpadArm = (dir, rot) => `
        <g class="gp-ctl gp-dpad-arm" data-ctl="dp${dir}" transform="rotate(${rot} 250 272)">
            <path d="M239 240 L261 240 Q264 240 264 243 L264 262 L250 272 L236 262 L236 243 Q236 240 239 240 Z"
                  fill="${url('dpad')}" stroke="rgba(0,0,0,.7)" stroke-width="1"/>
            <path d="M244 248 L250 243 L256 248 Z" class="gp-dpad-glyph"/>
            <path class="gp-hot" d="M239 240 L261 240 Q264 240 264 243 L264 262 L250 272 L236 262 L236 243 Q236 240 239 240 Z"/>
            <path class="gp-ring" d="M239 240 L261 240 Q264 240 264 243 L264 262 L250 272 L236 262 L236 243 Q236 240 239 240 Z"/>
        </g>`;

    const face = (ctl, cx, cy, letter) => `
        <g class="gp-ctl gp-face" data-ctl="${ctl}">
            <circle cx="${cx}" cy="${cy + 3}" r="18" fill="rgba(0,0,0,.6)"/>
            <circle cx="${cx}" cy="${cy}" r="17" fill="${url('face')}" stroke="rgba(0,0,0,.8)" stroke-width="1"/>
            <circle cx="${cx}" cy="${cy}" r="17" fill="none" class="gp-face-rim"/>
            <ellipse cx="${cx - 4}" cy="${cy - 8}" rx="8" ry="4" class="gp-spec"/>
            <circle class="gp-hot" cx="${cx}" cy="${cy}" r="17"/>
            <text x="${cx}" y="${cy + 6.5}" class="gp-face-letter gp-face-${ctl}">${letter}</text>
            <circle class="gp-ring" cx="${cx}" cy="${cy}" r="21"/>
        </g>`;

    const pill = (ctl, cx, cy, glyph) => `
        <g class="gp-ctl gp-small" data-ctl="${ctl}">
            <rect x="${cx - 13}" y="${cy - 8}" width="26" height="16" rx="8" fill="${url('face')}" stroke="rgba(0,0,0,.8)"/>
            ${glyph}
            <rect class="gp-hot" x="${cx - 13}" y="${cy - 8}" width="26" height="16" rx="8"/>
            <rect class="gp-ring" x="${cx - 17}" y="${cy - 12}" width="34" height="24" rx="12"/>
        </g>`;

    const BODY =
        'M190 92 C240 81 282 88 320 88 C358 88 400 81 450 92 C512 105 548 132 567 192 ' +
        'C590 268 612 350 592 388 C574 418 526 416 500 388 C470 352 452 322 422 308 ' +
        'C382 294 258 294 218 308 C188 322 170 352 140 388 C114 416 66 418 48 388 ' +
        'C28 350 50 268 73 192 C92 132 128 105 190 92 Z';

    return `
<svg class="gp-art" viewBox="0 0 640 440" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${id('shell')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#253140"/>
      <stop offset=".45" stop-color="#151d27"/>
      <stop offset="1" stop-color="#080b10"/>
    </linearGradient>
    <radialGradient id="${id('sheen')}" cx=".5" cy=".12" r=".7">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/>
      <stop offset=".5" stop-color="#ffffff" stop-opacity=".03"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id('trigger')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2e3a49"/>
      <stop offset="1" stop-color="#0d1218"/>
    </linearGradient>
    <linearGradient id="${id('bumper')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34414f"/>
      <stop offset=".6" stop-color="#18202a"/>
      <stop offset="1" stop-color="#0b0f14"/>
    </linearGradient>
    <radialGradient id="${id('well')}" cx=".5" cy=".42" r=".6">
      <stop offset="0" stop-color="#020304"/>
      <stop offset=".75" stop-color="#06090c"/>
      <stop offset="1" stop-color="#1a232e"/>
    </radialGradient>
    <radialGradient id="${id('capside')}" cx=".45" cy=".35" r=".7">
      <stop offset="0" stop-color="#3a4756"/>
      <stop offset="1" stop-color="#0c1117"/>
    </radialGradient>
    <radialGradient id="${id('capface')}" cx=".5" cy=".65" r=".65">
      <stop offset="0" stop-color="#27313d"/>
      <stop offset="1" stop-color="#11171f"/>
    </radialGradient>
    <linearGradient id="${id('dpad')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2f3b4a"/>
      <stop offset="1" stop-color="#121820"/>
    </linearGradient>
    <radialGradient id="${id('face')}" cx=".42" cy=".32" r=".75">
      <stop offset="0" stop-color="#2c3643"/>
      <stop offset="1" stop-color="#0b0f14"/>
    </radialGradient>
    <pattern id="${id('grip')}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
      <circle cx="3" cy="3" r=".8" fill="#ffffff" fill-opacity=".035"/>
    </pattern>
    <clipPath id="${id('clip-leftt')}"><path d="${TRIGGER}"/></clipPath>
    <clipPath id="${id('clip-rightt')}"><path d="${TRIGGER}"/></clipPath>
    <clipPath id="${id('clip-body')}"><path d="${BODY}"/></clipPath>
    <filter id="${id('drop')}" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#000" flood-opacity=".65"/>
    </filter>
  </defs>

  <ellipse cx="320" cy="412" rx="250" ry="14" class="gp-floor"/>

  ${trigger('left')}
  ${trigger('right')}
  ${bumper('left')}
  ${bumper('right')}

  <g filter="${url('drop')}">
    <path d="${BODY}" fill="${url('shell')}"/>
  </g>
  <g clip-path="${url('clip-body')}">
    <path d="M40 250 C60 330 80 400 150 400 L140 300 Z M600 250 C580 330 560 400 490 400 L500 300 Z" fill="${url('grip')}"/>
    <path d="M60 200 C120 110 520 110 580 200 L580 60 L60 60 Z" fill="${url('sheen')}"/>
    <path d="M218 308 C258 294 382 294 422 308" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="3"/>
  </g>
  <path d="${BODY}" fill="none" class="gp-edge"/>
  <path d="M196 98 C240 88 282 94 320 94 C358 94 400 88 444 98" fill="none" class="gp-sheen"/>

  <path d="M268 142 C284 118 356 118 372 142 C382 160 376 206 320 214 C264 206 258 160 268 142 Z" class="gp-plate"/>

  ${stick('left', 186, 186)}
  ${stick('right', 402, 272)}

  <circle cx="250" cy="272" r="46" fill="${url('well')}"/>
  <circle cx="250" cy="272" r="46" fill="none" class="gp-well-rim"/>
  ${dpadArm('up', 0)}
  ${dpadArm('right', 90)}
  ${dpadArm('down', 180)}
  ${dpadArm('left', 270)}
  <circle cx="250" cy="272" r="7" fill="#0b0f14" stroke="rgba(0,0,0,.6)"/>

  <circle cx="470" cy="186" r="62" class="gp-face-well"/>
  ${face('y', 470, 146, 'Y')}
  ${face('x', 430, 186, 'X')}
  ${face('b', 510, 186, 'B')}
  ${face('a', 470, 226, 'A')}

  ${pill('back', 272, 186, `<g class="gp-glyph"><rect x="265.5" y="182" width="7" height="6" rx="1"/><rect x="270.5" y="185" width="7" height="6" rx="1"/></g>`)}
  ${pill('start', 368, 186, `<g class="gp-glyph"><path d="M362 182.5 H374 M362 186 H374 M362 189.5 H374"/></g>`)}

  <g class="gp-ctl gp-guide" data-ctl="guide">
    <circle cx="320" cy="146" r="21" fill="${url('face')}" stroke="rgba(0,0,0,.8)"/>
    <circle cx="320" cy="146" r="21" fill="none" class="gp-guide-rim"/>
    <path d="M311 139 L320 153 L329 139" fill="none" class="gp-guide-mark"/>
    <circle class="gp-hot" cx="320" cy="146" r="21"/>
    <circle class="gp-ring" cx="320" cy="146" r="26"/>
  </g>
</svg>`;
}

/** Stick travel inside its well, in SVG units (a drawing may say otherwise). */
const STICK_TRAVEL = 12;

/** Stick axes in W3C order, as readVirtualPad gives them. */
const AXIS_ORDER = ['leftx', 'lefty', 'rightx', 'righty'];

/**
 * Live state of one drawn controller. `root` is the element holding
 * gamepadArtSvg()'s markup, or one of DeviceArt's.
 */
export class GamepadArtView {
    constructor(root) {
        this.root = root;
        this._ctl = new Map();
        for (const g of root.querySelectorAll('.gp-ctl')) {
            // One part may stand for several targets: a gimbal is "leftx lefty".
            for (const name of (g.getAttribute('data-ctl') || '').split(/\s+/)) {
                if (name) this._ctl.set(name, g);
            }
        }
        this._sticks = {};
        this._caps = {};
        this._travel = {};
        for (const side of ['left', 'right']) {
            const s = root.querySelector(`[data-stick="${side}"]`);
            this._sticks[side] = s;
            this._caps[side] = s ? s.querySelector('.gp-stick-cap') : null;
            this._travel[side] = (s && parseFloat(s.getAttribute('data-travel'))) || STICK_TRAVEL;
        }
        this._fills = {
            left: root.querySelector('[data-ctl="lefttrigger"] .gp-trigger-fill'),
            right: root.querySelector('[data-ctl="righttrigger"] .gp-trigger-fill'),
        };
        this._hooks = this._readHooks(root);
        this._target = null;
        // Last value drawn per control: the dialog redraws every frame, and a
        // filtered SVG re-rasterises on any attribute write, same value or not.
        this._drawn = new Map();
    }

    /**
     * The parts of a device that move otherwise than a stick or a trigger
     * (DeviceArt): a rim that turns, a toggle's lever, a pedal or a throttle
     * that slides. A drawing without them — the pad — has none.
     */
    _readHooks(root) {
        const hooks = [];
        const num = (el, n, d = 0) => {
            const v = parseFloat(el.getAttribute(n));
            return Number.isFinite(v) ? v : d;
        };
        for (const el of root.querySelectorAll('[data-rotate]')) {
            hooks.push({
                kind: 'rotate',
                el,
                target: el.getAttribute('data-rotate'),
                amp: num(el, 'data-amp', 30),
                cx: num(el, 'data-cx'),
                cy: num(el, 'data-cy'),
            });
        }
        for (const el of root.querySelectorAll('[data-lever]')) {
            hooks.push({
                kind: 'lever',
                el,
                target: el.getAttribute('data-lever'),
                cy: num(el, 'data-cy'),
                len: num(el, 'data-len', 24),
                stem: el.querySelector('.gp-lever-stem'),
                knob: el.querySelector('.gp-lever-knob'),
            });
        }
        for (const el of root.querySelectorAll('[data-press]')) {
            hooks.push({
                kind: 'press',
                el,
                target: el.getAttribute('data-press'),
                dx: num(el, 'data-dx'),
                dy: num(el, 'data-dy'),
            });
        }
        // Each its own entry in _drawn: two parts may follow the same target.
        hooks.forEach((h, i) => (h.key = `h:${i}`));
        return hooks;
    }

    _changed(k, v) {
        if (this._drawn.get(k) === v) return false;
        this._drawn.set(k, v);
        return true;
    }

    _el(ctl) {
        const own = this._ctl.get(ctl);
        if (own) return own;
        // A pad draws its stick axes on the stick.
        if (ctl === 'leftx' || ctl === 'lefty') return this._ctl.get('leftstick');
        if (ctl === 'rightx' || ctl === 'righty') return this._ctl.get('rightstick');
        return null;
    }

    /**
     * Draw a standard pad's state: `pad` = {buttons:[{pressed,value}], axes:[4]}
     * in W3C order (gamepadMapping.readVirtualPad, or a standard Gamepad) —
     * what the game receives, whatever the drawing.
     */
    render(pad, buttonTargets) {
        if (!pad) return this.clear();
        buttonTargets.forEach((t, i) => {
            const b = pad.buttons[i];
            this.setPressed(t, !!(b && b.pressed));
        });
        this.setTrigger('left', pad.buttons[6] ? pad.buttons[6].value : 0);
        this.setTrigger('right', pad.buttons[7] ? pad.buttons[7].value : 0);
        this.setStick('left', pad.axes[0] || 0, pad.axes[1] || 0);
        this.setStick('right', pad.axes[2] || 0, pad.axes[3] || 0);
        for (const h of this._hooks) this._drawHook(h, this._value(pad, buttonTargets, h.target));
    }

    clear() {
        for (const g of this._ctl.values()) g.classList.remove('is-pressed');
        this.setTrigger('left', 0);
        this.setTrigger('right', 0);
        this.setStick('left', 0, 0);
        this.setStick('right', 0, 0);
        for (const h of this._hooks) this._drawHook(h, 0);
    }

    /** What the game receives on `target`: an axis -1..1, a button or trigger 0..1. */
    _value(pad, buttonTargets, target) {
        const a = AXIS_ORDER.indexOf(target);
        if (a >= 0) return pad.axes[a] || 0;
        const b = pad.buttons[buttonTargets.indexOf(target)];
        return b ? b.value || (b.pressed ? 1 : 0) : 0;
    }

    /**
     * One hook at value `v`. A turn and a lever read a button or a trigger
     * from one end to the other (released = one end), an axis from its centre;
     * a press moves by v times its offset, full travel at 1.
     */
    _drawHook(h, v) {
        const axis = AXIS_ORDER.includes(h.target);
        const s = Math.max(-1, Math.min(1, axis ? v : 2 * v - 1));
        if (h.kind === 'rotate') {
            const tf = `rotate(${(s * h.amp).toFixed(1)} ${h.cx} ${h.cy})`;
            if (this._changed(h.key, tf)) h.el.setAttribute('transform', tf);
        } else if (h.kind === 'lever') {
            // The stem is drawn pointing down from the pivot: flipped by s.
            const k = s.toFixed(2);
            if (!this._changed(h.key, k)) return;
            if (h.stem) {
                h.stem.setAttribute(
                    'transform',
                    `translate(0 ${h.cy}) scale(1 ${k}) translate(0 ${-h.cy})`,
                );
            }
            if (h.knob) h.knob.setAttribute('transform', `translate(0 ${(s * h.len).toFixed(1)})`);
        } else {
            const p = Math.max(-1, Math.min(1, v));
            const tf = `translate(${(p * h.dx).toFixed(1)} ${(p * h.dy).toFixed(1)})`;
            if (this._changed(h.key, tf)) h.el.setAttribute('transform', tf);
        }
    }

    setPressed(ctl, on) {
        if (!this._changed(`p:${ctl}`, on)) return;
        const g = this._el(ctl);
        if (g) g.classList.toggle('is-pressed', on);
    }

    setStick(side, x, y) {
        const cap = this._caps[side];
        if (!cap) return;
        const travel = this._travel[side];
        const cx = Math.max(-1, Math.min(1, x)) * travel;
        const cy = Math.max(-1, Math.min(1, y)) * travel;
        const tf = `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`;
        if (!this._changed(`s:${side}`, tf)) return;
        cap.setAttribute('transform', tf);
        const g = this._sticks[side];
        if (g) g.classList.toggle('is-moved', Math.hypot(x, y) > 0.35);
    }

    setTrigger(side, v) {
        const r = this._fills[side];
        if (!r) return;
        const f = Math.round(Math.max(0, Math.min(1, v || 0)) * 100) / 100;
        if (!this._changed(`t:${side}`, f)) return;
        // Fills from the bottom of the trigger up.
        r.setAttribute('y', String(110 - 90 * f));
        r.setAttribute('height', String(90 * f));
    }

    /** The wizard's current control (null for none); stick axes show an arrow. */
    setTarget(ctl) {
        if (this._target) {
            const prev = this._el(this._target);
            if (prev) prev.classList.remove('is-target', 'is-target-x', 'is-target-y');
        }
        this._target = ctl;
        const g = ctl ? this._el(ctl) : null;
        if (!g) return;
        g.classList.add('is-target');
        if (ctl.endsWith('x') && ctl !== 'x') g.classList.add('is-target-x');
        if (ctl.endsWith('y') && ctl !== 'y') g.classList.add('is-target-y');
    }

    setMapped(ctl, on) {
        const g = this._el(ctl);
        if (g) g.classList.toggle('is-mapped', on);
    }

    clearMarks() {
        for (const g of this._ctl.values()) g.classList.remove('is-mapped');
        this.setTarget(null);
    }
}
