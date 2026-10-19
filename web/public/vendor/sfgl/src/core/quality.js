/**
 * Quality tiers.
 *
 *   static      CSS only: translucent fill and a static rim. No WebGL.
 *   frost       CSS only: backdrop-filter blur and a light-following rim.
 *   lite        WebGL, small backdrop at ≤30 Hz, no dispersion, no layered
 *               refraction or text underlay, render scale ≤ 1.
 *   glass       WebGL, full optics with 3-tap dispersion.
 *   superfluid  WebGL, full optics with 7-tap dispersion, backdrop at display rate.
 *
 * Tiers only scale GPU work; main-thread cost is the same in every WebGL tier.
 * @module
 */

/** @typedef {'static'|'frost'|'lite'|'glass'|'superfluid'} TierName */

/**
 * @typedef {object} Tier
 * @property {TierName} name
 * @property {boolean} webgl
 * @property {number} backdropCap     longest side of the prepared backdrop, texels
 * @property {number} backdropRate    max prepares per second for animated backdrops (0 = every frame)
 * @property {0|3|7} dispersion
 * @property {boolean} layers         upper lenses refract the glass below them
 * @property {boolean} underlay       live content underlays (text refraction)
 * @property {number} maxRenderScale
 * @property {number} minRenderScale
 */

/** @type {Record<TierName, Tier>} */
export const TIERS = Object.freeze({
  static: Object.freeze({name: 'static', webgl: false, backdropCap: 0, backdropRate: 0, dispersion: 0, layers: false, underlay: false, maxRenderScale: 0, minRenderScale: 0}),
  frost: Object.freeze({name: 'frost', webgl: false, backdropCap: 0, backdropRate: 0, dispersion: 0, layers: false, underlay: false, maxRenderScale: 0, minRenderScale: 0}),
  lite: Object.freeze({name: 'lite', webgl: true, backdropCap: 512, backdropRate: 30, dispersion: 0, layers: false, underlay: false, maxRenderScale: 1, minRenderScale: 0.5}),
  glass: Object.freeze({name: 'glass', webgl: true, backdropCap: 1024, backdropRate: 60, dispersion: 3, layers: true, underlay: true, maxRenderScale: 2, minRenderScale: 0.75}),
  superfluid: Object.freeze({name: 'superfluid', webgl: true, backdropCap: 1024, backdropRate: 0, dispersion: 7, layers: true, underlay: true, maxRenderScale: 2, minRenderScale: 1}),
});

export const TIER_ORDER = Object.freeze(['static', 'frost', 'lite', 'glass', 'superfluid']);

/**
 * Pick a starting tier from capabilities and device hints.
 * @param {import('../gl/context.js').GLCaps|null} caps
 * @param {{deviceMemory?: number, hardwareConcurrency?: number, reducedTransparency?: boolean}} [hints]
 * @returns {TierName}
 */
export function initialTier(caps, hints = {}) {
  if (hints.reducedTransparency) return 'static';
  if (!caps) return 'frost';
  if (caps.software) return 'frost';
  const memory = Number(hints.deviceMemory) || 0;
  const cores = Number(hints.hardwareConcurrency) || 0;
  if ((memory && memory <= 2) || (cores && cores <= 2) || !caps.highp) return 'lite';
  if (!caps.webgl2 && caps.lodMode === 'bias') return 'lite';
  if ((memory && memory <= 4) || (cores && cores <= 4)) return 'glass';
  return 'superfluid';
}

/** @param {TierName|string} name @returns {Tier} */
export function tier(name) {
  return TIERS[/** @type {TierName} */ (name)] || TIERS.glass;
}

/** @param {TierName} name @param {-1|1} direction @returns {TierName} */
export function stepTier(name, direction) {
  const i = TIER_ORDER.indexOf(name);
  const next = Math.max(0, Math.min(TIER_ORDER.length - 1, i + direction));
  return /** @type {TierName} */ (TIER_ORDER[next]);
}
