/**
 * Menus: the dropdown that comes out of a label or a button, and the menu
 * that comes out of something you hold. Both are popovers (`popover.js`):
 * glass that grows from its source, with no scrim and no blur behind it
 * (a held item's menu may add a dim and a preview card).
 *
 * The finger, mouse and keyboard all work:
 * - tap an item to choose it; tap outside to close;
 * - hold on an item for a moment and a highlight appears that follows the
 *   finger, jumping smoothly from item to item; lift to choose;
 * - drag past the sides of the menu and the glass stretches after the finger;
 * - after a long press that opened the menu, slide straight onto an item;
 * - arrow keys, Enter and Escape; right-click is a long press.
 * @module
 */

import {el, icon, spring, clamp} from './core.js';
import {presentPopover} from './popover.js';
import {overshoot} from './stretch.js';

const slide = spring(0.24, 0.86);
const HOLD_MS = 130;

/**
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {string} [symbol]       trailing icon
 * @property {string} [detail]       second line
 * @property {boolean} [checked]     leading check
 * @property {boolean} [destructive]
 * @property {boolean} [disabled]
 * @property {boolean} [keepOpen]
 * @property {() => void} [action]
 * @property {{title?: string, items: MenuItem[] | MenuItem[][]}} [submenu]
 *
 * @typedef {object} MenuOptions
 * @property {Element | DOMRect | {left: number, top: number, width: number, height: number}} source
 * @property {MenuItem[] | MenuItem[][]} items    a list, or groups separated by a heavier line
 * @property {{label: string, symbol: string, action: () => void, disabled?: boolean}[]} [quick]  icon-over-label row on top
 * @property {string} [title]
 * @property {Node} [preview]                      a card shown above the menu (held items) with a dim behind
 * @property {{id: number, x: number, y: number}} [pointer]  the finger that opened it (slide to choose)
 * @property {'auto'|'below'|'above'|'cover'} [placement]
 * @property {'start'|'end'|'center'} [align]
 * @property {number} [width]
 * @property {() => void} [onClose]
 */

const groupsOf = (items) => (items.length && Array.isArray(items[0]) ? items : [items]).filter((g) => g.length);

/**
 * Opens a menu.
 * @param {MenuOptions} o
 * @returns {{close: () => void, popover: any}}
 */
