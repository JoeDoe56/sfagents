/**
 * Standalone geometry clock with no application state.
 *
 * A geometry is `{x, y, width, height, radius, scaleX, scaleY}`. Every
 * function here is pure apart from `apply`, which writes to the element it is
 * given, and `animate`, which schedules frames.
 */

/**
 * Host globals used by `animate`. Each entry defaults to the matching global
 * when it is not supplied.
 *
 * @typedef {object} MotionEnv
 * @property {Window} [window] Source of `matchMedia` for reduced-motion checks.
 * @property {(callback: (time: number) => void) => number} [requestAnimationFrame]
 * @property {(id: number) => void} [cancelAnimationFrame]
 * @property {Performance} [performance]
 */

/**
 * @typedef {object} Geometry
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} radius
 * @property {number} scaleX
 * @property {number} scaleY
 */

/**
 * @typedef {object} MotionFrame
 * @property {number} offset Progress position of this keyframe, from 0 to 1.
 * @property {Partial<Geometry>} value Geometry at this keyframe.
 */

/**
 * @typedef {object} AnimateOptions
 * @property {MotionFrame[]} frames Keyframes sorted by `offset`.
 * @property {number} [duration] Duration in milliseconds. Zero or missing means no motion.
 * @property {() => boolean} [visible] When it returns false, the animation jumps to its end.
 * @property {(geometry: Geometry) => void} update Receives each interpolated geometry.
 * @property {() => void} [complete] Called once when the animation reaches its end.
 * @property {string} [key] Scheduler key for this animation. Defaults to a unique key.
 * @property {{request: (key: string, fn: Function) => void}} [scheduler]
 *   When given, ticks go through `scheduler.request` instead of requestAnimationFrame.
 * @property {MotionEnv} [env] Host globals. Defaults to the global objects.
 */

/**
 * @typedef {object} Animation
 * @property {() => void} cancel Stops the animation without calling `complete`.
 * @property {'running' | 'finished'} playState
 */

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

let animationSequence = 0;

/**
 * Coerces a partial geometry to finite values, clamps the size to be
 * non-negative and limits the radius to half the smaller side.
 *
 * @param {Partial<Geometry>} value
 * @returns {Geometry}
 */
export function normalize(value) {
  const g = Object.assign({x: 0, y: 0, width: 0, height: 0, radius: 0, scaleX: 1, scaleY: 1}, value);
  for (const k of Object.keys(g)) g[k] = finite(g[k], 0);
  g.width = Math.max(0, g.width);
  g.height = Math.max(0, g.height);
  g.radius = Math.max(0, Math.min(g.radius, Math.min(g.width, g.height) / 2));
  return g;
}

/**
 * Linearly interpolates every geometry field between two geometries.
 *
 * @param {Partial<Geometry>} from
 * @param {Partial<Geometry>} to
 * @param {number} progress Clamped to the range 0 to 1.
 * @returns {Geometry}
 */
export function interpolate(from, to, progress) {
  const a = normalize(from), b = normalize(to), p = Math.max(0, Math.min(1, progress)), out = {};
  for (const k of Object.keys(b)) out[k] = finite(a[k], b[k]) + (b[k] - finite(a[k], b[k])) * p;
  return normalize(out);
}

/**
 * Moves `from` toward `to` by one frame of an exponential ease. The result is
 * frame-rate independent because it depends only on total elapsed time.
 *
 * @param {Partial<Geometry>} from
 * @param {Partial<Geometry>} to
 * @param {number} elapsed Milliseconds since the previous step.
 * @param {number} tau Time constant in milliseconds. Defaults to 70 when falsy.
 * @returns {Geometry}
 */
export function advance(from, to, elapsed, tau) {
  const a = normalize(from), b = normalize(to);
  const done = Object.keys(b).every(k => Math.abs(b[k] - finite(a[k], b[k])) < 0.01);
  return interpolate(a, b, done ? 1 : 1 - Math.exp(-Math.max(0, elapsed) / Math.max(1, tau || 70)));
}

/**
 * Writes a geometry to an element's inline style and records it on the element.
 *
 * @param {HTMLElement} element
 * @param {Partial<Geometry>} geometry
 * @returns {Geometry} The normalized geometry that was written.
 */
export function apply(element, geometry) {
  const g = normalize(geometry), s = element.style;
  s.width = g.width + "px";
  s.height = g.height + "px";
  s.borderRadius = g.radius + "px";
  s.transform = "translate3d(" + g.x + "px," + g.y + "px,0) scale(" + g.scaleX + "," + g.scaleY + ")";
  /** @type {any} */ (element)._liquidGeometry = g;
  return g;
}

/**
 * Plays a keyframed geometry animation. Each tick interpolates between the two
 * keyframes around the current progress with a smoothstep curve.
 *
 * Frames come from the scheduler when `options.scheduler` is given, otherwise
 * from requestAnimationFrame. A scheduler frame passes an object whose
 * `timestamp` is the time. A requestAnimationFrame callback passes the time
 * as a number.
 *
 * @param {AnimateOptions} options
 * @returns {Animation}
 */
export function animate(options) {
  const env = options.env || {};
  const win = env.window || globalThis.window;
  const perf = env.performance || globalThis.performance;
  const raf = env.requestAnimationFrame || globalThis.requestAnimationFrame;
  const caf = env.cancelAnimationFrame || globalThis.cancelAnimationFrame;
  const scheduler = options.scheduler && typeof options.scheduler.request === "function" ? options.scheduler : null;
  const key = options.key || "sfgl-motion:" + (++animationSequence);
  const frames = options.frames, now = () => perf.now(), start = now();
  let id = 0, stopped = false;
  const duration = win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : Math.max(0, options.duration || 0);
  const requestTick = fn => scheduler ? scheduler.request(key, fn) : raf(fn);
  const tick = frame => {
    if (stopped) return;
    // Scheduler frames are objects with a timestamp. Animation frames are bare times.
    const time = typeof frame === "number" ? frame : (frame && frame.timestamp) || now();
    const p = duration && (!options.visible || options.visible()) ? Math.min(1, (time - start) / duration) : 1;
    let i = 1;
    while (i < frames.length - 1 && p > frames[i].offset) i++;
    const a = frames[i - 1], b = frames[i], t = Math.max(0, Math.min(1, (p - a.offset) / Math.max(0.00001, b.offset - a.offset)));
    options.update(interpolate(a.value, b.value, t * t * (3 - 2 * t)));
    if (p < 1) id = /** @type {number} */ (requestTick(tick));
    else {
      stopped = true;
      options.complete?.();
    }
  };
  id = /** @type {number} */ (requestTick(tick));
  return {
    // A scheduled tick is cancelled by the stopped flag. Only raf ids need cancelling.
    cancel() {
      stopped = true;
      if (!scheduler) caf(id);
    },
    get playState() {
      return stopped ? "finished" : "running";
    }
  };
}

export const motion = {normalize, interpolate, advance, apply, animate};
