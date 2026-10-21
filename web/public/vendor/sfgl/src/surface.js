/**
 * A surface: one WebGL canvas that draws a set of lenses.
 *
 * Most pages need one surface. Lenses that live in different stacking
 * contexts can use more; each surface has its own context and prepares its
 * own backdrop.
 * @module
 */
import {createContext, createProgram, finishProgram, setUniform} from './gl/context.js';
import {LENS_FRAGMENT, LENS_VERTEX, prelude} from './gl/shaders.js';
import {BackdropTarget} from './backdrop.js';
import {Lens} from './lens.js';
import {clamp, finiteNumber} from './material.js';
import {stepContact} from './contact.js';

/** Extra CSS px copied around a layer for refraction and bleed reach. */
const LAYER_MARGIN = 64;

export class Surface {
  /**
   * @param {import('./glass.js').Glass} glass
   * @param {{host?: HTMLElement, z?: number|string, bounds?: 'viewport'|'host', className?: string, attributes?: Record<string,string>}} options
   */
  constructor(glass, options = {}) {
    this.glass = glass;
    this.options = options;
    const doc = glass.env.document;
    this.canvas = doc.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.setAttribute('data-sf-surface', '');
    this.canvas.setAttribute('data-liquid-ignore', '');
    if (options.className) this.canvas.className = options.className;
    Object.entries(options.attributes || {}).forEach(([k, v]) => this.canvas.setAttribute(k, v));
    const style = this.canvas.style;
    style.pointerEvents = 'none';
    style.position = options.host ? 'absolute' : 'fixed';
    style.left = '0px';
    style.top = '0px';
    if (options.z !== undefined) style.zIndex = String(options.z);
    (options.host || doc.body).insertBefore(this.canvas, (options.host || doc.body).firstChild);
    this.lenses = [];
    this.renderScale = 1;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.origin = {left: 0, top: 0};
    this._placementDirty = true;
    this.stats = {renders: 0, copies: 0, copyPixels: 0, lensDraws: 0};
    this.lost = false;
    this.unavailable = false;
    this.cssMode = false;
    this.gl = null;
    this.backdrop = null;
    this.losses = 0;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._lose(); }, false);
    this.canvas.addEventListener('webglcontextrestored', () => {
      try { this._init(); } catch (err) { this.unavailable = true; }
      glass.requestRender();
    }, false);
    // The WebGL context is created on the first WebGL frame, so pages that
    // start in a CSS tier never pay for one.
  }

  /**
   * Whether this surface can draw with WebGL now (creating the context on
   * first use). False while the context is lost or when WebGL is missing.
   */
  webglReady() {
    if (this.lost || this.unavailable) return false;
    if (this.gl) return true;
    try {
      this._init();
      return true;
    } catch (e) {
      this.unavailable = true;
      this.gl = null;
      return false;
    }
  }

  _init() {
    const created = createContext(this.canvas, {webgl2: this.glass.options.webgl2 !== false});
    if (!created) throw new Error('sfgl: WebGL unavailable');
    this.gl = created.gl;
    // capsOverride lets tests force a weaker path (e.g. {lodMode: 'bias'}).
    this.caps = Object.assign(created.caps, this.glass.options.capsOverride || {});
    const gl = this.gl;
    this.lost = false;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.backdrop = new BackdropTarget(gl, this.caps, this.quad);
    if (this.glass._backdropProvider) this.backdrop.setProvider(this.glass._backdropProvider);
    this.programs = new Map();
    this.pending = new Map();
    this.underGlass = null;
    this.underGlassSize = [0, 0];
    this.underText = null;
    this.underTextRevision = -1;
    this.underTextCanvas = null;
    this.cssWidth = 0;
    this.cssHeight = 0;
    // Start compiling the common variants in the background.
    if (this.caps.parallelCompile) {
      const d = this.glass.tier().dispersion;
      /** @type {Array<[boolean, boolean, number]>} */ ([[false, false, d], [true, false, d], [false, true, d]]).forEach(([g, t, disp]) => this._variant({underGlass: g, underText: t, dispersion: disp, debugFlat: false}, true));
    }
  }

  _lose() {
    if (this._destroyed) return;
    this.lost = true;
    this.losses++;
    this.programs = new Map();
    this.pending = new Map();
    // Lenses fall back to CSS until the context is restored; repeated losses
    // (an overloaded GPU) step an automatic tier down.
    this.clearUnderlays();
    this.glass._onContextLost(this);
    this.glass.requestRender();
  }

  /**
   * CSS-tier frame: hide the canvas and let each lens style its element.
   * @param {'static'|'frost'} tierName
   * @param {{now: number}} context
   * @returns {boolean} whether something is still animating
   */
  renderCss(tierName, context) {
    if (!this.cssMode) {
      this.cssMode = true;
      this.clearUnderlays();
      this.canvas.style.display = 'none';
      if (this.gl && !this.lost) {
        // Release the backing store while the canvas is unused.
        this.canvas.width = 1;
        this.canvas.height = 1;
        this.cssWidth = 0;
        this.cssHeight = 0;
      }
    }
    let animating = false;
    this.lenses.forEach((lens) => {
      if (lens.advanceTransition(context.now)) animating = true;
      if (lens.advanceReveal(context.now)) animating = true;
      lens.applyCss(tierName);
    });
    return animating;
  }

  /** Restore DOM text that underlays clipped (when WebGL stops drawing them). */
  clearUnderlays() {
    this.lenses.forEach((lens) => {
      const underlay = lens.underlay();
      if (underlay && underlay.clear) { try { underlay.clear(); } catch (e) { /* ignore */ } }
    });
  }

  _leaveCss() {
    if (!this.cssMode) return;
    this.cssMode = false;
    this.canvas.style.display = '';
    this._placementDirty = true;
    this.lenses.forEach((lens) => lens.applyCss(null));
  }

  /** @param {{underGlass:boolean, underText:boolean, dispersion:number, debugFlat:boolean}} v */
  _variant(v, background = false) {
    const key = `${+v.underGlass}${+v.underText}${v.dispersion}${+v.debugFlat}`;
    const ready = this.programs.get(key);
    if (ready) return ready;
    const gl = this.gl;
    let pending = this.pending.get(key);
    if (!pending) {
      const defines = {SF_UNDER_GLASS: v.underGlass, SF_UNDER_TEXT: v.underText, SF_DISPERSION: v.dispersion, SF_DEBUG_FLAT: v.debugFlat};
      pending = createProgram(gl, prelude(this.caps, 'vertex') + LENS_VERTEX, prelude(this.caps, 'fragment', defines) + LENS_FRAGMENT);
      this.pending.set(key, pending);
    }
    if (background) return null;
    const info = finishProgram(gl, pending, null);
    this.pending.delete(key);
    this.programs.set(key, info);
    return info;
  }

  /** Add a lens for an element. */
  lens(element, options) {
    const existing = this.lenses.find((lens) => lens.el === element);
    if (existing) {
      if (options) existing.setOptions(options);
      return existing;
    }
    const lens = new Lens(this, element, options);
    this.lenses.push(lens);
    lens.reveal();
    this.glass.requestRender();
    return lens;
  }

  /**
   * Keep exactly these elements as lenses of a group, creating and destroying
   * lenses as needed. Lenses of other groups are untouched.
   * @param {string} group @param {Iterable<HTMLElement>} elements @param {object} options
   */
  syncGroup(group, elements, options) {
    const wanted = new Set(Array.from(elements || []).filter(Boolean));
    this.lenses.slice().forEach((lens) => {
      if (lens.group !== group) return;
      if (!wanted.has(lens.el) || !lens.el.isConnected) lens.destroy();
    });
    const out = [];
    wanted.forEach((el) => {
      if (!el.isConnected) return;
      const lens = this.lens(el, options);
      lens.group = group;
      out.push(lens);
    });
    return out;
  }

  _removeLens(lens) {
    const i = this.lenses.indexOf(lens);
    if (i >= 0) this.lenses.splice(i, 1);
    this.glass.requestRender();
  }

  invalidate() { this._placementDirty = true; }

  _place() {
    const win = this.glass.env.window;
    const host = this.options.host;
    let width = win.innerWidth || 1;
    let height = win.innerHeight || 1;
    if (host && this.options.bounds === 'host') {
      const r = host.getBoundingClientRect();
      width = Math.max(1, r.width);
      height = Math.max(1, r.height);
      this.canvas.style.left = '0px';
      this.canvas.style.top = '0px';
    } else if (host) {
      // Cover the viewport from inside the host's stacking context.
      const r = host.getBoundingClientRect();
      this.canvas.style.left = (-r.left).toFixed(3) + 'px';
      this.canvas.style.top = (-r.top).toFixed(3) + 'px';
    }
    const scale = this.glass.renderScale();
    if (width !== this.cssWidth || height !== this.cssHeight || scale !== this.renderScale) {
      this.cssWidth = width;
      this.cssHeight = height;
      this.renderScale = scale;
      this.canvas.width = Math.max(1, Math.round(width * scale));
      this.canvas.height = Math.max(1, Math.round(height * scale));
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
    }
    this._placementDirty = false;
  }

  /**
   * Where the canvas actually is, in the same client coordinates lenses are
   * measured in. Lens positions are taken relative to it, so they line up
   * with their elements wherever the canvas ends up: under an iOS keyboard
   * the visual viewport pans and client coordinates shift with it, and a
   * host that moves carries the canvas along until the next placement.
   */
  _readOrigin() {
    const r = this.canvas.getBoundingClientRect();
    this.origin = {left: r.left, top: r.top};
  }

  /**
   * Read phase: placement and lens geometry.
   * @returns {Array<{lens: Lens, i: number, layer: number}>} lenses to draw, in layer order
   */
  measure() {
    if (this.lost) return [];
    this._leaveCss();
    if (this._placementDirty || !this.cssWidth) this._place();
    this._readOrigin();
    const drawable = [];
    this.lenses.forEach((lens) => { if (lens.measure(this.origin)) drawable.push(lens); });
    // Stable sort by layer: lower layers draw first.
    return drawable.map((lens, i) => ({lens, i, layer: lens.layer()})).sort((a, b) => a.layer - b.layer || a.i - b.i);
  }

  clear() {
    if (this.lost || !this.gl) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Draw phase.
   * @param {Array<{lens: Lens, layer: number}>} ordered
   * @param {{timestamp: number}} frame
   * @param {object} context  per-frame values from the glass (light, contact, quality…)
   * @returns {boolean} whether something is still animating
   */
  render(ordered, frame, context) {
    if (this.lost) return false;
    const gl = this.gl;
    const tier = context.tier;
    let animating = false;
    this.clear();
    if (!this.backdrop.prepare(frame, {left: 0, top: 0, width: this.cssWidth, height: this.cssHeight}, tier)) { this.clearUnderlays(); return false; }
    // The prepare pass draws into its own framebuffer and viewport.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.stats.renders++;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const underlays = new Set();
    ordered.forEach(({lens}) => { const u = lens.underlay(); if (u) underlays.add(u); });
    underlays.forEach((u) => { if (u.beginFrame) u.beginFrame(); });

    let drawn = null; // union of drawn screen bounds (surface CSS px)
    let currentLayer = null;
    let underGlassActive = false;
    for (let index = 0; index < ordered.length; index++) {
      const {lens, layer} = ordered[index];
      if (layer !== currentLayer) {
        currentLayer = layer;
        underGlassActive = false;
        if (tier.layers && drawn) {
          // Copy only the part of the glass below that this layer can see.
          let need = null;
          for (let j = index; j < ordered.length && ordered[j].layer === layer; j++) need = union(need, ordered[j].lens.screenBounds());
          // Copy the whole reach (including transparent pixels) so nothing
          // stale from an earlier frame can be refracted; skip the copy when
          // the layer cannot see any glass below it.
          const reach = need ? expand(need, LAYER_MARGIN) : null;
          if (reach && intersect(reach, drawn)) underGlassActive = this._captureUnderGlass(reach);
        }
      }
      if (lens.advanceTransition(context.now)) animating = true;
      if (lens.advanceReveal(context.now)) animating = true;
      if (this._drawLens(lens, frame, context, underGlassActive)) animating = true;
      drawn = union(drawn, lens.screenBounds());
    }
    underlays.forEach((u) => { if (u.endFrame) u.endFrame(); });
    return animating;
  }

  _captureUnderGlass(region) {
    const gl = this.gl;
    const scale = this.renderScale;
    const w = this.canvas.width, h = this.canvas.height;
    const x0 = Math.max(0, Math.floor(region.left * scale));
    const x1 = Math.min(w, Math.ceil(region.right * scale));
    const y0 = Math.max(0, Math.floor(h - region.bottom * scale));
    const y1 = Math.min(h, Math.ceil(h - region.top * scale));
    if (x1 <= x0 || y1 <= y0) return false;
    gl.activeTexture(gl.TEXTURE3);
    if (!this.underGlass) {
      this.underGlass = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.underGlass);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.underGlass);
    }
    if (this.underGlassSize[0] !== w || this.underGlassSize[1] !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.underGlassSize = [w, h];
    }
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x0, y0, x1 - x0, y1 - y0);
    gl.activeTexture(gl.TEXTURE0);
    this.stats.copies++;
    this.stats.copyPixels += (x1 - x0) * (y1 - y0);
    return true;
  }

  _bindUnderText(source, bd) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE5);
    if (!this.underText) {
      this.underText = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.underText);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.underText);
    }
    // Key on the source canvas as well: two underlays can share a revision.
    if (this.underTextRevision !== source.revision || this.underTextCanvas !== source.canvas) {
      this.underTextCanvas = source.canvas;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.underTextRevision = source.revision;
    }
    gl.activeTexture(gl.TEXTURE0);
    const r = source.bounds;
    return [(r.left - this.origin.left - bd.left) / bd.width, (r.top - this.origin.top - bd.top) / bd.height, r.width / bd.width, r.height / bd.height];
  }

  /** @returns {boolean} whether this lens is still animating (press glow). */
  _drawLens(lens, frame, context, underGlass) {
    const gl = this.gl;
    const rect = lens.rect;
    const bd = this.backdrop.cssRect;
    const tier = context.tier;
    const opacity = lens.opacity();
    if (opacity <= 0.001) return false;

    // Live content underlay (e.g. neighbouring text refracted by a selection).
    let underTextBounds = null;
    const underlay = tier.underlay ? lens.underlay() : null;
    if (underlay && underlay.prepare) {
      if (opacity >= 0.995) {
        const viewportRect = {left: rect.left + this.origin.left, top: rect.top + this.origin.top, width: rect.width, height: rect.height};
        const source = underlay.prepare(viewportRect, lens.radiusCss, true);
        if (source) underTextBounds = this._bindUnderText(source, bd);
      } else if (underlay.clear) {
        underlay.clear();
      }
    }

    const info = this._variant({underGlass, underText: !!underTextBounds, dispersion: tier.dispersion, debugFlat: !!context.debugFlat});
    gl.useProgram(info.program);
    const set = (name, value) => setUniform(gl, info, name, value);
    const scale = this.renderScale;

    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.backdrop.texture);
    set('u_backdrop', 6);
    if (underGlass) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.underGlass); set('u_underGlass', 3); }
    if (underTextBounds) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.underText); set('u_underText', 5); set('u_underTextBounds', underTextBounds); }
    gl.activeTexture(gl.TEXTURE0);

    set('u_lensRect', [rect.left, rect.top, rect.width, rect.height]);
    set('u_surfaceSize', [this.cssWidth, this.cssHeight]);
    set('u_surfaceCssSize', [this.cssWidth, this.cssHeight]);
    set('u_transform', lens.matrix);
    set('u_fragTransform', lens.matrix);
    set('u_hasTransform', lens.hasTransform);
    set('u_backdropTexSize', [this.backdrop.width, this.backdrop.height]);
    set('u_backdropCssSize', [bd.width, bd.height]);
    set('u_backdropToSurface', [bd.width / this.cssWidth, bd.height / this.cssHeight, bd.left / this.cssWidth, bd.top / this.cssHeight]);
    set('u_resolution', [rect.width * scale, rect.height * scale]);
    set('u_lensCssSize', [rect.width, rect.height]);
    set('u_devicePixelRatio', scale);
    set('u_bounds', [(rect.left - bd.left) / bd.width, (rect.top - bd.top) / bd.height, rect.width / bd.width, rect.height / bd.height]);

    const optics = lens.resolveOptics(context.quality);
    set('u_refraction', optics.refraction);
    set('u_frost', Math.max(0, optics.frostSigmaPx));
    set('u_frostEnabled', context.frostEnabled ? 1 : 0);
    set('u_radius', lens.radiusCss * scale);
    set('u_cornerPower', lens.cornerPower || 2);
    set('u_specular', !!optics.specular);
    set('u_revealProgress', lens.revealProgress);
    set('u_revealType', lens.revealType);
    set('u_tiltX', lens.tiltX);
    set('u_tiltY', lens.tiltY);
    set('u_magnify', clamp(finiteNumber(optics.magnify, 1), 0.001, 3));
    set('u_hollowInset', lens.hollowInsetCss * scale);
    set('u_hollowMaskContent', lens.hollowMaskContent);
    set('u_materialDensity', optics.density);
    set('u_materialSign', optics.side);
    set('u_materialTone', optics.tone);
    set('u_specularPrimary', optics.specularPrimary);
    set('u_specularSecondary', optics.specularSecondary);
    set('u_toneAmount', clamp(finiteNumber(optics.toneAmount, 0), 0, 1));
    set('u_rim', Math.max(0, finiteNumber(optics.rim, 0.25)));
    set('u_rimTint', clamp(finiteNumber(optics.rimTint, 1), 0, 1));
    set('u_dispersionAmount', clamp(finiteNumber(optics.dispersionAmount, 1), 0, 1));
    set('u_globalLight', [context.light.x, context.light.y]);
    set('u_globalLightIntensity', context.light.intensity);
    const contactRect = {left: rect.left + this.origin.left, top: rect.top + this.origin.top, width: rect.width, height: rect.height};
    const contact = stepContact(lens.contact, context.contact, contactRect, context.now, context.reducedMotion);
    lens.contact = contact.state;
    set('u_contact', [contact.state.x, contact.state.y, contact.state.press, 0]);
    set('u_highlight', lens.highlightValue || 0);
    set('u_scrollEdge', lens.edgeFrost());
    set('u_opacity', opacity);

    const clip = lens.clipRect;
    if (clip) {
      gl.enable(gl.SCISSOR_TEST);
      // Round outwards so fractional positions keep their SDF edge coverage.
      const h = this.canvas.height;
      const left = Math.max(0, Math.floor(clip.left * scale));
      const right = Math.min(this.canvas.width, Math.ceil(clip.right * scale));
      const bottom = Math.max(0, Math.floor(h - clip.bottom * scale));
      const top = Math.min(h, Math.ceil(h - clip.top * scale));
      gl.scissor(left, bottom, Math.max(0, right - left), Math.max(0, top - bottom));
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);
    this.stats.lensDraws++;
    if (underTextBounds && underlay.commit) underlay.commit();
    lens.drawn = true;
    return !contact.settled;
  }

  destroy() {
    this._destroyed = true;
    this.lenses.slice().forEach((lens) => lens.destroy());
    try { if (this.backdrop) this.backdrop.dispose(); } catch (e) { /* ignore */ }
    try { if (this.caps && this.caps.loseContext) this.caps.loseContext.loseContext(); } catch (e) { /* ignore */ }
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.glass._removeSurface(this);
  }
}

function union(a, b) {
  if (!b) return a;
  if (!a) return {left: b.left, top: b.top, right: b.right, bottom: b.bottom};
  return {left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)};
}
function intersect(a, b) {
  const r = {left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)};
  return r.right > r.left && r.bottom > r.top ? r : null;
}
function expand(a, m) {
  return {left: a.left - m, top: a.top - m, right: a.right + m, bottom: a.bottom + m};
}
