/**
 * What a message bubble does when you touch it, as in Messages:
 *
 * - hold it (or right-click): the bubble lifts out of a blurred, dimmed
 *   conversation with the reactions row above it and the menu below it
 *   (Reply, Add Reaction, Speak Response | Copy, Select). Keep the finger
 *   down and slide onto an item to choose it;
 * - double-tap it (or double-click): just the reactions row;
 * - Add Reaction (or the smiley at the end of the row) opens every emoji,
 *   drawn by the system's own emoji font;
 * - Select puts the text under the finger into a native selection, with
 *   its two handles, instead of selecting the whole message.
 */

import { springAnimate } from './springs.js';
import { QUICK, CATEGORIES, lastEmoji } from './emoji.js';
import { speak, stopSpeaking, speaking } from './speech.js';
import { toast } from './dialogs.js';

const HOLD_MS = 420;
const DOUBLE_TAP_MS = 320;

const ICONS = {
  reply: '<path d="M9.5 6.5 4 12l5.5 5.5"/><path d="M4.5 12H14a6 6 0 0 1 6 6v.5"/>',
  react: '<circle cx="12" cy="12" r="8.25"/><path d="M8.6 14.2c.8 1.3 2 2 3.4 2s2.6-.7 3.4-2"/><circle cx="9.3" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="14.7" cy="10" r=".9" fill="currentColor" stroke="none"/>',
  speak: '<path d="M4 9.5h3l4.5-4v13l-4.5-4H4z"/><path d="M15 9a4 4 0 0 1 0 6"/><path d="M17.6 6.5a7.5 7.5 0 0 1 0 11"/>',
  stop: '<circle cx="12" cy="12" r="8.25"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8" y="8" width="11.5" height="12.5" rx="2.5"/><path d="M15.5 8V6a2.5 2.5 0 0 0-2.5-2.5H7A2.5 2.5 0 0 0 4.5 6v8.5A2.5 2.5 0 0 0 7 17h1"/>',
  select: '<path d="M8 4h2m4 0h2M12 4v16M8 20h2m4 0h2"/><path d="M4.5 9v6M19.5 9v6"/>',
  more: '<circle cx="12" cy="12" r="8.25"/><path d="M12 8.5v7M8.5 12h7"/>',
};

