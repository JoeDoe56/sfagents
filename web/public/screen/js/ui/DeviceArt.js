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
 * DeviceArt — the devices that are not pads (gamepadMapping.PAD_KINDS), drawn
 * the way they are held: a radio's two gimbals and its switches, a flight
 * stick's grip and throttle, a wheel's rim and its pedals. The pad itself is
 * GamepadArt.
 *
 * Same contract as GamepadArt, so GamepadArtView drives them unchanged:
 *   - every control is a `<g class="gp-ctl" data-ctl="…">` holding `.gp-hot`
 *     (lit when pressed) and `.gp-ring` (the wizard's step); `data-ctl` may
 *     name several targets ("leftx lefty" for a gimbal);
 *   - a stick cap is `[data-stick="left|right"] .gp-stick-cap`, its travel in
 *     `data-travel`;
 *   - ids are suffixed per instance.
 * And three hooks of their own, read by GamepadArtView:
 *   - `data-rotate="<target>"` with data-amp (degrees at full travel) and the
 *     centre data-cx/data-cy: a rim, a grip that tilts;
 *   - `data-lever="<target>"` with data-cy (pivot) and data-len: a toggle seen
 *     from the front, its `.gp-lever-stem` and `.gp-lever-knob` going from up
 *     (released) through the middle to down (full);
 *   - `data-press="<target>"` with data-dx/data-dy (the offset at full travel):
 *     a pedal pressed, a throttle or a notch that slides.
 *
 * Every control carries a small label — LT, A, LS — for what the game
 * receives from it: the host presents an Xbox 360 pad, whatever the device.
 */

import { gamepadArtSvg } from './GamepadArt.js';
import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../util/escapeHtml.js';

let seq = 0;

/** The gradients and shadow all three share, under this instance's ids. */
function defs(id) {
    return `
  <defs>
    <linearGradient id="${id('shell')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#253140"/>
      <stop offset=".45" stop-color="#151d27"/>
      <stop offset="1" stop-color="#080b10"/>
    </linearGradient>
    <linearGradient id="${id('plate')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2531"/>
      <stop offset="1" stop-color="#0c1117"/>
    </linearGradient>
    <radialGradient id="${id('well')}" cx=".5" cy=".42" r=".6">
      <stop offset="0" stop-color="#020304"/>
      <stop offset=".75" stop-color="#06090c"/>
      <stop offset="1" stop-color="#1a232e"/>
    </radialGradient>
    <radialGradient id="${id('capside')}" cx=".45" cy=".35" r=".7">
      <stop offset="0" stop-color="#4a5868"/>
      <stop offset="1" stop-color="#0c1117"/>
    </radialGradient>
    <radialGradient id="${id('capface')}" cx=".5" cy=".65" r=".65">
      <stop offset="0" stop-color="#2f3a47"/>
      <stop offset="1" stop-color="#11171f"/>
    </radialGradient>
    <radialGradient id="${id('face')}" cx=".42" cy=".32" r=".75">
      <stop offset="0" stop-color="#2c3643"/>
      <stop offset="1" stop-color="#0b0f14"/>
    </radialGradient>
    <linearGradient id="${id('metal')}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2a333d"/>
      <stop offset=".5" stop-color="#55626f"/>
      <stop offset="1" stop-color="#232b34"/>
    </linearGradient>
    <linearGradient id="${id('rim')}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b3540"/>
      <stop offset=".5" stop-color="#11171e"/>
      <stop offset="1" stop-color="#1f2832"/>
    </linearGradient>
    <radialGradient id="${id('sheen')}" cx=".5" cy=".12" r=".7">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".14"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id('drop')}" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#000" flood-opacity=".6"/>
    </filter>
  </defs>`;
}

/**
 * What the game receives from a control, as a small pill. `dir` adds a
 * drawn double arrow — 'h' for a stick's X, 'v' for its Y: the UI font has
 * no ↔ to rely on.
 */
function label(x, y, text, dir = '') {
    const tw = text.length * 7.4;
    const w = Math.max(26, tw + 12 + (dir ? 16 : 0));
    const tx = dir ? x - 8 : x;
    let arrow = '';
    if (dir === 'h') {
        const a = tx + tw / 2 + 4;
        arrow = `<path class="gp-label-arrow" d="M${a} ${y} h11 M${a} ${y} l3 -3 M${a} ${y} l3 3 M${a + 11} ${y} l-3 -3 M${a + 11} ${y} l-3 3"/>`;
    } else if (dir === 'v') {
        const a = tx + tw / 2 + 9;
        arrow = `<path class="gp-label-arrow" d="M${a} ${y - 6} v12 M${a} ${y - 6} l-3 3 M${a} ${y - 6} l3 3 M${a} ${y + 6} l-3 -3 M${a} ${y + 6} l3 -3"/>`;
    }
    return `
    <g class="gp-label">
      <rect x="${x - w / 2}" y="${y - 9}" width="${w}" height="18" rx="9"/>
      <text x="${tx}" y="${y + 4}">${text}</text>
      ${arrow}
    </g>`;
}

/** A small button named after what it gives the game (A, LB, Start…). */
function key(url, ctl, x, y, text, w = 40, h = 22) {
    const tint = ['a', 'b', 'x', 'y'].includes(ctl) ? ` gp-face-${ctl}` : '';
    return `
    <g class="gp-ctl gp-key" data-ctl="${ctl}">
      <rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${url('face')}" stroke="rgba(0,0,0,.8)"/>
      <rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="none" class="gp-face-rim"/>
      <rect class="gp-hot" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}"/>
      <text x="${x}" y="${y + 4}" class="gp-key-text${tint}">${text}</text>
      <rect class="gp-ring" x="${x - w / 2 - 4}" y="${y - h / 2 - 4}" width="${w + 8}" height="${h + 8}" rx="${h / 2 + 4}"/>
    </g>`;
}

/** One way of a hat or a d-pad: a small arrow button, `rot` from "up". */
function hatWay(url, ctl, x, y, rot, size = 9) {
    const s = size;
    const d = `M${x} ${y - s} L${x + s} ${y + s * 0.6} L${x - s} ${y + s * 0.6} Z`;
    return `
    <g class="gp-ctl gp-hat" data-ctl="${ctl}" transform="rotate(${rot} ${x} ${y + s * 0.1})">
      <path d="${d}" fill="${url('face')}" stroke="rgba(0,0,0,.8)"/>
      <path d="${d}" class="gp-hat-mark"/>
      <path class="gp-hot" d="${d}"/>
      <circle class="gp-ring" cx="${x}" cy="${y}" r="${s + 5}"/>
    </g>`;
}

/** A toggle switch seen from the front, giving `ctl` (LT or RT on a radio). */
function toggle(ctl, x, y, len = 26) {
    return `
    <g class="gp-ctl gp-switch" data-ctl="${ctl}">
      <rect x="${x - 15}" y="${y - 13}" width="30" height="26" rx="7" class="gp-switch-base"/>
      <rect class="gp-hot" x="${x - 15}" y="${y - 13}" width="30" height="26" rx="7"/>
      <g data-lever="${ctl}" data-cy="${y}" data-len="${len}">
        <path class="gp-lever-stem" d="M${x} ${y} L${x} ${y + len}"/>
        <circle class="gp-lever-knob" cx="${x}" cy="${y}" r="7.5"/>
      </g>
      <circle cx="${x}" cy="${y}" r="5" class="gp-switch-pivot"/>
      <rect class="gp-ring" x="${x - 21}" y="${y - len - 13}" width="42" height="${2 * len + 26}" rx="14"/>
    </g>`;
}

/** A radio gimbal: a square plate, its opening, the stick end moving in it. */
function gimbal(url, side, cx, cy, upArrow) {
    const c = side === 'left' ? 'leftx lefty' : 'rightx righty';
    const arrowY = upArrow
        ? `M${cx - 9} ${cy - 78} l9 -11 l9 11 z`
        : `M${cx - 9} ${cy + 76} l9 10 l9 -10 z`;
    return `
    <g class="gp-ctl gp-gimbal" data-ctl="${c}" data-stick="${side}" data-travel="34">
      <rect x="${cx - 66}" y="${cy - 66}" width="132" height="132" rx="20" fill="${url('plate')}" class="gp-gimbal-plate"/>
      <circle cx="${cx}" cy="${cy}" r="56" fill="${url('well')}"/>
      <circle cx="${cx}" cy="${cy}" r="56" fill="none" class="gp-well-rim"/>
      <path d="M${cx - 50} ${cy} H${cx + 50} M${cx} ${cy - 50} V${cy + 50}" class="gp-gimbal-cross"/>
      <g class="gp-stick-cap">
        <circle cx="${cx}" cy="${cy + 3}" r="19" fill="rgba(0,0,0,.55)"/>
        <circle cx="${cx}" cy="${cy}" r="18" fill="${url('capside')}"/>
        <circle cx="${cx}" cy="${cy}" r="12.5" fill="${url('capface')}"/>
        <circle cx="${cx}" cy="${cy}" r="15" fill="none" class="gp-cap-grip"/>
        <ellipse cx="${cx - 5}" cy="${cy - 7}" rx="7" ry="4" class="gp-spec"/>
        <circle class="gp-hot" cx="${cx}" cy="${cy}" r="18"/>
      </g>
      <rect class="gp-ring" x="${cx - 72}" y="${cy - 72}" width="144" height="144" rx="24"/>
      <g class="gp-arrows">
        <path class="gp-arrow" data-dir="x" d="M${cx + 78} ${cy - 9} l12 9 l-12 9 z"/>
        <path class="gp-arrow" data-dir="y" d="${arrowY}"/>
      </g>
    </g>`;
}

/** A radio control, front view: Mode 2 gimbals, CH5/CH6 switches, CH9-16 buttons. */
export function rcArtSvg() {
    const u = `rc${++seq}`;
    const id = (n) => `${u}-${n}`;
    const url = (n) => `url(#${id(n)})`;
    const BODY =
        'M176 84 C210 70 262 64 320 64 C378 64 430 70 464 84 C506 100 524 128 526 170 ' +
        'L530 332 C532 384 500 412 452 414 L188 414 C140 412 108 384 110 332 L114 170 ' +
        'C116 128 134 100 176 84 Z';
    return `
<svg class="gp-art gp-art-rc" viewBox="0 0 640 440" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  ${defs(id)}
  <ellipse cx="320" cy="424" rx="210" ry="12" class="gp-floor"/>
  <path d="M272 70 L272 32 Q272 20 284 20 L356 20 Q368 20 368 32 L368 70" fill="none" class="gp-handle"/>
  <g filter="${url('drop')}">
    <path d="${BODY}" fill="${url('shell')}"/>
  </g>
  <path d="${BODY}" fill="${url('sheen')}"/>
  <path d="${BODY}" fill="none" class="gp-edge"/>

  ${toggle('lefttrigger', 180, 124)}
  ${label(140, 128, 'LT')}
  ${toggle('righttrigger', 460, 124)}
  ${label(500, 128, 'RT')}

  ${gimbal(url, 'left', 226, 214, true)}
  ${gimbal(url, 'right', 414, 214, false)}
  ${label(226, 310, 'LS')}
  ${label(414, 310, 'RS')}

  <rect x="286" y="318" width="68" height="62" rx="7" class="gp-screen"/>
  <path d="M296 334 H344 M296 348 H330 M296 362 H338" class="gp-screen-lines"/>

  ${key(url, 'leftshoulder', 172, 336, 'LB')}
  ${key(url, 'back', 226, 336, 'Back', 46)}
  ${key(url, 'start', 414, 336, 'Start', 46)}
  ${key(url, 'rightshoulder', 468, 336, 'RB')}
  ${key(url, 'x', 196, 376, 'X', 34)}
  ${key(url, 'a', 250, 376, 'A', 34)}
  ${key(url, 'b', 390, 376, 'B', 34)}
  ${key(url, 'y', 444, 376, 'Y', 34)}
</svg>`;
}

/** A flight stick and its throttle: grip, twist, hat and trigger; the throttle's slide. */
export function flightstickArtSvg() {
    const u = `fs${++seq}`;
    const id = (n) => `${u}-${n}`;
    const url = (n) => `url(#${id(n)})`;
    // The grip as the pilot sees it: straight on the thumb's side, a palm
    // swell on the other, the trigger hooked out under a head that is a block
    // of buttons leaning to the thumb — no smooth shaft, no rounded top.
    const GRIP =
        'M446 278 C440 256 434 232 436 212 C437 198 440 188 444 182 L490 180 ' +
        'C497 192 502 212 500 234 C498 254 492 268 486 278 Z';
    const PALM = 'M452 200 C463 196 477 196 488 200 L490 246 C478 252 462 252 452 246 Z';
    const HEAD =
        'M420 142 L428 114 C430 107 435 104 442 103 L494 99 C501 99 505 103 507 109 ' +
        'L513 140 C515 150 512 158 505 166 L494 178 C490 182 486 184 480 184 L450 184 ' +
        'C443 184 438 181 434 175 Z';
    const TRIGGER =
        'M441 196 C427 195 416 205 416 219 C416 228 424 231 427 223 C429 214 434 209 442 208 Z';
    // The rubber boot the grip goes into: folds narrowing to the top.
    const BOOT = [
        [46, 280],
        [56, 291],
        [66, 302],
        [76, 313],
    ]
        .map(
            ([w, y]) => `
    <rect x="${465 - w / 2}" y="${y}" width="${w}" height="14" rx="7" fill="${url('shell')}" stroke="rgba(0,0,0,.85)"/>
    <path d="M${465 - w / 2 + 6} ${y + 2.5} H${465 + w / 2 - 6}" class="gp-boot-fold"/>`,
        )
        .join('');
    return `
<svg class="gp-art gp-art-flightstick" viewBox="0 0 640 440" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  ${defs(id)}
  <ellipse cx="320" cy="424" rx="260" ry="12" class="gp-floor"/>

  <!-- Throttle: its body, the slot, the handle sliding in it (up is forward). -->
  <g filter="${url('drop')}">
    <rect x="66" y="120" width="168" height="286" rx="22" fill="${url('shell')}"/>
  </g>
  <rect x="66" y="120" width="168" height="286" rx="22" fill="none" class="gp-edge"/>
  <g class="gp-ctl gp-throttle" data-ctl="lefty">
    <rect x="141" y="140" width="18" height="212" rx="9" fill="${url('well')}"/>
    <rect class="gp-ring" x="80" y="128" width="140" height="234" rx="18"/>
    <g class="gp-arrows">
      <path class="gp-arrow" data-dir="y" d="M141 136 l9 -11 l9 11 z"/>
    </g>
  </g>
  <g data-press="lefty" data-dy="76">
    <rect x="144" y="262" width="12" height="36" fill="${url('metal')}"/>
    <rect x="88" y="215" width="124" height="62" rx="16" fill="${url('plate')}" stroke="rgba(0,0,0,.8)"/>
    <rect x="88" y="215" width="124" height="62" rx="16" fill="none" class="gp-face-rim"/>
  </g>
  <g data-press="lefty" data-dy="76">
    ${key(url, 'leftshoulder', 114, 246, 'LB', 34, 20)}
    ${key(url, 'lefttrigger', 150, 246, 'LT', 30, 20)}
    ${key(url, 'rightshoulder', 186, 246, 'RB', 34, 20)}
  </g>
  ${label(150, 372, 'LS', 'v')}
  ${key(url, 'back', 104, 394, 'Back', 44, 18)}
  ${key(url, 'start', 196, 394, 'Start', 44, 18)}

  <!-- Stick: a heavy base and its square plate; the grip tilts in its boot. -->
  <g filter="${url('drop')}">
    <rect x="330" y="340" width="270" height="66" rx="22" fill="${url('shell')}"/>
  </g>
  <rect x="330" y="340" width="270" height="66" rx="22" fill="none" class="gp-edge"/>
  <path d="M408 346 L420 322 H510 L522 346 Z" fill="${url('plate')}" class="gp-gimbal-plate"/>
  <circle cx="425" cy="339" r="2" class="gp-screw"/>
  <circle cx="505" cy="339" r="2" class="gp-screw"/>

  <g class="gp-ctl gp-grip" data-ctl="rightx righty">
    <rect class="gp-ring" x="402" y="90" width="126" height="242" rx="28"/>
    <g class="gp-arrows">
      <path class="gp-arrow" data-dir="x" d="M536 196 l12 9 l-12 9 z"/>
      <path class="gp-arrow" data-dir="y" d="M533 232 l9 12 l9 -12 z"/>
    </g>
  </g>
  <g data-rotate="rightx" data-amp="16" data-cx="465" data-cy="318">
    <rect x="452" y="262" width="26" height="40" rx="3" fill="${url('metal')}"/>
    <path d="${GRIP}" fill="${url('shell')}" stroke="rgba(0,0,0,.8)"/>
    <path d="${GRIP}" fill="none" class="gp-face-rim"/>
    <path d="${PALM}" class="gp-grip-pad"/>
    <g class="gp-ctl gp-trigger-hook" data-ctl="righttrigger">
      <path d="${TRIGGER}" fill="${url('metal')}" stroke="rgba(0,0,0,.8)"/>
      <path class="gp-hot" d="${TRIGGER}"/>
      <circle class="gp-ring" cx="427" cy="214" r="19"/>
    </g>
    <g data-press="righty" data-dy="10">
      <path d="${HEAD}" fill="${url('plate')}" stroke="rgba(0,0,0,.8)"/>
      <path d="${HEAD}" fill="none" class="gp-face-rim"/>
      ${hatWay(url, 'dpup', 447, 121, 0, 6)}
      ${hatWay(url, 'dpright', 460, 134, 90, 6)}
      ${hatWay(url, 'dpdown', 447, 147, 180, 6)}
      ${hatWay(url, 'dpleft', 434, 134, 270, 6)}
      ${key(url, 'a', 489, 121, 'A', 22, 16)}
      ${key(url, 'b', 489, 147, 'B', 22, 16)}
    </g>
  </g>
  ${BOOT}
  ${label(465, 80, 'RS')}
  ${label(384, 214, 'RT')}

  <g class="gp-ctl gp-twist" data-ctl="leftx">
    <path d="M410 372 Q465 392 520 372" class="gp-twist-band"/>
    <g data-press="leftx" data-dx="48">
      <circle cx="465" cy="382" r="6" class="gp-twist-notch"/>
    </g>
    <rect class="gp-ring" x="400" y="360" width="130" height="34" rx="14"/>
    <g class="gp-arrows">
      <path class="gp-arrow" data-dir="x" d="M532 366 l12 9 l-12 9 z"/>
    </g>
  </g>
  ${label(568, 372, 'LS', 'h')}
  ${key(url, 'x', 362, 372, 'X', 30, 20)}
  ${key(url, 'y', 362, 396, 'Y', 30, 20)}
  ${key(url, 'leftstick', 588, 396, 'L3', 30, 20)}
  ${key(url, 'rightstick', 548, 396, 'R3', 30, 20)}
</svg>`;
}

/** A wheel and its pedals: the rim turns, the pedals go down, the clutch is not used. */
export function wheelArtSvg() {
    const u = `wh${++seq}`;
    const id = (n) => `${u}-${n}`;
    const url = (n) => `url(#${id(n)})`;
    const CX = 320;
    const CY = 160;
    // The steering axis spans the range set in G HUB, 900° by default — the
    // whole travel of a G29 or a G923: drawn so, the rim turns as far as the
    // wheel in hand. A range set narrower turns it further.
    const LOCK = 900;
    // The clutch has nowhere to go on an Xbox pad: drawn, greyed, no control.
    const pedal = (ctl, cx, w, h, text) => `
    <g class="${ctl ? 'gp-ctl ' : ''}gp-pedal${ctl ? '' : ' gp-unbound'}"${ctl ? ` data-ctl="${ctl}"` : ''}>
      <rect x="${cx - w / 2 - 6}" y="${430 - 12}" width="${w + 12}" height="12" rx="4" fill="${url('plate')}"/>
      <g${ctl ? ` data-press="${ctl}" data-dy="12"` : ''}>
        <rect x="${cx - w / 2}" y="${330}" width="${w}" height="${h}" rx="10" fill="${url('metal')}" stroke="rgba(0,0,0,.8)"/>
        <path d="M${cx - w / 2 + 8} ${346} H${cx + w / 2 - 8} M${cx - w / 2 + 8} ${358} H${cx + w / 2 - 8} M${cx - w / 2 + 8} ${370} H${cx + w / 2 - 8}" class="gp-pedal-grip"/>
        <rect class="gp-hot" x="${cx - w / 2}" y="${330}" width="${w}" height="${h}" rx="10"/>
        ${text ? `<text x="${cx}" y="${330 + h - 12}" class="gp-pedal-text">${text}</text>` : ''}
      </g>
      ${ctl ? `<rect class="gp-ring" x="${cx - w / 2 - 6}" y="324" width="${w + 12}" height="${h + 26}" rx="14"/>` : ''}
    </g>`;
    const paddle = (ctl, x, mirror) => `
    <g class="gp-ctl gp-paddle" data-ctl="${ctl}"${mirror ? ` transform="translate(${2 * CX} 0) scale(-1 1)"` : ''}>
      <path d="M${x} 98 C${x - 22} 104 ${x - 30} 134 ${x - 26} 170 C${x - 22} 196 ${x - 6} 206 ${x + 10} 202 L${x + 22} 112 C${x + 18} 100 ${x + 10} 96 ${x} 98 Z"
            fill="${url('metal')}" stroke="rgba(0,0,0,.8)"/>
      <path class="gp-hot" d="M${x} 98 C${x - 22} 104 ${x - 30} 134 ${x - 26} 170 C${x - 22} 196 ${x - 6} 206 ${x + 10} 202 L${x + 22} 112 C${x + 18} 100 ${x + 10} 96 ${x} 98 Z"/>
      <path class="gp-ring" d="M${x} 92 C${x - 28} 100 ${x - 36} 134 ${x - 32} 172 C${x - 28} 202 ${x - 6} 214 ${x + 14} 208 L${x + 28} 110 C${x + 22} 96 ${x + 12} 90 ${x} 92 Z"/>
    </g>`;
    return `
<svg class="gp-art gp-art-wheel" viewBox="0 0 640 440" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  ${defs(id)}
  <ellipse cx="320" cy="430" rx="190" ry="10" class="gp-floor"/>

  ${paddle('leftshoulder', 190, false)}
  ${paddle('rightshoulder', 190, true)}
  ${label(132, 150, 'LB')}
  ${label(508, 150, 'RB')}

  <!-- The rim turns with the steering; the hub and its buttons stay readable. -->
  <g class="gp-ctl gp-rim" data-ctl="leftx">
    <g data-rotate="leftx" data-amp="${LOCK / 2}" data-cx="${CX}" data-cy="${CY}" filter="${url('drop')}">
      <circle cx="${CX}" cy="${CY}" r="127" fill="none" stroke="${url('rim')}" stroke-width="26"/>
      <circle cx="${CX}" cy="${CY}" r="140" fill="none" class="gp-rim-edge"/>
      <circle cx="${CX}" cy="${CY}" r="114" fill="none" class="gp-rim-edge"/>
      <rect x="${CX - 6}" y="${CY - 140}" width="12" height="26" rx="3" class="gp-rim-mark"/>
    </g>
    <circle class="gp-ring" cx="${CX}" cy="${CY}" r="148"/>
    <g class="gp-arrows">
      <path class="gp-arrow" data-dir="x" d="M${CX + 150} ${CY - 98} l14 2 l-6 12 z"/>
    </g>
  </g>
  ${label(CX + 172, CY + 40, 'LS', 'h')}

  <path d="M${CX - 114} ${CY - 6} L${CX - 64} ${CY - 12} L${CX - 64} ${CY + 30} L${CX - 112} ${CY + 30} Z" fill="${url('shell')}" class="gp-spoke"/>
  <path d="M${CX + 114} ${CY - 6} L${CX + 64} ${CY - 12} L${CX + 64} ${CY + 30} L${CX + 112} ${CY + 30} Z" fill="${url('shell')}" class="gp-spoke"/>
  <path d="M${CX - 24} ${CY + 66} L${CX + 24} ${CY + 66} L${CX + 30} ${CY + 112} L${CX - 30} ${CY + 112} Z" fill="${url('shell')}" class="gp-spoke"/>
  <rect x="${CX - 76}" y="${CY - 40}" width="152" height="108" rx="34" fill="${url('shell')}" stroke="rgba(0,0,0,.8)"/>
  <rect x="${CX - 76}" y="${CY - 40}" width="152" height="108" rx="34" fill="none" class="gp-edge"/>

  ${hatWay(url, 'dpup', CX - 44, CY - 4, 0)}
  ${hatWay(url, 'dpright', CX - 26, CY + 12, 90)}
  ${hatWay(url, 'dpdown', CX - 44, CY + 30, 180)}
  ${hatWay(url, 'dpleft', CX - 62, CY + 12, 270)}
  ${key(url, 'y', CX + 44, CY - 6, 'Y', 22, 20)}
  ${key(url, 'x', CX + 24, CY + 14, 'X', 22, 20)}
  ${key(url, 'b', CX + 64, CY + 14, 'B', 22, 20)}
  ${key(url, 'a', CX + 44, CY + 34, 'A', 22, 20)}
  ${key(url, 'back', CX - 24, CY - 26, 'Back', 40, 16)}
  ${key(url, 'start', CX + 24, CY - 26, 'Start', 40, 16)}
  ${key(url, 'guide', CX, CY + 52, 'Guide', 46, 16)}
  ${key(url, 'leftstick', CX - 18, CY + 86, 'L3', 26, 18)}
  ${key(url, 'rightstick', CX + 18, CY + 86, 'R3', 26, 18)}

  ${pedal(null, 220, 58, 78, '')}
  ${pedal('lefttrigger', 320, 64, 80, 'LT')}
  ${pedal('righttrigger', 420, 54, 92, 'RT')}
</svg>`;
}

/**
 * A TV remote, standing: what each key does in MoonlightWeb, not a pad's
 * names — the game never sees a pad (gamepadMapping.isTvRemoteId). Its arrows
 * are the arrow keys (dpup…: they reach the page as a pad's buttons 12-15),
 * OK is Enter and, held, the stream's menu; Ch± are Page Up and Page Down,
 * the colour keys go back, the digits type. Back, Home, the volume and the
 * power key stay the TV's: greyed. Lit by the remap dialog from the pad and
 * from the keys (data-ctl ok, chup, chdown, colour, digits).
 */
export function remoteArtSvg() {
    const u = `tv${++seq}`;
    const id = (n) => `${u}-${n}`;
    const url = (n) => `url(#${id(n)})`;
    const CX = 320;
    const PAD_Y = 228;
    const BODY =
        'M262 22 L378 22 C392 22 400 30 400 44 L398 398 C398 412 390 420 376 420 ' +
        'L264 420 C250 420 242 412 242 398 L240 44 C240 30 248 22 262 22 Z';
    const round = (ctl, cx, cy, r, text = '', extra = '') => `
    <g class="${ctl ? 'gp-ctl ' : ''}gp-tv-key${extra}"${ctl ? ` data-ctl="${ctl}"` : ''}>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${url('face')}" stroke="rgba(0,0,0,.8)"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" class="gp-face-rim"/>
      ${ctl ? `<circle class="gp-hot" cx="${cx}" cy="${cy}" r="${r}"/>` : ''}
      ${text ? `<text x="${cx}" y="${cy + 4}" class="gp-key-text">${text}</text>` : ''}
      ${ctl ? `<circle class="gp-ring" cx="${cx}" cy="${cy}" r="${r + 5}"/>` : ''}
    </g>`;
    // The digits: one control, lit by any of them.
    let digits = '';
    for (let i = 0; i < 10; i++) {
        const col = i === 9 ? 1 : i % 3;
        const row = i === 9 ? 3 : Math.floor(i / 3);
        const x = CX - 40 + col * 40;
        const y = 78 + row * 26;
        digits += `
      <circle cx="${x}" cy="${y}" r="10" fill="${url('face')}" stroke="rgba(0,0,0,.8)"/>
      <circle class="gp-hot" cx="${x}" cy="${y}" r="10"/>
      <text x="${x}" y="${y + 4}" class="gp-key-text">${(i + 1) % 10}</text>`;
    }
    const COLOURS = ['red', 'green', 'yellow', 'blue'];
    const colours = COLOURS.map(
        (c, i) => `
      <rect x="${CX - 58 + i * 30}" y="383" width="26" height="14" rx="5" class="gp-tv-colour gp-tv-${c}"/>
      <rect class="gp-hot" x="${CX - 58 + i * 30}" y="383" width="26" height="14" rx="5"/>`,
    ).join('');
    const rocker = (top, bottom, x, text) => `
    <g class="gp-tv-rocker${top ? '' : ' gp-unbound'}">
      <rect x="${x - 15}" y="306" width="30" height="66" rx="15" fill="${url('face')}" stroke="rgba(0,0,0,.8)"/>
      ${top ? `<g class="gp-ctl" data-ctl="${top}"><path class="gp-hot" d="M${x - 15} 339 V321 A15 15 0 0 1 ${x + 15} 321 V339 Z"/><circle class="gp-ring" cx="${x}" cy="322" r="17"/></g>` : ''}
      ${bottom ? `<g class="gp-ctl" data-ctl="${bottom}"><path class="gp-hot" d="M${x - 15} 339 V357 A15 15 0 0 0 ${x + 15} 357 V339 Z"/><circle class="gp-ring" cx="${x}" cy="356" r="17"/></g>` : ''}
      <text x="${x}" y="326" class="gp-key-text">+</text>
      <text x="${x}" y="361" class="gp-key-text">−</text>
      <text x="${x}" y="344" class="gp-key-text gp-tv-rocker-text">${text}</text>
    </g>`;
    return `
<svg class="gp-art gp-art-remote" viewBox="0 0 640 440" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  ${defs(id)}
  <ellipse cx="${CX}" cy="430" rx="110" ry="8" class="gp-floor"/>
  <g filter="${url('drop')}">
    <path d="${BODY}" fill="${url('shell')}"/>
  </g>
  <path d="${BODY}" fill="${url('sheen')}"/>
  <path d="${BODY}" fill="none" class="gp-edge"/>

  ${round(null, CX - 46, 46, 9, '', ' gp-unbound gp-tv-power')}

  <g class="gp-ctl gp-tv-digits" data-ctl="digits">${digits}
    <rect class="gp-ring" x="${CX - 56}" y="62" width="112" height="104" rx="14"/>
  </g>
  ${label(CX + 140, 120, escapeHtml(t('gamepad.remote.digits')))}

  <circle cx="${CX}" cy="${PAD_Y}" r="56" fill="${url('plate')}" class="gp-gimbal-plate"/>
  ${hatWay(url, 'dpup', CX, PAD_Y - 38, 0, 9)}
  ${hatWay(url, 'dpright', CX + 38, PAD_Y, 90, 9)}
  ${hatWay(url, 'dpdown', CX, PAD_Y + 38, 180, 9)}
  ${hatWay(url, 'dpleft', CX - 38, PAD_Y, 270, 9)}
  ${round('ok', CX, PAD_Y, 22, 'OK')}
  ${label(CX + 150, PAD_Y - 24, escapeHtml(t('gamepad.remote.arrows')))}
  ${label(CX - 152, PAD_Y - 10, escapeHtml(t('gamepad.remote.ok')))}
  ${label(CX - 152, PAD_Y + 14, escapeHtml(t('gamepad.remote.okHold')))}

  ${round(null, CX - 36, 282, 12, '', ' gp-unbound')}
  ${round(null, CX + 36, 282, 12, '', ' gp-unbound')}
  ${rocker(null, null, CX - 36, 'VOL')}
  ${rocker('chup', 'chdown', CX + 36, 'CH')}
  ${label(CX + 150, 339, escapeHtml(t('gamepad.remote.channel')))}
  ${label(CX - 152, 300, escapeHtml(t('gamepad.remote.tvKeys')))}

  <g class="gp-ctl gp-tv-colours" data-ctl="colour">${colours}
    <rect class="gp-ring" x="${CX - 64}" y="377" width="128" height="26" rx="9"/>
  </g>
  ${label(CX + 150, 390, escapeHtml(t('gamepad.remote.colour')))}
</svg>`;
}

/** The drawing of a device of this kind (the pad for 'gamepad' or anything unknown). */
export function deviceArtSvg(kind) {
    if (kind === 'remote') return remoteArtSvg();
    if (kind === 'rc') return rcArtSvg();
    if (kind === 'flightstick') return flightstickArtSvg();
    if (kind === 'wheel') return wheelArtSvg();
    return gamepadArtSvg();
}

/** Line icons of each kind, 20×20, drawn in the text colour. */
const KIND_ICONS = {
    gamepad:
        '<path d="M6 7.5h8a4 4 0 0 1 3.9 4.9l-.6 2.4a1.8 1.8 0 0 1-3.1.8L12.5 13.5h-5l-1.7 2.1a1.8 1.8 0 0 1-3.1-.8l-.6-2.4A4 4 0 0 1 6 7.5Z"/>' +
        '<path d="M6.5 9.5v2.5M5.25 10.75h2.5"/><path d="M13.5 10h.01M15 11.5h.01"/>',
    rc:
        '<rect x="3" y="7.5" width="14" height="9.5" rx="2"/><path d="M10 7.5V2.5"/>' +
        '<circle cx="7" cy="12" r="1.7"/><circle cx="13" cy="12" r="1.7"/>',
    // Seen from the side, the head jutting forward over the trigger.
    flightstick:
        '<path d="M8.8 13.5C8.2 11 8 8.5 8.6 6.2 9 4.4 10 3.2 11.6 3l2.8-.2c1 0 1.4.8 1 1.6l-1.2 2c-.4.6-1 .8-1.6 1-.4 2-.6 4.2-.4 6.1"/>' +
        '<path d="M12.6 8.3c1.1.2 1.6 1.2 1.2 2.2"/>' +
        '<path d="M8.2 15.5l.6-2h3.4l.6 2"/><rect x="3.5" y="15.5" width="13" height="2.5" rx="1"/>',
    wheel:
        '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="2"/>' +
        '<path d="M2.6 8.6 8 9.5M17.4 8.6 12 9.5M10 12v5.5"/>',
    remote:
        '<rect x="6" y="1.5" width="8" height="17" rx="2.5"/><circle cx="10" cy="8" r="2.2"/>' +
        '<path d="M8.2 13h.01M11.8 13h.01M8.2 15.5h.01M11.8 15.5h.01"/>',
};

/** A small icon of a device kind, for lists (Settings → Controllers). */
export function kindIconSvg(kind) {
    return (
        '<svg class="pad-kind-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" ' +
        'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        (KIND_ICONS[kind] || KIND_ICONS.gamepad) +
        '</svg>'
    );
}
