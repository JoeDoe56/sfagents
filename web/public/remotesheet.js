/**
 * The Remote Desktop sheet: this computer's screen, streamed by MoonlightWeb
 * (see web/src/remote.ts) and shown in a frame that fills the sheet. The
 * stream is the frame's size, 16:9 or 9:16 as the device is held, and starts
 * by itself; turning the device or resizing the window remakes it.
 *
 * The ⋯ button has this device's settings: the resolution (a lighter stream
 * on a slow link), the display's scaling on Windows (kept per device), and
 * Reconnect.
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { showMenu } from './menu.js';
import { showError } from './dialogs.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function sym(name, size = 17) {
  const i = el('i');
  applySymbol(i, name, { size });
  return i;
}

const RESOLUTIONS = [
  { scale: 1, label: 'Full', detail: 'Every pixel of this screen' },
  { scale: 0.75, label: 'Balanced', detail: 'Three quarters' },
  { scale: 0.5, label: 'Light', detail: 'Half: for a slow connection' },
];

let current = null;
const statusListeners = new Set();

/** Server "remote" events (MoonlightWeb found, installing, started…). */
export function remoteEvent(status) {
  for (const l of statusListeners) l(status);
}

export function remoteOpen() {
  return current !== null;
}

export async function openRemoteDesktop() {
  if (current) return current;
  let info = null; // {status, device, settings, displayScales, platform}
  let frame = null;
  let stage;
  let panel;
  let streaming = false;
  let installAsked = false;

  const more = el('button', 'ms-close rd-more');
  more.type = 'button';
  more.dataset.glass = 'control';
  more.setAttribute('aria-label', 'Remote Desktop options');
  more.append(sym('ellipsis', 17));
  more.addEventListener('click', () => showMenu({ anchor: more, align: 'end', groups: menuGroups() }));

  const ctx = openSheet({
    title: 'Remote Desktop',
    detents: ['large'],
    className: 'rd-sheet',
    trailing: more,
    build(sheet) {
      stage = el('div', 'rd-stage');
      stage.dataset.noSheetDrag = '';
      panel = el('div', 'rd-panel');
      stage.append(panel);
      sheet.body.append(stage);
    },
    onClose: () => {
      stopStream();
      statusListeners.delete(onStatus);
      window.removeEventListener('message', onMessage);
      current = null;
    },
  });
  ctx.body.classList.add('rd-body');

  function menuGroups() {
    const s = info?.settings ?? { scale: 1, displayScale: null };
    const groups = [
      [
        {
          label: 'Resolution',
          symbol: 'rectangle.on.rectangle',
          detail: RESOLUTIONS.find((r) => r.scale === s.scale)?.label ?? 'Full',
          submenu: {
            title: 'Resolution',
            groups: [RESOLUTIONS.map((r) => ({ label: r.label, detail: r.detail, checked: r.scale === s.scale, action: () => saveSettings({ scale: r.scale }, true) }))],
          },
        },
      ],
    ];
    if (info?.platform === 'win32') {
      groups[0].push({
        label: 'Display Scaling',
        symbol: 'textformat.size',
        detail: s.displayScale ? `${s.displayScale}%` : 'Windows',
        submenu: {
          title: 'Display Scaling',
          groups: [
            [{ label: "Windows' Choice", checked: s.displayScale === null, action: () => saveSettings({ displayScale: null }) }],
            (info.displayScales ?? []).map((p) => ({ label: `${p}%`, checked: s.displayScale === p, action: () => saveSettings({ displayScale: p }) })),
          ],
        },
      });
    }
    groups.push([{ label: 'Reconnect', symbol: 'arrow.clockwise', action: () => startStream(true) }]);
    return groups;
  }

  async function saveSettings(patch, restart = false) {
    try {
      const { settings } = await postJson('/api/remote', { action: 'settings', ...patch });
      info.settings = settings;
      if (restart && frame) startStream(true);
    } catch (error) {
      showError(error.message, "Couldn't change the setting");
    }
  }

  function showPanel(title, text, actions = [], progress = null, keepFrame = false) {
    if (!keepFrame) {
      stopStream();
    }
    panel.hidden = false;
    panel.classList.toggle('over', keepFrame);
    panel.replaceChildren();
    const icon = el('div', 'rd-icon');
    icon.append(sym('desktopcomputer', 34));
    panel.append(icon, el('h3', 'rd-title', title));
    if (text) panel.append(el('p', 'rd-text', text));
    if (progress) {
      const bar = el('div', 'rd-progress');
      const fill = el('span');
      fill.style.width = `${Math.round(progress * 100)}%`;
      bar.append(fill);
      panel.append(bar);
    }
    for (const a of actions) {
      const b = el('button', `rd-btn${a.primary ? ' primary' : ''}`, a.label);
      b.type = 'button';
      b.addEventListener('click', a.action);
      panel.append(b);
    }
    ctx.refresh?.();
  }

  function render(status) {
    if (!status) return;
    if (status.state === 'ready') {
      if (!frame) startStream(false);
      return;
    }
    stopStream();
    if (status.state === 'installing') {
      const p = status.progress;
      const gb = p?.total ? ` ${(p.done / 1e6).toFixed(0)} of ${(p.total / 1e6).toFixed(0)} MB` : '';
      showPanel('Installing MoonlightWeb…', p ? `${p.label}${gb}` : '', [], p?.total ? p.done / p.total : null);
    } else if (status.state === 'starting') {
      showPanel('Starting MoonlightWeb…', '');
    } else if (status.state === 'error') {
      showPanel("Remote Desktop isn't available", status.error ?? '', [{ label: 'Try Again', primary: true, action: () => (status.canInstall ? install_() : load(true)) }]);
    } else if (status.canInstall) {
      // Normally done when SF Agents started; if not (declined, offline), now.
      showPanel('Setting up Remote Desktop…', 'SF Agents is installing MoonlightWeb, which streams this screen. The computer may ask for administrator approval once.');
      if (!installAsked) {
        installAsked = true;
        install_();
      }
    } else {
      showPanel('Remote Desktop is not available here', `MoonlightWeb, which streams this screen, has no build for this computer. See ${status.project}.`, [{ label: 'Check Again', action: () => load(true) }]);
    }
  }

  async function install_() {
    try {
      const { status } = await postJson('/api/remote', { action: 'install' });
      render(status);
    } catch (error) {
      showError(error.message, "Couldn't install MoonlightWeb");
    }
  }

  function startStream(force) {
    if (!window.isSecureContext) {
      showPanel(
        'Remote Desktop needs a secure address',
        'Browsers decode video streams only on localhost or over HTTPS. Open SF Agents through HTTPS (for example Tailscale Serve, with --public-origin).',
      );
      return;
    }
    if (frame && !force) return;
    if (frame) stopStream();
    const q = new URLSearchParams({ embed: 'sfagents', client: info.device, scale: String(info.settings?.scale ?? 1) });
    frame = el('iframe', 'rd-frame');
    frame.title = 'Remote Desktop';
    frame.allow = 'fullscreen; autoplay; gamepad; clipboard-read; clipboard-write; keyboard-map; screen-wake-lock';
    frame.src = `/apps/remote/?${q}`;
    stage.prepend(frame);
    // Covered until the picture comes (MoonlightWeb's own page says the same, in its own style).
    showPanel('Connecting…', '', [], null, true);
  }

  function stopStream() {
    if (frame) {
      try {
        frame.contentWindow?.postMessage({ target: 'mw-embed', type: 'stop' }, location.origin);
      } catch {
        // gone
      }
      frame.remove();
      frame = null;
    }
    if (streaming) {
      streaming = false;
      postJson('/api/remote', { action: 'ended' }).catch(() => {});
    }
  }

  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'mw-embed' || d.type !== 'state') return;
    if (d.state === 'streaming') {
      panel.hidden = true;
      if (!streaming) {
        streaming = true;
        postJson('/api/remote', { action: 'streaming' }).catch(() => {});
      }
      return;
    }
    if (d.state === 'connecting' || d.state === 'launching') {
      if (!streaming) showPanel('Connecting…', '', [], null, true);
      return;
    }
    if (streaming) {
      streaming = false;
      postJson('/api/remote', { action: 'ended' }).catch(() => {});
    }
    if (d.state === 'error') showPanel("Couldn't start the stream", d.message ?? '', [{ label: 'Try Again', primary: true, action: () => startStream(true) }]);
    else if (d.state === 'ended') showPanel('The stream ended', '', [{ label: 'Reconnect', primary: true, action: () => startStream(true) }]);
  }
  window.addEventListener('message', onMessage);

  function onStatus(status) {
    if (!info) return; // still loading: load() renders
    info.status = status;
    render(status);
  }
  statusListeners.add(onStatus);

  async function load(find) {
    showPanel('Looking for MoonlightWeb…', '');
    try {
      info = await getJson('/api/remote', find ? { find: true } : undefined);
      render(info.status);
    } catch (error) {
      showPanel("Remote Desktop isn't available", error.message, [{ label: 'Try Again', primary: true, action: () => load(true) }]);
    }
  }

  current = { ctx, close: () => ctx.close() };
  load(true);
  return current;
}
