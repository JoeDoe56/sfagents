/**
 * A lens: one glass shape bound to a DOM element.
 *
 * The element is a placeholder that gives the glass its position, size,
 * corner radius and drop shadow; the glass itself is drawn by its surface's
 * WebGL canvas. Per-frame reads are kept to one getBoundingClientRect (and a
 * native visibility check) for "live" lenses; "dom" lenses re-measure only
 * when invalidated; function geometry reads no DOM at all.
 * @module
 */
import {clamp, finiteNumber, normalizeMaterial, resolveMaterial, applyOpticsOverrides, mixNumber, mixTint, parseTintColor, easings, LIVE_NUMERIC_OPTIONS} from './material.js';

/**
 * @typedef {object} LensOptions
 * @property {number} [material]            signed material −1..1 (null: legacy optics below)
 * @property {number} [refraction] @property {number} [frost] @property {number} [magnify]
 * @property {boolean} [specular]
 * @property {{color: string|number[], amount?: number}} [tint]  body colour (CSS hex or display RGB 0..1) and how much of it, overriding the material's tone
 * @property {number} [rim]         hairline edge highlight strength (default 0.25)
 * @property {number} [rimTint]     0..1: how much the rim takes the colour of the content around the edge (default 1)
 * @property {number} [dispersion]  0..1 scale of the rim's spectral split (default 1)
 * @property {'live'|'dom'|((el: Element, lens: Lens) => Rect|null)} [geometry]  how the rect is measured (default 'live')
 * @property {boolean} [liveGeometry]  false: measure like 'dom' (legacy switch)
 * @property {(el: Element, lens: Lens) => Rect|null} [geometryRect]  legacy alias for function geometry
 * @property {Element|string|(() => Element|null)} [clip]  clip glass output to this element's box
 * @property {Element|string|(() => Element|null)} [clipTarget]  alias of clip
 * @property {boolean} [clipToPaddingBox]
 * @property {number|((el: Element) => number)} [layer]  optical depth; higher layers refract lower ones
 * @property {any|((el: Element) => any)} [underlay]       live content refracted by this lens
 * @property {number|((el: Element) => number)} [edgeFrost] extra frost at the top/bottom edges 0..1
 * @property {number|((el: Element) => number)} [opacity]   glass opacity 0..1 (default 1)
 * @property {boolean|((el: Element) => boolean)} [visible]  host visibility (default true)
 * @property {(lens: Lens) => ({matrix: DOMMatrix|Float32Array|number[], tiltX?: number, tiltY?: number}|null)} [transform]
 * @property {number} [tiltX]  light tilt used when there is no transform
 * @property {number} [tiltY]
 * @property {number} [refractionFill]  0..1 fill of the refracted interior (default 0)
 * @property {number} [bevelDepth]      bevel depth in lens units (default 0.08)
 * @property {number} [bevelWidth]      bevel width in lens units (default 0.15)
 * @property {boolean} [hollowMaskContent]  mask content inside a hollow lens (also set by data-liquid-mask-content)
 * @property {boolean} [shadow]  draw a lighting-aware drop shadow on the element (default true with material)
 * @property {'none'|'fade'} [reveal]
 * @property {{init?: (lens: Lens) => void}} [on]
 */

