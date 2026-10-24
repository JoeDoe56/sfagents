/**
 * The terminal sheet: xterm.js tabs attached to shells that keep running on
 * the computer (see web/src/terminal.ts). Tabs survive closing the sheet,
 * reloading the page and switching devices. On touch screens a key bar adds
 * Esc, Tab, Ctrl, the arrows and a few symbols the keyboard hides.
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { showError } from './dialogs.js';
import { showMenu } from './menu.js';
import { createButton } from './vendor/sfgl/src/ui/index.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function sym(name, size = 15) {
  const i = el('i');
  applySymbol(i, name, { size });
  return i;
}

let xtermModules = null;
function loadXterm() {
  if (!xtermModules) {
    if (!document.querySelector('link[data-xterm]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'vendor/xterm/xterm.css';
      link.dataset.xterm = '';
      document.head.append(link);
    }
    xtermModules = Promise.all([import('./vendor/xterm/xterm.mjs'), import('./vendor/xterm/addon-fit.mjs'), import('./vendor/xterm/addon-web-links.mjs')]);
  }
  return xtermModules;
}

const THEME = {
  background: '#000000',
  foreground: '#f2f2f7',
  cursor: '#f2f2f7',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(10, 132, 255, 0.45)',
  black: '#1c1c1e',
  red: '#ff453a',
  green: '#30d158',
  yellow: '#ffd60a',
  blue: '#0a84ff',
  magenta: '#bf5af2',
  cyan: '#64d2ff',
  white: '#d1d1d6',
  brightBlack: '#636366',
  brightRed: '#ff6961',
  brightGreen: '#4cd964',
  brightYellow: '#ffe066',
  brightBlue: '#409cff',
  brightMagenta: '#da8fff',
  brightCyan: '#8ae0ff',
  brightWhite: '#ffffff',
};

let current = null;

export function terminalOpen() {
  return current !== null;
}

/** Opens the terminal sheet (or brings it forward). */
export async function openTerminal() {
  if (current) return current;
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await loadXterm();
  const tabs = new Map(); // id → {term, fit, ws, host, info}
  let active = null;
  let ctrl = false;
  let strip;
  let stage;
  let keys;
  let resizeObs;

  const ctx = openSheet({
    title: 'Terminal',
    detents: ['large'],
    className: 'tm-sheet',
    trailing: (() => {
      return createButton({ symbol: 'plus', aria: 'New tab', size: 'large', onClick: () => newTab() }).el;
    })(),
    build(sheet) {
      strip = el('div', 'tm-tabs');
      strip.setAttribute('role', 'tablist');
      stage = el('div', 'tm-stage');
      stage.dataset.noSheetDrag = '';
      keys = keyBar();
      sheet.body.append(strip, stage, keys);
    },
    onClose: () => {
      // The shells keep running; only this page's connections close.
      for (const t of tabs.values()) {
        t.closing = true;
        t.ws?.close();
        t.term.dispose();
      }
      resizeObs?.disconnect();
      current = null;
    },
  });
  ctx.body.classList.add('tm-body');

  function keyBar() {
    const bar = el('div', 'tm-keys');
    bar.dataset.noSheetDrag = '';
    const send = (s) => {
      const t = tabs.get(active);
      if (t?.ws?.readyState === 1) t.ws.send(s);
      t?.term.focus();
    };
    const defs = [
      ['esc', '\x1b'],
      ['tab', '\t'],
      ['ctrl', null],
      ['↑', '\x1b[A'],
      ['↓', '\x1b[B'],
      ['←', '\x1b[D'],
      ['→', '\x1b[C'],
      ['|', '|'],
      ['~', '~'],
      ['/', '/'],
      ['-', '-'],
    ];
    for (const [label, seq] of defs) {
      const b = el('button', 'tm-key', label);
      b.type = 'button';
      b.dataset.press = 'none';
      b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard up
      b.addEventListener('click', () => {
        if (seq === null) {
          ctrl = !ctrl;
          b.classList.toggle('on', ctrl);
          tabs.get(active)?.term.focus();
          return;
        }
        send(seq);
      });
      bar.append(b);
    }
    return bar;
  }

  function renderTabs(list) {
    strip.replaceChildren();
    for (const info of list) {
      const t = tabs.get(info.id);
      if (t) t.info = info;
      const b = el('button', `tm-tab${info.id === active ? ' on' : ''}${info.exited ? ' exited' : ''}`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(info.id === active));
      b.append(el('span', 'tm-tab-title', info.title));
      const x = el('span', 'tm-tab-close');
      x.append(sym('xmark', 9));
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', `Close ${info.title}`);
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(info.id);
      });
      b.append(x);
      b.addEventListener('click', () => show(info.id));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu({ anchor: b, groups: [[{ label: 'Close Tab', symbol: 'xmark', role: 'destructive', action: () => closeTab(info.id) }]] });
      });
      strip.append(b);
    }
  }

  async function refreshTabs() {
    const { terminals } = await getJson('/api/terminals');
    renderTabs(terminals);
    return terminals;
  }

  function attach(id) {
    if (tabs.has(id)) return tabs.get(id);
    const host = el('div', 'tm-term');
    host.hidden = true;
    stage.append(host);
    const term = new Terminal({
      theme: THEME,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: innerWidth < 500 ? 12 : 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: false,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(host);
    const t = { id, term, fit, host, ws: null, info: null, closing: false, retry: 0 };
    tabs.set(id, t);
    term.onData((d) => {
      let data = d;
      // The key bar's Ctrl applies to the next letter typed.
      if (ctrl && d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
        ctrl = false;
        keys.querySelector('.tm-key.on')?.classList.remove('on');
      }
      if (t.ws?.readyState === 1) t.ws.send(data);
    });
    term.onResize(({ cols, rows }) => {
      if (t.ws?.readyState === 1) t.ws.send(`\0${JSON.stringify({ t: 'resize', cols, rows })}`);
    });
    connect(t);
    return t;
  }

  function connect(t) {
    try {
      t.fit.fit();
    } catch {
      // hidden
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/terminal?id=${encodeURIComponent(t.id)}&cols=${t.term.cols}&rows=${t.term.rows}`);
    t.ws = ws;
    let first = true;
    ws.onmessage = (e) => {
      const text = String(e.data);
      if (text.startsWith('\0')) {
        try {
          const msg = JSON.parse(text.slice(1));
          if (msg.t === 'exit') t.term.write(`\r\n\x1b[90m[The shell exited${msg.code ? ` with code ${msg.code}` : ''}. Close the tab or open a new one.]\x1b[0m\r\n`);
          if (msg.t === 'title') refreshTabs().catch(() => {});
        } catch {
          // ignore
        }
        return;
      }
      if (first) {
        // A reattach replays the kept output: start from a clean screen.
        t.term.reset();
        first = false;
      }
      t.term.write(text);
    };
    ws.onopen = () => (t.retry = 0);
    ws.onclose = () => {
      if (t.closing || !current) return;
      // The connection dropped (sleep, network): reattach; the shell kept running.
      t.retry = Math.min(t.retry + 1, 6);
      setTimeout(() => {
        if (!t.closing && current && tabs.get(t.id) === t) connect(t);
      }, 400 * t.retry);
    };
  }

  function show(id) {
    active = id;
    for (const t of tabs.values()) t.host.hidden = t.id !== id;
    const t = attach(id);
    t.host.hidden = false;
    requestAnimationFrame(() => {
      try {
        t.fit.fit();
      } catch {
        // not laid out yet
      }
      t.term.focus();
    });
    refreshTabs().catch(() => {});
  }

  async function newTab() {
    try {
      const probe = tabs.get(active)?.term;
      const { id } = await postJson('/api/terminals', { action: 'create', cols: probe?.cols, rows: probe?.rows });
      await refreshTabs();
      show(id);
    } catch (error) {
      showError(error.message, "Couldn't open a terminal");
    }
  }

  async function closeTab(id) {
    const t = tabs.get(id);
    if (t) {
      t.closing = true;
      t.ws?.close();
      t.term.dispose();
      t.host.remove();
      tabs.delete(id);
    }
    try {
      await postJson(`/api/terminals/${encodeURIComponent(id)}`, { action: 'close' });
    } catch {
      // already closed
    }
    const list = await refreshTabs().catch(() => []);
    if (active === id) {
      if (list.length) show(list[list.length - 1].id);
      else ctx.close();
    }
  }

  resizeObs = new ResizeObserver(() => {
    const t = tabs.get(active);
    if (!t || t.host.hidden) return;
    try {
      t.fit.fit();
    } catch {
      // hidden
    }
  });
  resizeObs.observe(stage);

  current = { ctx, refresh: () => refreshTabs().catch(() => {}), close: () => ctx.close() };
  try {
    const list = await refreshTabs();
    if (list.length) show(list[0].id);
    else await newTab();
  } catch (error) {
    showError(error.message, "Couldn't open the terminal");
  }
  return current;
}

/** Called when the server says the tabs changed. */
export function terminalsChanged() {
  current?.refresh();
}
