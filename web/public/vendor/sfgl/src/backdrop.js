/**
 * Backdrops: what the glass refracts.
 *
 * A backdrop provider describes the picture behind the glass. sfgl renders it
 * once into a power-of-two texture in screen space, builds mip levels for the
 * frost, and every lens samples that one texture at its own position. The
 * prepare pass runs only when the provider's key changes, or, for a dynamic
 * provider, at most at the quality tier's backdrop rate.
 *
 * Provider shapes (all functions are optional unless noted):
 *
 *   image provider (built-in, see imageBackdrop()):
 *     {kind: 'image', source(): TexImageSource, fit: 'cover'|'contain'|'stretch',
 *      key(): string, rect(): Rect, opaque: boolean,
 *      update(frame): void,       // optional: redraw the source; called in the glass frame, before prepare
 *      scrollLinked: boolean}     // optional: the source shows scrolled content; scrolling asks for a frame
 *
 *   Any provider may have update() and scrollLinked. A host that repaints a
 *   canvas from scroll events should do it in update(), not in its own
 *   requestAnimationFrame: the glass then reads the new canvas in the same
 *   frame instead of the next one.
 *
 *   program provider (host GLSL):
 *     {kind: 'program',
 *      fragment: string,                         // required: defines vec4 sfBackdrop(vec2 uv)
 *      textures(): {[sampler]: {source, key, flipY?, mipmap?}},
 *      uniforms(frame): {[name]: number|number[]|boolean},
 *      key(frame): string,                       // changes when the picture changes
 *      dynamic(frame): boolean,                  // true while it animates every frame
 *      rect(): Rect, ready(): boolean}
 *
 * Rect is {left, top, width, height} in surface CSS pixels; the default is
 * the whole surface.
 * @module
 */
import {createProgram, finishProgram, nextPowerOfTwo, setUniform} from './gl/context.js';
import {FULLSCREEN_VERTEX, IMAGE_BACKDROP, prepareFragment, prelude} from './gl/shaders.js';

/**
 * A static or changing image/canvas/video behind the glass.
 * @param {TexImageSource|(() => TexImageSource|null)} source
 * @param {{fit?: 'cover'|'contain'|'stretch', key?: () => string, rect?: () => any, opaque?: boolean, dynamic?: () => boolean,
 *   update?: (frame: {timestamp: number}) => void, scrollLinked?: boolean}} [options]
 */
export function imageBackdrop(source, options = {}) {
  const resolve = typeof source === 'function' ? source : () => source;
  let revision = 0;
  let last = null;
  return {
    kind: 'image',
    fit: options.fit || 'cover',
    opaque: options.opaque !== false,
    source: resolve,
    rect: options.rect,
    dynamic: options.dynamic,
    update: options.update,
    scrollLinked: !!options.scrollLinked,
    key() {
      if (options.key) return String(options.key());
      const current = resolve();
      if (current !== last) { last = current; revision++; }
      return 'image:' + revision;
    },
    ready() {
      const s = resolve();
      return !!s && sourceSize(s).width > 0;
    },
  };
}

/** @param {any} source */
export function sourceSize(source) {
  if (!source) return {width: 0, height: 0};
  return {
    width: source.videoWidth || source.naturalWidth || source.displayWidth || source.width || 0,
    height: source.videoHeight || source.naturalHeight || source.displayHeight || source.height || 0,
  };
}

const FIT = {stretch: 0, cover: 1, contain: 2};

/**
 * Per-surface backdrop state: the provider's programs and textures, and the
 * prepared mip-mapped texture lenses sample.
 */
export class BackdropTarget {
  /**
   * @param {WebGLRenderingContext} gl
   * @param {import('./gl/context.js').GLCaps} caps
   * @param {WebGLBuffer} quad
   */
  constructor(gl, caps, quad) {
    this.gl = gl;
    this.caps = caps;
    this.quad = quad;
    this.provider = null;
    this.texture = null;
    this.framebuffer = null;
    this.width = 0;
    this.height = 0;
    this.cssRect = {left: 0, top: 0, width: 1, height: 1};
    this.key = null;
    this.lastPrepareAt = 0;
    this.prepareCount = 0;
    this.ready = false;
    this.programs = new Map();
    this.inputs = new Map();
  }

