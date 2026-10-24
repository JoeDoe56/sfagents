/**
 * Glass for a container (a sheet, a window, a popup): sfgl draws every
 * element marked `data-glass="control|bar|tile|lens"` inside it, and keeps
 * doing so as elements come and go. Without WebGL (or without a glass
 * factory) the elements keep their CSS look.
 *
 * The container's own `scroller` is what the glass refracts: the default
 * factory repaints the content behind the chrome into a canvas (see
 * domglass.js). An app with its own backdrop (a chat, a map) supplies its own
 * factory with `configure({glass})`.
 * @module
 */

import {settings, lensFor} from './core.js';
import {createDomGlass} from './domglass.js';
import {ACTION_TINT, DANGER_TINT, materials} from './materials.js';

/** The tint a data-tint value names: 'action', 'danger' or a CSS colour. */
export function tintOf(value) {
  if (!value) return null;
  if (value === 'action') return ACTION_TINT;
  if (value === 'danger') return DANGER_TINT;
  return {color: value, amount: 0.9};
}

/**
 * @param {{host: HTMLElement, scroller?: HTMLElement|null, background?: string, units?: string, quality?: string,
 *   edges?: () => any[], clip?: HTMLElement|null, observe?: boolean, make?: (o: object) => any}} options
 *   `make`: this host's own glass factory (a chat behind a bar), instead of the app-wide `configure({glass})`
 *   `observe: false`: only elements given to `adopt`/`adoptOne` get glass (the shared popup layer, where sheets have hosts of their own)
 * @returns {{glass: any, adopt: (root: Element, o?: {clip?: Element}) => void, release: (node: Element) => void, bands: (rects: {top: number, bottom: number}[]) => void,
 *   adoptOne: (node: Element, o?: object, kind?: string) => void, invalidate: () => void, repaint: () => void, setBackground: (c: string) => void, destroy: () => void} | null}
 */
export function createGlassHost(options) {
  let glass = null;
  try {
    const make = options.make ?? settings.glass ?? ((o) => createDomGlass(o));
    glass = make({...options, scroller: options.scroller ?? options.host, quality: options.quality ?? settings.quality});
  } catch {
    glass = null;
  }
  if (!glass) return null;
  const clip = options.clip ?? null;
  const adopted = new Set();

  function lensOptions(node) {
    const out = {};
    const tint = tintOf(node.dataset.tint);
    if (tint) out.tint = tint;
    if (clip) out.clip = clip;
    // A component can tune its own lens (the tab pill's refraction follows how far it is lifted).
    const own = node.sfLens?.();
    if (own) Object.assign(out, own);
    return out;
  }

  function adoptNode(node, extra = {}, kindOverride) {
    if (adopted.has(node) || !node.isConnected) return;
    const kind = kindOverride || node.dataset.glass || 'control';
    if (!(kind in materials())) return;
    adopted.add(node);
    glass.lens(node, kind, {...lensOptions(node), ...extra});
    node.classList.add('has-glass');
  }

  function adopt(root, extra = {}) {
    if (root.dataset?.glass) adoptNode(root, extra);
    for (const node of root.querySelectorAll('[data-glass]')) adoptNode(node, extra);
  }

  // Elements added later (a row's button, a menu's chips) get glass too.
  let queued = false;
  const mo = new MutationObserver(() => {
    if (options.observe === false) return;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      adopt(options.host);
      for (const node of [...adopted]) if (!node.isConnected) adopted.delete(node);
      glass.invalidate?.();
    });
  });
  mo.observe(options.host, {subtree: true, childList: true});

  return {
    glass,
    adopt,
    adoptOne: adoptNode,
    release(node) {
      adopted.delete(node);
      lensFor(node)?.lens.destroy?.();
    },
    bands: (rects) => {
      glass.setBands?.(rects);
      glass.invalidate?.();
    },
    invalidate: () => glass.invalidate?.(),
    repaint: () => glass.repaint?.(),
    setBackground: (c) => glass.setBackground?.(c),
    destroy() {
      mo.disconnect();
      glass.destroy?.();
    },
  };
}
