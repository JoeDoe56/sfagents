/**
 * Artifact tiles (equal glass squares in the sheet) and the viewer.
 */

import { renderMarkdown, escapeHtml } from './markdown.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';

const ICONS = {
  app: 'macwindow',
  pdf: 'doc.richtext',
  video: 'film',
  audio: 'waveform',
  genui: 'square.grid.2x2',
  document: 'doc.richtext',
  html: 'globe',
  image: 'photo',
  code: 'chevron.left.slash.chevron.right',
  data: 'chart.bar',
  text: 'doc.text',
};

const previews = new Map(); // `${id}:${rev}` → {kind, text}

export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function loadPreview(a) {
  const key = `${a.id}:${a.version ?? a.rev}`;
  if (previews.has(key)) return previews.get(key);
  let value = { kind: 'icon' };
  if (a.type === 'image') value = { kind: 'image' };
  else if (a.type === 'app' || a.missing || !['document', 'code', 'data', 'text', 'genui'].includes(a.type)) value = { kind: 'icon' };
  else {
    try {
      const res = await fetch(`${a.url}?rev=${a.version ?? a.rev}`);
      if (res.ok) {
        const text = (await res.text()).slice(0, 1200);
        value = { kind: a.type === 'document' ? 'prose' : 'code', text };
      }
    } catch {
      // keep the icon
    }
  }
  previews.set(key, value);
  return value;
}

function proseExcerpt(md) {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Renders a list of artifacts into a tile container, reusing tiles by id.
 * Returns the tile elements (for glass lenses).
 */
export function renderTiles(container, artifacts, { onOpen, onPin }) {
  const existing = new Map([...container.children].map((el) => [el.dataset.id, el]));
  const wanted = [];
  for (const a of artifacts) {
    const sig = `${a.version ?? a.rev}|${a.pinned}|${a.title}|${a.updated}|${a.missing ? 1 : 0}`;
    let tile = existing.get(a.id);
    if (!tile || tile.dataset.sig !== sig) {
      tile?.remove();
      tile = buildTile(a, { onOpen, onPin });
      tile.dataset.sig = sig;
    }
    existing.delete(a.id);
    wanted.push(tile);
  }
  for (const stale of existing.values()) stale.remove();
  wanted.forEach((tile, i) => {
    if (container.children[i] !== tile) container.insertBefore(tile, container.children[i] ?? null);
  });
  return wanted;
}

function buildTile(a, { onOpen, onPin }) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.glass = 'tile';
  tile.dataset.id = a.id;
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-label', `${a.title}, ${a.filename}`);
  const content = document.createElement('div');
  content.className = 'tile-content above';
  const preview = document.createElement('div');
  preview.className = 'tile-preview';
  const icon = document.createElement('i');
  icon.className = 'tile-icon';
  applySymbol(icon, ICONS[a.type] || 'doc', { size: 30 });
  preview.append(icon);
  const title = document.createElement('div');
  title.className = 'tile-title';
  title.textContent = a.title;
  const meta = document.createElement('div');
  meta.className = 'tile-meta';
  meta.textContent = `${a.missing ? 'File missing' : a.filename} · ${relativeTime(a.updated)}`;
  content.append(preview, title, meta);
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'tile-pin above';
  pin.setAttribute('aria-pressed', String(a.pinned));
  pin.setAttribute('aria-label', a.pinned ? `Unpin ${a.title}` : `Pin ${a.title}`);
  const pinIcon = document.createElement('i');
  applySymbol(pinIcon, a.pinned ? 'pin.fill' : 'pin', { size: 13 });
  pin.append(pinIcon);
  pin.addEventListener('click', (e) => {
    e.stopPropagation();
    onPin(a, !a.pinned);
  });
  tile.append(content, pin);
  tile.addEventListener('click', () => onOpen(a));
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(a);
    }
  });
  loadPreview(a).then((p) => {
    if (p.kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = `${a.url}?rev=${a.version ?? a.rev}`;
      preview.className = 'tile-preview image';
      preview.replaceChildren(img);
    } else if (p.kind === 'prose' || p.kind === 'code') {
      preview.className = `tile-preview ${p.kind === 'prose' ? 'prose' : ''}`;
      preview.textContent = p.kind === 'prose' ? proseExcerpt(p.text) : p.text;
    }
  });
  return tile;
}

