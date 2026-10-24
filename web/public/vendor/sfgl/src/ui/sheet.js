/**
 * Sheets. One model for the three things that slide, grow or morph out of an
 * edge or a button and hold a header, a scrolling body and maybe a footer:
 *
 * - **bar sheets** (`kind: 'bar'`): the sheet is the bar. Collapsed it is a
 *   floating bar (a message field, a few buttons) with a handle; pulled up it
 *   becomes a medium glass sheet, then a full opaque one, the bar's row
 *   staying on top. The glass piece the handle sits on holds the buttons.
 * - **button sheets** (`kind: 'button'`): the sheet grows out of the button
 *   (or any element) that opened it, and folds back into it. It has a medium
 *   detent, a large one, or both (`detents`).
 * - windows (`window.js`) are the free-floating relatives.
 *
 * The half-open (medium) sheet floats with a gap all the way around. A
 * sheet that has only the large detent still passes through that gap on its
 * way, so opening and closing look the same for every sheet.
 *
 * The header and footer are `createBar`s: the same models as every other
 * bar, so they can hold buttons, a title, a text field or tabs and morph
 * between layouts.
 *
 * Gestures: drag the handle, the header or an empty part of the sheet; pull
 * the body down from the top (or push it up from a lower detent); scroll
 * the wheel over the handle (up opens, down closes); tap the handle to step.
 * A sheet with unsaved changes (`setDirty(true)`) does not close on a swipe,
 * the X or a tap outside: it asks first, in a popover that grows out of the
 * X button.
 * @module
 */

import {el, icon, spring, reducedMotion, clamp, lerp, onConfigure} from './core.js';
import {createLayer} from './layers.js';
import {createGlassHost} from './glasshost.js';
import {createBar} from './bar.js';
import {createButton} from './button.js';
import {confirmDiscard} from './dialog.js';