export function showMenu(o) {
  let pop = null;
  let items = [];
  let active = -1;
  let rootMenu = null;
  const history = [];

  // The held item's preview and the dim behind it.
  let dim = null;
  let previewCard = null;
  if (o.preview) {
    dim = el('div', 'sf-menu-dim');
    dim.dataset.sfNopaint = '';
    previewCard = el('div', 'sf-menu-preview');
    previewCard.dataset.sfNopaint = '';
    previewCard.append(o.preview);
    document.body.append(dim);
    dim.animate([{opacity: 0}, {opacity: 1}], {duration: 240, fill: 'both'});
  }

  function build(list, {quick, title, back} = {}) {
    const menu = el('div', 'sf-menu');
    const hl = el('div', 'sf-menu-hl');
    menu.append(hl);
    const entries = [];
    const add = (node, run, keep) => entries.push({node, run, keep});
    if (back) {
      const b = el('button', 'sf-menu-item sf-menu-back');
      b.type = 'button';
      b.append(el('span', 'sf-menu-lead'), el('span', 'sf-menu-text', back.title ?? 'Back'));
      b.firstChild.append(icon('chevron.left', 14));
      add(b, () => navigate(history.pop()), true);
      menu.append(b, el('div', 'sf-menu-sep'));
    } else if (title) menu.append(el('div', 'sf-menu-title', title));
    if (quick?.length) {
      const row = el('div', 'sf-menu-quick');
      for (const q of quick) {
        const b = el('button', 'sf-menu-quick-item');
        b.type = 'button';
        b.disabled = !!q.disabled;
        b.append(icon(q.symbol, 20), el('span', '', q.label));
        row.append(b);
        if (!q.disabled) add(b, () => q.action(), false);
      }
      menu.append(row, el('div', 'sf-menu-sep thick'));
    }
    const groups = groupsOf(list);
    groups.forEach((group, gi) => {
      for (const it of group) {
        const b = el('button', `sf-menu-item${it.destructive ? ' destructive' : ''}`);
        b.type = 'button';
        b.setAttribute('role', it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
        if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
        b.disabled = !!it.disabled;
        const lead = el('span', 'sf-menu-lead');
        if (it.checked) lead.append(icon('checkmark', 14));
        const text = el('span', 'sf-menu-text');
        text.append(el('span', 'sf-menu-label', it.label));
        if (it.detail) text.append(el('span', 'sf-menu-detail', it.detail));
        b.append(lead, text);
        if (it.submenu) b.append(icon('chevron.right', 13));
        else if (it.symbol) b.append(icon(it.symbol, 18));
        menu.append(b);
        if (it.disabled) continue;
        if (it.submenu) add(b, () => navigate({items: it.submenu.items, title: it.submenu.title, back: {title: it.label}, from: current}), true);
        else add(b, () => it.action?.(), !!it.keepOpen);
      }
      if (gi < groups.length - 1) menu.append(el('div', 'sf-menu-sep thick'));
    });
    return {el: menu, hl, entries};
  }

  let current = {items: o.items, quick: o.quick, title: o.title};
  function navigate(spec) {
    if (!spec) return;
    if (spec.from) history.push(spec.from);
    current = spec.from ? {items: spec.items, title: spec.title, back: spec.back} : spec;
    setActive(-1, true);
    const next = build(current.items, current);
    rootMenu = next;
    items = next.entries;
    hlState.y.x = hlState.h.x = 0;
    pop.setContent(next.el, {width: o.width});
    wire(next);
  }

  // ---------------------------------------------------------------- highlight

  const hlState = {y: {x: 0, v: 0}, h: {x: 0, v: 0}, a: {x: 0, v: 0}};
  let hlTarget = {y: 0, h: 0, a: 0};
  let hlRaf = 0;
  let hlLast = 0;

  function hlTick(now) {
    const dt = Math.min(0.05, (now - hlLast) / 1000);
    hlLast = now;
    const a = slide(hlState.y, hlTarget.y, dt);
    const b = slide(hlState.h, hlTarget.h, dt);
    const c = slide(hlState.a, hlTarget.a, dt);
    const hl = rootMenu?.hl;
    if (hl) {
      hl.style.transform = `translateY(${hlState.y.x}px)`;
      hl.style.height = `${Math.max(0, hlState.h.x)}px`;
      hl.style.opacity = String(clamp(hlState.a.x, 0, 1));
    }
    hlRaf = a && b && c ? 0 : requestAnimationFrame(hlTick);
  }

  function setActive(i, instant = false) {
    if (i === active && !instant) return;
    const first = active < 0 || hlState.a.x < 0.05;
    active = i;
    rootMenu?.entries.forEach((e, j) => e.node.classList.toggle('active', j === i));
    if (i < 0) hlTarget.a = 0;
    else {
      const node = items[i].node;
      hlTarget = {y: node.offsetTop, h: node.offsetHeight, a: 1};
      if (first || instant) {
        hlState.y.x = hlTarget.y;
        hlState.y.v = 0;
        hlState.h.x = hlTarget.h;
        hlState.h.v = 0;
      }
    }
    if (!hlRaf) {
      hlLast = performance.now();
      hlRaf = requestAnimationFrame(hlTick);
    }
  }

  const itemAt = (x, y) => {
    const hit = document.elementFromPoint(x, y)?.closest?.('.sf-menu-item, .sf-menu-quick-item');
    return hit ? items.findIndex((e) => e.node === hit) : -1;
  };

  // ---------------------------------------------------------------- gestures

  function choose(i) {
    const it = items[i];
    if (!it) return;
    if (it.keep) {
      it.run();
      return;
    }
    // Let the highlight flash for a moment, as a chosen item does, then go.
    pop.close();
    it.run();
  }

  let press = null; // {id, x, y, held, moved, timer}

  function startPress(id, x, y, held) {
    press = {id, x, y, held, moved: false, timer: 0};
    if (!held) press.timer = setTimeout(() => {
      if (press) {
        press.held = true;
        setActive(itemAt(press.x, press.y));
      }
    }, HOLD_MS);
  }

  function endPress(commit, x, y) {
    if (!press) return;
    clearTimeout(press.timer);
    const wasPressed = press;
    press = null;
    pop?.letGo();
    if (!commit) {
      setActive(-1);
      return;
    }
    const i = itemAt(x, y);
    if (i >= 0 && (wasPressed.held || wasPressed.moved || wasPressed.tap)) choose(i);
    else if (i < 0) setActive(-1);
    else choose(i);
  }

  const onMove = (e) => {
    if (!press || e.pointerId !== press.id) {
      // Mouse hover highlights too.
      if (!press && e.pointerType === 'mouse' && pop && !pop.closed && pop.el.contains(e.target)) setActive(itemAt(e.clientX, e.clientY));
      return;
    }
    press.x = e.clientX;
    press.y = e.clientY;
    if (Math.hypot(e.clientX - (press.sx ?? press.x), e.clientY - (press.sy ?? press.y)) > 6 || press.held) press.moved = true;
    if (press.held || press.moved) {
      clearTimeout(press.timer);
      press.held = true;
      setActive(itemAt(e.clientX, e.clientY));
      // Past the sides of the glass: it stretches after the finger.
      const o2 = overshoot(pop.el.getBoundingClientRect(), e.clientX, e.clientY);
      if (o2.x || o2.y) pop.pull(o2.x * 0.7, o2.y * 0.7);
      else pop.letGo();
    }
  };
  const onUp = (e) => {
    if (press && e.pointerId === press.id) endPress(e.type === 'pointerup', e.clientX, e.clientY);
  };

  function wire(built) {
    const node = built.el;
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.target.closest('.sf-menu-item, .sf-menu-quick-item')) return;
      startPress(e.pointerId, e.clientX, e.clientY, false);
      press.sx = e.clientX;
      press.sy = e.clientY;
      press.tap = true;
      // A short press shows the highlight at once on a mouse; a finger waits to see whether it is a scroll.
      if (e.pointerType === 'mouse') setActive(itemAt(e.clientX, e.clientY));
    });
    node.addEventListener('pointerleave', (e) => {
      if (!press && e.pointerType === 'mouse') setActive(-1);
    });
    // Keyboard activation of a focused item arrives as a click without a pointer.
    node.addEventListener('click', (e) => {
      if (e.detail !== 0) return;
      const i = items.findIndex((it) => it.node === e.target.closest('button'));
      if (i >= 0) choose(i);
    });
  }

  const onKey = (e) => {
    if (!pop || pop.closed) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (n) setActive(active < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      items[active]?.node.scrollIntoView({block: 'nearest'});
    } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
    } else if (e.key === 'ArrowLeft' && history.length) {
      e.preventDefault();
      navigate(history.pop());
    }
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('keydown', onKey, true);
  const blockScroll = (e) => {
    if (press?.held) e.preventDefault();
  };
  window.addEventListener('touchmove', blockScroll, {passive: false, capture: true});

  const built = build(o.items, current);
  rootMenu = built;
  items = built.entries;
  const menuEl = built.el;

  let place = o.placement;
  if (o.preview) place = 'below';
  pop = presentPopover({
    source: o.source,
    content: menuEl,
    width: o.width ?? (o.preview ? 270 : 248),
    placement: place ?? 'auto',
    align: o.align,
    radius: 26,
    className: 'sf-menu-pop',
    group: 'menu',
    onClose: () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('touchmove', blockScroll, {capture: true});
      cancelAnimationFrame(hlRaf);
      if (dim) {
        dim.animate([{opacity: 1}, {opacity: 0}], {duration: 220, fill: 'both'}).onfinish = () => dim.remove();
        if (previewCard) previewCard.animate([{opacity: 1}, {opacity: 0}], {duration: 160, fill: 'both'}).onfinish = () => previewCard.remove();
      }
      o.onClose?.();
    },
  });
  wire(built);

  if (previewCard) {
    // Held item: the preview card sits above the menu, growing out of the item.
    const r = pop.el.getBoundingClientRect();
    previewCard.style.width = `${Math.min(innerWidth - 24, o.width ?? 270)}px`;
    document.body.append(previewCard);
    const h = previewCard.getBoundingClientRect().height;
    previewCard.style.left = `${r.left}px`;
    previewCard.style.top = `${Math.max(12, r.top - 10 - h)}px`;
    const s = o.source instanceof Element ? o.source.getBoundingClientRect() : o.source;
    previewCard.animate(
      [
        {opacity: 0, transform: `translate(${s.left - r.left}px, ${s.top - r.top + h}px) scale(0.92)`},
        {opacity: 1, transform: 'none'},
      ],
      {duration: 380, easing: 'cubic-bezier(0.22, 1.18, 0.36, 1)', fill: 'backwards'},
    );
  }

  // A long press that opened the menu can slide straight onto an item.
  if (o.pointer) {
    startPress(o.pointer.id, o.pointer.x, o.pointer.y, true);
    press.sx = o.pointer.x;
    press.sy = o.pointer.y;
  }

  return {close: () => pop.close(), popover: pop};
}

/**
 * Long press (a finger held still) and right-click on `element` call
 * `open(target, {pointer})`; the pointer lets the menu take over the
 * finger. A long press also swallows the click that follows.
 */
export function onHold(element, open, {delay = 450, filter} = {}) {
  let timer = 0;
  let start = null;
  let fired = false;
  element.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || (filter && !filter(e))) return;
    fired = false;
    start = {x: e.clientX, y: e.clientY, id: e.pointerId, target: e.target};
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      navigator.vibrate?.(8);
      open(start.target, {pointer: {id: start.id, x: start.x, y: start.y}});
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
    open(e.target, {pointer: null, x: e.clientX, y: e.clientY});
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
