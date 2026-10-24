/**
 * Popovers: a glass shape that grows out of its source (the label of a
 * dropdown, a button, the thing you held) to hold some content, and folds
 * back into it when it goes. Dropdowns, menus, dialogs and any small panel
 * are popovers; sheets and windows (`sheet.js`) are the bigger members of
 * the same family and share the layer, the spring motion and the way a
 * shape leaves its source.
 *
 * - No scrim, no blur of what is behind. A tap outside closes it (and does
 *   nothing else).
 * - The shape's rect, its corner radius and its content spring from the
 *   source's to their own, with a little overshoot.
 * - The glass stretches when a finger is dragged past its sides
 *   (`pull()` / `letGo()`), as every glass here does.
 * @module
 */

import {el, spring, pose, lensFor, reducedMotion, clamp} from './core.js';
import {attachStretch} from './stretch.js';
import {layerRoot} from './layers.js';

const open = spring(0.42, 0.74);
const shut = spring(0.3, 0.92);
const fadeIn = spring(0.3, 0.9);

/**
 * @typedef {object} PopoverOptions
 * @property {Element | {left: number, top: number, width: number, height: number}} source  what it grows out of
 * @property {Node | {el: Node}} content
 * @property {number} [width]               default 248
 * @property {number} [maxHeight]           default: what fits
 * @property {'auto'|'below'|'above'|'cover'} [placement]  `cover`: top edge on the source's (a dropdown from its label)
 * @property {'start'|'end'|'center'} [align]  default 'start'
 * @property {number} [radius]              default 26
 * @property {string} [className]
 * @property {boolean} [dismissOutside]     tap outside closes it (default true)
 * @property {boolean} [hideSource]         the source is hidden while the popover stands in for it (default true)
 * @property {() => void} [onClose]
 * @property {'menu'|'bar'|'control'|'tile'} [glass]   material (default 'menu')
 */

const MARGIN = 12;

const rectOf = (source) => {
  const r = source instanceof Element ? source.getBoundingClientRect() : source;
  let radius = 0;
  if (source instanceof Element) radius = parseFloat(getComputedStyle(source).borderTopLeftRadius) || 0;
  return {left: r.left, top: r.top, width: r.width, height: r.height, radius: Math.min(radius || Math.min(r.height / 2, 12), r.height / 2)};
};

/** @type {Set<{close: (immediate?: boolean) => void, group?: string}>} */
const openPopovers = new Set();

/** Closes every open popover (or only those of a group). */
export function closePopovers(group) {
  for (const p of [...openPopovers]) if (!group || p.group === group) p.close();
}

/**
 * @param {PopoverOptions & {group?: string}} o
 */
