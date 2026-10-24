/**
 * Dialogs: a question in a popover that grows out of what asked it (the
 * close button of a sheet with unsaved changes, a delete button), with
 * capsule actions under the text. Used for the "discard changes?" box.
 *
 *   const answer = await presentDialog({source: xButton, title: 'Are you sure…?',
 *     actions: [{label: 'Discard Changes', role: 'destructive', value: 'discard'}]});
 *
 * Tapping outside (or Escape) answers `undefined`.
 * @module
 */

import {el} from './core.js';
import {presentPopover} from './popover.js';

/**
 * @typedef {object} DialogAction
 * @property {string} label
 * @property {'default'|'destructive'|'cancel'} [role]
 * @property {any} [value]    what the promise resolves with (default: the label)
 *
 * @typedef {object} DialogOptions
 * @property {Element | {left: number, top: number, width: number, height: number}} source
 * @property {string} [title]
 * @property {string} [message]
 * @property {DialogAction[]} actions
 * @property {number} [width]       default 240
 * @property {'auto'|'below'|'above'|'cover'} [placement]
 */

/**
 * @param {DialogOptions} o
 * @returns {Promise<any>}
 */
export function presentDialog(o) {
  return new Promise((resolve) => {
    const box = el('div', 'sf-dialog');
    if (o.title) box.append(el('div', 'sf-dialog-title', o.title));
    if (o.message) box.append(el('div', 'sf-dialog-message', o.message));
    const list = el('div', 'sf-dialog-actions');
    let answered = false;
    let pop = null;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      pop?.close();
    };
    for (const a of o.actions) {
      const b = el('button', `sf-dialog-action ${a.role ?? 'default'}`, a.label);
      b.type = 'button';
      b.addEventListener('click', () => answer(a.value ?? a.label));
      list.append(b);
    }
    box.append(list);
    pop = presentPopover({
      source: o.source,
      content: box,
      width: o.width ?? 240,
      placement: o.placement ?? 'cover',
      align: 'start',
      radius: 32,
      className: 'sf-dialog-pop',
      group: 'dialog',
      onClose: () => answer(undefined),
    });
  });
}

/**
 * The unsaved-changes question. Resolves true when the changes should be
 * thrown away.
 * @param {{source: Element | DOMRect, title?: string, discardLabel?: string, keepLabel?: string}} o
 */
export async function confirmDiscard(o) {
  const choice = await presentDialog({
    source: o.source,
    title: o.title ?? 'Are you sure you want to discard your changes?',
    actions: [{label: o.discardLabel ?? 'Discard Changes', role: 'destructive', value: 'discard'}],
  });
  return choice === 'discard';
}
