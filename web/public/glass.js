/**
 * sfgl glass for the bottom bar and the sheet.
 *
 * sfgl refracts a backdrop texture, not live DOM, so the chat behind the
 * glass is repainted into a 2D canvas (bubbles, their text, small system
 * lines and images) and handed to sfgl as an image backdrop. Bubble layout
 * is measured once in content coordinates and cached; scrolling only
 * repaints with a new offset. When the sheet turns opaque, its fill is
 * painted into the backdrop under the sheet, so the glass reads as a solid
 * sheet while keeping its rim.
 */

import { createGlass, imageBackdrop } from './vendor/sfgl/src/index.js';

const SHEET_RGB = [26, 25, 28];

export function setupGlass({ stage, chat, thread, quality }) {
  const glass = createGlass({ quality: quality || 'auto' });
  const surface = glass.surface({ host: stage, z: 3 });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let revision = 0;
  let scale = 1;
  let cache = null; // { width, placed: [...] } in content coordinates
  let sheet = null; // { left, top, width, height, radius, opaque }
  let pending = false;

  glass.setBackdrop(imageBackdrop(canvas, { fit: 'stretch', key: () => String(revision) }));

  function invalidateLayout() {
    cache = null;
    schedule();
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      paint();
    });
  }

  /** Per element: paint items relative to the element's own top-left, reused while its signature and size are unchanged. */
  const elementCache = new WeakMap();
  const range = document.createRange();

  function wordsOf(el, ox, oy) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const style = getComputedStyle(node.parentElement);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text))) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const r = rects[0];
        out.push({ t: m[0], x: r.left - ox, y: r.top - oy + r.height / 2, font, color: style.color });
      }
    }
    return out;
  }

  function measureElement(el, r) {
    const ox = r.left;
    const oy = r.top;
    const items = [];
    const rel = (rect) => ({ x: rect.left - ox, y: rect.top - oy, w: rect.width, h: rect.height });
    if (el.classList.contains('msg')) {
      const side = el.classList.contains('out') ? 'out' : 'in';
      for (const child of el.children) {
        if (child.classList.contains('bubble') || child.classList.contains('typing')) {
          const style = getComputedStyle(child);
          items.push({
            kind: 'bubble',
            ...rel(child.getBoundingClientRect()),
            color: style.backgroundColor,
            tail: child.classList.contains('tail') ? side : null,
            radius: parseFloat(style.borderTopLeftRadius) || 20,
            blocks: [...child.querySelectorAll('pre')].map((pre) => rel(pre.getBoundingClientRect())),
            words: wordsOf(child, ox, oy),
          });
        } else if (child.classList.contains('media')) {
          for (const img of child.querySelectorAll('img')) items.push({ kind: 'image', img, ...rel(img.getBoundingClientRect()) });
          for (const chip of child.querySelectorAll('.file-chip')) {
            items.push({ kind: 'bubble', ...rel(chip.getBoundingClientRect()), color: getComputedStyle(chip).backgroundColor, radius: 18, blocks: [], words: wordsOf(chip, ox, oy) });
          }
        }
      }
    } else if (el.classList.contains('approval')) {
      items.push({ kind: 'bubble', x: 0, y: 0, w: r.width, h: r.height, color: '#1c1c1e', radius: 20, blocks: [], words: wordsOf(el, ox, oy) });
    } else {
      items.push({ kind: 'text', x: 0, y: 0, w: r.width, h: r.height, words: wordsOf(el, ox, oy) });
    }
    return items;
  }

  /** Positions of every thread element relative to the scroll content; text is measured only when an element changed. */
  function measure() {
    const chatRect = chat.getBoundingClientRect();
    const originTop = chatRect.top - chat.scrollTop;
    const originLeft = chatRect.left;
    const placed = [];
    for (const el of thread.children) {
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const key = `${el.dataset.sig || el.textContent.length}|${Math.round(r.width)}x${Math.round(r.height)}`;
      let entry = elementCache.get(el);
      if (!entry || entry.key !== key) {
        entry = { key, items: measureElement(el, r) };
        elementCache.set(el, entry);
      }
      placed.push({ x: r.left - originLeft, y: r.top - originTop, h: r.height, items: entry.items });
    }
    return { width: chat.clientWidth, placed };
  }

  function bubblePath(c, x, y, w, h, r, tail) {
    r = Math.min(r, h / 2, w / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
    c.closePath();
    if (tail) {
      // Filled separately: mirrored tails wind the other way.
      c.fill();
      c.beginPath();
      // The same tail outline as the CSS mask, in a 24×24 box at the bottom corner.
      const s = tail === 'out' ? 1 : -1;
      const ox = tail === 'out' ? x + w - 24 : x + 24;
      const oy = y + h - 16;
      const P = (px, py) => [ox + s * px, oy + py];
      c.moveTo(...P(24, 0));
      c.bezierCurveTo(...P(24, 8), ...P(13.67, 10), ...P(13.67, 16.5));
      c.bezierCurveTo(...P(13.67, 19), ...P(14.7, 21.6), ...P(15.7, 22.7));
      c.quadraticCurveTo(...P(15.4, 23.2), ...P(13.8, 22.4));
      c.bezierCurveTo(...P(11, 20.9), ...P(6.5, 18.2), ...P(3, 16));
      c.lineTo(...P(0, 16));
      c.lineTo(...P(0, 0));
      c.closePath();
    }
  }

  function paint() {
    const W = innerWidth;
    const H = innerHeight;
    scale = Math.min(1, 1024 / Math.max(W, H, 1));
    const cw = Math.max(1, Math.round(W * scale));
    const ch = Math.max(1, Math.round(H * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    if (!cache || cache.width !== chat.clientWidth) cache = measure();
    const chatRect = chat.getBoundingClientRect();
    const dy = chatRect.top - chat.scrollTop;
    const dx = chatRect.left;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.textBaseline = 'middle';
    for (const p of cache.placed) {
      const ox = p.x + dx;
      const oy = p.y + dy;
      if (oy > H + 40 || oy + p.h < -40) continue;
      for (const it of p.items) {
        const top = oy + it.y;
        if (it.kind === 'bubble') {
          ctx.fillStyle = it.color;
          bubblePath(ctx, ox + it.x, top, it.w, it.h, it.radius, it.tail);
          ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.32)';
          for (const b of it.blocks) {
            bubblePath(ctx, ox + b.x, oy + b.y, b.w, b.h, 12, null);
            ctx.fill();
          }
        } else if (it.kind === 'image' && it.img.complete && it.img.naturalWidth) {
          ctx.save();
          bubblePath(ctx, ox + it.x, top, it.w, it.h, 18, null);
          ctx.clip();
          try {
            ctx.drawImage(it.img, ox + it.x, top, it.w, it.h);
          } catch {
            // undecodable image
          }
          ctx.restore();
        }
        for (const w of it.words || []) {
          const wy = oy + w.y;
          if (wy < -20 || wy > H + 20) continue;
          ctx.font = w.font;
          ctx.fillStyle = w.color;
          ctx.fillText(w.t, ox + w.x, wy);
        }
      }
    }
    if (sheet && sheet.opaque > 0) {
      ctx.fillStyle = `rgba(${SHEET_RGB[0]},${SHEET_RGB[1]},${SHEET_RGB[2]},${sheet.opaque})`;
      const pad = 40;
      bubblePath(ctx, sheet.left - pad, sheet.top - pad, sheet.width + pad * 2, sheet.height + pad * 2, sheet.radius + pad, null);
      ctx.fill();
    }
    revision++;
    glass.requestRender();
  }

  chat.addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', invalidateLayout);
  new ResizeObserver(invalidateLayout).observe(thread);
  new MutationObserver(invalidateLayout).observe(thread, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'src'] });
  thread.addEventListener('load', invalidateLayout, true);
  if (document.fonts) document.fonts.addEventListener('loadingdone', invalidateLayout);
  schedule();

  return {
    glass,
    surface,
    /** Tells the backdrop where the sheet is and how opaque it should look. */
    setSheet(next) {
      const was = sheet;
      sheet = next;
      if ((next && next.opaque > 0) || (was && was.opaque > 0)) schedule();
      glass.requestRender();
    },
    repaint: invalidateLayout,
    tier: () => glass.tier().name,
  };
}
