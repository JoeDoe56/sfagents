/**
 * createGlass(): the sfgl entry point.
 *
 *   const glass = createGlass({quality: 'auto'});
 *   glass.setBackdrop(imageBackdrop(img, {fit: 'cover'}));
 *   const surface = glass.surface({host: stage, z: 65});
 *   const lens = surface.lens(pill, {material: 0.35});
 *
 * Frames run on a scheduler (the built-in one, or the host's) in the render
 * phase: lens geometry is read first, shadow styles are written next, then
 * WebGL draws. A frame is drawn only when something asked for one.
 * @module
 */
import {createScheduler} from './core/scheduler.js';
import {createLighting} from './lighting/lighting.js';
import {createContactTracker} from './contact.js';
import {probe as probeCaps} from './gl/context.js';
import {initialTier, tier as tierConfig, stepTier, TIER_ORDER} from './core/quality.js';
import {Surface} from './surface.js';
import {imageBackdrop} from './backdrop.js';
import {clamp, finiteNumber} from './material.js';

/** @type {{x: number, y: number, intensity: number, source: string}} */
const NEUTRAL_LIGHT = Object.freeze({x: -0.16, y: -0.22, intensity: 0.22, source: 'default'});

/**
 * @typedef {object} GlassOptions
 * @property {'auto'|import('./core/quality.js').TierName|(() => string)} [quality]
 * @property {number|(() => number)} [renderScale]     backing scale; default the device pixel ratio, capped by the tier
 * @property {boolean|number|(() => boolean|number)} [frost]  frost on/off (a number: 0 disables)
 * @property {any} [scheduler]          host scheduler with mark/register (default: built-in)
 * @property {boolean|object|(() => object)} [lighting]  true: built-in pointer/tilt light; a function: host light state
 * @property {boolean} [webgl2]         set false to force WebGL1
 * @property {boolean} [debug]
 * @property {Partial<import('./gl/context.js').GLCaps>} [capsOverride]  test hook: fields merged over the probed caps
 * @property {{window?: Window, document?: Document}} [env]
 */

