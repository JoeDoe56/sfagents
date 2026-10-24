/**
 * sfgl/ui core: the shared bits every component uses.
 *
 * - `configure()`: global switches (stretchy glass on by default, the colour
 *   scheme, the factory that makes glass for an overlay).
 * - `el()` and `icon()`: tiny DOM helpers.
 * - `spring()`: a damped spring stepped per frame (response in seconds,
 *   damping ratio), the motion every bouncy thing here uses.
 * - the glass registry: components find the lens drawn for an element
 *   through it, so a press or a stretch can lift and re-measure the glass.
 * @module
 */

import {applySymbol} from '../symbols.js';

/** @type {{stretch: boolean, scheme: 'auto'|'light'|'dark', glass: null|((o: object) => any), quality: string|undefined}} */
export const settings = {stretch: true, scheme: 'auto', glass: null, quality: undefined};

const listeners = new Set();

/**
 * Global switches.
 * @param {{stretch?: boolean, scheme?: 'auto'|'light'|'dark', glass?: (o: object) => any, quality?: string}} next
 *   `stretch`: glass stretches and bounces when dragged (default on).
 *   `scheme`: light, dark, or follow the system.
 *   `glass`: makes the glass for an overlay, `({host, scroller, ...}) => handle`.
 */
export function configure(next = {}) {
  Object.assign(settings, next);
  if ('scheme' in next) {
    if (next.scheme === 'auto') delete document.documentElement.dataset.sfScheme;
    else document.documentElement.dataset.sfScheme = next.scheme;
  }
  for (const l of listeners) l(settings);
}

/** Calls `fn` when `configure` changes anything. */
export function onConfigure(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : {matches: false};

/** The effective scheme. */
export function scheme() {
  if (settings.scheme !== 'auto') return settings.scheme;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Makes an element. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An SF Symbol as an <i>. */
export function icon(name, size = 17) {
  const i = document.createElement('i');
  applySymbol(i, name, {size});
  return i;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, k) => a + (b - a) * k;

/**
 * A damped spring stepped by wall time. `state` is `{x, v}`; the step
 * returns true when it has settled on `target`.
 * @param {number} response  seconds for a full oscillation
 * @param {number} damping   1 is critical; lower bounces
 */
export function spring(response, damping) {
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

// ------------------------------------------------------------------ glass registry

/** @type {Set<any>} */
const glasses = new Set();

/** Registers an sfgl Glass so components can find the lens for an element. */
export function registerGlass(glass) {
  if (glass) glasses.add(glass);
  return () => glasses.delete(glass);
}

/** The lens (and its Glass) drawn for `element`, if any. */
export function lensFor(element) {
  for (const g of glasses) {
    for (const s of g.surfaces ?? []) {
      const lens = s.lenses?.find((l) => l.el === element);
      if (lens) return {lens, glass: g};
    }
  }
  return null;
}

// ------------------------------------------------------------------ pose

/**
 * An element's animated pose: a uniform press scale, a stretch (separate x
 * and y scale) and a translation, written to the individual CSS transform
 * properties so they compose without fighting each other. Glass follows
 * because the lens re-measures the element's box.
 */
const poses = new WeakMap();

export function pose(element) {
  let p = poses.get(element);
  if (p) return p;
  p = {
    press: 1,
    sx: 1,
    sy: 1,
    tx: 0,
    ty: 0,
    /** Called after every commit (a popover keeps its text undistorted). */
    after: null,
    /** Writes the pose and tells the lens to re-measure. */
    commit() {
      const sx = p.press * p.sx;
      const sy = p.press * p.sy;
      const rest = Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3;
      element.style.scale = rest ? '' : `${sx.toFixed(4)} ${sy.toFixed(4)}`;
      element.style.translate = Math.abs(p.tx) < 0.01 && Math.abs(p.ty) < 0.01 ? '' : `${p.tx.toFixed(2)}px ${p.ty.toFixed(2)}px`;
      const found = lensFor(element);
      if (found) found.glass.invalidate?.();
      p.after?.();
    },
  };
  poses.set(element, p);
  return p;
}
