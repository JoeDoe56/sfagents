/**
 * The Remote Desktop sheet: this computer's screen, streamed by SF Agents'
 * screen mirroring (web/src/screen.ts) into a frame that fills the sheet
 * (the stream page, /screen/). The stream starts by itself.
 *
 * The ⋯ button has this device's settings: the resolution, the display's
 * scaling on Windows (kept per device), and Reconnect.
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { showMenu } from './menu.js';
import { showError } from './dialogs.js';
import { createButton } from './vendor/sfgl/src/ui/index.js';

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
  { value: 'auto', label: 'Automatic', detail: 'Sized to this screen, up to 1440p' },
  { value: 'device', label: 'This Screen', detail: 'Every pixel of this screen' },
  { value: '1080', label: '1080p', detail: 'Full HD' },
  { value: '720', label: '720p', detail: 'For a slow connection' },
];

let current = null;
const statusListeners = new Set();

/** Server "screen" events (downloading, ready…). */
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
  let setupAsked = false;

  const more = createButton({ symbol: 'ellipsis', aria: 'Remote Desktop options', size: 'large', onClick: () => showMenu({ anchor: more.el, align: 'end', groups: menuGroups() }) });

  const ctx = openSheet({
    title: 'Remote Desktop',
    detents: ['large'],
    className: 'rd-sheet',
    trailing: more.el,
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
    const s = info?.settings ?? { resolution: 'auto', displayScale: null };
    const groups = [
      [
        {
          label: 'Resolution',
          symbol: 'rectangle.on.rectangle',
          detail: RESOLUTIONS.find((r) => r.value === s.resolution)?.label ?? 'Automatic',
          submenu: {
            title: 'Resolution',
            groups: [RESOLUTIONS.map((r) => ({ label: r.label, detail: r.detail, checked: r.value === s.resolution, action: () => saveSettings({ resolution: r.value }, true) }))],
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
      const { settings } = await postJson('/api/screen/settings', patch);
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
      const mb = p?.total ? ` ${(p.done / 1e6).toFixed(0)} of ${(p.total / 1e6).toFixed(0)} MB` : '';
      showPanel('Setting up Remote Desktop…', p ? `${p.label}${mb}` : '', [], p?.total ? p.done / p.total : null);
    } else if (status.state === 'missing') {
      // Normally done when SF Agents started; if not (offline then), now.
      showPanel('Setting up Remote Desktop…', '');
      if (!setupAsked) {
        setupAsked = true;
        setup();
      }
    } else if (status.state === 'unavailable') {
      showPanel('Remote Desktop is not available here', status.error ?? '');
    } else {
      showPanel("Remote Desktop isn't available", status.error ?? '', [{ label: 'Try Again', primary: true, action: () => setup() }]);
    }
  }

  async function setup() {
    try {
      const { status } = await postJson('/api/screen/setup');
      render(status);
    } catch (error) {
      showError(error.message, "Couldn't set up Remote Desktop");
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
    const q = new URLSearchParams({ resolution: info.settings?.resolution ?? 'auto' });
    frame = el('iframe', 'rd-frame');
    frame.title = 'Remote Desktop';
    frame.allow = 'fullscreen; autoplay; gamepad; clipboard-read; clipboard-write; keyboard-map; screen-wake-lock';
    frame.src = `/screen/?${q}`;
    stage.prepend(frame);
    // Covered until the picture comes.
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
      postJson('/api/screen/ended').catch(() => {});
    }
  }

  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'mw-embed') return;
    if (d.type === 'signIn') {
      location.reload();
      return;
    }
    if (d.type !== 'state') return;
    if (d.state === 'streaming') {
      panel.hidden = true;
      if (!streaming) {
        streaming = true;
        postJson('/api/screen/streaming').catch(() => {});
      }
      return;
    }
    if (d.state === 'connecting' || d.state === 'launching') {
      if (!streaming) showPanel('Connecting…', '', [], null, true);
      return;
    }
    if (streaming) {
      streaming = false;
      postJson('/api/screen/ended').catch(() => {});
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

  async function load() {
    showPanel('Connecting…', '');
    try {
      info = await getJson('/api/screen');
      render(info.status);
    } catch (error) {
      showPanel("Remote Desktop isn't available", error.message, [{ label: 'Try Again', primary: true, action: () => load() }]);
    }
  }

  current = { ctx, close: () => ctx.close() };
  load();
  return current;
}
