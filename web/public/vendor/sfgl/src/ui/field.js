/**
 * Text input rows, like the message box: a capsule that grows with its text
 * (up to `maxRows`), with buttons or anything else at either end. Return
 * sends (Shift+Return adds a line) unless `multiline` says otherwise.
 *
 * `look`:
 * - `card`: a white row of a sheet (Calendar's "Title or Describe Event").
 * - `glass`: no fill of its own, for use inside a bar (the message box).
 * @module
 */

import {el} from './core.js';

/**
 * @typedef {object} FieldOptions
 * @property {string} [placeholder]
 * @property {string} [value]
 * @property {'card'|'glass'} [look]
 * @property {boolean} [multiline]       Return adds a line instead of sending
 * @property {number} [maxRows]          the most lines it grows to (default 6)
 * @property {Node[]} [leading]          nodes before the text (buttons)
 * @property {Node[]} [trailing]         nodes after it
 * @property {string} [inputMode]
 * @property {string} [autocapitalize]
 * @property {string} [aria]
 * @property {(value: string) => void} [onInput]
 * @property {(value: string) => void} [onSubmit]
 * @property {(height: number) => void} [onResize]   its height changed
 */

/** @param {FieldOptions} o */
export function createField(o = {}) {
  const node = el('div', `sf-field ${o.look ?? 'card'}`);
  const input = el('textarea', 'sf-field-input');
  input.rows = 1;
  input.placeholder = o.placeholder ?? '';
  input.value = o.value ?? '';
  input.setAttribute('enterkeyhint', o.multiline ? 'enter' : 'send');
  if (o.aria) input.setAttribute('aria-label', o.aria);
  if (o.inputMode) input.inputMode = o.inputMode;
  input.setAttribute('autocapitalize', o.autocapitalize ?? 'sentences');
  if (o.leading?.length) {
    const lead = el('div', 'sf-field-lead');
    lead.append(...o.leading);
    node.append(lead);
  }
  node.append(input);
  let trail = null;
  const api = {
    el: node,
    input,
    get value() {
      return input.value;
    },
    set value(v) {
      input.value = v;
      fit();
    },
    focus() {
      input.focus({preventScroll: true});
    },
    clear() {
      input.value = '';
      fit();
      o.onInput?.('');
    },
    setTrailing(nodes) {
      trail?.remove();
      trail = null;
      if (nodes?.length) {
        trail = el('div', 'sf-field-trail');
        trail.append(...nodes);
        node.append(trail);
      }
    },
  };
  api.setTrailing(o.trailing);

  let lastHeight = 0;
  function fit() {
    input.style.height = 'auto';
    const style = getComputedStyle(input);
    const line = parseFloat(style.lineHeight) || 22;
    const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const maxHeight = line * (o.maxRows ?? 6) + pad;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
    const h = node.offsetHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      o.onResize?.(h);
    }
  }
  input.addEventListener('input', () => {
    fit();
    o.onInput?.(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !o.multiline && o.onSubmit) {
      e.preventDefault();
      o.onSubmit(input.value);
    }
  });
  // Tapping the capsule anywhere focuses the text.
  node.addEventListener('pointerdown', (e) => {
    if (e.target === node) {
      e.preventDefault();
      api.focus();
    }
  });
  api.fit = fit;
  requestAnimationFrame(fit);
  new ResizeObserver(() => fit()).observe(node);
  return api;
}