export function presentPopover(o) {
  const layer = layerRoot();
  if (o.group) closePopovers(o.group);
  const width = Math.min(o.width ?? 248, innerWidth - MARGIN * 2);
  const finalRadius = o.radius ?? 26;
  const catcher = el('div', 'sf-pop-catcher');
  const root = el('div', `sf-pop ${o.className ?? ''}`.trim());
  const body = el('div', 'sf-pop-body');
  root.dataset.sfNopaint = '';
  root.dataset.glass = o.glass ?? 'menu';
  root.setAttribute('role', 'dialog');
  const contentNode = o.content?.el ?? o.content;
  body.append(contentNode);
  root.append(body);
  layer.el.append(catcher, root);
  layer.host?.adoptOne(root);

  // The source gives way to the popover, and comes back as it folds in.
  const src = o.source instanceof Element && o.hideSource !== false ? o.source : null;
  const srcWas = src?.style.visibility ?? '';
  const showSource = () => {
    if (!src) return;
    src.style.visibility = srcWas;
    lensFor(src)?.glass.invalidate?.(true);
  };
  if (src) {
    src.style.visibility = 'hidden';
    lensFor(src)?.glass.invalidate?.(true);
  }

  let closed = false;
  let target = {x: 0, y: 0, w: width, h: 0, r: finalRadius};
  let from = rectOf(o.source);
  const st = {
    x: {x: from.left, v: 0},
    y: {x: from.top, v: 0},
    w: {x: from.width, v: 0},
    h: {x: from.height, v: 0},
    r: {x: from.radius, v: 0},
    fade: {x: 0, v: 0},
  };
  let raf = 0;
  let last = 0;
  let stepper = open;
  let fadeTarget = 1;
  let upward = false;
  let sourceNow = null;

  // ---------------------------------------------------------------- layout

  function measure() {
    body.style.width = `${target.w}px`;
    body.style.height = '';
    body.style.maxHeight = '';
    const vh = visualViewport?.height ?? innerHeight;
    const natural = body.scrollHeight;
    const s = sourceNow ?? rectOf(o.source);
    const room = Math.max(120, vh - MARGIN * 2);
    let placement = o.placement ?? 'auto';
    const below = vh - s.top - s.height - MARGIN - 8;
    const above = s.top - MARGIN - 8;
    if (placement === 'auto') placement = natural <= below || below >= above ? 'below' : 'above';
    const free = placement === 'cover' ? vh - s.top - MARGIN : placement === 'below' ? below : above;
    const h = Math.round(Math.min(natural, o.maxHeight ?? room, Math.max(free, Math.min(natural, 160))));
    let left = o.align === 'end' ? s.left + s.width - target.w : o.align === 'center' ? s.left + (s.width - target.w) / 2 : s.left;
    left = clamp(left, MARGIN, innerWidth - target.w - MARGIN);
    let top = placement === 'above' ? s.top - 8 - h : placement === 'cover' ? s.top : s.top + s.height + 8;
    top = clamp(top, MARGIN, Math.max(MARGIN, vh - h - MARGIN));
    upward = placement === 'above';
    target = {x: left, y: top, w: target.w, h, r: finalRadius};
    body.style.height = `${h}px`;
    body.style.top = upward ? '' : '0';
    body.style.bottom = upward ? '0' : '';
    body.style.left = '0';
    body.style.overflowY = natural > h + 1 ? 'auto' : 'hidden';
    root.style.transformOrigin = `${clamp(s.left + s.width / 2 - left, 0, target.w)}px ${upward ? '100%' : '0'}`;
  }

  function paint() {
    const s = root.style;
    s.left = `${st.x.x}px`;
    s.top = `${st.y.x}px`;
    s.width = `${Math.max(0, st.w.x)}px`;
    s.height = `${Math.max(0, st.h.x)}px`;
    s.borderRadius = `${Math.max(0, Math.min(st.r.x, st.h.x / 2, st.w.x / 2))}px`;
    const f = clamp(st.fade.x, 0, 1);
    body.style.opacity = String(f);
    body.style.filter = f < 0.98 ? `blur(${((1 - f) * 8).toFixed(2)}px)` : '';
    // The content grows with the shape: it starts small, at the source.
    body.style.transformOrigin = upward ? '0 100%' : '0 0';
    counter();
    layer.cover(handle, [{top: st.y.x, bottom: st.y.x + st.h.x}]);
    // Draw the glass now, in this frame, so it never trails the shape.
    const g = layer.host?.glass;
    g?.invalidate?.(true);
    g?.frame?.({timestamp: performance.now(), flags: {render: true}});
  }

  /** Stretching scales the glass, not the words on it. */
  function counter() {
    const p = pose(root);
    const sx = p.press * p.sx;
    const sy = p.press * p.sy;
    const k = clamp(st.w.x / Math.max(1, target.w), 0.3, 1.2);
    const bx = k / sx;
    const by = k / sy;
    body.style.transform = Math.abs(bx - 1) < 0.001 && Math.abs(by - 1) < 0.001 ? '' : `scale(${bx.toFixed(4)}, ${by.toFixed(4)})`;
  }

  function near(s, t, tol = 0.05) {
    return Math.abs(s.x - t) < tol && Math.abs(s.v) < tol * 12;
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    stepper(st.x, target.x, dt);
    stepper(st.y, target.y, dt);
    stepper(st.w, target.w, dt);
    stepper(st.h, target.h, dt);
    stepper(st.r, target.r, dt);
    (fadeTarget ? fadeIn : shut)(st.fade, fadeTarget, dt);
    paint();
    if (closed && st.fade.x < 0.4) showSource();
    if (closed && st.fade.x < 0.02) {
      raf = 0;
      finish();
      return;
    }
    if (near(st.x, target.x) && near(st.y, target.y) && near(st.w, target.w) && near(st.h, target.h) && near(st.r, target.r) && near(st.fade, fadeTarget, 0.004)) {
      raf = 0;
      st.x.x = target.x;
      st.y.x = target.y;
      st.w.x = target.w;
      st.h.x = target.h;
      st.r.x = target.r;
      st.fade.x = fadeTarget;
      paint();
      if (closed) finish();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function run() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- stretch

  const stretch = attachStretch(root, {axis: 'both'});
  pose(root).after = () => counter();

  // ---------------------------------------------------------------- closing

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);

  const swallow = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (o.dismissOutside !== false) {
    catcher.addEventListener('pointerdown', (e) => {
      swallow(e);
      close();
    });
    catcher.addEventListener('contextmenu', (e) => {
      swallow(e);
      close();
    });
  } else {
    catcher.addEventListener('pointerdown', swallow);
  }
  // A page scroll under an open popover would drag the source away from it.
  catcher.addEventListener('wheel', swallow, {passive: false});
  catcher.addEventListener('touchmove', swallow, {passive: false});

  function finish() {
    showSource();
    stretch.destroy();
    layer.host?.release(root);
    root.remove();
    catcher.remove();
    layer.cover(handle);
  }

  function close(immediate = false) {
    if (closed) return;
    closed = true;
    openPopovers.delete(handle);
    window.removeEventListener('keydown', onKey, true);
    stretch.release();
    root.style.pointerEvents = 'none';
    o.onClose?.();
    if (immediate || reducedMotion.matches) {
      cancelAnimationFrame(raf);
      finish();
      return;
    }
    // Fold back into the source (or where it is now).
    const s = o.source instanceof Element && !o.source.isConnected ? from : rectOf(o.source);
    target = {x: s.left, y: s.top, w: s.width, h: s.height, r: s.radius};
    stepper = shut;
    fadeTarget = 0;
    st.fade.v = Math.min(st.fade.v, 0);
    run();
  }

  const handle = {
    el: root,
    body,
    group: o.group,
    close,
    /** Closed and gone. */
    get closed() {
      return closed;
    },
    /** Pulls the glass past its sides by (ox, oy) px; call `letGo()` to release. */
    pull: (ox, oy = 0) => stretch.drive(ox, oy),
    letGo: () => stretch.release(),
    /** Re-measures after the content changed (a submenu, a longer list). */
    resize({width: w} = {}) {
      if (closed) return;
      if (w) target.w = Math.min(w, innerWidth - MARGIN * 2);
      measure();
      stepper = open;
      run();
    },
    /** Swaps the content, crossfading, and fits the shape to it. */
    setContent(node, {width: w} = {}) {
      const next = node?.el ?? node;
      body.replaceChildren(next);
      st.fade.x = 0.3;
      st.fade.v = 0;
      handle.resize({width: w});
    },
    destroy: () => close(true),
  };

  // ---------------------------------------------------------------- open

  sourceNow = rectOf(o.source);
  target.w = width;
  measure();
  if (reducedMotion.matches) {
    st.x.x = target.x;
    st.y.x = target.y;
    st.w.x = target.w;
    st.h.x = target.h;
    st.r.x = target.r;
    st.fade.x = 1;
    paint();
  } else {
    paint();
    run();
  }
  openPopovers.add(handle);
  return handle;
}
