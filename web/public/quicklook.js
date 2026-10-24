/**
 * Quick Look for the file manager: a full-screen viewer for images, video,
 * audio, PDFs, Markdown, HTML (shown without scripts), text and code, with
 * an editor for text files. Swipe or use the arrow keys to move between the
 * files of the folder. Anything else shows its icon, details and actions.
 */

import { getJson, postJson, rawUrl } from './api.js';
import { renderMarkdown } from './markdown.js';
import { alertDialog, showError } from './dialogs.js';
import { createSheet, createButton, confirmDiscard } from './vendor/sfgl/src/ui/index.js';
import { bytesText, dateText } from './format.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const TEXT_KINDS = new Set(['text', 'code', 'spreadsheet']);
const NO_PREVIEW = /\.(heic|heif|tif|tiff|mkv|avi)$/i;

/**
 * @param {{item: object, items?: object[], iconFor: (item: object) => Node, actions: {share: Function, download: Function, info: Function, ask?: Function, menu?: Function}, onSaved?: Function}} options
 */
export function openQuickLook(options) {
  const items = (options.items ?? [options.item]).filter((i) => i.kind !== 'folder');
  let index = Math.max(0, items.findIndex((i) => i.path === options.item.path));
  const titleWrap = el('div', 'sf-sheet-title ql-title');
  const title = el('h2', '');
  const meta = el('span', 'ql-meta');
  titleWrap.append(title, meta);
  // While editing, the close button leaves the editor (the preview stays) and the check saves.
  const close = createButton({ symbol: 'xmark', aria: 'Close', size: 'large' });
  const editBtn = createButton({ symbol: 'pencil', aria: 'Edit', size: 'large' });
  const checkBtn = createButton({ symbol: 'checkmark', aria: 'Save', size: 'large' });
  const more = createButton({ symbol: 'ellipsis', aria: 'More', size: 'large' });
  const share = createButton({ symbol: 'square.and.arrow.up', aria: 'Share', size: 'large' });
  const prev = createButton({ symbol: 'chevron.left', aria: 'Previous', size: 'large', className: 'ql-nav prev' });
  const next = createButton({ symbol: 'chevron.right', aria: 'Next', size: 'large', className: 'ql-nav next' });
  const titleItem = { id: 'title', node: titleWrap, size: 'fill', height: 48, glass: false };
  const btn = (id, b) => ({ id, node: b.el, size: 44, height: 48 });
  const sheet = createSheet({
    kind: 'button',
    source: options.source,
    detents: ['large'],
    handle: true,
    label: 'Quick Look',
    header: {
      edge: 'top',
      layout: 'view',
      layouts: {
        view: [[btn('close', close), titleItem, btn('edit', editBtn), btn('share', share), btn('more', more)]],
        readonly: [[btn('close', close), titleItem, btn('share', share), btn('more', more)]],
        editing: [[btn('close', close), titleItem, btn('save', checkBtn)]],
      },
    },
    closeSource: () => close.el,
    onClose: () => {
      window.removeEventListener('keydown', onKey, true);
      sheet.el.querySelectorAll('video, audio').forEach((m) => m.pause());
    },
  });
  sheet.el.classList.add('ql-sheet');
  sheet.layer.el.classList.add('ql-layer');
  const stage = el('div', 'ql-stage');
  sheet.body.append(stage);
  sheet.el.append(prev.el, next.el);
  close.el.addEventListener('click', () => {
    if (editor) leaveEdit();
  });
  editBtn.el.addEventListener('click', () => startEdit());
  checkBtn.el.addEventListener('click', () => editor?.save());
  more.el.addEventListener('click', (e) => options.actions.menu?.(current(), more.el, e));
  share.el.addEventListener('click', () => options.actions.share(current()));
  prev.el.addEventListener('click', () => go(-1));
  next.el.addEventListener('click', () => go(1));
  sheet.present('large');

  let editor = null;
  let canEdit = false;
  const current = () => items[index];

  /** The chrome for previewing or for editing. */
  function setEditing(on) {
    sheet.header.setLayout(on ? 'editing' : canEdit ? 'view' : 'readonly');
    close.el.setAttribute('aria-label', on ? 'Stop editing' : 'Close');
    close.el.title = on ? 'Stop editing' : 'Close';
    sheet.el.classList.toggle('editing', on);
  }

  function setSaveReady(on) {
    sheet.setDirty(on);
    checkBtn.setTint(on ? 'action' : null);
  }

  async function leaveEdit() {
    if (editor?.dirty() && !(await confirmDiscard({ source: close.el, title: 'Discard your changes?', discardLabel: 'Discard Changes' }))) return;
    setSaveReady(false);
    show();
  }

  async function show() {
    const item = current();
    editor = null;
    title.textContent = item.name;
    meta.textContent = [item.type, item.size !== null ? bytesText(item.size, false) : null, dateText(item.modified, true)].filter(Boolean).join(' · ');
    prev.el.hidden = index <= 0;
    next.el.hidden = index >= items.length - 1;
    canEdit = (TEXT_KINDS.has(item.kind) && item.writable) && (item.size ?? 0) <= 5 * 1024 * 1024;
    setEditing(false);
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
    actions.append(createButton({ symbol: 'arrow.down', label: 'Download', size: 'large', tint: 'action', onClick: () => options.actions.download(item) }).el);
    if (options.actions.ask) actions.append(createButton({ label: 'Ask SF Agents', size: 'large', onClick: () => options.actions.ask(item) }).el);
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
    box.append(area);
    stage.append(box);
    area.focus();
    setEditing(true);
    let modified = data.modified;
    let dirty = false;
    area.addEventListener('input', () => {
      if (!dirty) setSaveReady(true);
      dirty = true;
    });
    setSaveReady(false);
    // The check saves and, once it is saved, leaves the editor for the updated preview.
    const doSave = async (force = false) => {
      checkBtn.setDisabled(true);
      try {
        const saved = await postJson('/api/files/text', { path: item.path, text: area.value, modified, force });
        modified = saved.modified;
        Object.assign(item, saved);
        dirty = false;
        setSaveReady(false);
        options.onSaved?.(item);
        show();
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
      } finally {
        checkBtn.setDisabled(false);
      }
    };
    area.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        doSave();
      }
    });
    editor = { dirty: () => dirty, save: () => (dirty ? doSave() : show()) };
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
    if (document.querySelector('.sf-pop')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editor) leaveEdit();
      else dismiss();
    } else if (!editor && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      go(e.key === 'ArrowRight' ? 1 : -1);
    } else if (!editor && e.key === ' ' && !e.target.closest?.('video, audio')) {
      e.preventDefault();
      dismiss();
    }
  }
  window.addEventListener('keydown', onKey, true);

  function dismiss() {
    sheet.requestClose();
  }

  show().then(() => {
    if (options.edit && canEdit) startEdit();
  });
  return { close: dismiss };
}
