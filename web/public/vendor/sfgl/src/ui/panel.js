/**
 * A panel: a rounded box whose content is yours, or a status display with an
 * icon, a title, a line of text, a progress bar and buttons. `update()`
 * changes any of it, so showing "Installing… 40%" then "Ready" is a couple of
 * calls.
 * @module
 */

import {el, icon} from './core.js';
import {createButton} from './button.js';

/**
 * @typedef {object} PanelOptions
 * @property {string} [icon]          SF Symbol
 * @property {string} [title]
 * @property {string} [text]
 * @property {number|'indeterminate'|null} [progress]   0..1, or a bar that keeps moving
 * @property {{label: string, primary?: boolean, onClick: () => void}[]} [actions]
 * @property {string|null} [tint]     colours the icon's disc
 * @property {'card'|'plain'} [look]  `plain` has no box
 * @property {Node|Node[]} [content]  your own content (replaces the status parts)
 */

/** @param {PanelOptions} o */
export function createPanel(o = {}) {
  const node = el('div', 'sf-panel');
  node.setAttribute('role', 'status');
  const state = {...o};
  const buttons = [];

  function render() {
    for (const b of buttons.splice(0)) b.destroy();
    node.replaceChildren();
    node.classList.toggle('plain', state.look === 'plain');
    if (state.content) {
      node.append(...[].concat(state.content));
      return;
    }
    if (state.icon) {
      const disc = el('div', `sf-panel-icon${state.tint ? ' tinted' : ''}`);
      if (state.tint) disc.style.setProperty('--sf-tint', state.tint);
      disc.append(icon(state.icon, 30));
      node.append(disc);
    }
    if (state.title) node.append(el('h3', 'sf-panel-title', state.title));
    if (state.text) node.append(el('p', 'sf-panel-text', state.text));
    if (state.progress !== undefined && state.progress !== null) {
      const bar = el('div', `sf-panel-progress${state.progress === 'indeterminate' ? ' indeterminate' : ''}`);
      const fill = el('span');
      if (typeof state.progress === 'number') fill.style.width = `${Math.round(Math.max(0, Math.min(1, state.progress)) * 100)}%`;
      bar.append(fill);
      node.append(bar);
    }
    if (state.actions?.length) {
      const row = el('div', 'sf-panel-actions');
      for (const a of state.actions) {
        const b = createButton({label: a.label, tint: a.primary ? 'action' : null, onClick: a.onClick});
        buttons.push(b);
        row.append(b.el);
      }
      node.append(row);
    }
  }
  render();

  return {
    el: node,
    /** Changes any of the options and redraws; a progress-only change just moves the bar. */
    update(patch) {
      const onlyProgress = Object.keys(patch).length === 1 && 'progress' in patch && typeof patch.progress === 'number' && typeof state.progress === 'number';
      Object.assign(state, patch);
      if (onlyProgress) {
        const fill = node.querySelector('.sf-panel-progress > span');
        if (fill) {
          fill.style.width = `${Math.round(Math.max(0, Math.min(1, state.progress)) * 100)}%`;
          return;
        }
      }
      render();
    },
    show() {
      node.hidden = false;
    },
    hide() {
      node.hidden = true;
    },
    destroy() {
      for (const b of buttons) b.destroy();
      node.remove();
    },
  };
}

/** A status display: `createStatus({icon: 'desktopcomputer', title: 'Starting…'})`. */
export const createStatus = createPanel;
