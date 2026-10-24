/**
 * Stretchy, bouncy glass. Drag a finger (or the mouse) on a glass element,
 * or past the edge of one, and the glass stretches toward the pointer,
 * thinner across and longer along, holding back as it goes (a rubber band);
 * let go and it springs home with a bounce.
 *
 * On by default for every glass element the UI components make. Turn it off
 * for all of them with `configure({stretch: false})`, or for one element
 * with `stretch: false` in its options (or `data-sf-stretch="off"`).
 *
 * Two ways to drive it:
 * - automatic (`auto: true`): the element listens to its own pointer drag.
 * - manual: a component that already tracks the pointer (a menu, a sheet)
 *   calls `drive(overshootX, overshootY)` with how far past its edges the
 *   pointer is, and `release()` when done.
 * @module
 */

import {pose, settings, spring, reducedMotion, clamp} from './core.js';

const follow = spring(0.14, 0.92);
const bounce = spring(0.5, 0.42);

/**
 * How much glass a drag of `d` px adds along its axis: nearly linear at
 * first, then holding back towards `limit`.
 */
export function rubber(d, limit) {
  const s = Math.sign(d);
  return s * limit * Math.tanh(Math.abs(d) / limit);
}

/**
 * The pose for an element of `width` x `height` pulled by an overshoot.
 * Stretching keeps the far edge in place (so the translation is half the
 * growth, toward the pull) and narrows the other axis a little.
 * @returns {{sx: number, sy: number, tx: number, ty: number}}
 */
export function stretchPose(width, height, ox, oy, {limit = 0.55, squash = 0.2} = {}) {
  const ex = rubber(ox, Math.max(24, width * limit));
  const ey = rubber(oy, Math.max(24, height * limit));
  const gx = ex / Math.max(1, width);
  const gy = ey / Math.max(1, height);
  return {
    sx: (1 + Math.abs(gx)) * (1 - squash * Math.abs(gy)),
    sy: (1 + Math.abs(gy)) * (1 - squash * Math.abs(gx)),
    tx: ex / 2,
    ty: ey / 2,
  };
}

/**
 * @param {HTMLElement} element
 * @param {{auto?: boolean, axis?: 'both'|'x'|'y', limit?: number, squash?: number, pull?: number, enabled?: () => boolean}} [options]
 *   `pull`: how much of the pointer's travel counts in automatic mode (default 0.7).
 */
export function attachStretch(element, options = {}) {
  const state = {x: {x: 0, v: 0}, y: {x: 0, v: 0}, tx: 0, ty: 0, driven: false, raf: 0, last: 0};
  const p = pose(element);
  let size = {w: 1, h: 1};

  const enabled = () => settings.stretch && element.dataset.sfStretch !== 'off' && (options.enabled?.() ?? true) && !reducedMotion.matches;

  function apply() {
    const s = stretchPose(size.w, size.h, options.axis === 'y' ? 0 : state.x.x, options.axis === 'x' ? 0 : state.y.x, options);
    p.sx = s.sx;
    p.sy = s.sy;
    p.tx = s.tx;
    p.ty = s.ty;
    p.commit();
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    const step = state.driven ? follow : bounce;
    const a = step(state.x, state.driven ? state.tx : 0, dt);
    const b = step(state.y, state.driven ? state.ty : 0, dt);
    apply();
    if (!state.driven && a && b) {
      state.x.x = state.x.v = state.y.x = state.y.v = 0;
      apply();
      state.raf = 0;
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function run() {
    if (state.raf) return;
    state.last = performance.now();
    state.raf = requestAnimationFrame(tick);
  }

  const api = {
    /** Pulls the glass by an overshoot, in px (positive x is right, positive y down). */
    drive(ox, oy = 0) {
      if (!enabled()) return;
      if (!state.driven) {
        // The element's own size, undistorted by the pose it is in.
        const r = element.getBoundingClientRect();
        size = {w: r.width / (p.sx * p.press || 1), h: r.height / (p.sy * p.press || 1)};
      }
      state.driven = true;
      state.tx = ox;
      state.ty = oy;
      run();
    },
    /** Lets go: the glass springs back. */
    release() {
      if (!state.driven && !state.raf) return;
      state.driven = false;
      run();
    },
    destroy() {
      cancelAnimationFrame(state.raf);
      off?.();
      state.driven = false;
      p.sx = p.sy = 1;
      p.tx = p.ty = 0;
      p.commit();
    },
    get active() {
      return state.driven;
    },
  };

  let off = null;
  if (options.auto) {
    const pull = options.pull ?? 0.7;
    let down = null;
    const onDown = (e) => {
      if (e.button !== 0 || !enabled()) return;
      down = {id: e.pointerId, x: e.clientX, y: e.clientY};
    };
    const onMove = (e) => {
      if (!down || e.pointerId !== down.id) return;
      api.drive((e.clientX - down.x) * pull, (e.clientY - down.y) * pull);
    };
    const onUp = (e) => {
      if (!down || e.pointerId !== down.id) return;
      down = null;
      api.release();
    };
    element.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    off = () => {
      element.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }
  return api;
}

/** How far a pointer is past a rect's edges (0 inside), per axis. */
export function overshoot(rect, x, y) {
  return {
    x: x < rect.left ? x - rect.left : x > rect.right ? x - rect.right : 0,
    y: y < rect.top ? y - rect.top : y > rect.bottom ? y - rect.bottom : 0,
  };
}

export {clamp};
