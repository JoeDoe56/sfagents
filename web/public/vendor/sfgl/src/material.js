/**
 * Signed glass material.
 *
 * One scalar describes the material: −1 is the dark endpoint, 0 is clear glass
 * (refraction and highlights only, no tint or frost) and +1 is the light
 * endpoint. Magnitudes up to 0.52 move from clear to the regular material;
 * 0.52–1 moves on to the opaque dark/light tone.
 * @module
 */

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** @param {unknown} value @param {number} fallback */
export function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** @param {number} from @param {number} to @param {number} amount */
export function mixNumber(from, to, amount) {
  return from + (to - from) * amount;
}

/**
 * Clamp a material value to [−1, 1].
 * @param {unknown} value
 * @param {number} [fallback=0]
 */
export function normalizeMaterial(value, fallback = 0) {
  return clamp(finiteNumber(value, fallback), -1, 1);
}

/**
 * @typedef {object} ResolvedMaterial
 * @property {number} material      signed material value
 * @property {number} density       |material|
 * @property {number} side          −1 dark, 0 clear, +1 light
 * @property {number[]} tone        opaque endpoint colour (linear RGB 0..1, or display RGB with toneSpace 'display')
 * @property {'linear'|'display'} [toneSpace]  how `tone` is encoded (a `tint` option gives display RGB)
 * @property {number} toneAmount    how much of `tone` replaces the glass body, 0..1
 * @property {number} rim           strength of the hairline edge highlight
 * @property {number} dispersionAmount  0..1 scale of the rim's spectral split
 * @property {number} rimTint       0..1: how much the rim takes the colour of what is around it
 * @property {number} materialAlpha
 * @property {number} frostSigmaPx  blur radius in CSS px
 * @property {number} frostSampleScale
 * @property {number} refraction
 * @property {number} refractionFill
 * @property {number} bevelDepth
 * @property {number} bevelWidth
 * @property {number} magnify
 * @property {number} specularPrimary
 * @property {number} specularSecondary
 * @property {number} shadowStrength
 * @property {boolean} specular
 * @property {{width:number,height:number}|null} geometry
 */

/**
 * Resolve a signed material into shader parameters.
 * @param {number} material
 * @param {{width:number,height:number}|null} [geometry]
 * @param {number} [quality=1]
 * @returns {ResolvedMaterial}
 */
export function resolveMaterial(material, geometry, quality) {
  const m = normalizeMaterial(material, 0);
  const density = Math.abs(m);
  const side = m < 0 ? -1 : (m > 0 ? 1 : 0);
  const beyondApple = clamp((density - 0.52) / 0.48, 0, 1);
  const darkTone = mixNumber(35 / 255, 0, beyondApple);
  const tone = side < 0 ? [darkTone, darkTone, darkTone] : [1, 1, 1];
  const qualityScale = clamp(finiteNumber(quality, 1), 0.45, 1);
  return {
    material: m,
    density,
    side,
    tone,
    toneSpace: 'linear',
    toneAmount: beyondApple,
    rim: 0.25,
    rimTint: 1,
    dispersionAmount: 1,
    materialAlpha: density,
    frostSigmaPx: 24 * density,
    frostSampleScale: qualityScale,
    refraction: 0.045 + 0.025 * density,
    refractionFill: 0,
    bevelDepth: 0.075 + 0.045 * density,
    bevelWidth: 0.095 + 0.020 * density,
    magnify: 1.012 - 0.007 * density,
    specularPrimary: mixNumber(0.1675, 0.145, m),
    specularSecondary: mixNumber(0.080, 0.105, m),
    shadowStrength: 0.08 + 0.10 * density,
    specular: true,
    geometry: geometry || null,
  };
}

/**
 * Parse a tint colour: a CSS hex string (#rgb or #rrggbb) or an [r, g, b]
 * array of 0..1 display values. Returns display RGB 0..1, or null.
 * @param {unknown} color
 * @returns {number[]|null}
 */
