/**
 * The round glass button used everywhere: 44 pt, a symbol or a label, an
 * optional tint (the send button turning blue, a destructive red). Presses
 * grow and lighten it, drags stretch it, and a release makes it bounce:
 * all on by default.
 * @module
 */

import {el, icon, lensFor} from './core.js';
import {attachStretch} from './stretch.js';
import {tintOf} from './glasshost.js';
import {materials} from './materials.js';

/**
 * @typedef {object} ButtonOptions
 * @property {string} [symbol]            SF Symbol name
 * @property {string} [label]             text; makes a capsule (with a symbol, the symbol leads)
 * @property {string} [aria]              accessible name (defaults to the label)
 * @property {'small'|'regular'|'large'} [size]
 * @property {'action'|'danger'|string|null} [tint]   fills the glass with a colour
 * @property {boolean} [destructive]      red label
 * @property {'control'|'bar'|'tile'|false} [glass]   which glass material (false: none; default 'control')
 * @property {boolean} [stretch]          stretchy and bouncy (default: the global setting)
 * @property {(e: MouseEvent) => void} [onClick]
 * @property {string} [className]
 */

/** @param {ButtonOptions} o */
export function createButton(o = {}) {
  const node = el('button', 'sf-button');
  node.type = 'button';
  let symbolNode = null;
  let labelNode = null;
  const api = {
    el: node,
    setSymbol(name, size) {
      symbolNode?.remove();
      symbolNode = name ? icon(name, size ?? (o.size === 'small' ? 15 : 18)) : null;
      if (symbolNode) node.prepend(symbolNode);
    },
    setLabel(text) {
      if (labelNode && text) {
        if (labelNode.textContent !== text) labelNode.textContent = text;
        return;
      }
      labelNode?.remove();
      labelNode = null;
      node.classList.toggle('capsule', !!text);
      if (text) {
        labelNode = el('span', 'sf-button-label', text);
        node.append(labelNode);
        if (!node.getAttribute('aria-label')) node.removeAttribute('aria-label');
      }
    },
    /** Fills the glass with a colour (or clears it with null). */
    setTint(tint, {duration = 220} = {}) {
      const t = tintOf(tint);
      node.classList.toggle('tinted', !!t);
      if (t) {
        node.dataset.tint = tint;
        node.style.setProperty('--sf-tint', t.color);
      } else {
        delete node.dataset.tint;
        node.style.removeProperty('--sf-tint');
      }
      const lens = lensFor(node)?.lens;
      lens?.transition({tint: t ?? materials()[node.dataset.glass || 'control']?.tint}, {duration, easing: 'easeInOut'});
    },
    setDisabled(on) {
      node.disabled = !!on;
    },
    destroy() {
      stretch?.destroy();
      node.remove();
    },
  };
  if (o.size === 'small') node.classList.add('small');
  if (o.size === 'large') node.classList.add('large');
  if (o.className) node.classList.add(...o.className.split(/\s+/).filter(Boolean));
  if (o.destructive) node.classList.add('destructive');
  if (o.glass !== false) node.dataset.glass = o.glass || 'control';
  if (o.symbol) api.setSymbol(o.symbol);
  if (o.label) api.setLabel(o.label);
  const aria = o.aria ?? o.label;
  if (aria) node.setAttribute('aria-label', aria);
  if (o.tint) api.setTint(o.tint, {duration: 0});
  if (o.onClick) node.addEventListener('click', o.onClick);
  const stretch = o.stretch === false ? null : attachStretch(node, {auto: true});
  if (o.stretch === false) node.dataset.sfStretch = 'off';
  return api;
}
