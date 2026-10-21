/**
 * iOS 26 button presses, everywhere: a held button grows (a bigger share
 * for small round buttons, a few points for wide ones), its glass lifts to
 * a light grey, and on release it springs back with a little bounce.
 *
 * Glass buttons use the lens's press highlight (sfgl) and are re-measured
 * every frame of the spring so the glass follows the scale; other buttons
 * lighten with a class. List rows, menu items and similar keep their own
 * highlight instead (as iOS does).
 */

const SELECTOR = 'button, [role="button"], a.viewer-btn';
const EXCLUDE = '.fm-row, .fm-tile, .fm-place, .ui-row, .menu-item, .menu-quick-item, .fm-crumb, .proc-row, .user-row, .tile, .stat, .drive, .ag-slider, [data-press="none"], .dialog-button, .toast-cancel, .fm-back, .fm-textbtn, .peek-back, summary';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/** Every sfgl Glass on the page; lenses are found by element. */
const glasses = new Set();
export function registerGlass(glass) {
  if (glass) glasses.add(glass);
  return () => glasses.delete(glass);
}

function lensFor(el) {
  for (const g of glasses) {
    for (const s of g.surfaces ?? []) {
      const lens = s.lenses?.find((l) => l.el === el);
      if (lens) return { lens, glass: g };
    }
  }
  return null;
}

/** A damped spring stepped per frame (response in seconds, damping ratio). */
function spring(response, damping) {
  const w = (2 * Math.PI) / response;
  return (state, target, dt) => {
    const steps = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -w * w * (state.x - target) - 2 * damping * w * state.v;
      state.v += a * h;
      state.x += state.v * h;
    }
    return Math.abs(state.x - target) < 0.0005 && Math.abs(state.v) < 0.002;
  };
}
const pressIn = spring(0.26, 0.72);
const release = spring(0.42, 0.52);

const active = new Map(); // element → { scale, glow, target, raf, last, found }

function animate(el) {
  const s = active.get(el);
  if (!s) return;
  cancelAnimationFrame(s.raf);
  const tick = (now) => {
    const dt = Math.min(0.05, (now - s.last) / 1000);
    s.last = now;
    const step = s.down ? pressIn : release;
    const doneScale = step(s.scale, s.down ? s.big : 1, dt);
    const doneGlow = step(s.glow, s.down ? 1 : 0, dt);
    el.style.scale = s.scale.x.toFixed(4);
    if (s.found) {
      s.found.lens.setHighlight?.(Math.max(0, s.glow.x));
      s.found.glass.invalidate();
    } else el.style.setProperty('--press', Math.max(0, Math.min(1, s.glow.x)).toFixed(3));
    if (doneScale && doneGlow && !s.down) {
      el.style.scale = '';
      el.style.removeProperty('--press');
      el.classList.remove('pressing', 'press-css');
      s.found?.lens.setHighlight?.(0);
      s.found?.glass.invalidate();
      active.delete(el);
      return;
    }
    s.raf = requestAnimationFrame(tick);
  };
  s.last = performance.now();
  s.raf = requestAnimationFrame(tick);
}

function down(el, e) {
  if (reduced.matches) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // About 14 pt bigger along the longer side: a 44 pt circle grows by a third, a wide capsule a little.
  const big = Math.min(1.36, 1 + 14 / Math.max(r.width, r.height));
  let s = active.get(el);
  if (!s) {
    s = { scale: { x: 1, v: 0 }, glow: { x: 0, v: 0 }, raf: 0, last: performance.now(), found: lensFor(el) };
    active.set(el, s);
  }
  s.big = big;
  s.down = true;
  s.pointer = e.pointerId;
  s.x = e.clientX;
  s.y = e.clientY;
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

/** Installs the press behaviour for every button on the page (once). */
export function installPress() {
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      const el = e.target.closest?.(SELECTOR);
      if (!el || el.disabled || el.closest(EXCLUDE) || el.getAttribute('aria-disabled') === 'true') return;
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
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 14) end(ev);
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
      if (!el || el.closest(EXCLUDE)) return;
      down(el, { pointerId: -1, clientX: 0, clientY: 0 });
      setTimeout(() => up(el), 120);
    },
    true,
  );
}