function svg(name, size = 20) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const safe = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // not a secure context, or blocked: the old way
  }
  const area = el('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

/** Selects the word at (x, y) inside `bubble` (or its first word), so the OS shows its selection handles. */
function selectWordAt(bubble, x, y) {
  bubble.classList.add('selectable');
  const sel = getSelection();
  let range = null;
  const pos = document.caretPositionFromPoint?.(x, y);
  if (pos && bubble.contains(pos.offsetNode)) {
    range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
  } else {
    const r = document.caretRangeFromPoint?.(x, y);
    if (r && bubble.contains(r.startContainer)) range = r;
  }
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) {
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.reaction') || !n.data.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const first = walker.nextNode();
    if (!first) return;
    range = document.createRange();
    range.setStart(first, first.data.search(/\S/));
  }
  const node = range.startContainer;
  const text = node.data;
  let a = range.startOffset;
  let b = a;
  const word = /[\p{L}\p{N}_'’-]/u;
  while (a > 0 && word.test(text[a - 1])) a--;
  while (b < text.length && word.test(text[b])) b++;
  if (a === b) b = Math.min(text.length, a + 1);
  range.setStart(node, a);
  range.setEnd(node, b);
  sel.removeAllRanges();
  sel.addRange(range);
  // Selection mode ends when the selection leaves the bubble.
  const done = () => {
    const s = getSelection();
    if (s.rangeCount && !s.isCollapsed && bubble.contains(s.anchorNode)) return;
    bubble.classList.remove('selectable');
    document.removeEventListener('selectionchange', done);
  };
  setTimeout(() => document.addEventListener('selectionchange', done), 0);
}

/**
 * Wires bubbles under `root`.
 * @param {HTMLElement} root  a list of `.msg[data-key]` rows
 * @param {{
 *   message: (row: HTMLElement) => ({id: string, text: string, side: 'in'|'out'} | null),
 *   reaction: (id: string) => string | undefined,
 *   onReply: (msg: {id: string}) => void,
 *   onReact: (msg: {id: string}, emoji: string | null) => void,
 * }} o
 */
export function installBubbleMenus(root, o) {
  let press = null; // {id, x, y, row, bubble, timer, pressTimer, fired}
  let lastTap = null; // {time, x, y, bubble}

  const target = (e) => {
    const bubble = e.target.closest?.('.bubble');
    const row = bubble?.closest('.msg[data-key]');
    if (!row || !root.contains(row) || e.target.closest('a, button, input, .reaction')) return null;
    if (bubble.classList.contains('selectable')) return null;
    const msg = o.message(row);
    return msg ? { row, bubble, msg } : null;
  };

  const cancel = () => {
    if (!press) return;
    clearTimeout(press.timer);
    clearTimeout(press.pressTimer);
    if (!press.fired) press.bubble.classList.remove('bm-pressing');
    press = null;
  };

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || current) return;
    const t = target(e);
    if (!t) return;
    cancel();
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, ...t, fired: false, type: e.pointerType };
    if (e.pointerType === 'mouse') return; // a mouse holds with the right button
    // The bubble sinks a little while it is held, then pops into the menu.
    press.pressTimer = setTimeout(() => press?.bubble.classList.add('bm-pressing'), 90);
    press.timer = setTimeout(() => {
      if (!press) return;
      press.fired = true;
      navigator.vibrate?.(8);
      present(press, 'menu', { id: press.id, x: press.x, y: press.y });
    }, HOLD_MS);
  });
  root.addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.id && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancel();
  });
  root.addEventListener('pointercancel', (e) => press?.id === e.pointerId && !press.fired && cancel());
  root.addEventListener('pointerup', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    if (p.fired) {
      press = null;
      return;
    }
    cancel();
    if (p.type === 'mouse') return; // dblclick handles the mouse
    const now = performance.now();
    if (lastTap && lastTap.bubble === p.bubble && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
      lastTap = null;
      e.preventDefault();
      present(p, 'react');
    } else lastTap = { time: now, x: e.clientX, y: e.clientY, bubble: p.bubble };
  });
  root.addEventListener('dblclick', (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    getSelection()?.removeAllRanges();
    present({ ...t, x: e.clientX, y: e.clientY }, 'react');
  });
  root.addEventListener('contextmenu', (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    // A long press already opened the menu (Android sends contextmenu too).
    if (current || press?.fired) return;
    cancel();
    present({ ...t, x: e.clientX, y: e.clientY }, 'menu');
  });
  // Keyboard: the context-menu key or Shift+F10 on a focused bubble.
  root.addEventListener('keydown', (e) => {
    if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    const r = t.bubble.getBoundingClientRect();
    present({ ...t, x: r.left + 10, y: r.top + 10 }, 'menu');
  });

  // -------------------------------------------------------------- the layer

  function present(p, mode, pointer = null) {
    if (current) return;
    const { bubble, msg } = p;
    // Measured without the held bubble's shrink.
    bubble.style.transition = 'none';
    bubble.classList.remove('bm-pressing');
    const origin = bubble.getBoundingClientRect();
    bubble.style.transition = '';
    const side = msg.side;
    const layer = el('div', `bm-layer ${side}`);
    layer.dataset.sfNopaint = '';
    const dim = el('div', `bm-dim${mode === 'react' ? ' light' : ''}`);

    // The lifted bubble: a copy, where the real one was.
    const lift = el('div', `bm-lift msg ${side}`);
    const copy = bubble.cloneNode(true);
    copy.classList.remove('bm-pressing', 'selectable');
    // A hair wider than measured, so the copy's text wraps exactly as the bubble's did.
    copy.style.width = `${Math.ceil(origin.width) + 1}px`;
    copy.style.maxWidth = 'none';
    lift.append(copy);

    // The reactions row.
    const current_ = o.reaction(msg.id);
    const pill = el('div', 'bm-pill');
    pill.setAttribute('role', 'toolbar');
    pill.setAttribute('aria-label', 'Reactions');
    for (const emoji of QUICK) {
      const b = el('button', `bm-emoji${current_ === emoji ? ' chosen' : ''}`, emoji);
      b.type = 'button';
      b.dataset.emoji = emoji;
      b.setAttribute('aria-label', `React with ${emoji}`);
      pill.append(b);
    }
    if (current_ && !QUICK.includes(current_)) {
      const b = el('button', 'bm-emoji chosen', current_);
      b.type = 'button';
      b.dataset.emoji = current_;
      pill.append(b);
    }
    const more = el('button', 'bm-emoji bm-more');
    more.type = 'button';
    more.innerHTML = svg('more', 22);
    more.setAttribute('aria-label', 'More reactions');
    pill.append(more);

    // The menu.
    let menu = null;
    if (mode === 'menu') {
      menu = el('div', 'bm-menu');
      menu.setAttribute('role', 'menu');
      const item = (label, icon, run) => {
        const b = el('button', 'bm-item');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.innerHTML = svg(icon);
        b.append(el('span', '', label));
        b._run = run;
        menu.append(b);
      };
      item('Reply', 'reply', () => close().then(() => o.onReply(msg)));
      item('Add Reaction', 'react', () => openPicker());
      if (side === 'in') {
        if (speaking()) item('Stop Speaking', 'stop', () => (stopSpeaking(), close()));
        else
          item('Speak Response', 'speak', () => {
            close();
            speak(msg.text).catch((error) => toast(`Could not read it aloud: ${error.message}`, { symbol: 'exclamationmark.triangle', timeout: 5000 }));
          });
      }
      menu.append(el('div', 'bm-sep'));
      item('Copy', 'copy', () => {
        close();
        copyText(msg.text).then(() => toast('Copied', { symbol: 'doc.on.doc', timeout: 1400 }));
      });
      item('Select', 'select', () => close().then(() => selectWordAt(bubble, p.x ?? origin.left + 12, p.y ?? origin.top + 12)));
    }

    layer.append(dim, lift, pill);
    if (menu) layer.append(menu);
    document.body.append(layer);
    bubble.classList.add('bm-hidden');

    // ------------------------------------------------------------ layout

    const margin = 12;
    let geometry = null;
    function layout(panel) {
      const vw = innerWidth;
      const vh = visualViewport?.height ?? innerHeight;
      const top = safe('--safe-top') + margin;
      const bottom = vh - safe('--safe-bottom') - margin;
      const pillH = pill.offsetHeight;
      const panelH = panel ? panel.offsetHeight : 0;
      const room = bottom - top - pillH - 8 - (panel ? panelH + 10 : 0);
      const scale = Math.max(0.35, Math.min(1, room / origin.height));
      const h = origin.height * scale;
      const w = origin.width * scale;
      const now = bubble.getBoundingClientRect();
      const minTop = top + pillH + 8;
      const maxTop = bottom - (panel ? panelH + 10 : 0) - h;
      const y = Math.min(Math.max(now.top, minTop), Math.max(minTop, maxTop));
      const x = side === 'out' ? now.right - w : now.left;
      const align = (width) => (side === 'out' ? Math.max(margin, Math.min(now.right, vw - margin) - width) : Math.min(Math.max(margin, now.left), vw - margin - width));
      geometry = { x, y, w, h, scale, pillX: align(pill.offsetWidth), pillY: y - 8 - pillH, panelX: panel ? align(panel.offsetWidth) : 0, panelY: y + h + 10 };
      lift.style.left = `${now.left}px`;
      lift.style.top = `${now.top}px`;
      lift.style.width = `${now.width}px`;
      lift.style.transform = `translate(${x - now.left}px, ${y - now.top}px) scale(${scale})`;
      pill.style.left = `${geometry.pillX}px`;
      pill.style.top = `${geometry.pillY}px`;
      if (panel) {
        panel.style.left = `${geometry.panelX}px`;
        panel.style.top = `${geometry.panelY}px`;
      }
      return geometry;
    }

    const g = layout(menu);
    const corner = side === 'out' ? 'right' : 'left';
    dim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out', fill: 'both' });
    springAnimate(lift, [{ transform: `translate(0, 0) scale(${p.fired ? 0.96 : 1})` }, { transform: lift.style.transform }], { response: 0.42, bounce: 0.28 });
    pill.style.transformOrigin = `${corner} bottom`;
    springAnimate(pill, [{ transform: 'scale(0.35)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { response: 0.38, bounce: 0.3 });
    [...pill.children].forEach((b, i) => springAnimate(b, [{ transform: 'scale(0.2)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { response: 0.36, bounce: 0.4, delay: 40 + i * 22, fill: 'backwards' }));
    if (menu) {
      menu.style.transformOrigin = `${corner} top`;
      springAnimate(menu, [{ transform: 'scale(0.25)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { response: 0.4, bounce: 0.22 });
    }
    void g;

    // ------------------------------------------------------------ choosing

    let picker = null;
    function openPicker() {
      if (picker) return;
      picker = el('div', 'bm-picker');
      const field = el('input', 'bm-picker-field');
      field.type = 'text';
      field.placeholder = 'Type or paste any emoji';
      field.setAttribute('aria-label', 'Any emoji');
      field.setAttribute('inputmode', 'text');
      field.addEventListener('input', () => {
        const e = lastEmoji(field.value);
        if (e) react(e, field);
      });
      const scroll = el('div', 'bm-picker-scroll');
      for (const c of CATEGORIES) {
        scroll.append(el('div', 'bm-picker-head', c.name));
        const grid = el('div', 'bm-picker-grid');
        for (const emoji of c.list) {
          const b = el('button', 'bm-emoji', emoji);
          b.type = 'button';
          b.dataset.emoji = emoji;
          grid.append(b);
        }
        scroll.append(grid);
      }
      picker.append(field, scroll);
      layer.append(picker);
      const old = menu;
      menu = picker;
      if (old) old.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.9)' }], { duration: 160, fill: 'both' }).onfinish = () => old.remove();
      const before = lift.style.transform;
      layout(picker);
      springAnimate(lift, [{ transform: before }, { transform: lift.style.transform }], { response: 0.4, bounce: 0.15 });
      picker.style.transformOrigin = `${corner} top`;
      springAnimate(picker, [{ transform: 'scale(0.3)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { response: 0.42, bounce: 0.18 });
      if (matchMedia('(pointer: fine)').matches) field.focus({ preventScroll: true });
    }

    function react(emoji, from) {
      const chosen = o.reaction(msg.id) === emoji ? null : emoji;
      // The emoji flies to the bubble's corner, where its badge appears.
      if (chosen && from) {
        const a = from.getBoundingClientRect();
        const b = copy.getBoundingClientRect();
        const fly = el('div', 'bm-fly', chosen);
        document.body.append(fly);
        const tx = (side === 'out' ? b.left - 8 : b.right - 22) - a.left;
        const ty = b.top - 22 - a.top;
        fly.style.left = `${a.left}px`;
        fly.style.top = `${a.top}px`;
        springAnimate(fly, [{ transform: 'translate(0, 0) scale(1)' }, { transform: `translate(${tx}px, ${ty}px) scale(0.6)` }], { response: 0.34, bounce: 0.1, fill: 'forwards' }).finished.then(() => fly.remove(), () => fly.remove());
      }
      o.onReact(msg, chosen);
      setTimeout(() => close(), chosen ? 220 : 0);
    }

    // Taps, and a held finger sliding onto an item.
    let hot = null;
    const hit = (x, y) => document.elementFromPoint(x, y)?.closest?.('.bm-item, .bm-emoji');
    const highlight = (node) => {
      if (node === hot) return;
      hot?.classList.remove('hot');
      hot = node && layer.contains(node) ? node : null;
      hot?.classList.add('hot');
      if (hot && pointer) navigator.vibrate?.(4);
    };
    const choose = (node) => {
      if (!node || closing) return;
      if (node.classList.contains('bm-more')) return openPicker();
      if (node.dataset.emoji) return react(node.dataset.emoji, node);
      node._run?.();
    };
    const onMove = (e) => {
      if (!pointer || e.pointerId !== pointer.id) return;
      // Only a finger that slides chooses: the menu may open right under one that stays still.
      if (!pointer.moved && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 10) return;
      pointer.moved = true;
      highlight(hit(e.clientX, e.clientY));
    };
    const onUp = (e) => {
      if (pointer && e.pointerId === pointer.id) {
        // The finger that opened the menu: lifting on an item it slid to chooses it; otherwise the menu stays.
        const slid = pointer.moved;
        pointer = null;
        const node = slid ? hit(e.clientX, e.clientY) : null;
        highlight(null);
        if (node && layer.contains(node)) choose(node);
        // Some browsers follow a long press with a click where the finger lifted: not a tap outside.
        else ignoreClick = { x: e.clientX, y: e.clientY, until: performance.now() + 600 };
      }
    };
    const blockScroll = (e) => {
      if (pointer) e.preventDefault();
    };
    // The tap (or double-tap) that opened it also clicks, now on the layer: that is not a tap outside.
    let ignoreClick = p.x !== undefined && !pointer ? { x: p.x, y: p.y, until: performance.now() + 600 } : null;
    layer.addEventListener('click', (e) => {
      const echo = ignoreClick && performance.now() < ignoreClick.until && Math.hypot(e.clientX - ignoreClick.x, e.clientY - ignoreClick.y) < 12;
      ignoreClick = null;
      if (echo) return;
      const node = e.target.closest('.bm-item, .bm-emoji');
      if (node) choose(node);
      else if (!e.target.closest('.bm-picker, .bm-menu, .bm-pill')) close();
    });
    layer.addEventListener('pointerover', (e) => e.pointerType === 'mouse' && highlight(e.target.closest('.bm-item, .bm-emoji')));
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('touchmove', blockScroll, { passive: false, capture: true });
    window.addEventListener('keydown', onKey, true);
    const onResize = () => !closing && layout(menu);
    window.addEventListener('resize', onResize);

    // ------------------------------------------------------------ closing

    let closing = null;
    function close() {
      if (closing) return closing;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('touchmove', blockScroll, { capture: true });
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      layer.classList.add('closing');
      // Back to where the bubble is now (a new message may have moved it).
      const now = bubble.getBoundingClientRect();
      const home = `translate(${now.left - parseFloat(lift.style.left)}px, ${now.top - parseFloat(lift.style.top)}px) scale(1)`;
      const from = getComputedStyle(lift).transform;
      lift.style.transform = home;
      const back = springAnimate(lift, [{ transform: from }, { transform: home }], { response: 0.36, bounce: 0.12, fill: 'forwards' });
      dim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-in', fill: 'both' });
      for (const node of [pill, menu].filter(Boolean)) node.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 170, easing: 'ease-in', fill: 'both' });
      closing = back.finished
        .catch(() => {})
        .then(() => {
          bubble.classList.remove('bm-hidden');
          layer.remove();
          if (current?.layer === layer) current = null;
        });
      return closing;
    }

    current = { layer, close };
    return current;
  }
}

let current = null;

/** Closes an open bubble menu, if any. */
export function closeBubbleMenu() {
  return current?.close();
}
