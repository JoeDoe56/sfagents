/**
 * Small windows that grow out of what was tapped (a stat chip, a row) to a
 * card near the top of the screen, with a title and an X. Inside, a window
 * can push views (Processes → a process) with a back button. These are
 * the framework's windows (`createWindow`); the helpers below build their
 * rows, tabs and figures from the framework's row model.
 */

import { createWindow, createRow, createSection, createTabs, icon } from './vendor/sfgl/src/ui/index.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function symbol(name, size = 16) {
  return icon(name, size);
}

let openWindows = 0;

/** Whether a window is open (pages behind it can stop updating). */
export function peekOpen() {
  return openWindows > 0;
}

/**
 * @param {{from?: Element|null, title: string, symbol?: string, build: (ctx: PeekContext) => void, onClose?: () => void}} options
 * @typedef {{body: HTMLElement, setTitle: (t: string) => void, push: (view: {title: string, symbol?: string, build: (ctx: PeekContext) => void}) => void,
 *   pop: () => void, every: (ms: number, fn: () => unknown) => void, close: () => void, onLeave: (fn: () => void) => void, window: HTMLElement}} PeekContext
 */
export function openPeek(options) {
  openWindows++;
  const win = createWindow({
    source: options.from ?? undefined,
    title: options.title,
    symbol: options.symbol,
    build: options.build,
    onClose: () => {
      openWindows = Math.max(0, openWindows - 1);
      options.onClose?.();
    },
  });
  return { close: win.close, element: win.sheet.el };
}

// ------------------------------------------------------------------ building blocks

/** An inset grouped list (Settings style): rows of label and value. */
export function group(rows, title) {
  return createSection({ title: title || undefined, rows: rows.filter(Boolean) }).el;
}

/** A row: label on the left, value (text or node) on the right; a tap action makes it a button. */
export function row(label, value, opts = {}) {
  const r = createRow({
    title: label,
    value: value ?? '',
    icon: opts.symbol,
    accessory: opts.chevron ? 'chevron' : undefined,
    destructive: opts.role === 'destructive',
    onTap: opts.onClick ? (_a, e) => opts.onClick(e) : undefined,
  });
  if (opts.title) r.el.title = opts.title;
  return r.el;
}

/** Big figures above a chart: [{label, value, color?}]. */
export function figures(items) {
  const wrap = el('div', 'ui-figures');
  const nodes = items.map((it) => {
    const cell = el('div', 'ui-figure');
    const label = el('span', 'ui-figure-label', it.label);
    if (it.color) {
      const dot = el('span', 'ui-dot');
      dot.style.background = it.color;
      label.prepend(dot);
    }
    const value = el('span', 'ui-figure-value', it.value ?? '');
    cell.append(label, value);
    wrap.append(cell);
    return { cell, value, label };
  });
  return { element: wrap, set: (i, text) => (nodes[i].value.textContent !== text ? (nodes[i].value.textContent = text) : null) };
}

/** A segmented control (Apple's): returns the element and a way to read and change the selection. */
export function segmented(options, value, onChange) {
  const tabs = createTabs({
    variant: 'segment',
    items: options.map((o) => ({ id: o.value, label: o.label })),
    selected: value,
    onChange: (id) => {
      value = id;
      onChange(id);
    },
  });
  const wrap = el('div', 'ui-segment-wrap');
  wrap.append(tabs.el);
  return { element: wrap, set: (v) => tabs.select(v, { notify: false }), get: () => value };
}

/** An action row (End Task, Show in Files): put several in a `.ui-actions` container. */
export function button(label, opts = {}) {
  return createRow({
    icon: opts.symbol,
    title: label,
    destructive: opts.role === 'destructive',
    tintTitle: opts.role !== 'destructive',
    onTap: opts.onClick ? (_a, e) => opts.onClick(e) : undefined,
  }).el;
}

export { el, symbol };
