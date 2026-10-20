/**
 * sfgl — superfluid glass for the web.
 *
 * Core: createGlass (surfaces, lenses, backdrops), the signed material,
 * motion, lighting, the frame scheduler and quality tiers.
 * Optional: content transitions (sfgl/transitions) and the live text
 * underlay (sfgl/underlay), both also re-exported here for the IIFE build.
 * Also: SF Symbols as tintable icons (sfgl/symbols) and the bundled fonts.
 * @module
 */
export {createGlass, Glass} from './glass.js';
export {Surface} from './surface.js';
export {Lens} from './lens.js';
export {imageBackdrop, BackdropTarget} from './backdrop.js';
export {createScheduler} from './core/scheduler.js';
export {createLighting} from './lighting/lighting.js';
export {TIERS, TIER_ORDER, initialTier, tier, stepTier} from './core/quality.js';
export {probe} from './gl/context.js';
export {
  resolveMaterial, normalizeMaterial, easings, clamp, finiteNumber, mixNumber,
  sourceTexelsPerCssPixel, lensMinorDimensionInSourceUV, LIVE_NUMERIC_OPTIONS,
} from './material.js';
export {motion, normalize, interpolate, advance, apply, animate} from './motion/geometry.js';
export {createContentTransitions, changes} from './transitions/content.js';
export {createTextUnderlay} from './underlay/text.js';
export {createGradientUnderlay, gradientSpec, drawGradient, hashSeed} from './underlay/gradient.js';
export {createContactTracker} from './contact.js';
export {symbol, applySymbol, symbolUrl, setSymbolBase, resolveSymbol, symbolAliases} from './symbols.js';

export const version = '0.1.0';