export function parseTintColor(color) {
  if (Array.isArray(color) && color.length >= 3) return color.slice(0, 3).map((v) => clamp(finiteNumber(v, 0), 0, 1));
  if (typeof color !== 'string') return null;
  let hex = color.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

/**
 * Apply per-lens overrides on top of a resolved material, so a host can keep
 * the material's character and adjust single values:
 *   frost (blur radius, CSS px), refraction, magnify, specular (boolean),
 *   tint {color, amount} (a body colour in display RGB and how much of it),
 *   rim (hairline highlight strength), rimTint (0..1: how much the rim takes
 *   the colour of the content around the edge), dispersion (0..1 spectral split).
 * @param {ResolvedMaterial} optics
 * @param {Record<string, any>} options
 * @returns {ResolvedMaterial}
 */
export function applyOpticsOverrides(optics, options) {
  const o = options || {};
  const out = Object.assign({}, optics);
  if (o.frost !== undefined && o.frost !== null && typeof o.frost !== 'function') out.frostSigmaPx = Math.max(0, finiteNumber(o.frost, out.frostSigmaPx));
  if (o.refraction !== undefined && o.refraction !== null && typeof o.refraction !== 'function') out.refraction = Math.max(0, finiteNumber(o.refraction, out.refraction));
  if (o.magnify !== undefined && o.magnify !== null && typeof o.magnify !== 'function') out.magnify = clamp(finiteNumber(o.magnify, out.magnify), 0.001, 3);
  if (o.specular === false) out.specular = false;
  if (o.rim !== undefined && o.rim !== null) out.rim = clamp(finiteNumber(o.rim, out.rim), 0, 2);
  if (o.rimTint !== undefined && o.rimTint !== null && typeof o.rimTint !== 'function') out.rimTint = clamp(finiteNumber(o.rimTint, 1), 0, 1);
  if (o.dispersion !== undefined && o.dispersion !== null) out.dispersionAmount = clamp(finiteNumber(o.dispersion, 1), 0, 1);
  if (o.tint && typeof o.tint === 'object') {
    const color = parseTintColor(o.tint.color);
    if (color) {
      out.tone = color;
      out.toneSpace = 'display';
      out.toneAmount = clamp(finiteNumber(o.tint.amount, 0.8), 0, 1);
    }
  }
  return out;
}

/** Easing curves for option transitions. */
export const easings = Object.freeze({
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
});

/** Options that can be animated with lens.transition(), with their ranges. */
export const LIVE_NUMERIC_OPTIONS = Object.freeze({
  material: [-1, 1],
  refraction: [0, 1],
  refractionFill: [0, 1],
  bevelDepth: [0, 1],
  bevelWidth: [0, 1],
  frost: [0, 100],
  magnify: [0.001, 3],
  opacity: [0, 1],
  rim: [0, 2],
  rimTint: [0, 1],
  dispersion: [0, 1],
});

/**
 * Mix two tint colours (display RGB 0..1) and their amounts.
 * @param {{color: number[], amount: number}} from
 * @param {{color: number[], amount: number}} to
 * @param {number} k
 * @returns {{color: number[], amount: number}}
 */
export function mixTint(from, to, k) {
  return {color: [0, 1, 2].map((i) => mixNumber(from.color[i], to.color[i], k)), amount: mixNumber(from.amount, to.amount, k)};
}

/**
 * Texels per CSS pixel of a source texture placed over a CSS rect.
 * @param {number} textureWidth @param {number} textureHeight
 * @param {number} cssWidth @param {number} cssHeight
 */
export function sourceTexelsPerCssPixel(textureWidth, textureHeight, cssWidth, cssHeight) {
  return [
    Math.max(1, finiteNumber(textureWidth, 1)) / Math.max(1, finiteNumber(cssWidth, 1)),
    Math.max(1, finiteNumber(textureHeight, 1)) / Math.max(1, finiteNumber(cssHeight, 1)),
  ];
}

/**
 * The lens' minor dimension expressed in source UV units on each axis.
 * @param {number} lensWidth @param {number} lensHeight
 * @param {number} boundsWidth @param {number} boundsHeight
 */
export function lensMinorDimensionInSourceUV(lensWidth, lensHeight, boundsWidth, boundsHeight) {
  const width = Math.max(1, finiteNumber(lensWidth, 1));
  const height = Math.max(1, finiteNumber(lensHeight, 1));
  const minor = Math.min(width, height);
  return [(minor / width) * finiteNumber(boundsWidth, 0), (minor / height) * finiteNumber(boundsHeight, 0)];
}
