/**
 * Context menus in the style of iOS 26 (Apple Music's hold menu): the page
 * dims and blurs, a preview card of the item sits above a glass menu whose
 * top row holds a few quick actions (icon over label) and whose list is in
 * groups, with destructive items in red. Opened by a long press, the finger
 * can slide straight onto an item (a highlight follows it) and lift to
 * choose; taps, the mouse and the keyboard work too. Long menus scroll.
 *
 * The same menu, without a preview, is the ⋯ button's pull-down menu.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name, size) {
  const i = el('i');
  applySymbol(i, name, { size });
  return i;
}

let current = null;

/** Closes the open menu, if any. */
export function closeMenu() {
  current?.close();
}

/**
 * @param {{
 *   anchor: Element | DOMRect,
 *   preview?: Node,
 *   quick?: {label: string, symbol: string, action: () => void, disabled?: boolean}[],
 *   groups: ({label: string, symbol?: string, action?: () => void, role?: 'destructive', disabled?: boolean, checked?: boolean, detail?: string, submenu?: {title: string, groups: any[]}}[])[],
 *   pointer?: {id: number, x: number, y: number},
 *   align?: 'start' | 'end',
 *   title?: string,
 * }} options
 */
export function showMenu(options) {
  current?.close(true);
  const layer = el('div', 'menu-layer');
  const scrim = el('div', 'menu-scrim');
  const stackEl = el('div', 'menu-stack');
  layer.append(scrim, stackEl);
  if (options.preview) {
    const preview = el('div', 'menu-preview');
    preview.append(options.preview);
    stackEl.append(preview);
  }
  const panel = el('div', 'menu-panel');
  panel.setAttribute('role', 'menu');
  stackEl.append(panel);
  const highlight = el('div', 'menu-highlight');
  document.body.append(layer);

  let items = [];
  let active = -1;
  let closed = false;

  function render(groups, quick, title, back) {
    panel.replaceChildren();
    items = [];
    const scroller = el('div', 'menu-scroll');
    if (back) {
      const b = el('button', 'menu-item menu-back');
      b.type = 'button';
      b.append(icon('chevron.left', 14), el('span', 'menu-label', back.title));
      b.addEventListener('click', () => render(options.groups, options.quick, options.title));
      items.push({ node: b, run: () => render(options.groups, options.quick, options.title), keep: true });
      scroller.append(b, el('div', 'menu-sep'));
    }
    if (title && !back) scroller.append(el('div', 'menu-title', title));
    if (quick?.length) {
      const row = el('div', 'menu-quick');
      for (const q of quick) {
        const b = el('button', 'menu-quick-item');
        b.type = 'button';
        b.disabled = !!q.disabled;
        b.append(icon(q.symbol, 18), el('span', '', q.label));
        const run = () => {
          close();
          q.action();
        };
        b.addEventListener('click', run);
        if (!q.disabled) items.push({ node: b, run });
        row.append(b);
      }
      scroller.append(row, el('div', 'menu-sep'));
    }
    groups.filter((g) => g && g.length).forEach((group, gi, all) => {
      for (const it of group) {
        const b = el('button', `menu-item${it.role === 'destructive' ? ' destructive' : ''}`);
        b.type = 'button';
        b.setAttribute('role', it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
        if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
        b.disabled = !!it.disabled;
        const lead = el('span', 'menu-lead');
        if (it.checked) lead.append(icon('checkmark', 13));
        b.append(lead);
        const text = el('span', 'menu-text');
        text.append(el('span', 'menu-label', it.label));
        if (it.detail) text.append(el('span', 'menu-detail', it.detail));
        b.append(text);
        if (it.submenu) b.append(icon('chevron.right', 12));
        else if (it.symbol) b.append(icon(it.symbol, 17));
        const run = it.submenu
          ? () => render(it.submenu.groups, null, null, { title: it.submenu.title })
          : () => {
              close();
              it.action?.();
            };
        b.addEventListener('click', run);
        if (!it.disabled) items.push({ node: b, run, keep: !!it.submenu });
        scroller.append(b);
      }
      if (gi < all.length - 1) scroller.append(el('div', 'menu-sep thick'));
    });
    panel.append(scroller, highlight);
    position();
  }

  // ---------------------------------------------------------------- layout

  function position() {
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const margin = 12;
    const a = options.anchor instanceof Element ? options.anchor.getBoundingClientRect() : options.anchor;
    const width = Math.min(vw - margin * 2, options.preview ? 300 : 270);
    stackEl.style.width = `${width}px`;
    panel.style.maxHeight = '';
    const preview = stackEl.querySelector('.menu-preview');
    const pH = preview ? preview.getBoundingClientRect().height + 10 : 0;
    const menuH = panel.scrollHeight;
    let left = options.align === 'end' ? a.right - width : a.left + (options.preview ? (a.width - width) / 2 : 0);
    left = Math.max(margin, Math.min(vw - width - margin, left));
    // Below the anchor if it fits, else above, else as much as fits (the list scrolls).
    let top;
    const below = vh - a.bottom - margin;
    const above = a.top - margin;
    if (options.preview) {
      top = Math.max(margin, Math.min(a.top, vh - margin - pH - Math.min(menuH, vh * 0.6)));
      panel.style.maxHeight = `${Math.max(140, vh - margin - top - pH)}px`;
    } else if (menuH + 8 <= below || below >= above) {
      top = a.bottom + 8;
      panel.style.maxHeight = `${Math.max(120, vh - top - margin)}px`;
    } else {
      const h = Math.min(menuH, above - 8);
      top = a.top - 8 - h;
      panel.style.maxHeight = `${h}px`;
    }
    stackEl.style.left = `${left}px`;
    stackEl.style.top = `${top}px`;
    stackEl.style.transformOrigin = `${Math.max(0, Math.min(width, (a.left + a.width / 2) - left))}px ${options.preview ? '0' : top > a.top ? '0' : '100%'}`;
  }

  render(options.groups, options.quick, options.title);
  if (!reduced.matches) {
    if (morphFrom()) morph(true);
    else stackEl.animate([{ opacity: 0, transform: 'scale(0.86)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
  }

  // ---------------------------------------------------------------- selection

  function setActive(i, scrollIntoView = false) {
    if (i === active) return;
    active = i;
    items.forEach((it, j) => it.node.classList.toggle('active', j === i));
    if (i < 0) {
      highlight.classList.remove('on');
      return;
    }
    const node = items[i].node;
    if (scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    const pr = panel.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    highlight.style.transform = `translate(${r.left - pr.left}px, ${r.top - pr.top}px)`;
    highlight.style.width = `${r.width}px`;
    highlight.style.height = `${r.height}px`;
    highlight.classList.add('on');
  }

  function itemAt(x, y) {
    const hit = document.elementFromPoint(x, y)?.closest?.('.menu-item, .menu-quick-item');
    return hit ? items.findIndex((it) => it.node === hit) : -1;
  }

  // A long press that opened the menu can slide onto an item and lift to choose it.
  let sliding = options.pointer ? { id: options.pointer.id, x: options.pointer.x, y: options.pointer.y, moved: false } : null;
  const onMove = (e) => {
    if (!sliding || e.pointerId !== sliding.id) return;
    if (Math.hypot(e.clientX - sliding.x, e.clientY - sliding.y) > 6) sliding.moved = true;
    if (sliding.moved) setActive(itemAt(e.clientX, e.clientY));
  };
  const onUp = (e) => {
    if (!sliding || e.pointerId !== sliding.id) return;
    const moved = sliding.moved;
    sliding = null;
    if (!moved) return;
    const i = itemAt(e.clientX, e.clientY);
    if (i >= 0) items[i].run();
    else setActive(-1);
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  // Touch moves after a long press would otherwise scroll the page underneath.
  const blockScroll = (e) => {
    if (sliding) e.preventDefault();
  };
  window.addEventListener('touchmove', blockScroll, { passive: false, capture: true });
  panel.addEventListener('pointermove', (e) => {
    if (!sliding && e.pointerType === 'mouse') setActive(itemAt(e.clientX, e.clientY));
  });
  panel.addEventListener('pointerleave', () => {
    if (!sliding) setActive(-1);
  });

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (n) setActive(active < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n, true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (active >= 0) {
        e.preventDefault();
        items[active].run();
      }
    }
  };
  window.addEventListener('keydown', onKey, true);
  scrim.addEventListener('click', () => close());
  scrim.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    close();
  });

  function close(immediate = false) {
    if (closed) return;
    closed = true;
    current = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    window.removeEventListener('touchmove', blockScroll, { capture: true });
    window.removeEventListener('keydown', onKey, true);
    if (immediate || reduced.matches) {
      layer.remove();
      return;
    }
    layer.style.pointerEvents = 'none';
    if (morphFrom()) morph(false);
    else stackEl.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.92)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: options.anchor instanceof Element ? 260 : 180, fill: 'forwards' }).onfinish = () => layer.remove();
  }

  // A pull-down menu grows out of its button, as iOS 26's do: the glass
  // shape stretches from the button's outline to the menu's with a little
  // overshoot, while the items come in from a blur; closing folds it back
  // into the button.
  function morphFrom() {
    if (options.preview || !(options.anchor instanceof Element) || !options.anchor.isConnected) return null;
    const a = options.anchor.getBoundingClientRect();
    return a.width ? a : null;
  }
  function morph(opening) {
    const a = morphFrom();
    const p = panel.getBoundingClientRect();
    const radius = Math.min(a.height / 2, parseFloat(getComputedStyle(options.anchor).borderTopLeftRadius) || a.height / 2);
    const from = `inset(${a.top - p.top}px ${p.right - a.right}px ${p.bottom - a.bottom}px ${a.left - p.left}px round ${radius}px)`;
    const to = 'inset(0px 0px 0px 0px round 26px)';
    const content = panel.querySelector('.menu-scroll');
    const shrink = Math.max(0.35, Math.min(1, a.width / p.width));
    if (opening) {
      panel.animate([{ clipPath: from }, { clipPath: to }], { duration: 460, easing: 'cubic-bezier(0.22, 1.18, 0.36, 1)' });
      content?.animate(
        [
          { opacity: 0, filter: 'blur(8px)', transform: `scale(${shrink})`, transformOrigin: `${a.left + a.width / 2 - p.left}px ${a.top + a.height / 2 - p.top}px` },
          { opacity: 1, filter: 'blur(0px)', transform: 'none', transformOrigin: `${a.left + a.width / 2 - p.left}px ${a.top + a.height / 2 - p.top}px` },
        ],
        { duration: 380, easing: 'cubic-bezier(0.25, 1.1, 0.4, 1)' },
      );
    } else {
      panel.animate([{ clipPath: to, opacity: 1 }, { clipPath: from, opacity: 1, offset: 0.85 }, { clipPath: from, opacity: 0 }], { duration: 260, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' });
      content?.animate([{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(6px)' }], { duration: 160, fill: 'forwards' });
    }
  }

  current = { close };
  return { close };
}

/**
 * Long press (touch, 450 ms without moving) and right-click on `element`
 * call `open(event, {pointer})`; the pointer is passed so the menu can take
 * over the finger. A long press also suppresses the click that follows.
 */
export function onHold(element, open, { delay = 450, filter } = {}) {
  let timer = 0;
  let start = null;
  let fired = false;
  element.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || (filter && !filter(e))) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, target: e.target };
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      navigator.vibrate?.(8);
      open(start.target, { pointer: { id: start.id, x: start.x, y: start.y } });
    }, delay);
  });
  const cancel = () => clearTimeout(timer);
  element.addEventListener('pointermove', (e) => {
    if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  });
  element.addEventListener('pointerup', cancel);
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('contextmenu', (e) => {
    if (filter && !filter(e)) return;
    e.preventDefault();
    if (e.pointerType === 'touch' || fired) return;
    open(e.target, { pointer: null, x: e.clientX, y: e.clientY });
  });
  element.addEventListener(
    'click',
    (e) => {
      if (fired) {
        e.preventDefault();
        e.stopPropagation();
        fired = false;
      }
    },
    true,
  );
}
