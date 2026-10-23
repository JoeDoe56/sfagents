/**
 * An application artifact, open inside SF Agents: the app (a web server the
 * agent started on this computer) in a full sheet, reached through SF Agents'
 * own address (see web/src/apps.ts), so it works from a phone too. The app
 * keeps running when the sheet closes.
 */

import { openSheet } from './modalsheet.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function glassButton(symbol, label, onClick) {
  const b = el('button', 'ms-close');
  b.type = 'button';
  b.dataset.glass = 'control';
  b.setAttribute('aria-label', label);
  b.title = label;
  const i = el('i');
  applySymbol(i, symbol, { size: 17 });
  b.append(i);
  b.addEventListener('click', onClick);
  return b;
}

export function openApp(a) {
  let frame;
  const trailing = el('div', 'ap-actions');
  trailing.append(
    glassButton('arrow.clockwise', 'Reload', () => {
      frame.src = a.url;
    }),
    glassButton('arrow.up.right.square', 'Open in a new tab', () => window.open(a.url, '_blank', 'noopener')),
  );
  const ctx = openSheet({
    title: a.title,
    detents: ['large'],
    className: 'ap-sheet',
    trailing,
    build(sheet) {
      sheet.body.classList.add('ap-body');
      frame = el('iframe', 'ap-frame');
      frame.title = a.title;
      // The app is the user's own (the agent started it on their computer); it runs as it would on its own port.
      frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
      frame.src = a.url;
      const host = el('div', 'ap-host');
      host.dataset.noSheetDrag = '';
      host.append(frame);
      sheet.body.append(el('p', 'ap-target', a.target ?? ''), host);
    },
  });
  return ctx;
}
