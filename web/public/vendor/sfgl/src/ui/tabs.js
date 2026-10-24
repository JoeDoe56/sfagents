/**
 * The tab control: Apple Music's tab bar and Calendar's segmented control.
 *
 * A glass track holds the items; a selection pill sits under the selected
 * one. Pressing the pill (or dragging from any item) lifts it: the track
 * brightens and swells, the pill becomes a lens that bends the labels
 * under it, with the colour fringes glass makes at its edge, and everything
 * under the lens shows in the selected colour. The pill follows the finger
 * with a little lag, stretches when it moves fast, and may be pulled past
 * the ends of the track against a rubber band. Let go and it springs to the
 * nearest item with a bounce. A tap does the same without a drag: the pill
 * lifts on its way and settles.
 *
 * `variant: 'segment'` is 48 pt high with text items; `variant: 'bar'` is
 * 61 pt with an icon over a label. Both can be used in any bar.
 * @module
 */

import {el, icon, pose, spring, reducedMotion, clamp, lerp, settings, scheme} from './core.js';
import {rubber} from './stretch.js';
import {createTextUnderlay} from '../underlay/text.js';
import {materials} from './materials.js';

const follow = spring(0.1, 0.92); // the pill under a finger
const travel = spring(0.46, 0.64); // on its way to an item: bounces
const liftSpring = spring(0.3, 0.74);
const WIDEN = 0.0004; // extra width per px/s of speed
const MAX_WIDEN = 0.32;

/**
 * @typedef {object} TabItem
 * @property {string} id
 * @property {string} [label]
 * @property {string} [symbol]
 * @property {string} [selectedSymbol]   a different glyph while selected (house → house.fill)
 * @property {string} [aria]
 * @property {boolean} [disabled]
 */

/**
 * @typedef {object} TabsOptions
 * @property {TabItem[]} items
 * @property {string} [selected]
 * @property {'segment'|'bar'} [variant]
 * @property {string} [tint]                the colour under the lens and on the selected item
 * @property {'fill'|'glass'} [thumb]       the resting pill: a flat fill (Calendar) or clear glass (Apple Music)
 * @property {boolean} [stretch]            stretches and bounces (default: the global setting)
 * @property {object} [lens]                overrides for the pill's glass (any lens option, value or function)
 * @property {(id: string, previous: string|null) => void} [onChange]
 */

