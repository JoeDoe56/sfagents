/**
 * sfgl glass for the file manager's chrome: the close and ⋯ buttons, the
 * stats chips, the drive bars and the selection toolbar float over the list
 * as Liquid Glass.
 *
 * As in glass.js, sfgl refracts a backdrop texture rather than live DOM, so
 * the parts of the sheet that sit under the chrome (a band along the top and
 * one along the bottom) are repainted into a 2D canvas: the sheet's fill,
 * the grouped backgrounds, icons and thumbnails, SF Symbols and text. Each
 * element's paint is measured once relative to itself and cached; scrolling
 * only moves it. Rows are found by binary search, so a folder with
 * thousands of items paints as quickly as a short one.
 */

import {createGlass} from '../glass.js';
import {imageBackdrop} from '../backdrop.js';
import {registerGlass} from './core.js';
import {materials} from './materials.js';

/** Elements painted as one unit (their subtree measured together). */
const UNITS = '.sf-row, .sf-field, .sf-section-title, .sf-section-note, .sf-status, .sf-chip, .sf-title';
const reach = 64;

function rgbOf(color) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const n = /rgba?\(([^)]+)\)/.exec(color);
  return n ? n[1].split(',').slice(0, 3).map((v) => Number(v.trim())) : [28, 28, 30];
}

function transparent(color) {
  return !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color);
}

