/**
 * Bars: the row of glass (buttons, a tab control, a text field, a mini
 * player…) along the top or bottom of a screen, a sheet or a window. A bar
 * has named layouts and can morph between them: shapes with the same `id`
 * in both layouts spring from one place and size to the other, shapes that
 * only exist in one grow out of (or fold into) their neighbour, and what is
 * inside crossfades. That is how Apple Music's tab bar turns into a Home
 * button, a mini player and a Search button when you scroll, and back.
 *
 * Bars have the same features at the top and at the bottom.
 *
 * A layout is a list of rows (a plain list is one row); a row is a list of
 * items:
 *
 *   {id, node, size: 'fill' | number, height?, glass?: 'bar'|'control'|false,
 *    from?: id, into?: id}
 *
 * An id is one shape (and one node) however many layouts use it. A shape
 * that a layout does not have folds into `into` (default: its nearest
 * neighbour) and, when it comes back, grows out of `from`.
 *
 * `node` is a component's element (a button, tabs, a field) or any node of
 * your own, which is then wrapped in a glass shape. Components made by this
 * library are glass shapes themselves and are placed directly.
 *
 * With `container`, a glass piece behind everything (the main bar of SF
 * Agents: the handle sits on it and the buttons are inside it).
 * @module
 */

import {el, spring, reducedMotion, clamp} from './core.js';

const move = spring(0.5, 0.78);
const fadeSpring = spring(0.26, 1);

/**
 * @typedef {object} BarItem
 * @property {string} id
 * @property {HTMLElement | {el: HTMLElement}} node
 * @property {'fill'|number} [size]       width: a share of what is left, or points
 * @property {number} [height]            default 44
 * @property {'bar'|'control'|'tile'|false} [glass]   for a wrapped node (default 'bar')
 * @property {number} [grow]              share of the free width when size is 'fill' (default 1)
 * @property {string} [from]              the shape this one grows out of when it appears
 * @property {string} [into]              the shape this one folds into when it goes
 */

/**
 * @typedef {object} BarOptions
 * @property {'top'|'bottom'} [edge]
 * @property {Record<string, BarItem[] | BarItem[][]>} layouts
 * @property {string} layout                    the one shown first
 * @property {number} [gap]                     between items in a row (default 8)
 * @property {number} [rowGap]                  between rows (default 8)
 * @property {{padding?: number, glass?: 'bar'|'tile', radius?: number} | false} [container]
 * @property {(name: string) => void} [onLayout]
 */

