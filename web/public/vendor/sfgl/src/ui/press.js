/**
 * iOS 26 button presses: a held button grows (a bigger share for small round
 * buttons, a few points for wide ones), its glass lifts to a light grey, and
 * on release it springs back with a little bounce.
 *
 * Glass buttons use the lens's press highlight and are re-measured on every
 * frame of the spring so the glass follows the scale; other buttons lighten
 * with a class. List rows, menu items and similar keep their own highlight
 * (as iOS does): give them `data-press="none"`, or pass `exclude`.
 * @module
 */

import {lensFor, pose, spring, reducedMotion} from './core.js';

const SELECTOR = 'button, [role="button"], a.sf-press, .sf-press';
const EXCLUDE = '[data-press="none"], .sf-sheet-grab, .sf-row, .sf-menu-item, .sf-segment, .sf-tab, :disabled, [aria-disabled="true"]';

const pressIn = spring(0.26, 0.72);
const release = spring(0.42, 0.52);
const active = new Map(); // element → { scale, glow, raf, last, found, down, big }

function animate(el) {
  const s = active.get(el);
  if (!s) return;
  cancelAnimationFrame(s.raf);
  const p = pose(el);
  const tick = (now) => {
    const dt = Math.min(0.05, (now - s.last) / 1000);
    s.last = now;
    const step = s.down ? pressIn : release;
    const doneScale = step(s.scale, s.down ? s.big : 1, dt);
    const doneGlow = step(s.glow, s.down ? 1 : 0, dt);
    p.press = s.scale.x;
    p.commit();
    if (s.found) {
      s.found.lens.setHighlight?.(Math.max(0, s.glow.x));
      s.found.glass.invalidate?.();
    } else el.style.setProperty('--press', Math.max(0, Math.min(1, s.glow.x)).toFixed(3));
    if (doneScale && doneGlow && !s.down) {
      p.press = 1;
      p.commit();
      el.style.removeProperty('--press');
      el.classList.remove('pressing', 'press-css');
      s.found?.lens.setHighlight?.(0);
      s.found?.glass.invalidate?.();
      active.delete(el);
      return;
    }
    s.raf = requestAnimationFrame(tick);
  };
  s.last = performance.now();
  s.raf = requestAnimationFrame(tick);
}

function down(el, e) {
  if (reducedMotion.matches) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // About 14 pt bigger along the longer side: a 44 pt circle grows by a third, a wide capsule a little.
  const natural = Math.max(r.width, r.height) / (pose(el).press || 1);
  const big = Math.min(1.36, 1 + 14 / natural);
  let s = active.get(el);
  if (!s) {
    s = {scale: {x: pose(el).press, v: 0}, glow: {x: 0, v: 0}, raf: 0, last: performance.now(), found: lensFor(el)};
    active.set(el, s);
  }
  s.big = big;
  s.down = true;
  el.classList.add('pressing');
  if (!s.found) el.classList.add('press-css');
  animate(el);
}

function up(el) {
  const s = active.get(el);
  if (!s || !s.down) return;
  s.down = false;
  animate(el);
}

let installed = false;

/** Installs the press behaviour for every button on the page (once). */
export function installPress({exclude = ''} = {}) {
  if (installed) return;
  installed = true;
  const skip = exclude ? `${EXCLUDE}, ${exclude}` : EXCLUDE;
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      const el = e.target.closest?.(SELECTOR);
      if (!el || el.closest(skip) || el.dataset.press === 'none') return;
      down(el, e);
      const end = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        removeEventListener('pointerup', end, true);
        removeEventListener('pointercancel', end, true);
        removeEventListener('pointermove', moved, true);
        up(el);
      };
      // A finger that starts scrolling lets go of the button.
      const moved = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 14 && !el.hasAttribute('data-press-hold')) end(ev);
      };
      addEventListener('pointerup', end, true);
      addEventListener('pointercancel', end, true);
      addEventListener('pointermove', moved, true);
    },
    true,
  );
  // Keyboard presses get the same feedback.
  addEventListener(
    'keydown',
    (e) => {
      if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
      const el = document.activeElement?.closest?.(SELECTOR);
      if (!el || el.closest(skip)) return;
      down(el, {});
      setTimeout(() => up(el), 120);
    },
    true,
  );
}
