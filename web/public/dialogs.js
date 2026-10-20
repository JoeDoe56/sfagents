/**
 * Apple-style alerts (a title, a message, an optional text field and a row
 * or column of buttons) and a progress toast for long file operations.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{title: string, message?: string, input?: {value?: string, placeholder?: string, select?: [number, number]},
 *   actions: {label: string, value?: string, role?: 'cancel' | 'destructive' | 'default'}[]}} options
 * @returns {Promise<{action: string | null, value: string}>}  action is the chosen button's value (or label); null when dismissed
 */
export function alertDialog(options) {
  return new Promise((resolve) => {
    const layer = el('div', 'dialog-layer');
    const box = el('div', 'dialog');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const title = el('h2', 'dialog-title', options.title);
    title.id = `dialog-${Math.random().toString(36).slice(2)}`;
    box.setAttribute('aria-labelledby', title.id);
    const content = el('div', 'dialog-content');
    content.append(title);
    if (options.message) content.append(el('p', 'dialog-message', options.message));
    let field = null;
    if (options.input) {
      field = el('input', 'dialog-input');
      field.type = 'text';
      field.value = options.input.value ?? '';
      field.placeholder = options.input.placeholder ?? '';
      field.autocomplete = 'off';
      field.spellcheck = false;
      field.setAttribute('autocapitalize', 'off');
      content.append(field);
    }
    box.append(content);
    const actions = el('div', `dialog-actions${options.actions.length > 2 ? ' stacked' : ''}`);
    const buttons = options.actions.map((a) => {
      const b = el('button', `dialog-button${a.role ? ` ${a.role}` : ''}`, a.label);
      b.type = 'button';
      b.addEventListener('click', () => finish(a.value ?? a.label));
      actions.append(b);
      return [a, b];
    });
    box.append(actions);
    layer.append(box);
    document.body.append(layer);
    layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    box.animate([{ transform: 'scale(1.12)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EASE });
    const preferred = buttons.find(([a]) => a.role === 'default') ?? buttons.find(([a]) => a.role !== 'cancel');
    if (field) {
      field.focus();
      const sel = options.input.select;
      if (sel) field.setSelectionRange(sel[0], sel[1]);
      else field.select();
    } else (preferred?.[1] ?? buttons[0]?.[1])?.focus();

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const cancel = options.actions.find((a) => a.role === 'cancel');
        finish(cancel ? (cancel.value ?? cancel.label) : null);
      } else if (e.key === 'Enter' && preferred && (field ? document.activeElement === field : true)) {
        e.preventDefault();
        e.stopPropagation();
        finish(preferred[0].value ?? preferred[0].label);
      }
    }
    window.addEventListener('keydown', onKey, true);

    function finish(action) {
      window.removeEventListener('keydown', onKey, true);
      const value = field?.value ?? '';
      layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }).onfinish = () => layer.remove();
      resolve({ action, value });
    }
  });
}

/** OK/Cancel question; resolves true for the confirming button. */
export async function confirmDialog(title, message, confirmLabel, destructive = false) {
  const { action } = await alertDialog({
    title,
    message,
    actions: [
      { label: 'Cancel', role: 'cancel', value: 'cancel' },
      { label: confirmLabel, role: destructive ? 'destructive' : 'default', value: 'ok' },
    ],
  });
  return action === 'ok';
}

/** A name field (rename, new folder); resolves with the trimmed name, or null. */
export async function promptDialog(title, value, okLabel, { message, select } = {}) {
  const { action, value: text } = await alertDialog({
    title,
    message,
    input: { value, select },
    actions: [
      { label: 'Cancel', role: 'cancel', value: 'cancel' },
      { label: okLabel, role: 'default', value: 'ok' },
    ],
  });
  return action === 'ok' && text.trim() ? text.trim() : null;
}

export function showError(message, title = 'Something went wrong') {
  return alertDialog({ title, message, actions: [{ label: 'OK', role: 'default' }] });
}

// ------------------------------------------------------------------ toasts

let toastHost = null;

/**
 * A small glass toast at the bottom of the screen ("Copying 3 items… 42%"),
 * with an optional Cancel. Returns a handle to update or close it.
 */
export function toast(text, { progress = null, cancel = null, cancelLabel = 'Cancel', symbol = null, timeout = 0 } = {}) {
  if (!toastHost) {
    toastHost = el('div', 'toast-host');
    document.body.append(toastHost);
  }
  const node = el('div', 'toast');
  node.setAttribute('role', 'status');
  if (symbol) {
    const i = el('i');
    applySymbol(i, symbol, { size: 15 });
    node.append(i);
  }
  const body = el('div', 'toast-body');
  const label = el('span', 'toast-text', text);
  const bar = el('div', 'toast-bar');
  const fill = el('span');
  bar.append(fill);
  body.append(label, bar);
  node.append(body);
  if (cancel) {
    const b = el('button', 'toast-cancel', cancelLabel);
    b.type = 'button';
    b.addEventListener('click', cancel);
    node.append(b);
  }
  toastHost.append(node);
  node.animate([{ transform: 'translateY(20px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EASE });
  const handle = {
    set(nextText, nextProgress) {
      if (nextText !== undefined && label.textContent !== nextText) label.textContent = nextText;
      bar.hidden = nextProgress === null || nextProgress === undefined;
      if (Number.isFinite(nextProgress)) fill.style.width = `${Math.round(Math.max(0, Math.min(1, nextProgress)) * 100)}%`;
    },
    close(delay = 0) {
      setTimeout(() => {
        node.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(10px)' }], { duration: 200, fill: 'forwards' }).onfinish = () => node.remove();
      }, delay);
    },
  };
  handle.set(text, progress);
  if (timeout) handle.close(timeout);
  return handle;
}