/**
 * An artifact in the chat, where it was made: a preview with its title and
 * file name, like a shared document in Messages. Tapping it opens it.
 */
export function chatCard(a, onOpen) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'art-card';
  card.setAttribute('aria-label', `Open ${a.title}`);
  const preview = document.createElement('div');
  preview.className = 'art-card-preview';
  const icon = document.createElement('i');
  applySymbol(icon, ICONS[a.type] || 'doc', { size: 34 });
  preview.append(icon);
  const foot = document.createElement('div');
  foot.className = 'art-card-foot';
  const small = document.createElement('i');
  applySymbol(small, ICONS[a.type] || 'doc', { size: 15 });
  const text = document.createElement('div');
  text.className = 'art-card-text';
  const title = document.createElement('strong');
  title.textContent = a.title;
  const meta = document.createElement('span');
  meta.textContent = a.missing ? `${a.filename} · file missing` : a.type === 'app' ? `App · ${a.filename}` : a.filename;
  text.append(title, meta);
  foot.append(small, text);
  card.append(preview, foot);
  card.addEventListener('click', () => onOpen(a));
  loadPreview(a).then((p) => {
    if (p.kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = `${a.url}?rev=${a.version ?? a.rev}`;
      preview.className = 'art-card-preview image';
      preview.replaceChildren(img);
    } else if (a.type === 'html' && !a.missing) {
      // A web page: a scaled, script-free render.
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.setAttribute('tabindex', '-1');
      frame.loading = 'lazy';
      frame.src = `${a.url}?rev=${a.version ?? a.rev}`;
      preview.className = 'art-card-preview page';
      preview.replaceChildren(frame);
    } else if (p.kind === 'prose' || p.kind === 'code') {
      preview.className = `art-card-preview text ${p.kind}`;
      preview.textContent = p.kind === 'prose' ? proseExcerpt(p.text) : p.text;
    }
  });
  return card;
}

/** The full-screen artifact viewer. */
export function createViewer({ root, title, meta, body, close, pin, open, download, onPin }) {
  let current = null;
  let lastFocus = null;

  function hide() {
    root.hidden = true;
    body.replaceChildren();
    current = null;
    lastFocus?.focus?.();
  }

  async function show(a) {
    current = a;
    lastFocus = document.activeElement;
    title.textContent = a.title;
    meta.textContent = `${a.filename} · revision ${a.rev} · ${relativeTime(a.updated)}`;
    updatePin(a.pinned);
    const raw = `${a.url}?rev=${a.version ?? a.rev}`;
    open.href = raw;
    download.href = `${raw}&download=1`;
    download.setAttribute('download', a.filename);
    body.replaceChildren();
    root.hidden = false;
    close.focus();
    if (a.type === 'html') {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = a.title;
      frame.src = raw;
      body.append(frame);
      return;
    }
    if (a.type === 'image') {
      const wrap = document.createElement('div');
      wrap.className = 'image';
      const img = document.createElement('img');
      img.alt = a.title;
      img.src = raw;
      wrap.append(img);
      body.append(wrap);
      return;
    }
    let text = '';
    try {
      const res = await fetch(raw);
      text = res.ok ? await res.text() : `Could not load this artifact (${res.status}).`;
    } catch (error) {
      text = `Could not load this artifact: ${error.message}`;
    }
    if (current !== a) return;
    if (a.type === 'document') {
      const doc = document.createElement('article');
      doc.className = 'doc';
      doc.innerHTML = renderMarkdown(text);
      body.append(doc);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'code';
      pre.innerHTML = escapeHtml(text);
      body.append(pre);
    }
  }

  function updatePin(pinned) {
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
    applySymbol(pin.querySelector('i'), pinned ? 'pin.fill' : 'pin', { size: 16 });
  }

  close.addEventListener('click', hide);
  pin.addEventListener('click', () => {
    if (!current) return;
    onPin(current, !current.pinned);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hide();
    }
  });

  return {
    show,
    hide,
    get open() {
      return !root.hidden;
    },
    /** Keeps the open viewer in step with a refreshed artifact list. */
    refresh(artifacts) {
      if (!current) return;
      const next = artifacts.find((x) => x.id === current.id);
      if (!next) return hide();
      if (next.rev !== current.rev) return show(next);
      current = next;
      updatePin(next.pinned);
    },
  };
}