  /** @param {any} provider */
  setProvider(provider) {
    if (provider === this.provider) return;
    this.provider = provider || null;
    this.key = null;
    this.ready = false;
  }

  _program(provider) {
    const source = provider.kind === 'image' ? IMAGE_BACKDROP : String(provider.fragment || '');
    let entry = this.programs.get(source);
    if (!entry) {
      const gl = this.gl;
      const pending = createProgram(gl, prelude(this.caps, 'vertex') + FULLSCREEN_VERTEX, prelude(this.caps, 'fragment') + prepareFragment(source));
      entry = finishProgram(gl, pending, null);
      this.programs.set(source, entry);
    }
    return entry;
  }

  _input(name, spec) {
    const gl = this.gl;
    const source = spec && (spec.source !== undefined ? spec.source : spec);
    if (!source) return null;
    const key = spec && spec.key !== undefined ? String(spec.key) : null;
    let entry = this.inputs.get(name);
    if (!entry) {
      entry = {texture: gl.createTexture(), key: undefined, source: null, width: 0, height: 0};
      this.inputs.set(name, entry);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    const changed = key === null ? entry.source !== source || (spec && spec.live) : entry.key !== key || entry.source !== source;
    if (changed) {
      const size = sourceSize(source);
      if (!(size.width > 0 && size.height > 0)) return null;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!(spec && spec.flipY));
      try {
        if (entry.width === size.width && entry.height === size.height && entry.uploaded) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        }
        entry.uploaded = true;
      } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      const pot = (n) => (n & (n - 1)) === 0;
      const mip = (spec && spec.mipmap !== false) && (this.caps.webgl2 || (pot(size.width) && pot(size.height)));
      // Some sources (SVG images) upload at a size other than their natural
      // size, so WebGL1 can still reject the mip chain; fall back to linear.
      let mipped = false;
      if (mip) {
        while (gl.getError() !== gl.NO_ERROR) { /* drain earlier errors */ }
        gl.generateMipmap(gl.TEXTURE_2D);
        mipped = gl.getError() === gl.NO_ERROR;
      }
      if (mipped) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      entry.key = key;
      entry.source = source;
      entry.width = size.width;
      entry.height = size.height;
    }
    return entry;
  }

  /**
   * Prepare the backdrop for this frame if needed.
   * @param {{timestamp:number}} frame
   * @param {{left:number,top:number,width:number,height:number}} surfaceRect surface CSS rect
   * @param {{backdropCap:number, backdropRate:number}} quality
   * @returns {boolean} whether the prepared texture is usable
   */
  prepare(frame, surfaceRect, quality) {
    const provider = this.provider;
    const gl = this.gl;
    if (!provider) { this.ready = false; return false; }
    try { if (provider.ready && !provider.ready()) { this.ready = false; return false; } } catch (e) { this.ready = false; return false; }
    let rect = null;
    try { rect = provider.rect ? provider.rect() : null; } catch (e) { rect = null; }
    rect = rect && rect.width > 0 && rect.height > 0 ? rect : {left: 0, top: 0, width: surfaceRect.width, height: surfaceRect.height};
    const cap = Math.min(this.caps.maxTextureSize, Math.max(64, quality.backdropCap || 1024));
    const scale = Math.min(1, cap / Math.max(rect.width, rect.height, 1));
    const width = nextPowerOfTwo(rect.width * scale, cap);
    const height = nextPowerOfTwo(rect.height * scale, cap);
    let dynamic = false;
    try { dynamic = !!(provider.dynamic && provider.dynamic(frame)); } catch (e) { dynamic = false; }
    let key = '';
    try { key = String(provider.key ? provider.key(frame) : ''); } catch (e) { key = ''; }
    key += '|' + width + 'x' + height + '|' + rect.width + 'x' + rect.height;
    const now = frame && Number.isFinite(frame.timestamp) ? frame.timestamp : 0;
    const interval = quality.backdropRate > 0 ? 1000 / quality.backdropRate : 0;
    const due = dynamic && (!interval || !this.lastPrepareAt || now - this.lastPrepareAt >= interval - 1);
    this.cssRect = rect;
    if (this.ready && key === this.key && !due) return true;

    if (!this.texture) {
      this.texture = gl.createTexture();
      this.framebuffer = gl.createFramebuffer();
    }
    if (this.width !== width || this.height !== height) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('sfgl: backdrop framebuffer unavailable');
      this.width = width;
      this.height = height;
    }

    const info = this._program(provider);
    gl.useProgram(info.program);
    let unit = 0;
    if (provider.kind === 'image') {
      const source = provider.source();
      // Mip levels of the source only help when it is much larger than the
      // prepared texture; a canvas redrawn every frame would otherwise pay
      // for a full mip chain on each upload.
      const srcSize = sourceSize(source);
      const mipmap = srcSize.width > width * 1.5 || srcSize.height > height * 1.5;
      const input = this._input('sf_image', {source, key: provider.key ? provider.key(frame) : null, live: !!dynamic, mipmap});
      if (!input) { this.ready = false; return false; }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      setUniform(gl, info, 'sf_image', 0);
      setUniform(gl, info, 'sf_imageSize', [input.width, input.height]);
      setUniform(gl, info, 'sf_backdropSize', [rect.width, rect.height]);
      setUniform(gl, info, 'sf_fit', FIT[provider.fit] === undefined ? 1 : FIT[provider.fit]);
      setUniform(gl, info, 'sf_opaque', provider.opaque !== false);
      unit = 1;
    } else {
      let textures = {};
      try { textures = provider.textures ? provider.textures(frame) || {} : {}; } catch (e) { textures = {}; }
      const bound = new Set();
      for (const [name, spec] of Object.entries(textures)) {
        const input = this._input(name, spec);
        if (!input) continue;
        bound.add(name);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, input.texture);
        setUniform(gl, info, name, unit);
        unit++;
      }
      // Samplers the provider left unset would default to unit 0, where the
      // target texture may still be bound (a feedback loop that drops the
      // draw). Point them at a 1x1 transparent texture instead.
      let emptyUnit = -1;
      for (const [name, u] of info.uniforms) {
        if (u.type !== gl.SAMPLER_2D || bound.has(name)) continue;
        if (emptyUnit < 0) {
          emptyUnit = unit++;
          gl.activeTexture(gl.TEXTURE0 + emptyUnit);
          gl.bindTexture(gl.TEXTURE_2D, this._emptyTexture());
        }
        setUniform(gl, info, name, emptyUnit);
      }
      let uniforms = {};
      try { uniforms = provider.uniforms ? provider.uniforms(frame, {width: rect.width, height: rect.height}) || {} : {}; } catch (e) { uniforms = {}; }
      for (const [name, value] of Object.entries(uniforms)) setUniform(gl, info, name, value);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.key = key;
    this.lastPrepareAt = now;
    this.prepareCount++;
    this.ready = true;
    return true;
  }

  _emptyTexture() {
    if (!this.empty) {
      const gl = this.gl;
      this.empty = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    return this.empty;
  }

  dispose() {
    const gl = this.gl;
    try {
      if (this.empty) gl.deleteTexture(this.empty);
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
      this.inputs.forEach((entry) => gl.deleteTexture(entry.texture));
      this.programs.forEach((entry) => gl.deleteProgram(entry.program));
    } catch (e) { /* context may be lost */ }
    this.inputs.clear();
    this.programs.clear();
    this.texture = this.framebuffer = this.empty = null;
    this.width = this.height = 0;
    this.ready = false;
  }
}