export function createDomGlass({ host, scroller, quality, units = UNITS, background: bg = '#1c1c1e', edges = () => [], skip = (n) => n.hasAttribute('data-sf-nopaint') }) {
  const glass = createGlass({ quality: quality || 'auto' });
  const surface = glass.surface({ host, z: 3 });
  const unregister = registerGlass(glass);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let revision = 0;
  let dirty = true;
  let painted = null;
  let bands = [];
  let background = bg;

  glass.setBackdrop(
    imageBackdrop(canvas, {
      fit: 'stretch',
      key: () => String(revision),
      scrollLinked: true,
      update: () => {
        if (needsPaint()) paint();
      },
    }),
  );

  // ---------------------------------------------------------------- symbols (tinted masks)

  const symbolImages = new Map(); // url → Image
  const tinted = new Map(); // `${url}|${color}` → canvas
  function symbolCanvas(url, color) {
    const key = `${url}|${color}`;
    if (tinted.has(key)) return tinted.get(key);
    let img = symbolImages.get(url);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = url;
      img.addEventListener('load', () => schedule(), { once: true });
      symbolImages.set(url, img);
    }
    if (!img.complete || !img.naturalWidth) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    tinted.set(key, c);
    return c;
  }

  // ---------------------------------------------------------------- measuring

  const cache = new WeakMap();
  const range = document.createRange();

  function measureUnit(unit, r) {
    const ops = [];
    const ox = r.left;
    const oy = r.top;
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (!text || !text.trim()) return;
        const style = getComputedStyle(node.parentElement);
        if (style.visibility === 'hidden') return;
        const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const re = /\S+/g;
        let m;
        while ((m = re.exec(text))) {
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const rects = range.getClientRects();
          if (!rects.length) continue;
          const rr = rects[0];
          ops.push({ k: 't', t: m[0], x: rr.left - ox, y: rr.top - oy + rr.height / 2, font, color: style.color });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.hidden) return;
      const er = node.getBoundingClientRect();
      if (!er.width || !er.height) return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const box = { x: er.left - ox, y: er.top - oy, w: er.width, h: er.height };
      if (node.classList.contains('sf-symbol')) {
        const mask = style.webkitMaskImage || style.maskImage;
        const url = /url\("?([^")]+)"?\)/.exec(mask || '')?.[1];
        if (url) ops.push({ k: 's', url, color: style.backgroundColor, ...box });
        return;
      }
      if (!transparent(style.backgroundColor)) ops.push({ k: 'r', color: style.backgroundColor, radius: parseFloat(style.borderTopLeftRadius) || 0, ...box });
      if (node.tagName === 'IMG') {
        ops.push({ k: 'i', img: node, radius: parseFloat(style.borderTopLeftRadius) || 0, ...box });
        return;
      }
      if (node.tagName === 'INPUT') {
        const text = node.value || node.placeholder;
        if (text) ops.push({ k: 't', t: text, x: box.x + (parseFloat(style.paddingLeft) || 0), y: box.y + box.h / 2, font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, color: node.value ? style.color : 'rgba(235,235,245,0.3)' });
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    const style = getComputedStyle(unit);
    if (!transparent(style.backgroundColor)) ops.push({ k: 'r', color: style.backgroundColor, radius: parseFloat(style.borderTopLeftRadius) || 0, x: 0, y: 0, w: r.width, h: r.height });
    if (unit.tagName === 'IMG' || unit.tagName === 'VIDEO') ops.push({ k: 'i', img: unit, radius: parseFloat(style.borderTopLeftRadius) || 0, x: 0, y: 0, w: r.width, h: r.height });
    else for (const child of unit.childNodes) walk(child);
    return ops;
  }

  function opsFor(unit, r) {
    const key = `${unit.className}|${unit.textContent.length}|${Math.round(r.width)}x${Math.round(r.height)}|${unit.querySelector('input')?.value ?? ''}`;
    let entry = cache.get(unit);
    if (!entry || entry.key !== key) {
      entry = { key, ops: measureUnit(unit, r) };
      cache.set(unit, entry);
    }
    return entry.ops;
  }

  /** Children of `parent` whose boxes cross [top, bottom]: binary search when they are many (rows in order). */
  function childrenIn(parent, top, bottom) {
    const kids = parent.children;
    const n = kids.length;
    if (n < 40) return [...kids];
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom < top) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < n; i++) {
      const r = kids[i].getBoundingClientRect();
      if (r.top > bottom) break;
      out.push(kids[i]);
    }
    return out;
  }

  const ownText = (node) => {
    for (const c of node.childNodes) if (c.nodeType === Node.TEXT_NODE && c.nodeValue.trim()) return true;
    return false;
  };

  /** Every unit and grouped background crossing a band, with its rect. */
  function collect(top, bottom, out) {
    const visit = (node) => {
      for (const child of childrenIn(node, top, bottom)) {
        if (child.hidden || skip(child)) continue;
        const r = child.getBoundingClientRect();
        if (!r.height || r.bottom < top || r.top > bottom) continue;
        // A symbol is a mask over its background colour: draw the glyph, never the box.
        if (child.classList.contains('sf-symbol')) {
          const style = getComputedStyle(child);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const url = /url\("?([^")]+)"?\)/.exec(style.webkitMaskImage || style.maskImage || '')?.[1];
          if (url) out.push({ symbol: { url, color: style.backgroundColor }, r });
          continue;
        }
        if (child.matches(units) || ownText(child) || child.tagName === 'IMG' || child.tagName === 'VIDEO' || child.tagName === 'INPUT') {
          out.push({ unit: child, r });
          continue;
        }
        const bg = getComputedStyle(child).backgroundColor;
        if (!transparent(bg)) out.push({ bg, radius: parseFloat(getComputedStyle(child).borderTopLeftRadius) || 0, r });
        visit(child);
      }
    };
    visit(scroller);
  }

  // ---------------------------------------------------------------- painting

  function roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
  }

  function needsPaint() {
    if (dirty) return true;
    const o = surface.canvas.getBoundingClientRect();
    return !painted || scroller.scrollTop !== painted.scrollTop || scroller.scrollLeft !== painted.scrollLeft || o.top !== painted.top || o.left !== painted.left || innerWidth !== painted.w || innerHeight !== painted.h;
  }

  function paint() {
    const W = innerWidth;
    const H = innerHeight;
    const scale = Math.min(0.75, 1024 / Math.max(W, H, 1));
    const cw = Math.max(1, Math.round(W * scale));
    const ch = Math.max(1, Math.round(H * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const origin = surface.canvas.getBoundingClientRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(scale, 0, 0, scale, -origin.left * scale, -origin.top * scale);
    ctx.textBaseline = 'middle';
    for (const band of bands) {
      const top = band.top - reach;
      const bottom = band.bottom + reach;
      const items = [];
      collect(top, bottom, items);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, W, bottom - top);
      ctx.clip();
      for (const it of items) {
        if (it.symbol) {
          const c = symbolCanvas(it.symbol.url, it.symbol.color);
          if (c) {
            const k = Math.min(it.r.width / c.width, it.r.height / c.height);
            const w = c.width * k;
            const h = c.height * k;
            ctx.drawImage(c, it.r.left + (it.r.width - w) / 2, it.r.top + (it.r.height - h) / 2, w, h);
          }
          continue;
        }
        if (it.bg) {
          ctx.fillStyle = it.bg;
          roundRect(it.r.left, it.r.top, it.r.width, it.r.height, it.radius);
          ctx.fill();
          continue;
        }
        const { left: ox, top: oy } = it.r;
        for (const op of opsFor(it.unit, it.r)) {
          if (op.k === 'r') {
            ctx.fillStyle = op.color;
            roundRect(ox + op.x, oy + op.y, op.w, op.h, op.radius);
            ctx.fill();
          } else if (op.k === 'i') {
            if (op.img.tagName === 'VIDEO' ? op.img.readyState < 2 : !op.img.complete || !op.img.naturalWidth) continue;
            ctx.save();
            roundRect(ox + op.x, oy + op.y, op.w, op.h, op.radius);
            ctx.clip();
            try {
              ctx.drawImage(op.img, ox + op.x, oy + op.y, op.w, op.h);
            } catch {
              // undecodable
            }
            ctx.restore();
          } else if (op.k === 's') {
            const c = symbolCanvas(op.url, op.color);
            if (c) {
              // Masks are drawn "contain" in their box.
              const k = Math.min(op.w / c.width, op.h / c.height);
              const w = c.width * k;
              const h = c.height * k;
              ctx.drawImage(c, ox + op.x + (op.w - w) / 2, oy + op.y + (op.h - h) / 2, w, h);
            }
          } else {
            ctx.font = op.font;
            ctx.fillStyle = op.color;
            ctx.fillText(op.t, ox + op.x, oy + op.y);
          }
        }
      }
      ctx.restore();
    }
    // The page's scroll-edge effect (the fade under the chrome) is in the
    // backdrop too, so the glass shows what the eye sees around it rather
    // than crisp rows the fade hides.
    for (const e of edges()) {
      if (!(e.opacity > 0) || !(e.height > 0)) continue;
      const [r, g, b] = rgbOf(background);
      const top = e.from === 'top';
      const grad = ctx.createLinearGradient(0, top ? e.top : e.top + e.height, 0, top ? e.top + e.height : e.top);
      for (const [at, a] of e.stops ?? [[0, 1], [0.45, 0.86], [1, 0]]) grad.addColorStop(at, `rgba(${r},${g},${b},${a * e.opacity})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, e.top, W, e.height);
    }
    revision++;
    dirty = false;
    painted = { scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft, top: origin.top, left: origin.left, w: W, h: H };
  }

  function schedule() {
    dirty = true;
    glass.requestRender();
  }

  const mo = new MutationObserver(schedule);
  mo.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'src', 'hidden', 'style'] });
  scroller.addEventListener('load', schedule, true);
  scroller.addEventListener('input', schedule, true);
  addEventListener('resize', () => glass.invalidate(true));
  if (document.fonts) document.fonts.addEventListener('loadingdone', schedule);

  // Animations move the chrome: re-measure every frame while one runs.
  let follow = 0;
  function track(ms) {
    const until = performance.now() + ms;
    cancelAnimationFrame(follow);
    const step = () => {
      glass.invalidate();
      schedule();
      if (performance.now() < until) follow = requestAnimationFrame(step);
    };
    step();
  }

  return {
    glass,
    surface,
    lens: (el, kind = 'control', extra = {}) => surface.lens(el, { ...materials()[kind], ...extra }),
    group: (name, els, kind = 'control', extra = {}) => {
      surface.syncGroup(name, els, { ...materials()[kind], ...extra });
      glass.invalidate(true);
    },
    /** The rects (viewport px) of the chrome the backdrop must cover. */
    setBands(next) {
      bands = next;
      schedule();
    },
    setBackground(color) {
      background = color;
      schedule();
    },
    lensOf: (el) => surface.lenses.find((l) => l.el === el) ?? null,
    repaint: schedule,
    setEdges(fn) {
      edges = fn;
      schedule();
    },
    track,
    invalidate: () => glass.invalidate(true),
    destroy() {
      unregister();
      cancelAnimationFrame(follow);
      mo.disconnect();
      try {
        glass.destroy();
      } catch {
        // already gone
      }
    },
  };
}
