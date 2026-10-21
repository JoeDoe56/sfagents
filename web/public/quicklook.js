/**
 * Quick Look for the file manager: a full-screen viewer for images, video,
 * audio, PDFs, Markdown, HTML (shown without scripts), text and code, with
 * an editor for text files. Swipe or use the arrow keys to move between the
 * files of the folder. Anything else shows its icon, details and actions.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { getJson, postJson, rawUrl } from './api.js';
import { renderMarkdown } from './markdown.js';
import { alertDialog, showError } from './dialogs.js';
import { bytesText, dateText } from './format.js';
import { makeGlass } from './modalsheet.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(symbol, label, onClick) {
  const b = el('button', 'ql-btn glass');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  const i = el('i');
  applySymbol(i, symbol, { size: 16 });
  b.append(i);
  b.addEventListener('click', onClick);
  return b;
}

const TEXT_KINDS = new Set(['text', 'code', 'spreadsheet']);
const NO_PREVIEW = /\.(heic|heif|tif|tiff|mkv|avi)$/i;

/**
 * @param {{item: object, items?: object[], iconFor: (item: object) => Node, actions: {share: Function, download: Function, info: Function, ask?: Function, menu?: Function}, onSaved?: Function}} options
 */
export function openQuickLook(options) {
  const items = (options.items ?? [options.item]).filter((i) => i.kind !== 'folder');
  let index = Math.max(0, items.findIndex((i) => i.path === options.item.path));
  const layer = el('div', 'ql-layer');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  const top = el('header', 'ql-top');
  const titleWrap = el('div', 'ql-title');
  const title = el('h2', '');
  const meta = el('span', 'ql-meta');
  titleWrap.append(title, meta);
  const close = iconButton('xmark', 'Close', () => dismiss());
  const editBtn = iconButton('square.and.pencil', 'Edit', () => startEdit());
  const more = iconButton('ellipsis', 'More', (e) => options.actions.menu?.(current(), e.currentTarget));
  const share = iconButton('square.and.arrow.up', 'Share', () => options.actions.share(current()));
  top.append(close, titleWrap, editBtn, share, more);
  const stage = el('div', 'ql-stage');
  const prev = iconButton('chevron.left', 'Previous', () => go(-1));
  const next = iconButton('chevron.right', 'Next', () => go(1));
  prev.classList.add('ql-nav', 'prev');
  next.classList.add('ql-nav', 'next');
  const shade = el('div', 'ql-shade');
  layer.append(stage, shade, top, prev, next);
  document.body.append(layer);
  layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
  // The buttons are real Liquid Glass over the file being shown.
  const glass = makeGlass({
    host: layer,
    scroller: stage,
    background: '#000000',
    edges: () => {
      const r = shade.getBoundingClientRect();
      return [{ from: 'top', top: r.top, height: r.height, opacity: 1, stops: [[0, 0.72], [1, 0]] }];
    },
  });
  const glassBands = () => {
    if (!glass) return;
    const rects = [top, prev, next].map((n) => n.getBoundingClientRect()).filter((r) => r.height);
    glass.setBands(rects.map((r) => ({ top: r.top, bottom: r.bottom })));
    glass.invalidate();
  };
  if (glass) {
    for (const b of [close, editBtn, more, share, prev, next]) glass.lens(b, 'control');
    new ResizeObserver(glassBands).observe(layer);
    stage.addEventListener('load', () => glass.repaint(), true);
    glassBands();
  }

  let editor = null;
  const current = () => items[index];

  async function show() {
    const item = current();
    editor = null;
    title.textContent = item.name;
    meta.textContent = [item.type, item.size !== null ? bytesText(item.size, false) : null, dateText(item.modified, true)].filter(Boolean).join(' · ');
    prev.hidden = index <= 0;
    next.hidden = index >= items.length - 1;
    editBtn.hidden = !(TEXT_KINDS.has(item.kind) && item.writable) || (item.size ?? 0) > 5 * 1024 * 1024;
    stage.replaceChildren();
    const url = rawUrl(item.path);
    const lower = item.name.toLowerCase();
    if (item.kind === 'image' && !NO_PREVIEW.test(lower)) {
      const img = el('img', 'ql-image');
      img.src = url;
      img.alt = item.name;
      stage.append(img);
    } else if (item.kind === 'video' && !NO_PREVIEW.test(lower)) {
      const v = el('video', 'ql-video');
      v.src = url;
      v.controls = true;
      v.playsInline = true;
      v.preload = 'metadata';
      stage.append(v);
    } else if (item.kind === 'audio') {
      const wrap = el('div', 'ql-audio');
      wrap.append(options.iconFor(item, 96));
      const a = el('audio');
      a.src = url;
      a.controls = true;
      wrap.append(el('p', 'ql-file-name', item.name), a);
      stage.append(wrap);
    } else if (item.kind === 'pdf' || /\.html?$/.test(lower) || /\.svg$/.test(lower)) {
      const frame = el('iframe', 'ql-frame');
      frame.src = url;
      frame.title = item.name;
      // HTML from disk is served with a sandbox that allows no scripts.
      frame.setAttribute('sandbox', item.kind === 'pdf' ? 'allow-same-origin allow-downloads' : '');
      if (item.kind === 'pdf') frame.removeAttribute('sandbox');
      stage.append(frame);
    } else if (TEXT_KINDS.has(item.kind) || item.mime?.startsWith('text/')) {
      const box = el('div', 'ql-text');
      stage.append(box);
      try {
        const t = await getJson('/api/files/text', { path: item.path });
        if (current() !== item) return;
        if (/\.(md|markdown)$/.test(lower)) {
          const doc = el('article', 'ql-markdown markdown');
          doc.innerHTML = renderMarkdown(t.text);
          box.append(doc);
        } else {
          const pre = el('pre', 'ql-code');
          pre.textContent = t.text;
          box.append(pre);
        }
        box.dataset.modified = String(t.modified);
        box._text = t.text;
      } catch (error) {
        box.replaceChildren(fallback(item, error.message));
      }
    } else {
      stage.append(fallback(item));
    }
  }

  function fallback(item, note) {
    const wrap = el('div', 'ql-other');
    wrap.append(options.iconFor(item, 120), el('p', 'ql-file-name', item.name), el('p', 'ql-file-meta', `${item.type} · ${item.size !== null ? bytesText(item.size, false) : ''}`));
    if (note) wrap.append(el('p', 'ql-file-meta', note));
    const actions = el('div', 'ql-actions');
    const dl = el('button', 'ui-button primary', 'Download');
    dl.type = 'button';
    dl.addEventListener('click', () => options.actions.download(item));
    actions.append(dl);
    if (options.actions.ask) {
      const ask = el('button', 'ui-button', 'Ask SF Agents');
      ask.type = 'button';
      ask.addEventListener('click', () => options.actions.ask(item));
      actions.append(ask);
    }
    wrap.append(actions);
    return wrap;
  }

  async function startEdit() {
    const item = current();
    let data;
    try {
      data = await getJson('/api/files/text', { path: item.path });
    } catch (error) {
      await showError(error.message, `Can't edit "${item.name}"`);
      return;
    }
    stage.replaceChildren();
    const box = el('div', 'ql-editor');
    const area = el('textarea', 'ql-textarea');
    area.value = data.text;
    area.spellcheck = item.kind === 'text';
    area.setAttribute('autocapitalize', 'off');
    const bar = el('div', 'ql-editbar');
    const status = el('span', 'ql-status', '');
    const cancel = el('button', 'ui-button', 'Cancel');
    const save = el('button', 'ui-button primary', 'Save');
    cancel.type = save.type = 'button';
    bar.append(status, cancel, save);
    box.append(area, bar);
    stage.append(box);
    area.focus();
    editBtn.hidden = true;
    let modified = data.modified;
    let dirty = false;
    area.addEventListener('input', () => {
      dirty = true;
      status.textContent = 'Edited';
    });
    const doSave = async (force = false) => {
      try {
        const saved = await postJson('/api/files/text', { path: item.path, text: area.value, modified, force });
        modified = saved.modified;
        Object.assign(item, saved);
        dirty = false;
        status.textContent = 'Saved';
        options.onSaved?.(item);
      } catch (error) {
        if (error.status === 409) {
          const { action } = await alertDialog({
            title: `"${item.name}" changed on disk`,
            message: 'Another program changed it after you opened it here.',
            actions: [
              { label: 'Keep Editing', role: 'cancel', value: 'cancel' },
              { label: 'Replace It', role: 'destructive', value: 'replace' },
            ],
          });
          if (action === 'replace') await doSave(true);
        } else await showError(error.message, `Couldn't save "${item.name}"`);
      }
    };
    save.addEventListener('click', () => doSave());
    cancel.addEventListener('click', async () => {
      if (dirty) {
        const { action } = await alertDialog({ title: 'Discard your changes?', actions: [{ label: 'Keep Editing', role: 'cancel', value: 'keep' }, { label: 'Discard', role: 'destructive', value: 'discard' }] });
        if (action !== 'discard') return;
      }
      show();
    });
    area.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        doSave();
      }
    });
    editor = { dirty: () => dirty };
  }

  function go(step) {
    const nextIndex = index + step;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    if (editor?.dirty()) return;
    index = nextIndex;
    stage.animate([{ opacity: 0, transform: `translateX(${step * 30}px)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE });
    show();
  }

  // Swipe between files (not while zoomed or editing).
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    if (editor || e.pointerType === 'mouse' || e.target.closest('video, audio, iframe, textarea, .ql-text')) return;
    swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && (window.visualViewport?.scale ?? 1) <= 1.01) go(dx < 0 ? 1 : -1);
    else if (dy > 120 && Math.abs(dy) > Math.abs(dx) * 1.5) dismiss();
  });

  function onKey(e) {
    if (document.querySelector('.menu-layer, .dialog-layer')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editor?.dirty()) return;
      dismiss();
    } else if (!editor && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      go(e.key === 'ArrowRight' ? 1 : -1);
    } else if (!editor && e.key === ' ' && !e.target.closest?.('video, audio')) {
      e.preventDefault();
      dismiss();
    }
  }
  window.addEventListener('keydown', onKey, true);

  async function dismiss() {
    if (editor?.dirty()) {
      const { action } = await alertDialog({ title: 'Discard your changes?', actions: [{ label: 'Keep Editing', role: 'cancel', value: 'keep' }, { label: 'Discard', role: 'destructive', value: 'discard' }] });
      if (action !== 'discard') return;
    }
    window.removeEventListener('keydown', onKey, true);
    layer.querySelectorAll('video, audio').forEach((m) => m.pause());
    glass?.destroy();
    layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).onfinish = () => layer.remove();
  }

  show();
  return { close: dismiss };
}
