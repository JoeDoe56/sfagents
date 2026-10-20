/**
 * Modal sheets, as iOS presents them (and as the Claude app's sheets
 * behave): the sheet slides up from the bottom and stops just under the
 * status bar (the Dynamic Island), keeping its rounded corners; a grabber
 * sits at the top. Some sheets have a medium detent first and expand to the
 * large one (drag up, or scroll up from the medium height); others go
 * straight to large. Dragging down, the close button, the scrim or Escape
 * send it back down quickly.
 *
 * `createSheetFrame` is the frame alone (the file manager fills it with its
 * own chrome); `openSheet` adds the standard header (close button on the
 * left, a centred title) and a scrolling body with a progressive blur under
 * the header.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';

const OPEN_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const CLOSE_EASE = 'cubic-bezier(0.4, 0, 0.9, 0.6)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let probe = null;
/** The top safe-area inset (status bar, Dynamic Island) in px. */
export function safeTop() {
  if (!probe) {
    probe = el('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
    document.body.append(probe);
  }
  return probe.getBoundingClientRect().height;
}

let bottomProbe = null;
function safeBottom() {
  if (!bottomProbe) {
    bottomProbe = el('div');
    bottomProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
    document.body.append(bottomProbe);
  }
  return bottomProbe.getBoundingClientRect().height;
}

let openSheets = 0;
let defaultGlass = null;
/** Sets how sheets make their Liquid Glass (the app passes sfgl with its quality setting). */
export function setSheetGlass(factory) {
  defaultGlass = factory;
}
/** Whether any modal sheet is open. */
export function sheetOpen() {
  return openSheets > 0;
}

/**
 * @param {{
 *   detents?: ('medium'|'large')[],
 *   mediumHeight?: () => number,
 *   className?: string,
 *   label?: string,
 *   scroller?: () => HTMLElement | null,
 *   onDetent?: (detent: string) => void,
 *   onClosed?: () => void,
 *   onMove?: () => void,
 *   z?: number,
 *   onEscape?: () => boolean,
 * }} options
 */
export function createSheetFrame(options = {}) {
  const detents = options.detents?.length ? options.detents : ['large'];
  const layer = el('div', `ms-layer ${options.className ?? ''}`);
  layer.hidden = true;
  if (options.z) layer.style.zIndex = String(options.z);
  const scrim = el('div', 'ms-scrim');
  const panel = el('section', 'ms-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (options.label) panel.setAttribute('aria-label', options.label);
  panel.tabIndex = -1;
  const grabber = el('div', 'ms-grabber');
  grabber.setAttribute('aria-hidden', 'true');
  panel.append(grabber);
  layer.append(scrim, panel);
  document.body.append(layer);

  let height = 0; // panel height (the large detent)
  let y = 0; // current offset from the large position
  let detent = null; // 'medium' | 'large' | null (closed)
  let anim = null;
  let open = false;
  const previousFocus = { node: null };

  function layout() {
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const wide = vw >= 700;
    const top = wide ? 24 : Math.max(10, safeTop() + 10);
    height = vh - top;
    panel.style.top = `${top}px`;
    panel.style.height = `${height}px`;
    panel.classList.toggle('wide', wide);
  }

  function offsetFor(d) {
    if (d === 'large') return 0;
    if (d === 'medium') {
      const want = options.mediumHeight?.() ?? height * 0.5;
      return Math.max(0, height - Math.min(height - 40, Math.max(180, want)));
    }
    return height + 24;
  }

  function apply(next) {
    y = next;
    panel.style.transform = `translate3d(0, ${y}px, 0)`;
    // The scrim deepens as the sheet rises towards the large detent.
    const medium = offsetFor('medium');
    const shown = Math.max(0, Math.min(1, 1 - y / Math.max(1, height)));
    const toLarge = detents.includes('medium') ? Math.max(0, Math.min(1, 1 - y / Math.max(1, medium))) : 1;
    scrim.style.opacity = String(shown * (0.45 + 0.55 * toLarge));
    options.onMove?.();
  }

  function settle(to, { duration, ease = OPEN_EASE, velocity = 0 } = {}) {
    const target = offsetFor(to);
    anim?.cancel();
    const from = y;
    const dist = Math.abs(target - from);
    const ms = reduced.matches ? 0 : duration ?? Math.max(220, Math.min(520, 300 + dist * 0.25 - Math.abs(velocity) * 60));
    if (!ms || dist < 0.5) {
      apply(target);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const curve = bezier(ease);
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        apply(from + (target - from) * curve(t));
        if (t < 1) anim.id = requestAnimationFrame(step);
        else {
          anim = null;
          resolve();
        }
      };
      anim = { id: requestAnimationFrame(step), cancel() { cancelAnimationFrame(this.id); anim = null; resolve(); } };
    });
  }

  function setDetent(d) {
    detent = d;
    panel.dataset.detent = d;
    const scroller = options.scroller?.();
    if (scroller) scroller.classList.toggle('ms-locked', d === 'medium');
    options.onDetent?.(d);
  }

  async function show(d = detents[0]) {
    if (open) return set(d);
    open = true;
    openSheets++;
    previousFocus.node = document.activeElement;
    layer.hidden = false;
    layout();
    apply(offsetFor(null));
    setDetent(d);
    window.dispatchEvent(new CustomEvent('sheetchange'));
    await settle(d, { duration: 460 });
    if (open) panel.focus({ preventScroll: true });
  }

  function set(d) {
    if (!open || !detents.includes(d)) return Promise.resolve();
    setDetent(d);
    return settle(d);
  }

  async function close() {
    if (!open) return;
    open = false;
    openSheets--;
    detent = null;
    await settle(null, { duration: 260, ease: CLOSE_EASE });
    if (open) return;
    layer.hidden = true;
    window.dispatchEvent(new CustomEvent('sheetchange'));
    options.onClosed?.();
    previousFocus.node?.focus?.({ preventScroll: true });
  }

  // ---------------------------------------------------------------- dragging

  let drag = null;
  const now = () => performance.now();

  function begin(e) {
    anim?.cancel();
    drag = { id: e.pointerId ?? e.identifier, startY: e.clientY, startOffset: y, last: [{ t: now(), y: e.clientY }] };
  }
  function move(clientY) {
    const dy = clientY - drag.startY;
    let next = drag.startOffset + dy;
    // Rubber band above the large detent.
    if (next < 0) next = -Math.pow(-next, 0.7);
    apply(next);
    drag.last.push({ t: now(), y: clientY });
    if (drag.last.length > 6) drag.last.shift();
  }
  function end() {
    const pts = drag.last;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const v = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0; // px per ms, down positive
    drag = null;
    // Where a flick would carry the sheet, then the nearest stop.
    const projected = y + v * 220;
    const stops = [...detents.map((d) => [d, offsetFor(d)]), [null, offsetFor(null)]];
    let best = stops[0];
    for (const s of stops) if (Math.abs(s[1] - projected) < Math.abs(best[1] - projected)) best = s;
    if (v > 1.1 && y > 30) best = [null, 0];
    if (best[0] === null) close();
    else {
      setDetent(best[0]);
      settle(best[0], { velocity: v });
    }
  }

  /** Drags on `area` (a header, the grabber) move the sheet, unless they start on a control. */
  function addDragArea(area) {
    area.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, textarea, a, [role="button"], [role="slider"]')) return;
      begin(e);
      try {
        area.setPointerCapture(e.pointerId);
      } catch {
        // synthetic pointer
      }
    });
    area.addEventListener('pointermove', (e) => {
      if (drag && e.pointerId === drag.id) move(e.clientY);
    });
    const up = (e) => {
      if (drag && e.pointerId === drag.id) end();
    };
    area.addEventListener('pointerup', up);
    area.addEventListener('pointercancel', up);
  }
  addDragArea(grabber);

  // Touch drags on the content: pulling down at the top of the list moves
  // the sheet, and so does pushing up from the medium detent.
  let touch = null;
  panel.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || drag) return;
      const t = e.touches[0];
      const scroller = options.scroller?.();
      if (!scroller || !scroller.contains(e.target) || e.target.closest('[role="slider"], input[type="range"], textarea')) return;
      touch = { y: t.clientY, x: t.clientX, scroller, taken: false, decided: false };
    },
    { passive: true },
  );
  panel.addEventListener(
    'touchmove',
    (e) => {
      if (!touch) return;
      const t = e.touches[0];
      const dy = t.clientY - touch.y;
      const dx = t.clientX - touch.x;
      if (!touch.decided) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        touch.decided = true;
        const atTop = touch.scroller.scrollTop <= 0;
        const vertical = Math.abs(dy) > Math.abs(dx);
        touch.taken = vertical && ((dy > 0 && atTop) || (dy < 0 && detent === 'medium' && detents.includes('large')));
        if (touch.taken) begin({ pointerId: 'touch', clientY: t.clientY });
      }
      if (touch.taken) {
        e.preventDefault();
        move(t.clientY);
      }
    },
    { passive: false },
  );
  const touchEnd = () => {
    if (touch?.taken && drag) end();
    touch = null;
  };
  panel.addEventListener('touchend', touchEnd);
  panel.addEventListener('touchcancel', touchEnd);
  // A wheel or trackpad scroll up from the medium detent expands the sheet.
  panel.addEventListener(
    'wheel',
    (e) => {
      if (detent === 'medium' && e.deltaY > 4 && detents.includes('large')) {
        e.preventDefault();
        set('large');
      }
    },
    { passive: false },
  );

  scrim.addEventListener('click', () => close());
  layer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.menu-layer, .dialog-layer, .peek-layer, .ql-layer, .fm-picker-layer')) {
      e.preventDefault();
      e.stopPropagation();
      if (!options.onEscape?.()) close();
    }
  });
  const relayout = () => {
    if (!open) return;
    layout();
    apply(offsetFor(detent));
  };
  addEventListener('resize', relayout);
  window.visualViewport?.addEventListener('resize', relayout);

  return {
    layer,
    panel,
    scrim,
    grabber,
    show,
    set,
    close,
    addDragArea,
    /** Re-reads the medium height (content changed). */
    refresh: () => {
      if (open && detent === 'medium' && !drag && !anim) apply(offsetFor('medium'));
    },
    get detent() {
      return detent;
    },
    get isOpen() {
      return open;
    },
  };
}

