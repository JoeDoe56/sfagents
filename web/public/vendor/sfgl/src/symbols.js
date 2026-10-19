/**
 * SF Symbols as tintable icons.
 *
 * Each symbol is an alpha-silhouette PNG used as a CSS mask, so it takes the
 * current text colour. The glyphs live in symbols/glyphs (see
 * symbols/PROVENANCE.md for their source and licensing).
 *
 *   import {symbol} from 'sfgl/symbols';
 *   button.append(symbol('heart.fill', {size: 20}));
 *
 * Without JavaScript, link symbols/symbols.css and use
 * <i class="sf-symbol sf-symbol-heart-fill"></i>.
 * @module
 */

/**
 * Closest available glyph for a few symbols the bundled set does not have.
 * These are approximations, not the real symbols.
 * @type {Readonly<Record<string, string>>}
 */
export const symbolAliases = Object.freeze({
  'gearshape': 'gear',
  'books.vertical': 'rectangle.stack',
  'network': 'antenna.radiowaves.left.and.right',
  'text.line.first.and.arrowtriangle.forward': 'forward.end.fill',
  'text.line.last.and.arrowtriangle.forward': 'arrowshape.turn.up.right.fill',
});

function defaultBase() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) return new URL('../symbols/glyphs/', import.meta.url).href;
  } catch (e) { /* not an ES module context */ }
  try {
    const script = typeof document !== 'undefined' ? /** @type {HTMLScriptElement|null} */ (document.currentScript) : null;
    if (script && script.src) return new URL('../symbols/glyphs/', script.src).href;
  } catch (e) { /* no current script */ }
  return 'symbols/glyphs/';
}

let base = defaultBase();

/**
 * Where the glyph PNGs are served from. The default is the symbols/glyphs
 * folder next to the sfgl source or build; set this when you copy the glyphs
 * somewhere else.
 * @param {string} url folder URL (a trailing slash is added)
 */
export function setSymbolBase(url) {
  base = String(url).replace(/\/*$/, '/');
}

/** @param {string} name a symbol name, e.g. "heart.fill" */
export function resolveSymbol(name) {
  const key = String(name);
  return Object.prototype.hasOwnProperty.call(symbolAliases, key) ? symbolAliases[key] : key;
}

/**
 * URL of a symbol's glyph PNG.
 * @param {string} name
 * @param {string} [folder] overrides the base for this call
 */
export function symbolUrl(name, folder) {
  const prefix = folder === undefined ? base : String(folder).replace(/\/*$/, '/');
  return prefix + encodeURIComponent(resolveSymbol(name)) + '.png';
}

/**
 * @typedef {object} SymbolOptions
 * @property {number|string} [size]   width and height; a number is px. Default 1em.
 * @property {string} [color]         any CSS colour. Default: the current text colour.
 * @property {string} [label]         accessible name; without one the icon is hidden from assistive tech.
 * @property {string} [base]          glyph folder URL for this icon.
 */

/**
 * Point an element at a symbol and style it as a mask, in place.
 * @param {HTMLElement} element
 * @param {string} name
 * @param {SymbolOptions} [options]
 */
export function applySymbol(element, name, options = {}) {
  const resolved = resolveSymbol(name);
  const url = `url("${symbolUrl(name, options.base)}")`;
  const style = /** @type {any} */ (element.style);
  element.classList.add('sf-symbol');
  element.setAttribute('data-sf-symbol', resolved);
  style.display = 'inline-block';
  style.flex = 'none';
  style.verticalAlign = '-0.125em';
  const size = options.size === undefined ? '1em' : typeof options.size === 'number' ? options.size + 'px' : options.size;
  style.width = size;
  style.height = size;
  style.backgroundColor = options.color || 'currentColor';
  style.webkitMaskImage = url;
  style.maskImage = url;
  style.webkitMaskRepeat = style.maskRepeat = 'no-repeat';
  style.webkitMaskPosition = style.maskPosition = 'center';
  style.webkitMaskSize = style.maskSize = 'contain';
  if (options.label) {
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', options.label);
    element.removeAttribute('aria-hidden');
  } else {
    element.setAttribute('aria-hidden', 'true');
    element.removeAttribute('role');
    element.removeAttribute('aria-label');
  }
}

/**
 * Create an icon element for a symbol.
 * @param {string} name
 * @param {SymbolOptions & {document?: Document}} [options]
 * @returns {HTMLSpanElement}
 */
export function symbol(name, options = {}) {
  const doc = options.document || document;
  const element = doc.createElement('span');
  applySymbol(element, name, options);
  return element;
}