/** @typedef {{left:number, top:number, width:number, height:number}} Rect */

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class Lens {
  /**
   * @param {import('./surface.js').Surface} surface
   * @param {HTMLElement} element
   * @param {LensOptions} options
   */
  constructor(surface, element, options = {}) {
    this.surface = surface;
    this.el = element;
    this.options = Object.assign({}, options);
    if (this.options.material !== null && this.options.material !== undefined) {
      this.options.material = normalizeMaterial(this.options.material, 0);
    }
    this.rect = null;          // CSS rect in surface space
    this.clipRect = null;      // visible CSS rect in surface space (left, top, right, bottom)
    this.radiusCss = 0;
    this.cornerPower = 2;
    this.hollowInsetCss = 0;
    this.hollowMaskContent = !!this.options.hollowMaskContent || element.hasAttribute('data-liquid-mask-content') || element.hasAttribute('data-sf-mask-content');
    this.revealType = this.options.reveal === 'fade' ? 1 : 0;
    this.revealProgress = this.revealType === 0 ? 1 : 0;
    this.tiltX = 0;
    this.tiltY = 0;
    this.matrix = IDENTITY;
    this.hasTransform = false;
    this.contact = undefined;
    this.highlightValue = 0;
    this.drawn = false;
    this._dirty = true;
    this._shapeDirty = true;
    this._transition = null;
    this._initCalled = false;
    this._shadowKey = '';
    this._cssTier = null;      // 'static' | 'frost' while drawn with CSS
    this._cssKey = '';

    const style = element.style;
    this.originalShadow = style.boxShadow;
    this.originalOpacity = style.opacity;
    this.originalTransition = style.transition;
    // Every inline style the lens overrides, restored by destroy().
    this._originalStyles = {
      transition: style.transition, opacity: style.opacity, position: style.position,
      backdropFilter: style.backdropFilter, webkitBackdropFilter: /** @type {any} */ (style).webkitBackdropFilter,
      backgroundImage: style.backgroundImage, background: style.background, boxShadow: style.boxShadow,
    };
    // Start with the glass's current light so a new lens's shadow matches.
    this._light = surface.glass._light;
    style.transition = 'none';
    style.opacity = '0';
    if (style.position === 'static') style.position = 'relative';
    style.backdropFilter = 'none';
    /** @type {any} */ (style).webkitBackdropFilter = 'none';
    style.backgroundImage = 'none';
    style.background = 'transparent';

    const win = /** @type {any} */ (surface.glass.env.window);
    if (win && typeof win.ResizeObserver !== 'undefined') {
      this._resizeObserver = new win.ResizeObserver(() => { this.invalidate(true); surface.glass.requestRender(); });
      this._resizeObserver.observe(element);
    }
    const optics = this.resolveOptics(1);
    this.setShadow(this.options.material !== null && this.options.material !== undefined ? true : this.options.shadow, optics.shadowStrength);
  }

  /** Re-measure on the next frame (and re-read the shape when asked). */
  invalidate(shape = false) {
    this._dirty = true;
    if (shape) this._shapeDirty = true;
  }

  _value(key, fallback) {
    const value = this.options[key];
    if (value === undefined || value === null) return fallback;
    try {
      const resolved = typeof value === 'function' ? value(this.el, this) : value;
      return resolved === undefined || resolved === null ? fallback : resolved;
    } catch (e) {
      return fallback;
    }
  }

  layer() { return finiteNumber(this._value('layer', 0), 0); }
  underlay() { return this._value('underlay', null); }

  /**
   * Press highlight, 0..1: the body lifts toward a light grey as an iOS
   * button's does while held. Set every frame by the host's press
   * animation; independent of option transitions (a tint in flight keeps
   * going).
   */
  setHighlight(value) {
    const v = clamp(finiteNumber(value, 0), 0, 1);
    if (v === this.highlightValue) return;
    this.highlightValue = v;
    this.surface.glass.requestRender();
  }
  edgeFrost() { return clamp(finiteNumber(this._value('edgeFrost', 0), 0), 0, 1); }
  opacity() { return clamp(finiteNumber(this._value('opacity', 1), 1), 0, 1); }

  _geometryMode() {
    const geometry = this.options.geometry || this.options.geometryRect;
    if (typeof geometry === 'function') return 'function';
    if (geometry === 'dom') return 'dom';
    if (this.options.liveGeometry === false) return 'dom';
    return 'live';
  }

  /**
   * Measure geometry, shape and visibility for this frame.
   * @param {{left:number, top:number}} origin surface origin in viewport CSS px
   * @returns {boolean} whether the lens should draw
   */
  measure(origin) {
    const el = this.el;
    if (!el.isConnected || !this._value('visible', true)) { this.rect = null; return false; }
    const mode = this._geometryMode();
    if (mode === 'dom' && !this._dirty && this._cachedViewportRect !== undefined) {
      // Cached; visibility can still change without layout.
    } else {
      let rect = null;
      if (mode === 'function') {
        const geometry = this.options.geometry || this.options.geometryRect;
        try { rect = /** @type {(el: Element, lens: Lens) => Rect|null} */ (geometry)(el, this); } catch (e) { rect = null; }
      }
      if (!rect) rect = el.getBoundingClientRect();
      this._cachedViewportRect = rect ? {left: rect.left, top: rect.top, width: rect.width, height: rect.height} : null;
      this._dirty = false;
    }
    const rect = this._cachedViewportRect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) { this.rect = null; return false; }
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({opacityProperty: true, visibilityProperty: true})) { this.rect = null; return false; }
    } else if (!el.getClientRects().length) {
      this.rect = null;
      return false;
    }
    if (mode !== 'dom' || this._shapeDirty) this._readShape(rect);
    this.rect = {left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height};
    let clip = {left: this.rect.left, top: this.rect.top, right: this.rect.left + rect.width, bottom: this.rect.top + rect.height};
    const clipRect = this._clipRect(origin);
    if (clipRect) {
      clip = {left: Math.max(clip.left, clipRect.left), top: Math.max(clip.top, clipRect.top), right: Math.min(clip.right, clipRect.right), bottom: Math.min(clip.bottom, clipRect.bottom)};
      if (clip.right <= clip.left || clip.bottom <= clip.top) { this.rect = null; return false; }
    }
    this.clipRect = clip;
    // Transform (e.g. perspective tilt) for this frame.
    let transform = null;
    try { transform = this.options.transform ? this.options.transform(this) : null; } catch (e) { transform = null; }
    if (transform && transform.matrix) {
      const m = /** @type {any} */ (transform.matrix);
      const values = m.toFloat32Array ? m.toFloat32Array() : Float32Array.from(m);
      // The matrix is in viewport space; express it in surface space.
      this.matrix = originAdjust(values, origin);
      this.hasTransform = true;
      this.tiltX = finiteNumber(transform.tiltX, 0);
      this.tiltY = finiteNumber(transform.tiltY, 0);
    } else {
      this.matrix = IDENTITY;
      this.hasTransform = false;
      this.tiltX = finiteNumber(this.options.tiltX, 0);
      this.tiltY = finiteNumber(this.options.tiltY, 0);
    }
    return true;
  }

  _readShape(rect) {
    const win = this.surface.glass.env.window;
    const style = win.getComputedStyle(this.el);
    const raw = String(style.borderTopLeftRadius || '0').split(' ')[0];
    const minor = Math.min(rect.width, rect.height);
    let radius = raw.trim().endsWith('%') ? (minor * parseFloat(raw)) / 100 : parseFloat(raw);
    if (!Number.isFinite(radius)) radius = 0;
    const power = Number(style.getPropertyValue('--sf-corner-power')) || Number(style.getPropertyValue('--liquid-corner-power'));
    this.cornerPower = power || (/squircle|superellipse\(2\)/.test(style.getPropertyValue('corner-shape')) ? 4 : 2);
    this.radiusCss = Math.min(radius, minor * 0.5);
    const insetRaw = String(style.getPropertyValue('--sf-hole-inset') || style.getPropertyValue('--liquid-hole-inset') || this.el.getAttribute('data-liquid-hole-inset') || '0').trim();
    const inset = parseFloat(insetRaw);
    this.hollowInsetCss = Number.isFinite(inset) ? Math.max(0, Math.min(inset, minor * 0.5)) : 0;
    this._shapeDirty = false;
    if (this.options.clip && this.options.clipToPaddingBox) this._clipPadding = null;
  }

  _clipElement() {
    const clip = this.options.clip || this.options.clipTarget;
    if (!clip) return null;
    if (typeof clip === 'function') { try { return clip(); } catch (e) { return null; } }
    if (typeof clip === 'string') return this.el.ownerDocument.querySelector(clip);
    return clip;
  }

  _clipRect(origin) {
    const clipEl = this._clipElement();
    if (!clipEl) return null;
    const r = clipEl.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    if (this.options.clipToPaddingBox) {
      if (!this._clipPadding || this._clipPaddingFor !== clipEl) {
        const style = this.surface.glass.env.window.getComputedStyle(clipEl);
        this._clipPadding = [parseFloat(style.paddingLeft) || 0, parseFloat(style.paddingTop) || 0, parseFloat(style.paddingRight) || 0, parseFloat(style.paddingBottom) || 0];
        this._clipPaddingFor = clipEl;
      }
      left += this._clipPadding[0]; top += this._clipPadding[1]; right -= this._clipPadding[2]; bottom -= this._clipPadding[3];
    }
    return {left: left - origin.left, top: top - origin.top, right: right - origin.left, bottom: bottom - origin.top};
  }

  /** Screen-space bounding box of the drawn lens (after its transform), in surface CSS px. */
  screenBounds() {
    const r = this.rect;
    if (!r) return null;
    if (!this.hasTransform) return {left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height};
    const m = this.matrix;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of [[r.left, r.top], [r.left + r.width, r.top], [r.left, r.top + r.height], [r.left + r.width, r.top + r.height]]) {
      const w = m[3] * x + m[7] * y + m[15];
      const px = (m[0] * x + m[4] * y + m[12]) / w;
      const py = (m[1] * x + m[5] * y + m[13]) / w;
      left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py);
    }
    return {left, top, right, bottom};
  }

  // ---------------------------------------------------------------- options

  _normalizePatch(patch) {
    const normalized = {};
    Object.keys(patch || {}).forEach((key) => {
      const value = patch[key];
      if (key === 'material') {
        normalized.material = value === null ? null : normalizeMaterial(value, 0);
        return;
      }
      const bounds = LIVE_NUMERIC_OPTIONS[key];
      if (bounds && typeof value !== 'function') {
        const fallback = finiteNumber(this.options[key], key === 'magnify' || key === 'opacity' ? 1 : 0);
        normalized[key] = clamp(finiteNumber(value, fallback), bounds[0], bounds[1]);
        return;
      }
      normalized[key] = value;
    });
    return normalized;
  }

  _applyPatch(patch, request) {
    const hadShadow = !!this.options.shadow;
    Object.assign(this.options, patch || {});
    this.revealType = this.options.reveal === 'fade' ? 1 : 0;
    const optics = this.resolveOptics(1);
    if (this.options.material !== null && this.options.material !== undefined) {
      this.setShadow(true, optics.shadowStrength);
    } else if (Object.prototype.hasOwnProperty.call(patch || {}, 'shadow') || hadShadow !== !!this.options.shadow) {
      this.setShadow(this.options.shadow, optics.shadowStrength);
    }
    if ('geometry' in (patch || {}) || 'geometryRect' in (patch || {}) || 'clip' in (patch || {})) this.invalidate(true);
    if (request !== false) this.surface.glass.requestRender();
    return this;
  }

  /** Change options immediately. */
  setOptions(patch) {
    this._transition = null;
    return this._applyPatch(this._normalizePatch(patch), true);
  }

  /**
   * Animate numeric options (material, frost, refraction, magnify, opacity,
   * rim, dispersion…) and the tint, whose colour and amount are mixed
   * together. Other options apply at once.
   * @param {object} patch
   * @param {{duration?: number, easing?: string|((t:number)=>number)}} [transition]
   */
  transition(patch, transition = {}) {
    const duration = Math.max(0, finiteNumber(transition.duration, 200));
    if (duration === 0) return this.setOptions(patch);
    const now = this.surface.glass.now();
    if (this._transition) this.advanceTransition(now);
    const normalized = this._normalizePatch(patch);
    const from = {};
    const to = {};
    const immediate = {};
    const final = {};
    Object.keys(normalized).forEach((key) => {
      const value = normalized[key];
      if (LIVE_NUMERIC_OPTIONS[key] && value !== null && typeof value !== 'function') {
        from[key] = this._currentNumber(key);
        to[key] = value;
      } else if (key === 'tint' && value && typeof value === 'object' && parseTintColor(value.color)) {
        from.tint = this._currentTint();
        to.tint = {color: parseTintColor(value.color), amount: clamp(finiteNumber(value.amount, 0.8), 0, 1)};
        final.tint = value;
      } else {
        immediate[key] = value;
      }
    });
    if (Object.keys(immediate).length) this._applyPatch(immediate, false);
    if (Object.keys(to).length) {
      const easing = typeof transition.easing === 'function' ? transition.easing : (easings[transition.easing] || easings.easeOut);
      this._transition = {startTime: now, duration, easing, from, to, final};
    }
    this.surface.glass.requestRender();
    return this;
  }

  /** The value a numeric option has now, falling back to what the material resolves to. */
  _currentNumber(key) {
    const value = this.options[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (key === 'rim' || key === 'dispersion' || key === 'rimTint') {
      const optics = this.resolveOptics(1);
      return key === 'rim' ? optics.rim : key === 'rimTint' ? finiteNumber(optics.rimTint, 1) : optics.dispersionAmount;
    }
    return key === 'magnify' || key === 'opacity' ? 1 : 0;
  }

  /** The body colour now: the tint option, or the material's own tone. */
  _currentTint() {
    const tint = this.options.tint;
    const color = tint && typeof tint === 'object' ? parseTintColor(tint.color) : null;
    if (color) return {color, amount: clamp(finiteNumber(tint.amount, 0.8), 0, 1)};
    const optics = this.resolveOptics(1);
    const display = optics.toneSpace === 'display' ? optics.tone : optics.tone.map((v) => Math.pow(clamp(finiteNumber(v, 1), 0, 1), 1 / 2.2));
    return {color: display.slice(0, 3), amount: clamp(finiteNumber(optics.toneAmount, 0), 0, 1)};
  }

  /** Legacy name for transition(). */
  transitionOptions(patch, transition) { return this.transition(patch, transition); }

  /** @returns {boolean} whether a transition is still running */
  advanceTransition(now) {
    const transition = this._transition;
    if (!transition) return false;
    const progress = clamp((now - transition.startTime) / transition.duration, 0, 1);
    const eased = clamp(finiteNumber(transition.easing(progress), progress), 0, 1);
    const next = {};
    Object.keys(transition.to).forEach((key) => {
      next[key] = key === 'tint' ? mixTint(transition.from.tint, transition.to.tint, eased) : mixNumber(transition.from[key], transition.to[key], eased);
    });
    // Land on the values exactly as given (a tint keeps its CSS colour string).
    if (progress >= 1) Object.assign(next, transition.final || {});
    this._applyPatch(next, false);
    if (progress >= 1) { this._transition = null; return false; }
    return true;
  }

  /** @param {number} [quality] */
  resolveOptics(quality) {
    if (this.options.material !== null && this.options.material !== undefined) {
      const base = resolveMaterial(this.options.material, this.rect ? {width: this.rect.width, height: this.rect.height} : {width: 0, height: 0}, quality);
      return applyOpticsOverrides(base, this.options);
    }
    const o = this.options;
    return {
      material: 0, density: 0, side: 0, tone: [1, 1, 1], materialAlpha: 0,
      frostSigmaPx: Math.max(0, finiteNumber(o.frost, 0)),
      refraction: Math.max(0, finiteNumber(o.refraction, 0.01)),
      refractionFill: clamp(finiteNumber(o.refractionFill, 0), 0, 1),
      bevelDepth: Math.max(0, finiteNumber(o.bevelDepth, 0.08)),
      bevelWidth: Math.max(0, finiteNumber(o.bevelWidth, 0.15)),
      magnify: clamp(finiteNumber(o.magnify, 1), 0.001, 3),
      specularPrimary: 0.1675, specularSecondary: 0.08, shadowStrength: 0.1,
      specular: o.specular !== false,
      toneSpace: 'linear', toneAmount: 0, rim: 0.25, rimTint: 1, dispersionAmount: 1,
    };
  }

  // ---------------------------------------------------------------- shadow

  _shadowValue(strength) {
    const light = this._light || {x: 0, y: 0, intensity: 0};
    const intensity = clamp(finiteNumber(light.intensity, 0), 0, 1);
    // Quarter-pixel steps: the offset spans ±2 px, so a moving light changes
    // the shadow (and repaints it) at most a few times per sweep.
    const step = (v) => Math.round(v * 4) / 4;
    const offsetX = step(clamp(finiteNumber(light.x, 0), -1, 1) * intensity * 2.0);
    const offsetY = step(clamp(finiteNumber(light.y, 0), -1, 1) * intensity * 2.0);
    return `${offsetX.toFixed(2)}px ${(10 + offsetY).toFixed(2)}px 30px rgba(0,0,0,${strength.toFixed(4)}), ` +
      `${(-offsetX * 0.25).toFixed(2)}px ${(-offsetY * 0.25).toFixed(2)}px 0 0.5px rgba(0,0,0,${(strength * 0.5).toFixed(4)})`;
  }

  /**
   * Follow the light with the drop shadow. Writes the style only when the
   * rounded value changes, so a light that moves continuously repaints the
   * shadow rarely (it moves by at most 2 px across the full light range).
   */
  setLight(light) {
    this._light = light;
    if (!this.options.shadow && !this._cssTier) return;
    const value = this._boxShadow();
    if (value === this._shadowKey) return;
    this._shadowKey = value;
    this.el.style.boxShadow = value;
  }

  setShadow(enabled, strength) {
    this.options.shadow = !!enabled;
    this._shadowStrength = clamp(finiteNumber(strength, 0.1), 0, 0.4);
    const value = this._boxShadow();
    this._shadowKey = value;
    this.el.style.boxShadow = value || this.originalShadow;
  }

  /** Drop shadow (when enabled) plus, in the CSS tiers, the inner rim. */
  _boxShadow() {
    const parts = [];
    if (this.options.shadow) parts.push(this._shadowValue(clamp(finiteNumber(this._shadowStrength, 0.1), 0, 0.4)));
    if (this._cssTier) parts.push(this._rimValue());
    return parts.join(', ');
  }

  /**
   * CSS-tier rim: a hairline all round, plus (frost) a brighter edge on the
   * side the light comes from, in quarter-pixel steps like the shadow.
   */
  _rimValue() {
    const hairline = 'inset 0 0 0 0.5px rgba(255,255,255,0.14)';
    if (this._cssTier !== 'frost') return hairline;
    const light = this._light || {x: 0, y: 0, intensity: 0};
    const intensity = clamp(finiteNumber(light.intensity, 0), 0, 1);
    const step = (v) => Math.round(v * 4) / 4;
    const x = step(-clamp(finiteNumber(light.x, 0), -1, 1) * 1.5);
    const y = step(-clamp(finiteNumber(light.y, 0), -1, 1) * 1.5);
    return `inset ${x.toFixed(2)}px ${y.toFixed(2)}px 0 0 rgba(255,255,255,${(0.10 + 0.22 * intensity).toFixed(3)}), ${hairline}`;
  }

  // ------------------------------------------------------------- CSS tiers

  /**
   * Draw this lens with the element's own background and backdrop-filter
   * (the 'static' and 'frost' tiers, or while WebGL is unavailable). Pass
   * null to hand the lens back to WebGL. Styles are written only on change.
   * @param {'static'|'frost'|null} tierName
   */
  applyCss(tierName) {
    const el = this.el;
    const style = el.style;
    if (!tierName) {
      if (!this._cssTier) return;
      this._cssTier = null;
      this._cssKey = '';
      el.removeAttribute('data-sf-tier');
      style.backdropFilter = 'none';
      /** @type {any} */ (style).webkitBackdropFilter = 'none';
      style.background = 'transparent';
      this._shadowKey = this._boxShadow();
      style.boxShadow = this._shadowKey || this.originalShadow;
      return;
    }
    const entering = this._cssTier !== tierName;
    this._cssTier = tierName;
    const optics = this.resolveOptics(1);
    const shown = this.el.isConnected && this._value('visible', true);
    const strength = shown ? this.opacity() * (this.revealType === 1 ? this.revealProgress : 1) : 0;
    const srgb = (v) => Math.round(255 * Math.pow(clamp(finiteNumber(v, 1), 0, 1), 1 / 2.2));
    let rgb = optics.toneSpace === 'display' ? optics.tone.map((v) => Math.round(255 * clamp(v, 0, 1))) : optics.tone.map(srgb);
    let alpha;
    let filter = 'none';
    if (!strength) {
      alpha = 0;
    } else if (tierName === 'static') {
      // Reduced transparency: a mostly opaque fill, no blur.
      if (optics.side === 0) rgb = [128, 128, 132];
      alpha = optics.side === 0 ? 0.6 : 0.72 + 0.2 * optics.density;
    } else {
      // Dark glass reads mostly through its tint, so it carries more of it.
      alpha = optics.side < 0 ? 0.12 + 0.7 * optics.density : 0.06 + 0.5 * optics.density;
      // An explicit tint says how much body colour it wants.
      if (optics.toneSpace === 'display') alpha = Math.max(alpha, 0.1 + 0.85 * finiteNumber(optics.toneAmount, 0));
      const blur = Math.max(2, Math.round(finiteNumber(optics.frostSigmaPx, 0)));
      filter = `blur(${blur}px) saturate(1.4)`;
    }
    alpha = clamp(alpha * strength, 0, 0.95);
    const background = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
    const key = tierName + '|' + background + '|' + filter;
    if (key !== this._cssKey) {
      this._cssKey = key;
      el.setAttribute('data-sf-tier', tierName);
      style.background = background;
      style.backdropFilter = filter;
      /** @type {any} */ (style).webkitBackdropFilter = filter;
    }
    if (entering) {
      this._shadowKey = this._boxShadow();
      style.boxShadow = this._shadowKey;
    }
  }

  // ---------------------------------------------------------------- reveal

  reveal() {
    if (this.revealType === 0) {
      this.el.style.opacity = String(this.originalOpacity || 1);
      this.revealProgress = 1;
      this._triggerInit();
      return;
    }
    const glass = this.surface.glass;
    const start = glass.now();
    this._revealStart = start;
    glass.requestRender();
  }

  /**
   * Drive the diffusion reveal by hand: 0 draws nothing, 1 is fully formed;
   * refraction, frost and body tint grow in at different rates in between.
   * Pass null to return to a fully formed lens.
   * @param {number|null} progress
   */
  setReveal(progress) {
    // A running fade drives the element's opacity; hand it back first.
    if (this._revealStart !== undefined) {
      this.el.style.opacity = String(this.originalOpacity || 1);
      this.el.style.transition = this.originalTransition || '';
    }
    this._revealStart = undefined;
    if (progress === null || progress === undefined) {
      this.revealType = this.options.reveal === 'fade' ? 1 : 0;
      this.revealProgress = 1;
    } else {
      this.revealType = 1;
      this.revealProgress = clamp(finiteNumber(progress, 1), 0, 1);
    }
    this.surface.glass.requestRender();
  }

  /** @returns {boolean} whether the reveal is still animating */
  advanceReveal(now) {
    if (this.revealType !== 1 || this._revealStart === undefined) return false;
    const progress = Math.min(1, (now - this._revealStart) / 1000);
    this.revealProgress = progress;
    this.el.style.opacity = String((Number(this.originalOpacity) || 1) * progress);
    if (progress >= 1) {
      this._revealStart = undefined;
      this.el.style.transition = this.originalTransition || '';
      this._triggerInit();
      return false;
    }
    return true;
  }

  _triggerInit() {
    if (this._initCalled) return;
    this._initCalled = true;
    if (this.options.on && this.options.on.init) this.options.on.init(this);
  }

  destroy() {
    this._transition = null;
    this.applyCss(null);
    const style = this.el.style;
    Object.entries(this._originalStyles).forEach(([key, value]) => { /** @type {any} */ (style)[key] = value || ''; });
    this.el.removeAttribute('data-sf-tier');
    try { if (this._resizeObserver) this._resizeObserver.disconnect(); } catch (e) { /* ignore */ }
    const underlay = this.underlay();
    if (underlay && underlay.clear) { try { underlay.clear(); } catch (e) { /* ignore */ } }
    this.surface._removeLens(this);
  }
}

/**
 * Express a viewport-space CSS matrix in surface space: T(-o) · M · T(o).
 * @param {Float32Array} m column-major 4×4
 * @param {{left:number, top:number}} origin
 */
function originAdjust(m, origin) {
  const ox = origin.left, oy = origin.top;
  if (!ox && !oy) return m;
  const out = new Float32Array(m);
  // M · T(o): add o.x·col0 + o.y·col1 to col3.
  for (let r = 0; r < 4; r++) out[12 + r] = m[12 + r] + ox * m[r] + oy * m[4 + r];
  // T(-o) · (…): subtract o times the w row from the x and y rows.
  for (let c = 0; c < 4; c++) {
    out[c * 4] -= ox * out[c * 4 + 3];
    out[c * 4 + 1] -= oy * out[c * 4 + 3];
  }
  return out;
}
