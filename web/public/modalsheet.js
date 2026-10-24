/**
 * The app's way to open a standard sheet: a sfgl sheet with the standard
 * header (close button on the left, a centred title, an optional trailing
 * control) and a scrolling body, growing out of the button that opened it.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let bottomProbe = null;
function safeBottom() {
  if (!bottomProbe) {
    bottomProbe = el('div');
    bottomProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
    document.body.append(bottomProbe);
  }
  return bottomProbe.getBoundingClientRect().height;
}

let openSheets = 0;
/** Whether any modal sheet is open. */
export function sheetOpen() {
  return openSheets > 0;
}

// ------------------------------------------------------------------ the standard sheet (sfgl/ui)

import { createSheet, standardHeader } from './vendor/sfgl/src/ui/index.js';

// The button that was pressed last: a sheet grows out of it and folds back into it.
let lastSource = { el: null, at: 0 };
document.addEventListener(
  'click',
  (e) => {
    const b = e.target?.closest?.('button, [role="button"], a');
    if (b) lastSource = { el: b, at: performance.now() };
  },
  true,
);
const recentSource = () => (lastSource.el?.isConnected && performance.now() - lastSource.at < 2500 ? lastSource.el : null);

/**
 * A standard sheet: close button on the left, a centred title, an optional
 * trailing control, and a scrolling body. It is a sfgl/ui sheet that grows
 * out of the button that opened it.
 * @param {{title: string, detents?: ('medium'|'large')[], className?: string, trailing?: Node, from?: Element,
 *   mediumHeight?: (ctx: object) => number, build: (ctx: object) => void, onClose?: (confirmed: boolean) => void, onDetent?: (d: string) => void,
 *   onConfirm?: (ctx: object) => Promise<boolean | void> | boolean | void, confirmLabel?: string}} options
 */
export function openSheet(options) {
  const header = standardHeader({
    title: options.title,
    confirm: options.onConfirm ? { aria: options.confirmLabel ?? 'Done' } : false,
    trailing: options.trailing ? [options.trailing] : [],
  });
  let ctx;
  let confirmed = false;
  openSheets++;
  window.dispatchEvent(new CustomEvent('sheetchange'));
  const sheet = createSheet({
    kind: 'button',
    source: options.from ?? recentSource() ?? undefined,
    detents: options.detents?.length ? options.detents : ['large'],
    header,
    label: options.title,
    mediumHeight: () => (options.mediumHeight ? options.mediumHeight(ctx) : (sheet.body.querySelector('[data-medium-end]')?.offsetTop ?? sheet.body.scrollHeight) + 16 + safeBottom()),
    onDetent: (d) => d && options.onDetent?.(d),
    onDirty: (on) => header.buttons.confirm?.setTint(on ? 'action' : null),
    onClose: () => {
      openSheets--;
      window.dispatchEvent(new CustomEvent('sheetchange'));
      options.onClose?.(confirmed);
    },
  });
  sheet.el.classList.add(...(options.className ?? '').split(/\s+/).filter(Boolean));
  sheet.body.classList.add('ms-content');
  header.buttons.confirm?.el.addEventListener('click', async () => {
    const button = header.buttons.confirm;
    button.setDisabled(true);
    try {
      if ((await options.onConfirm(ctx)) === false) return;
      confirmed = true;
      sheet.close();
    } finally {
      button.setDisabled(false);
    }
  });
  ctx = {
    setDirty: (on) => sheet.setDirty(on),
    invalidateGlass: () => sheet.layer.host?.invalidate(),
    addGlass(node, kind = 'control') {
      node.dataset.glass = kind;
    },
    body: sheet.body,
    head: sheet.header.el,
    title: header.title,
    frame: { panel: sheet.el, layer: sheet.layer.el },
    sheet,
    close: () => sheet.requestClose(),
    set: (d) => sheet.setDetent(d),
    setTitle: (t) => (header.title.textContent = t),
    refresh: () => sheet.refresh(),
  };
  options.build(ctx);
  sheet.present(options.detents?.[0] ?? 'large');
  return ctx;
}