export class Glass {
  /** @param {GlassOptions} options */
  constructor(options = {}) {
    this.options = options;
    const win = (options.env && options.env.window) || globalThis.window;
    const doc = (options.env && options.env.document) || globalThis.document;
    this.env = {window: win, document: doc};
    this.surfaces = [];
    this._backdropProvider = null;
    this._dirty = true;
    this._light = NEUTRAL_LIGHT;
    this._lightKey = '';
    this._debugFlat = false;
    this._frameTimes = [];
    this.stats = {frames: 0, cpuMs: 0};
    this._ownsScheduler = !options.scheduler;
    this.scheduler = options.scheduler || createScheduler({window: win, document: doc, requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win)});
    this.caps = probeCaps(doc);
    this._tierName = this._pickTier();
    this.contact = createContactTracker({window: win});
    this._unsubscribeContact = this.contact.subscribe(() => this.requestRender());
    if (options.lighting === true || options.lighting === undefined) {
      this.lighting = createLighting({onChange: () => this.requestRender()}, {window: win, document: doc});
      this._ownsLighting = true;
    } else if (options.lighting && typeof options.lighting === 'object' && typeof options.lighting.state === 'function') {
      this.lighting = options.lighting;
    } else {
      this.lighting = null;
    }
    this._reducedMotion = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    // Follow the reduced-transparency preference live while quality is automatic.
    this._reducedTransparency = win.matchMedia ? win.matchMedia('(prefers-reduced-transparency: reduce)') : null;
    this._onTransparencyChange = () => { if (this._automatic()) this.setTier(this._pickTier()); };
    if (this._reducedTransparency && this._reducedTransparency.addEventListener) this._reducedTransparency.addEventListener('change', this._onTransparencyChange);
    this._onVisibility = () => { if (!doc.hidden) this.requestRender(); };
    doc.addEventListener('visibilitychange', this._onVisibility);
    // A scroll-linked backdrop (one that draws scrolled content) is redrawn in
    // the frame of the scroll itself: asking for the frame from inside the
    // scroll event lands it in this vsync, with the provider's update() run
    // just before the backdrop is prepared. Asking from a separate
    // requestAnimationFrame instead makes the glass trail the page by one
    // frame, which reads as stutter while scrolling.
    this._onScroll = () => {
      this._invalidateDom();
      const p = this._backdropProvider;
      if (p && p.scrollLinked) this.requestRender();
    };
    this._onResize = () => this.invalidate(true);
    doc.addEventListener('scroll', this._onScroll, {capture: true, passive: true});
    win.addEventListener('resize', this._onResize, {passive: true});
    // On-screen keyboards and pinch zoom move the visual viewport without a
    // window resize (iOS Safari pans it to reveal a focused field).
    this._onViewport = () => { this.invalidate(false); this.requestRender(); };
    if (win.visualViewport) {
      win.visualViewport.addEventListener('resize', this._onViewport, {passive: true});
      win.visualViewport.addEventListener('scroll', this._onViewport, {passive: true});
    }
    this.scheduler.register('sfgl', (frame) => this.frame(frame), {phase: 'render'});
    this.requestRender();
  }

  /** @returns {import('./core/quality.js').TierName} */
  _pickTier() {
    const q = typeof this.options.quality === 'function' ? this.options.quality() : this.options.quality;
    if (q && q !== 'auto' && TIER_ORDER.includes(q)) return /** @type {import('./core/quality.js').TierName} */ (q);
    const win = this.env.window;
    const nav = /** @type {any} */ (win.navigator || {});
    const reduced = !!(win.matchMedia && win.matchMedia('(prefers-reduced-transparency: reduce)').matches);
    return initialTier(this.caps, {deviceMemory: nav.deviceMemory, hardwareConcurrency: nav.hardwareConcurrency, reducedTransparency: reduced});
  }

  _automatic() {
    const q = typeof this.options.quality === 'function' ? this.options.quality() : this.options.quality;
    return !q || q === 'auto' || !TIER_ORDER.includes(q);
  }

  /** @param {import('./surface.js').Surface} surface */
  _onContextLost(surface) {
    if (surface.losses >= 2 && this._automatic() && this._tierName !== 'frost' && this._tierName !== 'static') this.stepTier(-1);
  }

  /** Current tier configuration. */
  tier() {
    const q = typeof this.options.quality === 'function' ? this.options.quality() : this.options.quality;
    if (q && q !== 'auto' && TIER_ORDER.includes(q)) this._tierName = /** @type {import('./core/quality.js').TierName} */ (q);
    return tierConfig(this._tierName);
  }

  /** @param {import('./core/quality.js').TierName} name */
  setTier(name) {
    if (!TIER_ORDER.includes(name) || name === this._tierName) return;
    this._tierName = name;
    this._dynamicScale = 1;
    if (this._adaptState) this._adaptState.samples.length = 0;
    this.invalidate(true);
  }

  /** @param {-1|1} direction */
  stepTier(direction) { this.setTier(stepTier(this._tierName, direction)); }

  renderScale() {
    const t = this.tier();
    const raw = typeof this.options.renderScale === 'function' ? this.options.renderScale() : this.options.renderScale;
    // Default to the display's pixel density so hairline rims stay crisp; the
    // tier caps it (superfluid 3, glass 2, lite 1).
    const dpr = finiteNumber(this.env.window && this.env.window.devicePixelRatio, 1);
    const value = finiteNumber(raw, Math.max(1, dpr));
    // The adaptive scale applies only while quality is automatic.
    const dynamic = this._automatic() ? (this._dynamicScale || 1) : 1;
    return clamp(value * dynamic, t.minRenderScale || 0.5, t.maxRenderScale || 2);
  }

  frostEnabled() {
    const raw = typeof this.options.frost === 'function' ? this.options.frost() : this.options.frost;
    if (raw === undefined || raw === null) return true;
    return typeof raw === 'number' ? raw > 0 : !!raw;
  }

  now() {
    const perf = this.env.window.performance;
    return perf && perf.now ? perf.now() : Date.now();
  }

  /**
   * Create a drawing surface.
   * @param {ConstructorParameters<typeof Surface>[1]} options
   */
  surface(options = {}) {
    const surface = new Surface(this, options);
    this.surfaces.push(surface);
    this.requestRender();
    return surface;
  }

  _removeSurface(surface) {
    const i = this.surfaces.indexOf(surface);
    if (i >= 0) this.surfaces.splice(i, 1);
  }

  /**
   * Set what the glass refracts (shared by every surface).
   * @param {any} provider  a backdrop provider; an image/canvas/video is wrapped with imageBackdrop()
   */
  setBackdrop(provider) {
    if (provider && !provider.kind) provider = imageBackdrop(provider);
    this._backdropProvider = provider || null;
    // An image or video that is still loading draws nothing yet; draw again
    // once it can be sampled.
    try {
      const source = provider && provider.kind === 'image' && provider.source ? provider.source() : null;
      if (source && source.tagName === 'IMG' && !source.complete) source.addEventListener('load', () => this.requestRender(), {once: true});
      if (source && source.tagName === 'VIDEO' && source.readyState < 2) source.addEventListener('loadeddata', () => this.requestRender(), {once: true});
    } catch (e) { /* not an element source */ }
    this.surfaces.forEach((s) => { if (s.backdrop) s.backdrop.setProvider(this._backdropProvider); });
    this.requestRender();
  }

  /** Ask for a frame. Cheap; any number of calls per frame draw once. */
  requestRender() {
    this._dirty = true;
    if (this.scheduler && this.scheduler.mark) this.scheduler.mark({render: true});
  }

  /** Re-measure "dom" lenses (and re-read shapes if asked) on the next frame. */
  invalidate(shape = false) {
    this.surfaces.forEach((surface) => {
      surface.invalidate();
      surface.lenses.forEach((lens) => lens.invalidate(shape));
    });
    this.requestRender();
  }

  _invalidateDom() {
    let any = false;
    this.surfaces.forEach((surface) => surface.lenses.forEach((lens) => {
      if (lens._geometryMode() === 'dom') { lens.invalidate(false); any = true; }
    }));
    if (any) this.requestRender();
  }

  /** Test hook: draw the backdrop with no optics (to verify projection). */
  debugFlat(on) { this._debugFlat = !!on; this.requestRender(); }

  _readLight() {
    let state = null;
    try { state = this.lighting ? this.lighting.state() : (typeof this.options.lighting === 'function' ? this.options.lighting() : null); } catch (e) { state = null; }
    if (!state) return NEUTRAL_LIGHT;
    return {
      x: clamp(Number(state.x) || 0, -1, 1),
      y: clamp(Number(state.y) || 0, -1, 1),
      intensity: clamp(Number(state.intensity) || 0, 0, 1),
      source: String(state.source || 'default'),
    };
  }

  /**
   * Scheduler task. Draws when asked to (requestRender or the host's
   * render/metrics flags) and keeps itself alive while animating.
   * @param {{timestamp?: number, flags?: Record<string, boolean>}} [frame]
   */
  frame(frame = {}) {
    const flags = frame.flags || {};
    if (flags.metrics) this.invalidate(false);
    if (!this._dirty && !flags.render && !flags.metrics && !flags.refreshSources) return;
    const doc = this.env.document;
    // Keep the request while hidden; visibilitychange asks again on show.
    if (doc.hidden) { this._dirty = true; return; }
    this._dirty = false;
    const started = this.now();
    const now = Number.isFinite(frame.timestamp) ? frame.timestamp : started;
    const tier = this.tier();
    // Let the backdrop redraw its source in this frame, before it is read.
    if (tier.webgl) {
      const p = this._backdropProvider;
      if (p && typeof p.update === 'function') {
        try { p.update({timestamp: now}); } catch (e) { /* a failing host update must not stop the glass */ }
      }
    }

    // Read phase. CSS tiers (and surfaces without a usable WebGL context)
    // need no geometry: the lens elements draw themselves.
    const cssTier = tier.webgl ? 'frost' : /** @type {'static'|'frost'} */ (tier.name);
    const plans = this.surfaces.map((surface) => {
      const css = !tier.webgl || !surface.webglReady();
      return {surface, css, ordered: css ? null : surface.measure()};
    });
    // Write phase: lighting-aware shadows (only written when they change).
    const light = this._readLight();
    const lightKey = light.x.toFixed(3) + ':' + light.y.toFixed(3) + ':' + light.intensity.toFixed(3);
    if (lightKey !== this._lightKey) {
      this._lightKey = lightKey;
      this._light = light;
      this.surfaces.forEach((s) => s.lenses.forEach((lens) => lens.setLight(light)));
    }
    // Draw phase.
    const context = {
      now,
      tier,
      light,
      quality: 1,
      frostEnabled: this.frostEnabled(),
      contact: this.contact.state,
      reducedMotion: !!(this._reducedMotion && this._reducedMotion.matches),
      debugFlat: this._debugFlat,
    };
    let animating = false;
    let backdropDynamic = false;
    let webglSurfaces = 0;
    plans.forEach(({surface, css, ordered}) => {
      if (css) { if (surface.renderCss(cssTier, context)) animating = true; return; }
      if (!ordered.length) { surface.clear(); surface.clearUnderlays(); return; }
      webglSurfaces++;
      if (surface.render(ordered, {timestamp: now, flags}, context)) animating = true;
    });
    // An animated backdrop only needs frames while WebGL lenses sample it.
    if (webglSurfaces) {
      try {
        const p = this._backdropProvider;
        backdropDynamic = !!(p && p.dynamic && p.dynamic({timestamp: now}));
      } catch (e) { backdropDynamic = false; }
    }
    this.stats.frames++;
    const cpu = this.now() - started;
    this.stats.cpuMs = this.stats.cpuMs * 0.9 + cpu * 0.1;
    this._adapt(now, webglSurfaces > 0);
    this._continuing = animating || backdropDynamic;
    if (animating || backdropDynamic) {
      this._dirty = true;
      if (this.scheduler.mark) this.scheduler.mark({render: true});
    }
  }

  /**
   * Automatic quality: while frames run back to back (an animation or a
   * live backdrop), watch the frame interval. Sustained slow frames lower
   * the render scale, then the tier; a long run of fast frames brings the
   * render scale back. Only active when quality is 'auto'.
   * @param {number} now frame timestamp
   * @param {boolean} drewWebgl
   */
  _adapt(now, drewWebgl) {
    const previous = this._lastFrameAt;
    const continuing = this._continuing;
    this._lastFrameAt = drewWebgl ? now : 0;
    if (!drewWebgl || !previous || !continuing || !this._automatic()) return;
    const dt = now - previous;
    if (!(dt > 0) || dt > 250) return;
    const a = this._adaptState || (this._adaptState = {samples: [], fast: 0, display: Infinity, ceiling: this._tierName});
    // The shortest interval seen approximates the display's frame period.
    a.display = Math.max(6, Math.min(a.display, dt));
    a.samples.push(dt);
    if (a.samples.length > 30) a.samples.shift();
    if (a.samples.length < 20) return;
    const sorted = a.samples.slice().sort((x, y) => x - y);
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    // Hosts may pace frames below the display rate on purpose (a 30 Hz
    // visualizer), so only frames slower than ~24 fps count as slow.
    const slow = Math.max(a.display * 1.6, 42);
    if (p75 > slow) {
      a.samples.length = 0;
      a.fast = 0;
      const t = this.tier();
      const scale = this._dynamicScale || 1;
      if (this.renderScale() > (t.minRenderScale || 0.5) + 0.01) {
        this._dynamicScale = Math.max(0.25, scale * 0.8);
        this.invalidate(true);
      } else if (this._tierName !== 'static' && this._tierName !== 'frost') {
        this.stepTier(-1);
      }
      this.stats.adaptations = (this.stats.adaptations || 0) + 1;
    } else if (p75 < Math.max(a.display * 1.15, 20)) {
      // Sustained headroom: restore the render scale, then (more slowly)
      // the tier, never above the tier auto first chose.
      a.fast++;
      if (a.fast >= 240 && (this._dynamicScale || 1) < 1) {
        a.fast = 0;
        this._dynamicScale = Math.min(1, (this._dynamicScale || 1) * 1.25);
        this.invalidate(true);
      } else if (a.fast >= 600 && TIER_ORDER.indexOf(this._tierName) < TIER_ORDER.indexOf(a.ceiling) && this.tier().webgl) {
        a.fast = 0;
        this.stepTier(1);
      }
    } else {
      a.fast = 0;
    }
  }

  /** Counters for diagnostics and tests. */
  statsSnapshot() {
    const out = {renders: 0, prepares: 0, copies: 0, copyPixels: 0, lensDraws: 0, lenses: 0, surfaces: this.surfaces.length, cssSurfaces: this.surfaces.filter((s) => s.cssMode).length, dynamicScale: +(this._dynamicScale || 1).toFixed(3), adaptations: this.stats.adaptations || 0, frames: this.stats.frames, cpuMs: +this.stats.cpuMs.toFixed(3), tier: this._tierName, renderScale: this.renderScale()};
    this.surfaces.forEach((s) => {
      out.renders += s.stats.renders;
      out.copies += s.stats.copies;
      out.copyPixels += s.stats.copyPixels;
      out.lensDraws += s.stats.lensDraws;
      out.prepares += s.backdrop ? s.backdrop.prepareCount : 0;
      out.lenses += s.lenses.length;
    });
    return out;
  }

  destroy() {
    this.surfaces.slice().forEach((s) => s.destroy());
    if (this.scheduler.unregister) this.scheduler.unregister('sfgl');
    this.env.document.removeEventListener('scroll', this._onScroll, {capture: true});
    this.env.window.removeEventListener('resize', this._onResize);
    if (this.env.window.visualViewport) {
      this.env.window.visualViewport.removeEventListener('resize', this._onViewport);
      this.env.window.visualViewport.removeEventListener('scroll', this._onViewport);
    }
    if (this._unsubscribeContact) this._unsubscribeContact();
    this.env.document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._ownsLighting && this.lighting && this.lighting.destroy) this.lighting.destroy();
    if (this._ownsScheduler && this.scheduler.destroy) this.scheduler.destroy();
    if (this._reducedTransparency && this._reducedTransparency.removeEventListener) this._reducedTransparency.removeEventListener('change', this._onTransparencyChange);
  }
}

/** @param {GlassOptions} [options] */
export function createGlass(options) {
  return new Glass(options);
}
