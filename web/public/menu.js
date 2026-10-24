/**
 * Menus now come from sfgl/ui (a popover that grows out of its source: no
 * scrim, tap outside to close, hold to highlight and slide to choose, the
 * glass stretches past its sides). This module keeps the shape of the old
 * calls: `groups` and `role: 'destructive'`.
 */

import { showMenu as present, onHold, closePopovers } from './vendor/sfgl/src/ui/index.js';

export { onHold };

/** Closes the open menu, if any. */
export function closeMenu() {
  closePopovers('menu');
}

function item(it) {
  const { role, submenu, ...rest } = it;
  return { ...rest, destructive: role === 'destructive' || it.destructive, submenu: submenu ? { title: submenu.title, items: submenu.groups.filter((g) => g && g.length).map((g) => g.map(item)) } : undefined };
}

/**
 * @param {{anchor: Element | DOMRect, preview?: Node, quick?: object[], groups: object[][], pointer?: {id: number, x: number, y: number},
 *   align?: 'start' | 'end', title?: string, placement?: 'auto' | 'below' | 'above' | 'cover'}} o
 */
export function showMenu(o) {
  return present({
    source: o.anchor,
    preview: o.preview,
    quick: o.quick,
    items: o.groups.filter((g) => g && g.length).map((g) => g.map(item)),
    pointer: o.pointer,
    align: o.align,
    title: o.title,
    placement: o.placement,
  });
}