const MOTION = spring(0.39, 0.81); // Apple Maps' sheet spring, fitted to a recording
const CLOSE_MOTION = spring(0.34, 0.92);
const ROW_TOP = 13;
const OVER = 1000; // px of extra height per unit of t above the large detent
const smooth = (a, b, v) => {
  const k = clamp((v - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

// ------------------------------------------------------------------ insets

let probes = {};
function inset(side) {
  if (typeof window !== 'undefined' && side === 'top' && typeof window.__sfSafeTop === 'number') return window.__sfSafeTop;
  let p = probes[side];
  if (!p?.isConnected) {
    p = el('div');
    p.style.cssText = `position:fixed;left:0;${side}:0;width:0;height:env(safe-area-inset-${side},0px);visibility:hidden;pointer-events:none`;
    document.body.append(p);
    probes[side] = p;
  }
  return p.getBoundingClientRect().height;
}

/** The safe-area inset (the status bar, the home indicator) in px. */
export const safeInset = inset;

function parseColor(value) {
  const v = String(value).trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = /rgba?\(([^)]+)\)/.exec(v);
  return m ? m[1].split(',').slice(0, 3).map((x) => parseFloat(x)) : [242, 242, 247];
}

// ------------------------------------------------------------------ standard header

/**
 * The usual header: a close button on the left, a title in the middle, a
 * confirm button (a check) and anything else on the right. Returns the
 * layouts for `createSheet({header})` and the buttons.
 * @param {{title?: string, close?: boolean, confirm?: boolean | {symbol?: string, aria?: string}, leading?: Node[], trailing?: Node[]}} o
 */
export function standardHeader(o = {}) {
  const items = [];
  const buttons = {};
  if (o.close !== false) {
    buttons.close = createButton({symbol: 'xmark', aria: 'Close', size: 'large'});
    items.push({id: 'close', node: buttons.close.el, size: 44, height: 48});
  }
  for (const [i, n] of (o.leading ?? []).entries()) items.push({id: `lead${i}`, node: n, size: 44, height: 48});
  const title = el('div', 'sf-sheet-title', o.title ?? '');
  items.push({id: 'title', node: title, size: 'fill', height: 48, glass: false});
  for (const [i, n] of (o.trailing ?? []).entries()) items.push({id: `trail${i}`, node: n, size: 44, height: 48});
  if (o.confirm) {
    const c = typeof o.confirm === 'object' ? o.confirm : {};
    buttons.confirm = createButton({symbol: c.symbol ?? 'checkmark', aria: c.aria ?? 'Done', size: 'large'});
    items.push({id: 'confirm', node: buttons.confirm.el, size: 44, height: 48});
  }
  return {layouts: {main: [items]}, layout: 'main', buttons, title};
}

// ------------------------------------------------------------------ the sheet

/**
 * @typedef {object} SheetOptions
 * @property {'bar'|'button'|'window'} [kind]      default: 'button' when there is a source, else 'bar'
 * @property {'bottom'|'top'} [edge]               the edge it comes from (default 'bottom')
 * @property {Element | {left: number, top: number, width: number, height: number}} [source]  button sheets: what it grows out of
 * @property {('collapsed'|'medium'|'large')[]} [detents]   which resting positions it has (bar: all three; button: medium and large)
 * @property {'collapsed'|'medium'|'large'} [detent]  where it opens (default: the first of `detents`)
 * @property {() => number} [mediumHeight]          px; default 46% of the screen
 * @property {import('./bar.js').BarOptions | ReturnType<typeof createBar> | Node} [header]
 * @property {import('./bar.js').BarOptions | ReturnType<typeof createBar> | Node} [footer]
 * @property {Node} [content]                       put in the scrolling body
 * @property {boolean} [modal]                      dims the page and a tap outside closes it (default: button sheets)
 * @property {boolean | 'wheel'} [handle]           show the handle (default: when it has more than one detent)
 * @property {string} [label]                       accessible name
 * @property {number} [headerTop]                   px from the top of the sheet to the header (button sheets, default 18)
 * @property {() => Element | null} [closeSource]   the element the discard popover grows from (default: the header's close button)
 * @property {(detent: string) => void} [onDetent]
 * @property {(o: object) => any} [layerGlass]     a glass factory for what is behind this sheet (a chat); it may offer `setSheet({left, top, width, height, radius, opaque})`
 * @property {() => boolean | void} [onEscape]    handle Escape yourself (return true to keep the sheet open)
 * @property {(confirmed?: boolean) => void} [onClose]
 * @property {() => void} [onMove]
 * @property {(dirty: boolean) => void} [onDirty]    e.g. tint the confirm button
 * @property {number} [collapsedHeight]
 * @property {number} [width]                        windows: width (default 600)
 * @property {() => number} [height]                windows: height (default 720)
 */

/**
 * @param {SheetOptions} o
 */
export function createSheet(o = {}) {
  const kind = o.kind ?? (o.source ? 'button' : 'bar');
  const isWindow = kind === 'window';
  const edge = o.edge ?? 'bottom';
  const isBar = kind === 'bar';
  const names = isBar ? ['collapsed', 'medium', 'large'] : isWindow ? [null, 'window'] : [null, 'medium', 'large'];
  const detents = (o.detents?.length ? o.detents : isBar ? ['collapsed', 'medium', 'large'] : isWindow ? ['window'] : ['medium', 'large']).filter((d) => names.includes(d));
  const stops = detents.map((d) => names.indexOf(d)).sort((a, b) => a - b); // t values
  const lowest = stops[0];
  const highest = stops[stops.length - 1];
  const modal = o.modal ?? !isBar;
  const showHandle = o.handle ?? (!isWindow && stops.length > 1);

  // ---------------------------------------------------------------- dom

  const layer = createLayer({glass: o.layerGlass});
  const root = layer.el;
  root.classList.add('sf-sheet-layer');
  const scrim = el('div', 'sf-sheet-scrim');
  const panel = el('section', 'sf-sheet');
  panel.dataset.kind = kind;
  panel.dataset.edge = edge;
  panel.setAttribute('role', 'dialog');
  if (modal) panel.setAttribute('aria-modal', 'true');
  if (o.label) panel.setAttribute('aria-label', o.label);
  panel.tabIndex = -1;
  const grab = el('div', 'sf-sheet-grab');
  const handle = el('div', 'sf-sheet-handle');
  grab.append(handle);
  grab.hidden = !showHandle;
  const inner = el('div', 'sf-sheet-inner');
  const body = el('div', 'sf-sheet-body');
  const edgeFade = el('div', 'sf-sheet-edge');
  const headEl = el('div', 'sf-sheet-head');
  const footEl = el('div', 'sf-sheet-foot');
  inner.append(body, edgeFade, headEl, footEl);
  panel.append(inner, grab);
  root.append(scrim, panel);
  if (o.content) body.append(o.content);

  const asBar = (spec, e) => {
    if (!spec) return null;
    if (spec.el && 'setLayout' in spec) return spec;
    if (spec instanceof Node) return {el: spec, node: true};
    return createBar({edge: e, ...spec});
  };
  const header = asBar(o.header, 'top');
  const footer = asBar(o.footer, 'bottom');
  if (header) headEl.append(header.el);
  if (footer) footEl.append(footer.el);
  const heightOf = (b) => (b ? (b.node ? b.el.offsetHeight : b.height) || 0 : 0);

  // ---------------------------------------------------------------- state

  let t = 0; // 0 = at rest (the bar, or the source button), 1 = medium, 2 = large; above 2 stretches
  let drop = 0; // px the sheet is pulled past its lowest detent (button sheets)
  let detentName = null;
  let isOpen = false;
  let closing = false;
  let dirty = false;
  let keyboard = false;
  let anim = null;
  let drag = null;
  let glassHost = null;
  let rect = {left: 0, top: 0, width: 0, height: 0, radius: 0};
  let opaque = 0;
  let sheetRGB = [242, 242, 247];

  const sourceRect = () => {
    const s = o.source;
    if (!s) return {left: innerWidth / 2 - 22, top: innerHeight - 70, width: 44, height: 44, radius: 22};
    const r = s instanceof Element ? s.getBoundingClientRect() : s;
    const radius = s instanceof Element ? parseFloat(getComputedStyle(s).borderTopLeftRadius) || Math.min(r.width, r.height) / 2 : Math.min(r.width, r.height) / 2;
    return {left: r.left, top: r.top, width: r.width, height: r.height, radius: Math.min(radius, r.height / 2)};
  };

  function viewport() {
    return {W: innerWidth, H: visualViewport?.height ?? innerHeight};
  }

  /** The keyframes: rest, medium, large (for this edge). */
  function keyframes() {
    const {W, H} = viewport();
    const phone = W < 640;
    const near = edge === 'bottom' ? inset('bottom') : inset('top');
    const far = edge === 'bottom' ? inset('top') : inset('bottom');
    const place = (nearOff, height) => (edge === 'bottom' ? H - nearOff - height : nearOff);
    // rest
    let rest;
    if (isBar) {
      const w = Math.min(W - (phone ? 40 : 48), 640);
      const h = o.collapsedHeight ?? heightOf(header) + ROW_TOP * 2;
      const off = keyboard ? 8 : (phone ? 18 : 24) + near;
      rest = {left: (W - w) / 2, top: place(off, h), width: w, height: h, radius: 32};
    } else rest = sourceRect();
    if (isWindow) {
      // A window: floats near the top with a gap all round, one size.
      const ww = Math.min(W - 20, o.width ?? 600);
      const wt = phone ? Math.max(10, inset('top') + 8) : Math.max(24, H * 0.08);
      const wh = Math.min(o.height?.() ?? 720, H - wt - (phone ? 14 : 40));
      const win = {left: (W - ww) / 2, top: wt, width: ww, height: wh, radius: 34};
      return [rest, win, win];
    }
    // medium: floats with a gap all round
    const mw = Math.min(W - 16, 720);
    const wanted = o.mediumHeight?.();
    const mh = Math.min(H - 24, wanted ?? clamp(Math.round(H * 0.46), Math.min((rest.height || 60) + 260, H - 40), Math.max((rest.height || 60) + 260, 560)));
    const medium = {left: (W - mw) / 2, top: place(8 + near * 0.5, mh), width: mw, height: mh, radius: 40};
    // large: nearly the whole screen, running past the near edge so only the far corners show
    const fw = phone ? W : Math.min(W - 32, 720);
    const gap = (phone ? 10 : 16) + far;
    const fh = H - gap + 40;
    const large = {left: (W - fw) / 2, top: edge === 'bottom' ? gap : -40, width: fw, height: fh, radius: phone ? 38 : 34};
    return [rest, medium, large];
  }

  function rectAt(k, v) {
    const e = v;
    const clampedV = clamp(v, -0.3, 2);
    const i = clampedV <= 1 ? 0 : 1;
    const a = k[i];
    const b = k[i + 1];
    const f = clampedV <= 1 ? clampedV : clampedV - 1;
    const r = {
      left: lerp(a.left, b.left, f),
      top: lerp(a.top, b.top, f),
      width: lerp(a.width, b.width, f),
      height: lerp(a.height, b.height, f),
      radius: lerp(a.radius, b.radius, f),
    };
    if (e > 2) {
      const extra = (e - 2) * OVER;
      r.height += extra;
      if (edge === 'bottom') r.top -= extra;
    }
    return r;
  }

  /** Where the free edge of the sheet is at t, signed so it decreases as t grows. */
  function freeEdge(k, v) {
    const r = rectAt(k, v);
    return edge === 'bottom' ? r.top : -(r.top + r.height);
  }

  // ---------------------------------------------------------------- apply

  function colors() {
    sheetRGB = parseColor(getComputedStyle(panel).getPropertyValue('--sf-sheet'));
  }

  function apply() {
    const k = keyframes();
    rect = rectAt(k, t);
    const {H} = viewport();
    const shift = edge === 'bottom' ? drop : -drop;
    const s = panel.style;
    s.left = `${rect.left}px`;
    s.width = `${Math.max(0, rect.width)}px`;
    s.top = `${rect.top + shift}px`;
    s.height = `${Math.max(0, rect.height)}px`;
    s.borderRadius = `${Math.max(0, Math.min(rect.radius, rect.height / 2, rect.width / 2))}px`;
    // Medium and below is glass; the large sheet is opaque.
    opaque = isBar ? smooth(1.15, 1.6, t) : isWindow ? smooth(0.5, 1, t) : smooth(1.2, 1.7, t);
    s.backgroundColor = `rgba(${sheetRGB[0]},${sheetRGB[1]},${sheetRGB[2]},${opaque.toFixed(3)})`;
    // The inner box keeps the width the content was made for while the sheet is still growing out of a button.
    const innerW = Math.max(rect.width, k[1].width);
    const visibleH = edge === 'bottom' ? Math.min(rect.height, H - rect.top - shift) : rect.height + Math.min(0, rect.top + shift);
    inner.style.width = `${innerW}px`;
    inner.style.left = `${(rect.width - innerW) / 2}px`;
    inner.style.height = `${Math.max(0, visibleH)}px`;
    inner.style.top = edge === 'top' ? `${Math.max(0, -(rect.top + shift))}px` : '0px';
    // Header on the attached side; the body scrolls beneath it.
    const headH = heightOf(header);
    const footH = heightOf(footer);
    const headTop = isBar ? lerp(ROW_TOP, 22, smooth(0, 1, t)) : (o.headerTop ?? 18);
    headEl.style.top = `${headTop}px`;
    const bottomInset = edge === 'bottom' ? Math.max(inset('bottom'), footer ? 12 : 0) * smooth(1.2, 2, t) : 0;
    footEl.style.bottom = `${bottomInset}px`;
    const bodyTop = header ? headTop + headH + 10 : isBar ? 0 : 28;
    const bodyBottom = footer ? footH + bottomInset + 10 : bottomInset;
    body.style.setProperty('--sf-sheet-top', `${bodyTop}px`);
    body.style.setProperty('--sf-sheet-bottom', `${bodyBottom}px`);
    // Content appears as the sheet opens.
    const contentIn = isBar ? 1 : smooth(0.3, 0.8, t);
    headEl.style.opacity = footEl.style.opacity = String(contentIn);
    const bodyIn = isBar ? smooth(0.08, 0.6, t) : contentIn;
    body.style.opacity = String(bodyIn);
    edgeFade.style.opacity = String(bodyIn * opaque);
    body.style.visibility = bodyIn < 0.02 ? 'hidden' : 'visible';
    edgeFade.style.top = '0px';
    edgeFade.style.height = `${bodyTop + 18}px`;
    // The attached bar sheet's field keeps room for the handle.
    grab.style.opacity = String(showHandle ? (isBar ? 1 : smooth(0.4, 0.9, t)) : 0);
    // The page dims as a modal sheet rises.
    if (modal) scrim.style.opacity = String(clamp(t, 0, 1) * (0.45 + 0.55 * smooth(0, highest || 1, Math.max(t, 0))) * 0.55);
    // Locked while it is below its highest detent: the body does not scroll until the sheet is up.
    body.classList.toggle('locked', t < highest - 0.02);
    // Layout state.
    const state = detentFor(t);
    if (state !== panel.dataset.state) panel.dataset.state = state;
    panel.dataset.opaque = opaque > 0.95 ? 'true' : 'false';
    coverBands();
    layer.host?.glass?.setSheet?.({...rect, top: rect.top + shift, opaque});
    o.onMove?.({t, rect, clearance: edge === 'bottom' ? H - k[0].top : k[0].top + k[0].height});
    window.dispatchEvent(new CustomEvent('sfsheet', {detail: {sheet: api, t, rect}}));
  }

  function coverBands() {
    const bands = [{top: rect.top + (edge === 'bottom' ? drop : -drop), bottom: rect.top + rect.height + (edge === 'bottom' ? drop : -drop)}];
    layer.cover(api, bands);
    if (!glassHost) return;
    const rects = [];
    for (const n of [headEl, footEl]) {
      const r = n.getBoundingClientRect();
      if (r.height) rects.push({top: r.top, bottom: r.bottom});
    }
    glassHost.bands(rects);
  }

  function detentFor(v) {
    if (v >= 1.98) return 'large';
    if (v >= 0.5) return 'medium';
    return isBar ? 'collapsed' : 'closed';
  }

  // ---------------------------------------------------------------- motion

  let vt = {x: 0, v: 0};
  let vd = {x: 0, v: 0};
  let goal = {t: 0, drop: 0, step: MOTION};
  let last = 0;
  let raf = 0;

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    vt.x = t;
    vd.x = drop;
    const a = goal.step(vt, goal.t, dt);
    const b = goal.step(vd, goal.drop, dt);
    t = vt.x;
    drop = vd.x;
    const settledT = Math.abs(t - goal.t) < 0.0015 && Math.abs(vt.v) < 0.02;
    const settledD = Math.abs(drop - goal.drop) < 0.3 && Math.abs(vd.v) < 8;
    void a;
    void b;
    if (settledT && settledD) {
      t = goal.t;
      drop = goal.drop;
      raf = 0;
      anim = null;
      apply();
      goal.done?.();
      return;
    }
    if (closing && !isBar && t < 0.04) {
      t = 0;
      raf = 0;
      anim = null;
      apply();
      goal.done?.();
      return;
    }
    apply();
    raf = requestAnimationFrame(tick);
  }

  /** Springs to `target` t (and drop), from a finger velocity in t/s and px/s. */
  function animateTo(target, {drop: d = 0, velocity = 0, dropVelocity = 0, step = MOTION, done} = {}) {
    cancelAnimationFrame(raf);
    if (reducedMotion.matches) {
      t = target;
      drop = d;
      apply();
      done?.();
      return;
    }
    vt = {x: t, v: velocity};
    vd = {x: drop, v: dropVelocity};
    goal = {t: target, drop: d, step, done};
    last = performance.now();
    anim = true;
    raf = requestAnimationFrame(tick);
  }

  function setDetentName(name) {
    if (name === detentName) return;
    detentName = name;
    panel.dataset.detent = name ?? '';
    o.onDetent?.(name);
  }

  // ---------------------------------------------------------------- opening and closing

  function present(name = o.detent ?? detents[0]) {
    if (isOpen) return setDetent(name);
    isOpen = true;
    closing = false;
    colors();
    glassHost = createGlassHost({
      host: panel,
      scroller: body,
      background: `rgb(${sheetRGB.join(',')})`,
      edges: () => {
        const r = edgeFade.getBoundingClientRect();
        return [{from: edge === 'bottom' ? 'top' : 'bottom', top: r.top, height: r.height, opacity: body.scrollTop > 2 ? 1 : 0, stops: [[0, 1], [0.5, 0.85], [1, 0]]}];
      },
      clip: null,
    });
    // The sheet's own glass: it bends the page behind it.
    panel.sfLens = () => ({opacity: () => 1 - opaque});
    layer.host?.adoptOne(panel, {}, 'bar');
    glassHost?.adopt(panel);
    document.body.classList.add('sf-sheet-open');
    const target = names.indexOf(name) >= 0 ? names.indexOf(name) : lowest;
    t = isBar ? stops[0] : 0;
    setDetentName(isBar ? detents[0] : null);
    apply();
    if (isBar && target === t) return Promise.resolve();
    return new Promise((resolve) => {
      animateTo(target, {
        step: MOTION,
        done: () => {
          setDetentName(names[target]);
          panel.focus({preventScroll: true});
          resolve();
        },
      });
      setDetentName(names[target]);
    });
  }

  function setDetent(name) {
    const i = names.indexOf(name);
    if (!isOpen || i < 0 || !stops.includes(i)) return Promise.resolve();
    setDetentName(name);
    return new Promise((resolve) => animateTo(i, {done: resolve}));
  }

  function teardown() {
    isOpen = false;
    closing = false;
    layer.cover(api);
    glassHost?.destroy();
    glassHost = null;
    layer.destroy();
    document.body.classList.toggle('sf-sheet-open', !!document.querySelector('.sf-sheet-layer'));
    removeEventListener('resize', relayout);
    removeEventListener('sfbar', coverBands);
    removeEventListener('pointermove', onPointerMove);
    removeEventListener('pointerup', pointerEnd);
    removeEventListener('pointercancel', pointerEnd);
    visualViewport?.removeEventListener('resize', relayout);
    offConfigure();
    o.onClose?.(confirmed);
  }

  let confirmed = false;

  /** Closes for good (button sheets) or collapses (bar sheets), without asking. */
  function close({confirm = false} = {}) {
    if (!isOpen || closing) return Promise.resolve();
    confirmed = confirm;
    if (isBar) return setDetent(detents[0]);
    closing = true;
    setDetentName(null);
    return new Promise((resolve) =>
      animateTo(0, {
        step: CLOSE_MOTION,
        done: () => {
          teardown();
          resolve();
        },
      }),
    );
  }

  /**
   * A request to close (the X, a swipe, a tap outside, Escape). A sheet with
   * unsaved changes asks first.
   */
  async function requestClose(from) {
    if (!isOpen || closing) return false;
    if (dirty) {
      const source = from ?? o.closeSource?.() ?? header?.el?.querySelector?.('.sf-button') ?? panel;
      const discard = await confirmDiscard({source});
      if (!discard) return false;
    }
    await close();
    return true;
  }

  // ---------------------------------------------------------------- dragging

  const now = () => performance.now();

  function beginDrag(y) {
    cancelAnimationFrame(raf);
    anim = null;
    const k = keyframes();
    drag = {y0: y, free0: freeEdge(k, t) + (edge === 'bottom' ? drop : -drop), t0: t, samples: [{y, at: now()}]};
    panel.classList.add('dragging');
    suppressClick = true;
    window.getSelection?.()?.removeAllRanges?.();
  }

  function tForFree(k, free) {
    // freeEdge decreases with t: bisect over [lowest, 2].
    const lo0 = freeEdge(k, lowest);
    if (free >= lo0) return {t: lowest, over: free - lo0};
    const hi = freeEdge(k, 2);
    if (free <= hi) return isWindow ? {t: highest, over: 0, up: hi - free} : {t: 2 + Math.pow(hi - free, 0.7) / OVER, over: 0};
    let lo = lowest;
    let up = 2;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + up) / 2;
      if (freeEdge(k, mid) > free) lo = mid;
      else up = mid;
    }
    return {t: (lo + up) / 2, over: 0};
  }

  function moveDrag(y) {
    if (!drag) return;
    const k = keyframes();
    const dy = y - drag.y0;
    const free = drag.free0 + (edge === 'bottom' ? dy : -dy);
    const r = tForFree(k, free);
    if (isBar) t = r.over > 0 ? lowest - Math.min(0.06, r.over / 2000) : r.t;
    else {
      t = r.t;
      drop = r.up ? -Math.min(28, Math.pow(r.up, 0.62)) : r.over;
    }
    drag.samples.push({y, at: now()});
    if (drag.samples.length > 6) drag.samples.shift();
    apply();
  }

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    panel.classList.remove('dragging');
    const first = d.samples[0];
    const lastS = d.samples[d.samples.length - 1];
    const v = lastS.at > first.at ? (lastS.y - first.y) / (lastS.at - first.at) : 0; // px/ms, + is down
    const sign = edge === 'bottom' ? 1 : -1; // toward the attached edge
    const vToward = v * sign;
    const k = keyframes();
    const here = freeEdge(k, t) + (edge === 'bottom' ? drop : -drop);
    const projected = here + vToward * 220;
    // The stops, and for button sheets a "closed" stop below the lowest.
    const candidates = stops.map((i) => ({t: i, free: freeEdge(k, i)}));
    if (!isBar) candidates.push({t: 0, free: freeEdge(k, lowest) + Math.max(110, rect.height * 0.28), dismiss: true});
    let best = candidates[0];
    for (const c of candidates) if (Math.abs(c.free - projected) < Math.abs(best.free - projected)) best = c;
    if (!isBar && vToward > 1.1 && drop > 30) best = candidates[candidates.length - 1];
    // t velocity from px velocity near the current segment.
    const seg = Math.max(30, Math.abs(freeEdge(k, Math.min(2, Math.ceil(clamp(t, 0, 2) + 0.001))) - freeEdge(k, Math.floor(clamp(t, 0, 1.999)))));
    const vt0 = -(vToward * 1000) / seg; // t/s (positive = opening)
    if (best.dismiss) {
      if (dirty) {
        animateTo(lowest, {drop: 0, velocity: vt0, dropVelocity: 0});
        requestClose();
      } else {
        const dropV = vToward * 1000;
        void dropV;
        close();
      }
    } else {
      setDetentName(names[best.t]);
      animateTo(best.t, {velocity: vt0, drop: 0, dropVelocity: vToward * 1000 * 0});
    }
    setTimeout(() => (suppressClick = false), 0);
  }

  // Pointer drags: the handle, the header (not its buttons), empty parts of the sheet.
  const INTERACTIVE = 'button, input, select, textarea, a, [role="button"], [role="slider"], .sf-tabs, .sf-field, [data-no-sheet-drag]';
  let press = null;
  let suppressClick = false;
  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || closing) return;
    if (e.target.closest(INTERACTIVE) && !e.target.closest('.sf-sheet-grab')) return;
    if (body.contains(e.target) && e.pointerType === 'touch') return; // touch in the body: handled below
    if (body.contains(e.target) && !e.target.closest('.sf-sheet-grab')) return; // the body scrolls by itself
    press = {id: e.pointerId, x: e.clientX, y: e.clientY, onGrab: !!e.target.closest('.sf-sheet-grab'), moved: false};
  });
  // Moves are watched on the window: a quick flick leaves the sheet before the first move arrives.
  const onPointerMove = (e) => {
    if (drag && press && e.pointerId === press.id) {
      moveDrag(e.clientY);
      e.preventDefault();
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (Math.abs(dy) < 7 || Math.abs(dy) < Math.abs(dx)) return;
    beginDrag(press.y);
    press.moved = true;
    try {
      panel.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer
    }
    moveDrag(e.clientY);
    e.preventDefault();
  };
  addEventListener('pointermove', onPointerMove);
  const pointerEnd = (e) => {
    if (!press || e.pointerId !== press.id) return;
    const tap = !drag && e.type === 'pointerup' && press.onGrab;
    press = null;
    if (drag) endDrag();
    else if (tap) stepFromHandle();
  };
  addEventListener('pointerup', pointerEnd);
  addEventListener('pointercancel', pointerEnd);
  panel.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }
    },
    true,
  );

  // Touch in the body: pulling down at the top moves the sheet; so does pushing up from a lower detent.
  let touch = null;
  body.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || drag || e.target.closest('[role="slider"], input[type="range"], textarea, [data-no-sheet-drag]')) return;
      const p = e.touches[0];
      touch = {x: p.clientX, y: p.clientY, decided: false, taken: false};
    },
    {passive: true},
  );
  body.addEventListener(
    'touchmove',
    (e) => {
      if (!touch) return;
      const p = e.touches[0];
      const dy = p.clientY - touch.y;
      const dx = p.clientX - touch.x;
      if (!touch.decided) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        touch.decided = true;
        const vertical = Math.abs(dy) > Math.abs(dx);
        const towardClose = edge === 'bottom' ? dy > 0 : dy < 0;
        const towardOpen = !towardClose;
        touch.taken = vertical && ((towardClose && body.scrollTop <= 0) || (towardOpen && t < highest - 0.02));
        if (touch.taken) beginDrag(p.clientY);
      }
      if (touch.taken) {
        e.preventDefault();
        moveDrag(p.clientY);
      }
    },
    {passive: false},
  );
  const touchEnd = () => {
    if (touch?.taken && drag) endDrag();
    touch = null;
  };
  body.addEventListener('touchend', touchEnd);
  body.addEventListener('touchcancel', touchEnd);

  // ---------------------------------------------------------------- stepping, wheel, keys

  function stepUp() {
    const next = stops.find((s) => s > t + 0.05);
    if (next !== undefined) {
      setDetentName(names[next]);
      animateTo(next);
      return true;
    }
    return false;
  }

  function stepDown() {
    const prev = [...stops].reverse().find((s) => s < t - 0.05);
    if (prev !== undefined) {
      setDetentName(names[prev]);
      animateTo(prev);
      return true;
    }
    if (!isBar) requestClose();
    return false;
  }

  function stepFromHandle() {
    // Tap the handle: up one detent, or back down from the top.
    if (t >= highest - 0.05) stepDown();
    else stepUp();
  }

  // Scrolling over the handle moves the sheet like a finger would: scroll
  // down (content moving up, a finger swiping up) opens it, scroll up closes it.
  let wheelSum = 0;
  let wheelAt = 0;
  grab.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const t0 = now();
      if (t0 - wheelAt > 220) wheelSum = 0;
      wheelAt = t0;
      if (t0 < wheelLock) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      wheelSum += edge === 'bottom' ? dy : -dy;
      if (Math.abs(wheelSum) < 24) return;
      const up = wheelSum > 0;
      wheelSum = 0;
      wheelLock = t0 + 380;
      if (up) stepUp();
      else stepDown();
    },
    {passive: false},
  );
  let wheelLock = 0;
  // From a lower detent, scrolling the body up expands the sheet instead of scrolling it.
  panel.addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('.sf-sheet-grab') || !body.contains(e.target) || t >= highest - 0.02 || closing) return;
      if ((edge === 'bottom' ? e.deltaY : -e.deltaY) > 4) {
        e.preventDefault();
        if (now() >= wheelLock) {
          wheelLock = now() + 380;
          stepUp();
        }
      }
    },
    {passive: false},
  );

  grab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if ((e.key === 'ArrowUp') === (edge === 'bottom')) stepUp();
      else stepDown();
    }
  });
  grab.tabIndex = 0;
  grab.setAttribute('role', 'button');
  grab.setAttribute('aria-label', 'Sheet handle');

  scrim.addEventListener('pointerdown', (e) => {
    if (!modal) return;
    e.preventDefault();
    requestClose();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.sf-pop')) {
      e.preventDefault();
      e.stopPropagation();
      if (o.onEscape?.()) return;
      if (isBar) stepDown();
      else requestClose();
    }
  });
  // The close button of the standard header.
  const closeBtn = () => header?.el?.querySelector?.('.sf-button[aria-label="Close"]');
  headEl.addEventListener('click', (e) => {
    const b = e.target.closest('.sf-button[aria-label="Close"]');
    if (b) requestClose(b);
  });

  const relayout = () => {
    if (isOpen) apply();
  };
  addEventListener('resize', relayout);
  visualViewport?.addEventListener('resize', relayout);
  const offConfigure = onConfigure(() => {
    colors();
    apply();
  });
  if (header?.el) new ResizeObserver(relayout).observe(header.el);
  addEventListener('sfbar', coverBands);

  // Non-modal sheets let the page behind stay usable.
  root.style.pointerEvents = 'none';
  panel.style.pointerEvents = 'auto';
  scrim.style.pointerEvents = modal ? 'auto' : 'none';
  scrim.hidden = !modal;
  if (isWindow) scrim.dataset.blur = '';
  body.addEventListener('scroll', () => panel.classList.toggle('scrolled', body.scrollTop > 2), {passive: true});

  const api = {
    el: panel,
    body,
    header,
    footer,
    handle: grab,
    layer,
    present,
    close,
    requestClose,
    setDetent,
    stepUp,
    stepDown,
    /** Marks unsaved changes: closing then asks first. */
    setDirty(on) {
      dirty = !!on;
      panel.classList.toggle('dirty', dirty);
      o.onDirty?.(dirty);
    },
    get dirty() {
      return dirty;
    },
    /** Asks the sheet's glass to redraw (content that moved or resized on its own). */
    invalidate() {
      glassHost?.invalidate();
    },
    /** The glass host of the sheet's content (null until it is presented). */
    get glass() {
      return glassHost;
    },
    /** Re-reads the medium height (the content changed). */
    refresh() {
      if (!isOpen || drag || t !== 1) return;
      apply();
    },
    /** An on-screen keyboard took the bottom of the screen (or went away). */
    setKeyboard(open) {
      if (keyboard === !!open) return;
      keyboard = !!open;
      apply();
    },
    get detent() {
      return detentName;
    },
    get t() {
      return t;
    },
    get isOpen() {
      return isOpen;
    },
    get rect() {
      return rect;
    },
    destroy() {
      cancelAnimationFrame(raf);
      if (isOpen) teardown();
      else layer.destroy();
    },
  };
  void closeBtn;
  void icon;
  return api;
}