/** A cubic-bezier easing function from a CSS string. */
function bezier(css) {
  const m = /cubic-bezier\(([^)]+)\)/.exec(css);
  const [x1, y1, x2, y2] = m ? m[1].split(',').map(Number) : [0.25, 0.1, 0.25, 1];
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (sx(t) - x) / d;
    }
    return sy(Math.max(0, Math.min(1, t)));
  };
}

/**
 * A standard sheet: close button on the left, a centred title, an optional
 * trailing control, and a scrolling body.
 * @param {{title: string, detents?: ('medium'|'large')[], className?: string, trailing?: Node,
 *   mediumHeight?: (ctx: object) => number, build: (ctx: object) => void, onClose?: () => void, onDetent?: (d: string) => void,
 *   glass?: (opts: {host: HTMLElement, scroller: HTMLElement}) => any}} options
 */
export function openSheet(options) {
  const head = el('header', 'ms-head');
  const closeBtn = el('button', 'ms-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  const x = el('i');
  applySymbol(x, 'xmark', { size: 15 });
  closeBtn.append(x);
  const title = el('h2', 'ms-title', options.title);
  const trailing = el('div', 'ms-trailing');
  if (options.trailing) trailing.append(options.trailing);
  head.append(closeBtn, title, trailing);
  const body = el('div', 'ms-body');
  const edge = el('div', 'ms-edge');
  let ctx;
  const frame = createSheetFrame({
    detents: options.detents,
    className: options.className,
    label: options.title,
    scroller: () => body,
    mediumHeight: () => (options.mediumHeight ? options.mediumHeight(ctx) : (body.querySelector('[data-medium-end]')?.offsetTop ?? body.scrollHeight) + 16 + safeBottom()),
    onDetent: (d) => options.onDetent?.(d),
    onClosed: () => {
      glass?.destroy();
      frame.layer.remove();
      options.onClose?.();
    },
    onMove: () => frame?.onMove?.(),
  });
  frame.panel.append(head, edge, body);
  frame.addDragArea(head);
  // The close button is Liquid Glass with the main sheet's control values.
  let glass = null;
  const extraGlass = [];
  const setupGlass = () => {
    const factory = options.glass ?? defaultGlass;
    if (glass || !factory) return;
    try {
      glass = factory({ host: frame.panel, scroller: body });
      glass.lens(closeBtn, 'control');
      for (const node of trailing.querySelectorAll('[data-glass]')) glass.lens(node, node.dataset.glass || 'control');
      for (const [node, kind] of extraGlass) glass.lens(node, kind, { clip: body });
      const bands = () => {
        const rects = [head, ...extraGlass.map(([n]) => n)].map((n) => n.getBoundingClientRect()).filter((r) => r.height);
        glass.setBands(rects.map((r) => ({ top: r.top, bottom: r.bottom })));
        glass.invalidate();
      };
      frame.onMove = bands;
      body.addEventListener('scroll', bands, { passive: true });
      new ResizeObserver(bands).observe(body);
      bands();
    } catch {
      glass = null;
      frame.panel.classList.add('no-glass');
    }
  };
  closeBtn.addEventListener('click', () => frame.close());
  body.addEventListener('scroll', () => frame.panel.classList.toggle('ms-scrolled', body.scrollTop > 2), { passive: true });
  ctx = { invalidateGlass: () => glass?.invalidate(), addGlass: (node, kind = 'control') => (extraGlass.push([node, kind]), glass?.lens(node, kind, { clip: body })), body, head, title, frame, close: () => frame.close(), set: (d) => frame.set(d), setTitle: (t) => (title.textContent = t), refresh: () => frame.refresh() };
  options.build(ctx);
  frame.show(options.detents?.[0] ?? 'large');
  setupGlass();
  return ctx;
}