/** @param {TabsOptions} o */
export function createTabs(o) {
  const variant = o.variant ?? 'segment';
  const thumbStyle = o.thumb ?? (variant === 'bar' ? 'glass' : 'fill');
  const root = el('div', `sf-tabs ${variant}`);
  root.setAttribute('role', 'tablist');
  root.dataset.glass = 'bar';
  const thumb = el('div', `sf-tabs-thumb${thumbStyle === 'glass' ? ' glass-thumb' : ''}`);
  thumb.dataset.glass = 'lens';
  thumb.setAttribute('aria-hidden', 'true');
  root.append(thumb);
  if (o.tint) root.style.setProperty('--sf-tab-tint', o.tint);

  /** @type {{item: TabItem, node: HTMLButtonElement, iconNode: HTMLElement|null}[]} */
  let tabs = [];
  let selected = o.selected ?? o.items[0]?.id ?? null;
  let tintColor = '#007aff';

  // ------------------------------------------------------------ building

  function build() {
    for (const t of tabs) t.node.remove();
    tabs = o.items.map((item) => {
      const node = el('button', 'sf-tab');
      node.type = 'button';
      node.setAttribute('role', 'tab');
      node.dataset.id = item.id;
      node.disabled = !!item.disabled;
      node.setAttribute('aria-label', item.aria ?? item.label ?? item.id);
      node.dataset.press = 'none';
      let iconNode = null;
      if (item.symbol) {
        iconNode = icon(item.symbol, variant === 'bar' ? 25 : 18);
        iconNode.classList.add('sf-tab-icon');
        node.append(iconNode);
      }
      if (item.label) node.append(el('span', 'sf-tab-label', item.label));
      root.append(node);
      return {item, node, iconNode};
    });
    paintSelected();
  }

  function paintSelected() {
    for (const t of tabs) {
      const on = t.item.id === selected;
      t.node.classList.toggle('selected', on);
      t.node.setAttribute('aria-selected', String(on));
      t.node.tabIndex = on ? 0 : -1;
      if (t.iconNode && t.item.selectedSymbol) {
        const next = icon(on ? t.item.selectedSymbol : t.item.symbol, variant === 'bar' ? 25 : 18);
        next.classList.add('sf-tab-icon');
        t.iconNode.replaceWith(next);
        t.iconNode = next;
      }
    }
  }

  // ------------------------------------------------------------ geometry

  const indexOf = (id) => tabs.findIndex((t) => t.item.id === id);
  const inset = () => (variant === 'bar' ? 5 : 4);
  const extra = () => (variant === 'bar' ? 14 : 0); // the bar's pill is wider than its cell

  /** An item's slot: centre and width of the pill when resting on it. */
  function slot(i) {
    const n = tabs[Math.max(0, Math.min(tabs.length - 1, i))]?.node;
    if (!n) return {cx: 0, w: 0};
    const w = n.offsetWidth - (variant === 'bar' ? 0 : inset() * 2) + extra();
    return {cx: n.offsetLeft + n.offsetWidth / 2, w: Math.max(24, w)};
  }

  const state = {
    cx: {x: 0, v: 0},
    w: {x: 0, v: 0},
    lift: {x: 0, v: 0},
    mode: 'rest', // 'rest' | 'travel' | 'drag'
    target: 0, // the pointer's x while dragging
    raf: 0,
    last: 0,
    placed: false,
  };

  function trackScale(lift) {
    return 1 + lift * (variant === 'bar' ? 0.03 : 0.045);
  }

  function pillScale(lift) {
    return 1 + lift * 0.27;
  }

  function write() {
    const lift = clamp(state.lift.x, 0, 1.2);
    const speed = Math.abs(state.cx.v);
    const widen = settings.stretch && root.dataset.sfStretch !== 'off' ? Math.min(MAX_WIDEN, speed * WIDEN) : 0;
    const w = state.w.x * (1 + widen);
    thumb.style.left = `${state.cx.x - w / 2}px`;
    thumb.style.width = `${w}px`;
    thumb.style.top = `${inset()}px`;
    thumb.style.bottom = `${inset()}px`;
    const p = pose(thumb);
    p.press = pillScale(lift);
    p.commit();
    const r = pose(root);
    r.press = trackScale(lift);
    r.commit();
    root.style.setProperty('--lift', lift.toFixed(3));
    thumb.dataset.lifted = lift > 0.03 ? '1' : '';
    lens.active = lift > 0.03 || thumbStyle === 'glass';
    clipSelected();
  }

  /** Items under the pill show the selected colour, whatever is selected. */
  function clipSelected() {
    // With glass the underlay draws that rendition inside the lens; without it
    // (frost, static, no WebGL) the same is done with a clipped copy.
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    const i = indexOf(selected);
    const s = slot(i);
    let doneX;
    let targetCx;
    if (state.mode === 'drag') {
      const first = slot(0).cx;
      const last = slot(tabs.length - 1).cx;
      const pad = s.w / 2;
      const lo = first;
      const hi = last;
      const t = state.target;
      targetCx = t < lo ? lo + rubber(t - lo, 18) : t > hi ? hi + rubber(t - hi, 18) : t;
      doneX = follow(state.cx, targetCx, dt);
      void pad;
    } else {
      targetCx = s.cx;
      doneX = travel(state.cx, targetCx, dt);
    }
    const doneW = travel(state.w, s.w, dt);
    // How far it is lifted: held while dragging, and a pulse on the way to an item.
    let liftTarget = 0;
    if (state.mode === 'drag') liftTarget = 1;
    else if (state.mode === 'travel') liftTarget = clamp(Math.abs(state.cx.x - s.cx) / Math.max(30, s.w * 0.9), 0, 1) * 0.9;
    if (state.mode === 'rest' || (state.mode === 'travel' && liftTarget < 0.01)) liftTarget = 0;
    const doneLift = liftSpring(state.lift, liftTarget, dt);
    write();
    if (state.mode === 'travel' && doneX && doneLift && Math.abs(state.cx.x - s.cx) < 0.3) state.mode = 'rest';
    if (state.mode === 'rest' && doneX && doneW && doneLift) {
      state.cx.x = s.cx;
      state.w.x = s.w;
      state.cx.v = state.w.v = state.lift.v = 0;
      state.lift.x = 0;
      write();
      state.raf = 0;
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  function run() {
    if (state.raf) return;
    state.last = performance.now();
    state.raf = requestAnimationFrame(tick);
  }

  function place(animate) {
    const s = slot(indexOf(selected));
    if (!animate || !state.placed || reducedMotion.matches) {
      state.cx.x = s.cx;
      state.w.x = s.w;
      state.cx.v = state.w.v = 0;
      state.placed = tabs.length > 0 && s.w > 0;
      write();
      return;
    }
    state.mode = 'travel';
    run();
  }

  // ------------------------------------------------------------ selection

  function select(id, {animate = true, notify = true} = {}) {
    if (id === selected || indexOf(id) < 0) {
      if (animate) {
        state.mode = state.mode === 'drag' ? 'travel' : state.mode;
        run();
      }
      return;
    }
    const previous = selected;
    selected = id;
    paintSelected();
    if (animate) {
      state.mode = 'travel';
      run();
    } else place(false);
    if (notify) o.onChange?.(id, previous);
  }

  // ------------------------------------------------------------ pointer

  let down = null;
  function nearestTo(cx) {
    let best = 0;
    let bestD = Infinity;
    tabs.forEach((t, i) => {
      if (t.item.disabled) return;
      const d = Math.abs(slot(i).cx - cx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || down) return;
    const rect = root.getBoundingClientRect();
    const sc = rect.width / (root.offsetWidth || 1);
    const x = (e.clientX - rect.left) / sc;
    down = {id: e.pointerId, x0: e.clientX, x, moved: false, onThumb: Math.abs(x - state.cx.x) < state.w.x / 2, samples: [{x, t: performance.now()}], item: e.target.closest('.sf-tab')};
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointers
    }
    // Pressing the pill lifts it at once; other items wait to see whether it is a drag.
    if (down.onThumb) {
      state.mode = 'drag';
      state.target = state.cx.x;
      run();
    }
  });
  root.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const rect = root.getBoundingClientRect();
    const sc = rect.width / (root.offsetWidth || 1);
    const x = (e.clientX - rect.left) / sc;
    if (!down.moved && Math.abs(e.clientX - down.x0) > 5) {
      down.moved = true;
      state.mode = 'drag';
      run();
    }
    if (state.mode === 'drag') {
      state.target = x;
      down.samples.push({x, t: performance.now()});
      if (down.samples.length > 6) down.samples.shift();
      run();
    }
  });
  const end = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    if (e.type === 'pointercancel') {
      state.mode = 'travel';
      run();
      return;
    }
    if (d.moved || d.onThumb) {
      const a = d.samples[0];
      const b = d.samples[d.samples.length - 1];
      const v = b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0; // px/ms
      const projected = state.cx.x + clamp(v, -3, 3) * 90;
      const i = d.moved ? nearestTo(projected) : indexOf(selected);
      select(tabs[i].item.id);
    } else if (d.item && !d.item.disabled) {
      select(d.item.dataset.id);
    }
    state.mode = 'travel';
    run();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  // A drag must not also click the item it ends on.
  root.addEventListener(
    'click',
    (e) => {
      if (e.detail > 0) e.preventDefault();
    },
    true,
  );
  root.addEventListener('keydown', (e) => {
    const i = indexOf(selected);
    let j = i;
    if (e.key === 'ArrowRight') j = Math.min(tabs.length - 1, i + 1);
    else if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.sf-tab')) {
      select(e.target.closest('.sf-tab').dataset.id);
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    select(tabs[j].item.id);
    tabs[j].node.focus({preventScroll: true});
  });

  // ------------------------------------------------------------ glass

  const underlay = createTextUnderlay({
    container: () => root,
    textSelector: '.sf-tab-label, .sf-tab-icon',
    sampleRowSelector: '.sf-tab',
    textColor: () => tintColor,
  });
  const lens = {active: false};
  // The lens: flat until lifted, then a refracting glass with the colour fringe.
  thumb.sfLens = () => {
    const lift = () => clamp(state.lift.x, 0, 1);
    return {
      underlay: () => (lens.active ? underlay : null),
      opacity: () => (thumbStyle === 'glass' ? 1 : Math.min(1, lift() * 1.6)),
      // Clear glass on the same layer as the track: it shows the content under the bar crisply, bent at its edge.
      layer: 0,
      material: 0,
      frost: 0,
      tint: {color: scheme() === 'dark' ? '#202022' : '#ffffff', amount: 0.03},
      refraction: () => lerp(thumbStyle === 'glass' ? 0.04 : 0.0, 0.12, lift()),
      dispersion: () => lerp(thumbStyle === 'glass' ? 0.4 : 0, 1, lift()),
      magnify: () => 1 + 0.04 * lift(),
      rim: () => lerp(0.3, 0.5, lift()),
      ...o.lens,
    };
  };
  // The track brightens as the pill lifts: its glass takes on more white.
  root.sfLens = () => {
    const base = materials().bar;
    return {
      frost: variant === 'bar' ? 4 : base.frost,
      tint: () => ({color: base.tint.color, amount: lerp(base.tint.amount, Math.min(0.95, base.tint.amount + 0.35), clamp(state.lift.x, 0, 1))}),
    };
  };

  function readTint() {
    tintColor = getComputedStyle(root).getPropertyValue('--sf-tab-tint').trim() || getComputedStyle(root).getPropertyValue('--sf-blue').trim() || '#007aff';
  }

  build();
  readTint();
  new ResizeObserver(() => {
    place(false);
    readTint();
  }).observe(root);
  requestAnimationFrame(() => place(false));

  return {
    el: root,
    thumb,
    get selected() {
      return selected;
    },
    select,
    setTint(color) {
      root.style.setProperty('--sf-tab-tint', color);
      readTint();
    },
    setItems(items) {
      o.items = items;
      if (indexOf(selected) < 0) selected = items[0]?.id ?? null;
      build();
      place(false);
    },
    /** Moves the pill to wherever the selected item is now (call after a layout change). */
    relayout: () => place(false),
    destroy() {
      cancelAnimationFrame(state.raf);
      underlay.destroy?.();
      root.remove();
    },
  };
}
