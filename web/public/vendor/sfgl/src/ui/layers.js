/**
 * Layers: the fixed, click-through containers that sheets, windows and
 * popovers live in. Each has a glass host of its own, so its glass bends
 * what is behind it, whatever that is (the page, a sheet, another popover).
 *
 * Painting what is behind: a layer's backdrop is the page's DOM near the
 * glass (see domglass.js). A layer never paints itself; popovers (which
 * share one layer) are marked `data-sf-nopaint` so they do not refract
 * themselves, but they do see the sheets below.
 * @module
 */

import {el, scheme, settings} from './core.js';
import {createGlassHost} from './glasshost.js';

function pageBackground() {
  for (const node of [document.body, document.documentElement]) {
    const c = getComputedStyle(node).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c)) return c;
  }
  return scheme() === 'dark' ? '#1c1c1e' : '#ffffff';
}

let stack = 0;

/**
 * A new layer above the earlier ones (below the shared popover layer).
 * @param {{z?: number}} [o]
 * @returns {{el: HTMLElement, host: ReturnType<typeof createGlassHost>, cover: (owner: object, rects?: {top: number, bottom: number}[]) => void, destroy: () => void}}
 */
export function createLayer(o = {}) {
  const root = el('div', 'sf-layers');
  root.style.zIndex = String(o.z ?? 2000 + stack++);
  document.body.append(root);
  const host = createGlassHost({
    host: root,
    scroller: document.body,
    background: pageBackground(),
    quality: settings.quality,
    observe: false,
    skip: (n) => n === root || n.hasAttribute('data-sf-nopaint'),
  });
  const bandsBy = new Map();
  return {
    el: root,
    host,
    /** Bands of the page `owner` needs painted behind its glass (viewport rects); none clears. */
    cover(owner, rects = []) {
      if (rects.length) bandsBy.set(owner, rects);
      else bandsBy.delete(owner);
      const all = [];
      for (const list of bandsBy.values()) for (const r of list) all.push({top: r.top - 6, bottom: r.bottom + 6});
      host?.bands(all);
    },
    destroy() {
      host?.destroy();
      root.remove();
      stack = Math.max(0, stack - 1);
    },
  };
}

let shared = null;

/** The layer popovers share (always above the sheets). */
export function layerRoot() {
  if (shared?.el.isConnected) return shared;
  shared = createLayer({z: 2600});
  return shared;
}
