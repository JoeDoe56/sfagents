/**
 * Small windows that grow out of what was tapped, like an iOS notification
 * held open: the card expands from the tapped element's frame to a window
 * near the top of the screen, the page behind it dims and blurs, and its
 * content fades in. Inside, a window can push views (Processes → a process)
 * with a back button. It closes with its X, a tap outside, Escape or a
 * downward swipe on its header, shrinking back into where it came from.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const OPEN_MS = 440;
const CLOSE_MS = 340;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function symbol(name, size = 16) {
  const i = el('i');
  applySymbol(i, name, { size });
  return i;
}

let openCount = 0;
let openWindows = 0;

/** Whether a window is open (pages behind it can stop updating). */
export function peekOpen() {
  return openWindows > 0;
}

/** The top safe-area inset (status bar) in pixels. */
function safeInsetTop() {
  const probe = el('div');
  probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

/**
 * @param {{from?: Element|null, title: string, symbol?: string, build: (ctx: PeekContext) => void, onClose?: () => void}} options
 * @typedef {{body: HTMLElement, setTitle: (t: string) => void, push: (view: {title: string, symbol?: string, build: (ctx: PeekContext) => void}) => void,
 *   pop: () => void, every: (ms: number, fn: () => unknown) => void, close: () => void, onLeave: (fn: () => void) => void, window: HTMLElement}} PeekContext
 */
export function openPeek(options) {
  const layer = el('div', 'peek-layer');
  const scrim = el('div', 'peek-scrim');
  const card = el('section', 'peek');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const inner = el('div', 'peek-inner');
  const head = el('header', 'peek-head');
  const back = el('button', 'peek-back');
  back.type = 'button';
  back.hidden = true;
  back.append(symbol('chevron.left', 17), el('span', 'peek-back-label', ''));
  const titleWrap = el('div', 'peek-title');
  const titleIcon = el('span', 'peek-title-icon');
  const titleText = el('h2', '', options.title);
  titleText.id = `peek-title-${++openCount}`;
  card.setAttribute('aria-labelledby', titleText.id);
  titleWrap.append(titleIcon, titleText);
  const close = el('button', 'peek-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.append(symbol('xmark', 12));
  head.append(back, titleWrap, close);
  const viewport = el('div', 'peek-viewport');
  inner.append(head, viewport);
  card.append(inner);
  layer.append(scrim, card);
  document.body.append(layer);

  const previousFocus = document.activeElement;
  const stack = [];
  let closed = false;

  function setIcon(name) {
    titleIcon.replaceChildren();
    titleIcon.hidden = !name;
    if (name) titleIcon.append(symbol(name, 15));
  }

  /** A view's own timers and cleanups, stopped when it is left. */
  function makeView(view) {
    const body = el('div', 'peek-body');
    const timers = [];
    const leaves = [];
    const ctx = {
      body,
      window: card,
      setTitle: (t) => {
        view.title = t;
        if (stack[stack.length - 1] === entry) titleText.textContent = t;
      },
      push: (next) => push(next),
      pop: () => pop(),
      close: () => dismiss(),
      every(ms, fn) {
        let stopped = false;
        let timer = 0;
        const tick = async () => {
          if (stopped) return;
          try {
            await fn();
          } catch {
            // a failed refresh keeps the last content
          }
          if (!stopped) timer = setTimeout(tick, ms);
        };
        tick();
        timers.push(() => {
          stopped = true;
          clearTimeout(timer);
        });
      },
      onLeave(fn) {
        leaves.push(fn);
      },
    };
    const entry = { view, body, stop: () => [...timers, ...leaves].forEach((f) => f()) };
    view.build(ctx);
    return entry;
  }

  function show(entry, direction) {
    titleText.textContent = entry.view.title;
    setIcon(entry.view.symbol);
    const prev = stack[stack.length - 2];
    back.hidden = stack.length < 2;
    back.querySelector('.peek-back-label').textContent = prev?.view.title ?? '';
    titleWrap.classList.toggle('pushed', stack.length > 1);
    const old = viewport.querySelector('.peek-body.current');
    entry.body.classList.add('current');
    viewport.append(entry.body);
    if (old && direction && !reduced.matches) {
      const sign = direction === 'forward' ? 1 : -1;
      entry.body.animate([{ transform: `translateX(${sign * 30}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: EASE });
      const leaving = old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${-sign * 20}%)`, opacity: 0 }], { duration: 260, easing: EASE });
      leaving.onfinish = () => {
        if (!old.classList.contains('current')) old.remove();
      };
      old.classList.remove('current');
    } else if (old) {
      old.remove();
    }
  }

  function push(view) {
    const entry = makeView(view);
    stack.push(entry);
    show(entry, 'forward');
  }

  function pop() {
    if (stack.length < 2) return;
    const leaving = stack.pop();
    leaving.stop();
    // The previous view kept running underneath (its search, scroll and timers).
    show(stack[stack.length - 1], 'back');
  }

  // ---------------------------------------------------------------- frames

  function finalRect() {
    const vw = window.innerWidth;
    const vh = (window.visualViewport?.height ?? window.innerHeight);
    const width = Math.min(vw - 20, 600);
    const safeTop = safeInsetTop();
    const top = vw < 640 ? Math.max(10, safeTop + 8) : Math.max(24, vh * 0.08);
    const height = Math.min(vh - top - (vw < 640 ? 14 : 40), 720);
    return { left: (vw - width) / 2, top, width, height };
  }

  function sourceRect() {
    const from = options.from;
    if (!from || !from.isConnected) return null;
    const r = from.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height, radius: parseFloat(getComputedStyle(from).borderTopLeftRadius) || 22 };
  }

  function place(r) {
    card.style.left = `${r.left}px`;
    card.style.top = `${r.top}px`;
    card.style.width = `${r.width}px`;
    card.style.height = `${r.height}px`;
    inner.style.width = `${r.width}px`;
    inner.style.height = `${r.height}px`;
  }

  const target = finalRect();
  place(target);
  push({ title: options.title, symbol: options.symbol, build: options.build });

  const src = sourceRect();
  if (!reduced.matches) {
    const from = src ?? { left: target.left + target.width * 0.1, top: target.top + 20, width: target.width * 0.8, height: target.height * 0.6, radius: 34 };
    card.animate(
      [
        { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: `${from.radius}px`, opacity: src ? 1 : 0 },
        { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px`, borderRadius: '34px', opacity: 1 },
      ],
      { duration: OPEN_MS, easing: EASE },
    );
    inner.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-out' });
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.8, easing: 'ease-out' });
  }
  options.from?.classList?.add('peek-source');
  openWindows++;
  window.dispatchEvent(new CustomEvent('peekchange', { detail: { open: openWindows } }));
  requestAnimationFrame(() => close.focus({ preventScroll: true }));

  function dismiss() {
    if (closed) return;
    closed = true;
    for (const e of stack) e.stop();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    const to = sourceRect();
    openWindows--;
    window.dispatchEvent(new CustomEvent('peekchange', { detail: { open: openWindows } }));
    const done = () => {
      layer.remove();
      options.from?.classList?.remove('peek-source');
      options.onClose?.();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
    if (reduced.matches) return done();
    const now = card.getBoundingClientRect();
    const end = to ?? { left: now.left + now.width * 0.1, top: now.top + 10, width: now.width * 0.8, height: Math.min(now.height, 120), radius: 34 };
    const anim = card.animate(
      [
        { left: `${now.left}px`, top: `${now.top}px`, width: `${now.width}px`, height: `${now.height}px`, borderRadius: '34px', opacity: 1 },
        { left: `${end.left}px`, top: `${end.top}px`, width: `${end.width}px`, height: `${end.height}px`, borderRadius: `${end.radius}px`, opacity: to ? 0.2 : 0 },
      ],
      { duration: CLOSE_MS, easing: EASE, fill: 'forwards' },
    );
    inner.animate([{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], { duration: CLOSE_MS, fill: 'forwards' });
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, fill: 'forwards' });
    anim.onfinish = done;
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    // A menu or dialog opened from this window closes first.
    if (document.querySelector('.menu-layer, .dialog-layer')) return;
    e.preventDefault();
    e.stopPropagation();
    if (stack.length > 1) pop();
    else dismiss();
  }
  function onResize() {
    if (!closed) place(finalRect());
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  close.addEventListener('click', dismiss);
  scrim.addEventListener('click', dismiss);
  back.addEventListener('click', pop);

  // Swipe down on the header to close (the card follows the finger).
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = { id: e.pointerId, y: e.clientY, t: performance.now(), dy: 0 };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    card.style.transform = `translateY(${drag.dy}px) scale(${1 - Math.min(0.06, drag.dy / 3000)})`;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const v = drag.dy / Math.max(1, performance.now() - drag.t);
    const far = drag.dy > 90 || (drag.dy > 30 && v > 0.5);
    drag = null;
    if (far) {
      card.style.transform = '';
      dismiss();
    } else {
      card.animate([{ transform: card.style.transform }, { transform: 'none' }], { duration: 220, easing: EASE });
      card.style.transform = '';
    }
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  return { close: dismiss, element: card };
}

// ------------------------------------------------------------------ building blocks

/** An inset grouped list (Settings style): rows of label and value. */
export function group(rows, title) {
  const wrap = el('section', 'ui-section');
  if (title) wrap.append(el('h3', 'ui-section-title', title));
  const list = el('div', 'ui-group');
  for (const r of rows) if (r) list.append(r);
  wrap.append(list);
  return wrap;
}

/** A row: label on the left, value (text or node) on the right; a tap action makes it a button. */
export function row(label, value, opts = {}) {
  const node = el(opts.onClick ? 'button' : 'div', `ui-row${opts.onClick ? ' tappable' : ''}${opts.role ? ` ${opts.role}` : ''}`);
  if (opts.onClick) {
    node.type = 'button';
    node.addEventListener('click', opts.onClick);
  }
  if (opts.symbol) {
    const icon = symbol(opts.symbol, 16);
    icon.classList.add('ui-row-icon');
    node.append(icon);
  }
  const l = el('span', 'ui-row-label', label);
  node.append(l);
  const v = el('span', 'ui-row-value');
  if (value instanceof Node) v.append(value);
  else v.textContent = value ?? '';
  node.append(v);
  if (opts.chevron) node.append(symbol('chevron.right', 12));
  if (opts.title) node.title = opts.title;
  return node;
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
  const wrap = el('div', 'ui-segmented');
  wrap.setAttribute('role', 'tablist');
  const buttons = options.map((o) => {
    const b = el('button', '', o.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      set(o.value);
      onChange(o.value);
    });
    wrap.append(b);
    return [o.value, b];
  });
  function set(v) {
    value = v;
    for (const [val, b] of buttons) {
      b.classList.toggle('on', val === v);
      b.setAttribute('aria-selected', String(val === v));
    }
  }
  set(value);
  return { element: wrap, set, get: () => value };
}

export function button(label, opts = {}) {
  const b = el('button', `ui-button${opts.role ? ` ${opts.role}` : ''}`);
  b.type = 'button';
  if (opts.symbol) b.append(symbol(opts.symbol, 15));
  b.append(el('span', '', label));
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export { el, symbol };
