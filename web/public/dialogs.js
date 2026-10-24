/**
 * Apple-style alerts (a title, a message, an optional text field and a row
 * or column of buttons) and a progress toast for long file operations.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { presentAlert } from './vendor/sfgl/src/ui/index.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// What was last pressed: an alert that follows a tap grows out of that control.
let lastPressed = null;
let lastPressedAt = 0;
document.addEventListener(
  'pointerdown',
  (e) => {
    lastPressed = e.target instanceof Element ? e.target.closest('button, [role="button"], .sf-row, .fm-row') : null;
    lastPressedAt = performance.now();
  },
  true,
);

/**
 * An alert (a title, a message, an optional text field and capsule actions)
 * that grows out of what was tapped, or out of the middle of the screen.
 * @param {{title: string, message?: string, source?: Element, input?: {value?: string, placeholder?: string, select?: [number, number]},
 *   actions: {label: string, value?: string, role?: 'cancel' | 'destructive' | 'default'}[]}} options
 * @returns {Promise<{action: string | null, value: string}>}  action is the chosen button's value (or label); null when dismissed
 */
export function alertDialog(options) {
  let source = options.source;
  if (!source && lastPressed?.isConnected && performance.now() - lastPressedAt < 4000) {
    const r = lastPressed.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(lastPressed).visibility !== 'hidden') source = lastPressed;
  }
  return presentAlert({ ...options, source });
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