/** @param {BarOptions} o */
export function createBar(o) {
  const edge = o.edge ?? 'bottom';
  const gap = o.gap ?? 8;
  const rowGap = o.rowGap ?? 8;
  const root = el('div', 'sf-bar');
  root.dataset.edge = edge;
  const pad = o.container ? (o.container.padding ?? 13) : 0;

  /** layout name → rows of items */
  const layouts = new Map();
  for (const [name, items] of Object.entries(o.layouts)) layouts.set(name, Array.isArray(items[0]) ? items : [items]);
  let active = o.layout;

  /** @type {Map<string, any>} one entry per id */
  const entries = new Map();
  let width = 0;
  let boxH = 0; // current container height (spring)
  const boxSpring = {y: {x: 0, v: 0}, h: {x: 0, v: 0}, x: {x: 0, v: 0}, w: {x: 0, v: 0}};
  let box = null;
  let raf = 0;
  let last = 0;

  if (o.container) {
    box = el('div', 'sf-bar-box');
    box.dataset.glass = o.container.glass ?? 'bar';
    box.style.borderRadius = `${o.container.radius ?? 32}px`;
    root.append(box);
  }

  const nodeOf = (n) => n?.el ?? n;

  function entryFor(layoutName, item) {
    const key = item.id;
    let e = entries.get(key);
    if (e) {
      e.hints = {from: e.hints.from ?? item.from, into: e.hints.into ?? item.into};
      return e;
    }
    const node = nodeOf(item.node);
    const own = node.sfAsGroup !== false && (node.classList.contains('sf-button') || node.classList.contains('sf-tabs') || node.classList.contains('sf-field'));
    let group = node;
    if (!own) {
      group = el('div', 'sf-bar-item');
      if (item.glass !== false) group.dataset.glass = item.glass ?? 'bar';
      else group.classList.add('plain');
      group.append(node);
    }
    group.classList.add('sf-bar-shape');
    group.dataset.barId = item.id;
    e = {
      key,
      id: item.id,
      hints: {from: item.from, into: item.into},
      item,
      group,
      wrapped: !own,
      x: {x: 0, v: 0},
      y: {x: 0, v: 0},
      w: {x: 0, v: 0},
      h: {x: 0, v: 0},
      fade: {x: 0, v: 0},
      target: null,
      placed: false,
    };
    // The glass fades with the shape.
    const base = group.sfLens;
    group.sfLens = () => ({...(base?.() ?? {}), opacity: () => clamp(e.fade.x, 0, 1)});
    group.style.position = 'absolute';
    root.append(group);
    entries.set(key, e);
    return e;
  }

  /** Rects for every item of a layout, anchored to the bar's edge. */
  function compute(rows) {
    const out = new Map();
    const inner = Math.max(0, width - pad * 2);
    let y = pad;
    // Rows are listed top to bottom; positions are measured from the bar's anchored edge, so a bottom bar starts with its last row.
    const ordered = edge === 'bottom' ? [...rows].reverse() : rows;
    for (const row of ordered) {
      const h = Math.max(...row.map((it) => it.height ?? 44));
      const fixed = row.reduce((s, it) => s + (typeof it.size === 'number' ? it.size : 0), 0);
      const fills = row.filter((it) => it.size === 'fill' || it.size === undefined);
      const share = fills.reduce((s, it) => s + (it.grow ?? 1), 0) || 1;
      const free = Math.max(0, inner - fixed - gap * (row.length - 1));
      let x = pad;
      for (const it of row) {
        const w = typeof it.size === 'number' ? it.size : (free * (it.grow ?? 1)) / share;
        out.set(it.id, {x, y, w, h: it.height ?? h});
        x += w + gap;
      }
      y += h + rowGap;
    }
    return {rects: out, height: Math.max(0, y - rowGap) + pad};
  }

  /** The rect an item without a counterpart grows from: the centre of the nearest shape that does exist. */
  function nearest(rects, fromX, fromY) {
    let best = null;
    let bestD = Infinity;
    for (const r of rects.values()) {
      const d = Math.abs(r.x + r.w / 2 - fromX) + Math.abs(r.y + r.h / 2 - fromY);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best ?? {x: width / 2, y: 0, w: 0, h: 0};
  }

  let heightNow = 0;
  function retarget(animate) {
    const rows = layouts.get(active);
    const now = compute(rows);
    heightNow = now.height;
    // Make sure every layout has its entries (built once).
    for (const [name, lrows] of layouts) for (const row of lrows) for (const item of row) entryFor(name, item);
    for (const e of entries.values()) {
      const own = now.rects.get(e.id) ?? null;
      const isActive = !!own;
      e.active = isActive;
      let rect = own;
      if (!rect) {
        // Gone from this layout: fold into the shape it names, else the nearest one.
        const into = e.hints.into && now.rects.get(e.hints.into);
        const near = into || nearest(now.rects, e.x.x + e.w.x / 2, e.y.x + e.h.x / 2);
        const w = Math.min(near.w, e.h.x || 44);
        rect = {x: near.x + near.w / 2 - w / 2, y: near.y, w, h: near.h};
      }
      if (!e.placed) {
        e.placed = true;
        // Where it first sits: its place if it is in the layout; otherwise folded away.
        e.x.x = rect.x;
        e.y.x = rect.y;
        e.w.x = rect.w;
        e.h.x = rect.h;
        e.fade.x = isActive ? 1 : 0;
      } else if (isActive && e.fade.x < 0.05 && animate) {
        // Coming back: grow out of the shape it names (or where it folded to).
        const from = e.hints.from && [...entries.values()].find((o) => o.id === e.hints.from);
        if (from) {
          e.x.x = from.x.x + from.w.x / 2 - Math.min(from.w.x, 44) / 2;
          e.y.x = from.y.x;
          e.w.x = Math.min(from.w.x, 44);
          e.h.x = from.h.x;
        }
      }
      e.target = {rect, fade: isActive ? 1 : 0};
      if (!animate || reducedMotion.matches) {
        e.x.x = rect.x;
        e.y.x = rect.y;
        e.w.x = rect.w;
        e.h.x = rect.h;
        e.x.v = e.y.v = e.w.v = e.h.v = 0;
        e.fade.x = e.target.fade;
        e.fade.v = 0;
      }
    }
    if (!animate || reducedMotion.matches) boxSpring.h.x = heightNow;
    paint();
    if (animate && !reducedMotion.matches) run();
  }

  function paint() {
    const yOf = (y, h) => (edge === 'bottom' ? `${y}px` : `${y}px`);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const e of entries.values()) {
      const s = e.group.style;
      const visible = e.fade.x > 0.01 || e.active;
      e.group.hidden = !visible;
      e.group.style.pointerEvents = e.active ? '' : 'none';
      s.left = `${e.x.x}px`;
      s.width = `${Math.max(0, e.w.x)}px`;
      s.height = `${Math.max(0, e.h.x)}px`;
      s.borderRadius = `${Math.max(0, e.h.x) / 2}px`;
      if (edge === 'bottom') {
        s.bottom = `${e.y.x}px`;
        s.top = '';
      } else {
        s.top = `${e.y.x}px`;
        s.bottom = '';
      }
      s.opacity = String(clamp(e.fade.x, 0, 1));
      s.filter = e.fade.x < 0.98 ? `blur(${((1 - clamp(e.fade.x, 0, 1)) * 6).toFixed(2)}px)` : '';
      if (e.active && e.fade.x > 0.2) {
        minX = Math.min(minX, e.x.x);
        maxX = Math.max(maxX, e.x.x + e.w.x);
      }
    }
    root.style.height = `${Math.max(heightNow, boxSpring.h.x)}px`;
    if (box) {
      box.style.left = '0px';
      box.style.width = '100%';
      box.style.height = `${boxSpring.h.x}px`;
      if (edge === 'bottom') box.style.bottom = '0px';
      else box.style.top = '0px';
    }
    void yOf;
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let busy = false;
    for (const e of entries.values()) {
      if (!e.target) continue;
      const t = e.target;
      const a = move(e.x, t.rect.x, dt);
      const b = move(e.y, t.rect.y, dt);
      const c = move(e.w, t.rect.w, dt);
      const d = move(e.h, t.rect.h, dt);
      const f = fadeSpring(e.fade, t.fade, dt);
      if (!(a && b && c && d && f)) busy = true;
    }
    if (!move(boxSpring.h, heightNow, dt)) busy = true;
    paint();
    window.dispatchEvent(new Event('sfbar'));
    if (busy) raf = requestAnimationFrame(tick);
    else {
      raf = 0;
      for (const e of entries.values()) {
        if (!e.target) continue;
        e.x.x = e.target.rect.x;
        e.y.x = e.target.rect.y;
        e.w.x = e.target.rect.w;
        e.h.x = e.target.rect.h;
        e.fade.x = e.target.fade;
      }
      boxSpring.h.x = heightNow;
      paint();
    }
  }

  function run() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function measure() {
    const w = root.clientWidth;
    if (!w || w === width) return;
    width = w;
    retarget(false);
  }
  new ResizeObserver(measure).observe(root);
  width = 0;

  const api = {
    el: root,
    get layout() {
      return active;
    },
    /** Morphs to another layout. */
    setLayout(name, {animate = true} = {}) {
      if (name === active || !layouts.has(name)) return;
      active = name;
      retarget(animate);
      o.onLayout?.(name);
    },
    /** Changes the items of a layout (a new button, a different mini player). */
    setItems(name, items) {
      layouts.set(name, Array.isArray(items[0]) ? items : [items]);
      for (const row of layouts.get(name)) for (const it of row) entryFor(name, it);
      retarget(false);
    },
    /** Total height of the shapes now (for scroll insets). */
    get height() {
      return heightNow;
    },
    relayout: () => {
      width = 0;
      measure();
    },
    destroy() {
      cancelAnimationFrame(raf);
      root.remove();
    },
  };
  // Initial layout once the bar has a width.
  requestAnimationFrame(() => {
    width = root.clientWidth || width;
    retarget(false);
  });
  return api;
}
