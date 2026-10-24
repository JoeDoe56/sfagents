/**
 * The file manager: the resource monitor expanded into its own opaque sheet.
 *
 * The monitor's expand button grows into a glass close button at the top
 * left; the stats become a strip of glass chips beside it (each opens its
 * window); a ⋯ button at the top right holds Upload, New Folder, Select,
 * view and sort options; the drive bars become Liquid Glass bars along the
 * bottom. In between is a Files-style browser: Browse (locations, drives,
 * favorites, Trash), folders as lists or icons, search, Quick Look and an
 * editor, hold menus like Apple Music's, selection with a toolbar, a folder
 * picker for Move and Copy, Get Info, compress and uncompress, Trash with
 * Put Back, uploads into the open folder (button or drop), and "Ask SF
 * Agents", which attaches a file to the message being written.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { getJson, postJson, waitJob, rawUrl, zipUrl } from './api.js';
import { showMenu, onHold, closeMenu } from './menu.js';
import { alertDialog, confirmDialog, promptDialog, showError, toast } from './dialogs.js';
import { openPeek, group, row, button as peekButton, el as peekEl } from './peek.js';
import { openQuickLook } from './quicklook.js';
import { UploadJob } from './up2k.js';
import { createSheet, createButton, createField, standardHeader } from './vendor/sfgl/src/ui/index.js';
import { DASH, bytesText, dateText, fullDate, formatUsedTotal, percentText, rateText, temperature, formatDuration, plural } from './format.js';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sym(name, size = 16) {
  const i = el('i');
  applySymbol(i, name, { size });
  return i;
}

function read(key, fallback) {
  try {
    const v = localStorage.getItem(`sfagents.files.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(`sfagents.files.${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable: the preference lasts for this page
  }
}

const sep = (p) => (p.includes('\\') && !p.startsWith('/') ? '\\' : '/');
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
function parentOf(p) {
  const s = sep(p);
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = trimmed.lastIndexOf(s);
  if (i < 0) return null;
  if (i === 0) return trimmed.length > 1 ? s : null;
  // "C:\" stays a drive root.
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, i))) return `${trimmed.slice(0, i)}\\`;
  return trimmed.slice(0, i);
}
const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}${sep(dir)}${name}`;

/** Path segments for the breadcrumbs: [{name, path}]. */
function crumbs(p) {
  const out = [];
  let cur = p;
  while (cur) {
    out.unshift({ name: baseName(cur) || cur, path: cur });
    const up = parentOf(cur);
    if (!up || up === cur) break;
    cur = up;
  }
  return out;
}

// ------------------------------------------------------------------ icons

const KIND_ICON = {
  folder: ['folder.fill', '#5ac8fa'],
  image: ['photo', '#30d158'],
  video: ['film', '#bf5af2'],
  audio: ['music.note', '#ff375f'],
  pdf: ['doc.richtext', '#ff453a'],
  text: ['doc.text.fill', '#8e8e93'],
  code: ['chevron.left.slash.chevron.right', '#ff9f0a'],
  archive: ['archivebox.fill', '#a2845e'],
  document: ['doc.text.fill', '#0a84ff'],
  spreadsheet: ['chart.bar', '#30d158'],
  presentation: ['play.rectangle.fill', '#ff9f0a'],
  font: ['textformat', '#8e8e93'],
  app: ['app', '#0a84ff'],
  disk: ['tray.full.fill', '#8e8e93'],
  other: ['doc.fill', '#8e8e93'],
};

const THUMB = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

/** An item's icon tile: a thumbnail for images, else its kind's symbol. */
export function iconFor(item, size = 40) {
  const tile = el('span', `fm-icon kind-${item.kind}`);
  tile.style.setProperty('--size', `${size}px`);
  if (item.kind === 'image' && THUMB.test(item.name) && (item.size ?? 0) < 25 * 1024 * 1024) {
    const img = el('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = rawUrl(item.path);
    img.addEventListener('error', () => img.replaceWith(sym('photo', Math.round(size * 0.55))));
    tile.classList.add('thumb');
    tile.append(img);
    return tile;
  }
  const [name, color] = KIND_ICON[item.kind] ?? KIND_ICON.other;
  const i = sym(name, Math.round(size * (item.kind === 'folder' ? 0.72 : 0.55)));
  tile.style.color = color;
  tile.append(i);
  if (item.link) tile.append(el('span', 'fm-alias', '↗'));
  return tile;
}

function subtitle(item) {
  if (item.kind === 'folder') return [Number.isFinite(item.items) ? plural(item.items, 'item') : null, dateText(item.modified)].filter(Boolean).join(' · ');
  return [bytesText(item.size, false), dateText(item.modified)].join(' · ');
}

// ------------------------------------------------------------------ sorting

const SORTS = {
  name: { label: 'Name', cmp: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) },
  date: { label: 'Date', cmp: (a, b) => b.modified - a.modified },
  size: { label: 'Size', cmp: (a, b) => (b.size ?? -1) - (a.size ?? -1) || (b.items ?? 0) - (a.items ?? 0) },
  kind: { label: 'Kind', cmp: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, undefined, { numeric: true }) },
};

function sorted(entries, sort) {
  const s = SORTS[sort.key] ?? SORTS.name;
  const list = [...entries].sort((a, b) => s.cmp(a, b) * (sort.desc ? -1 : 1));
  // Folders first, as Files and Finder keep them when sorting by name or kind.
  if (sort.key === 'name' || sort.key === 'kind') list.sort((a, b) => (a.kind === 'folder') - (b.kind === 'folder') === 0 ? 0 : a.kind === 'folder' ? -1 : 1);
  return list;
}

// ------------------------------------------------------------------ clipboard text

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not a secure context (an address other than localhost): the old way.
    const area = el('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// ------------------------------------------------------------------ the sheet

/**
 * @param {{monitorEl: HTMLElement, openWindow: (key: string, from: Element, openInFiles: Function) => void,
 *   attach: (ref: object) => void, onOpenChange?: (open: boolean) => void}} options
 */
export function createFileManager(options) {
  // The sheet is rebuilt each time Files opens (its content nodes below are
  // kept); its header and footer are the framework's bars.
  let sheet = null;
  let root = null;
  let scroller = null;
  let closeBtn = null;
  let moreBtn = null;
  let doneBtn = null;
  let statsBtn = null;
  let toolbar = null;
  let picker = null;
  let dropHint = null;
  let statsOpen = false;
  let pendingFrom = null;

  const hero = el('div', 'fm-hero');
  const nav = el('div', 'fm-nav');
  const back = el('button', 'fm-back');
  back.type = 'button';
  back.append(sym('chevron.left', 18), el('span', 'fm-back-label', ''));
  const selectAll = el('button', 'fm-textbtn', 'Select All');
  selectAll.type = 'button';
  selectAll.hidden = true;
  nav.append(back, selectAll);
  const title = el('h1', 'fm-title', 'Browse');
  const info = el('p', 'fm-info');
  const path = el('div', 'fm-path');
  const searchField = createField({ placeholder: 'Search', look: 'card', multiline: false, maxRows: 1, inputMode: 'search', autocapitalize: 'off', aria: 'Search this folder and the folders in it', leading: [sym('magnifyingglass', 15)] });
  const searchWrap = searchField.el;
  searchWrap.classList.add('fm-search');
  const search = searchField.input;
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('enterkeyhint', 'search');
  hero.append(nav, title, info, path, searchWrap);
  const content = el('div', 'fm-content');

  const headerLayout = () => `${state.selecting ? 'select' : 'browse'}${statsOpen ? '-stats' : ''}`;
  const footerLayout = () => (state.selecting ? 'select' : 'drives');
  const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

  function buildSheet(from) {
    statsOpen = false;
    chipNodes.clear();
    driveNodes.clear();
    driveOrder = [];
    closeBtn = createButton({ symbol: 'xmark', aria: 'Close', size: 'large' });
    moreBtn = createButton({ symbol: 'ellipsis', aria: 'More', size: 'large' });
    doneBtn = createButton({ label: 'Done', aria: 'Done', size: 'large' });
    statsBtn = createButton({ symbol: 'gauge', label: 'System', aria: 'System statistics', size: 'large' });
    toolbar = el('div', 'fm-toolbar');
    // The statistics: one button that opens a second row of chips below it. They
    // stay separate buttons, because each opens a window (not a tab).
    const chipItems = CHIPS.map(([key, label]) => {
      const chip = el('button', 'fm-chip');
      chip.type = 'button';
      const v = el('span', 'fm-chip-value', DASH);
      chip.append(el('span', 'fm-chip-label', label), v);
      chip.addEventListener('click', () => options.openWindow(key, chip, (p, o) => navigate(p, o)));
      chipNodes.set(key, v);
      return { id: `chip-${key}`, node: chip, size: 'fill', height: 48, glass: 'control', from: 'stats', into: 'stats' };
    });
    const chipRows = chunk(chipItems, 3);
    const top = (right) => [{ id: 'close', node: closeBtn.el, size: 44, height: 48 }, { id: 'stats', node: statsBtn.el, size: 'fill', height: 48 }, right];
    const more = { id: 'more', node: moreBtn.el, size: 44, height: 48, into: 'done' };
    const done = { id: 'done', node: doneBtn.el, size: 88, height: 48, from: 'more' };
    sheet = createSheet({
      kind: 'button',
      source: from ?? options.monitorEl,
      detents: ['large'],
      handle: true,
      label: 'Files',
      header: { edge: 'top', layout: headerLayout(), layouts: { browse: [top(more)], 'browse-stats': [top(more), ...chipRows], select: [top(done)], 'select-stats': [top(done), ...chipRows] } },
      footer: {
        edge: 'bottom',
        layout: footerLayout(),
        layouts: { drives: [[]], select: [[{ id: 'toolbar', node: toolbar, size: 'fill', height: 56, glass: 'bar' }]] },
      },
      // Escape leaves selection first.
      onEscape: () => (state.selecting ? (setSelecting(false), true) : false),
      onClose: () => finishClose(),
    });
    root = sheet.layer.el;
    scroller = sheet.body;
    sheet.el.classList.add('fm', 'fm-inner');
    scroller.append(hero, content);
    dropHint = el('div', 'fm-drop', '');
    dropHint.append(sym('tray.and.arrow.down', 34), el('span', '', 'Drop to upload here'));
    dropHint.hidden = true;
    picker = el('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;
    sheet.el.append(dropHint, picker);
    wireSheet();
    sheet.present('large');
  }

  const state = {
    open: false,
    path: read('path', null),
    listing: null,
    locations: null,
    history: [],
    view: read('view', 'list'),
    sort: read('sort', { key: 'name', desc: false }),
    hidden: read('hidden', false),
    favorites: read('favorites', []),
    selecting: false,
    selection: new Set(),
    query: '',
    results: null,
    searching: false,
    clipboard: null,
    snapshot: null,
    pendingSelect: null,
  };

  // ---------------------------------------------------------------- stats strip

  const CHIPS = [
    ['cpu', 'CPU', (s) => percentText(s.cpu.usage)],
    ['gpu', 'GPU', (s) => (s.gpu ? percentText(s.gpu.usage) : DASH)],
    ['memory', 'Memory', (s) => percentText(s.memory.used / s.memory.total)],
    ['disk', 'Disk', (s) => (s.disk ? (Number.isFinite(s.disk.read) ? `R ${percentText(s.disk.read)} W ${percentText(s.disk.write)}` : rateText(s.disk.readRate + s.disk.writeRate)) : DASH)],
    ['network', 'Network', (s) => (s.network ? `↓ ${rateText(s.network.down)}` : DASH)],
    ['processes', 'Processes', (s) => (Number.isFinite(s.processes) ? s.processes.toLocaleString() : DASH)],
    ['uptime', 'Up', (s) => formatDuration(s.uptime.system)],
    ['sfagents', 'SF Agents', (s) => formatDuration(s.uptime.sfagents)],
  ];
  const chipNodes = new Map();
  function renderStats(s) {
    state.snapshot = s;
    for (const [key, , fmt] of CHIPS) {
      const text = fmt(s);
      const node = chipNodes.get(key);
      if (node && node.textContent !== text) node.textContent = text;
    }
    const t = temperature(s.cpu.temperature);
    const cpuNode = chipNodes.get('cpu');
    if (cpuNode) cpuNode.parentElement.title = t ? `CPU temperature ${t}` : '';
    statsBtn?.setLabel(`CPU ${percentText(s.cpu.usage)} · Mem ${percentText(s.memory.used / s.memory.total)}`);
    renderDrives(s);
  }

  // ---------------------------------------------------------------- drive bars

  const driveNodes = new Map(); // mount → {node, name, pct, size, fill}
  let driveOrder = [];
  function renderDrives(s) {
    const binary = s.platform !== 'darwin';
    const list = s.drives ?? [];
    const seen = new Set();
    let changed = false;
    const order = [...driveOrder];
    list.forEach((d, i) => {
      seen.add(d.mount);
      let n = driveNodes.get(d.mount);
      if (!n) {
        const node = el('button', 'fm-drive');
        node.type = 'button';
        const fill = el('span', 'fm-drive-fill');
        const text = el('span', 'fm-drive-text');
        const name = el('span', 'fm-drive-name');
        const size = el('span', 'fm-drive-size');
        const pct = el('span', 'fm-drive-pct');
        text.append(name, size, pct);
        node.append(fill, text);
        node.addEventListener('click', () => navigate(d.mount));
        n = { node, name, size, pct, fill };
        driveNodes.set(d.mount, n);
        changed = true;
      }
      const frac = d.total > 0 ? Math.max(0, Math.min(1, d.used / d.total)) : 0;
      n.node.classList.toggle('full', frac >= 0.9);
      n.node.classList.toggle('warn', frac >= 0.8 && frac < 0.9);
      n.node.title = `${d.name} (${d.mount}): ${bytesText(d.total - d.used, binary)} available`;
      n.node.setAttribute('aria-label', `${d.name}, ${Math.round(frac * 100)}% full, ${formatUsedTotal(d.used, d.total, binary)}`);
      if (n.name.textContent !== d.name) n.name.textContent = d.name;
      const sizeText = formatUsedTotal(d.used, d.total, binary);
      if (n.size.textContent !== sizeText) n.size.textContent = sizeText;
      const pctText = `${Math.round(frac * 100)}%`;
      if (n.pct.textContent !== pctText) n.pct.textContent = pctText;
      n.fill.style.width = `${(frac * 100).toFixed(2)}%`;
      if (order[i] !== n.node) changed = true;
      order[i] = n.node;
    });
    order.length = list.length;
    for (const [mount, n] of driveNodes) {
      if (!seen.has(mount)) {
        n.node.remove();
        driveNodes.delete(mount);
        changed = true;
      }
    }
    if (changed) {
      driveOrder = order.filter(Boolean);
      sheet?.footer?.setItems(
        'drives',
        chunk(driveOrder.map((node, i) => ({ id: `drive-${i}`, node, size: 'fill', height: 48, glass: 'tile' })), 3),
      );
    }
  }

  // ---------------------------------------------------------------- loading

  let loadSeq = 0;

  async function loadLocations() {
    state.locations = await getJson('/api/files/locations');
    if (state.locations.drives?.length && state.snapshot === null) renderDrives({ drives: state.locations.drives, platform: state.locations.platform });
    return state.locations;
  }

  async function refresh({ quiet = false } = {}) {
    const seq = ++loadSeq;
    try {
      if (!state.locations) await loadLocations();
      if (state.path === null) {
        if (seq === loadSeq) renderBrowse();
        return;
      }
      const listing = await getJson('/api/files/list', { path: state.path, hidden: state.hidden });
      if (seq !== loadSeq) return;
      const changed = !state.listing || state.listing.path !== listing.path || JSON.stringify(state.listing.entries) !== JSON.stringify(listing.entries);
      state.listing = listing;
      if (changed || !quiet) renderFolder();
    } catch (error) {
      if (seq !== loadSeq) return;
      if (quiet) return;
      state.listing = null;
      renderMessage(error.message, error.status === 403 ? 'lock' : 'exclamationmark.triangle');
    }
  }

  /** Opens a folder (null: Browse). `select` highlights an item in it. */
  async function navigate(path, { select = null, push = true } = {}) {
    if (push && state.path !== path) state.history.push(state.path);
    state.path = path;
    state.listing = null;
    state.query = '';
    state.results = null;
    search.value = '';
    state.selection.clear();
    state.pendingSelect = select;
    write('path', path);
    if (!state.open) return open({ path, select });
    scroller.scrollTop = 0;
    renderHeader();
    content.replaceChildren(el('div', 'fm-loading'));
    await refresh();
  }

  // ---------------------------------------------------------------- rendering

  /** Where Back goes: the parent folder; Browse from the Trash and from the top. */
  function upOf(p) {
    if (p === null || p === state.locations?.trash) return null;
    return parentOf(p);
  }

  function renderHeader() {
    const p = state.path;
    const up = upOf(p);
    back.hidden = p === null;
    back.querySelector('.fm-back-label').textContent = up ? baseName(up) : 'Browse';
    selectAll.hidden = !state.selecting;
    selectAll.textContent = state.listing && state.selection.size === state.listing.entries.length && state.selection.size ? 'Deselect All' : 'Select All';
    const placeName = state.locations?.places.find((x) => x.path === p)?.name;
    title.textContent = state.selecting ? (state.selection.size ? `${state.selection.size} Selected` : 'Select Items') : p === null ? 'Browse' : p === state.locations?.trash ? 'Trash' : placeName ?? baseName(p);
    path.replaceChildren();
    path.hidden = p === null;
    if (p !== null) {
      for (const c of crumbs(p)) {
        const b = el('button', 'fm-crumb', c.name);
        b.type = 'button';
        b.addEventListener('click', () => navigate(c.path));
        path.append(b, el('span', 'fm-crumb-sep', '›'));
      }
      path.lastElementChild?.remove();
      requestAnimationFrame(() => (path.scrollLeft = path.scrollWidth));
    }
    searchWrap.hidden = p === null;
    sheet?.header.setLayout(headerLayout());
    sheet?.footer.setLayout(footerLayout());
    if (state.selecting) renderToolbar();
  }

  function renderMessage(text, symbol) {
    renderHeader();
    const box = el('div', 'fm-empty');
    box.append(sym(symbol, 34), el('p', '', text));
    content.replaceChildren(box);
  }

  function section(titleText, nodes, cls = '') {
    const s = el('section', `fm-section ${cls}`);
    if (titleText) s.append(el('h2', 'fm-section-title', titleText));
    const list = el('div', 'fm-group');
    list.append(...nodes);
    s.append(list);
    return s;
  }

  function placeRow(name, symbol, color, onClick, detail, holdItem) {
    const b = el('button', 'fm-place');
    b.type = 'button';
    const icon = el('span', 'fm-place-icon');
    icon.style.color = color;
    icon.append(sym(symbol, 20));
    const text = el('span', 'fm-place-text');
    text.append(el('span', 'fm-place-name', name));
    if (detail) text.append(detail);
    b.append(icon, text, sym('chevron.right', 13));
    b.addEventListener('click', onClick);
    if (holdItem) onHold(b, (_t, how) => itemMenu(holdItem, b, how));
    return b;
  }

  const PLACE_ICONS = { home: 'house.fill', desktop: 'desktopcomputer', documents: 'doc.text.fill', downloads: 'arrow.down.circle', pictures: 'photo.on.rectangle', music: 'music.note.list', videos: 'tv' };

  function folderItem(p) {
    return { name: baseName(p), path: p, kind: 'folder', type: 'Folder', size: null, modified: 0, created: 0, hidden: false, writable: true, items: null };
  }

  function renderBrowse() {
    state.selecting = false;
    renderHeader();
    const loc = state.locations;
    info.textContent = '';
    const sections = [];
    const places = loc.places.map((p) => placeRow(p.name, PLACE_ICONS[p.id] ?? 'folder.fill', '#5ac8fa', () => navigate(p.path), null, folderItem(p.path)));
    if (loc.project) places.push(placeRow('SF Agents project', 'cube.box', '#bf5af2', () => navigate(loc.project), el('span', 'fm-place-detail', loc.project), folderItem(loc.project)));
    if (loc.trash) places.push(placeRow('Trash', 'trash', '#8e8e93', () => navigate(loc.trash), null, null));
    sections.push(section('Locations', places));
    const driveList = state.snapshot?.drives ?? loc.drives ?? [];
    if (driveList.length) {
      sections.push(
        section(
          'Drives',
          driveList.map((d) => {
            const detail = el('span', 'fm-place-drive');
            const bar = el('span', 'fm-drive-bar');
            const fill = el('span');
            const frac = d.total > 0 ? d.used / d.total : 0;
            fill.style.width = `${(frac * 100).toFixed(1)}%`;
            if (frac >= 0.8) fill.style.background = frac >= 0.9 ? 'var(--red)' : 'var(--orange)';
            bar.append(fill);
            detail.append(bar, el('span', 'fm-place-detail', `${bytesText(d.total - d.used, loc.platform !== 'darwin')} free of ${bytesText(d.total, loc.platform !== 'darwin')}`));
            return placeRow(d.name, d.mount === '/' || /^C:/i.test(d.mount) ? 'desktopcomputer' : 'tray.full.fill', '#8e8e93', () => navigate(d.mount), detail, folderItem(d.mount));
          }),
        ),
      );
    }
    if (state.favorites.length) sections.push(section('Favorites', state.favorites.map((p) => placeRow(baseName(p), 'star.fill', '#ffd60a', () => navigate(p), el('span', 'fm-place-detail', p), folderItem(p)))));
    content.replaceChildren(...sections);
  }

  /** The entries shown: the listing, filtered by the search field; or the search results. */
  function visibleEntries() {
    if (state.results) return state.results;
    const entries = state.listing?.entries ?? [];
    const q = state.query.trim().toLowerCase();
    const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    return sorted(filtered, state.sort);
  }

  function renderFolder() {
    const l = state.listing;
    if (!l) return;
    renderHeader();
    const entries = visibleEntries();
    const folders = l.entries.filter((e) => e.kind === 'folder').length;
    const free = state.snapshot?.drives?.filter((d) => l.path.startsWith(d.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
    info.textContent = state.results
      ? `${plural(state.results.length, 'result')} in “${baseName(l.path)}” and its folders${state.searching ? '…' : ''}`
      : [plural(l.entries.length, 'item'), folders ? plural(folders, 'folder') : null, free ? `${bytesText(free.total - free.used, state.snapshot.platform !== 'darwin')} available` : null, !l.writable ? 'read-only' : null].filter(Boolean).join(' · ');
    if (!entries.length) {
      const box = el('div', 'fm-empty');
      box.append(sym(state.query ? 'magnifyingglass' : 'folder', 34), el('p', '', state.query ? 'No items match.' : l.truncated ? '' : 'This folder is empty.'));
      if (!state.query && l.writable && l.path !== state.locations?.trash) {
        const up = createButton({ symbol: 'tray.and.arrow.up', label: 'Upload', size: 'large', glass: 'control', onClick: () => picker.click() });
        box.append(up.el);
      }
      content.replaceChildren(box);
      return;
    }
    const container = el('div', state.view === 'grid' ? 'fm-grid' : 'fm-list');
    for (const item of entries) container.append(state.view === 'grid' ? tile(item) : listRow(item));
    content.replaceChildren(container);
    if (l.truncated) content.append(el('p', 'fm-note', 'Showing the first 10,000 items.'));
    if (state.pendingSelect) {
      const target = container.querySelector(`[data-path="${CSS.escape(state.pendingSelect)}"]`);
      state.pendingSelect = null;
      if (target) {
        target.classList.add('flash');
        target.scrollIntoView({ block: 'center' });
        target.focus({ preventScroll: true });
      }
    }
  }

  function bindItem(node, item) {
    node.dataset.path = item.path;
    node.addEventListener('click', (e) => {
      if (state.selecting || e.metaKey || e.ctrlKey) {
        if (!state.selecting) setSelecting(true);
        toggleSelect(item, node);
        return;
      }
      activate(item);
    });
    node.addEventListener('dblclick', (e) => e.preventDefault());
    onHold(node, (_t, how) => {
      if (state.selecting && state.selection.size > 1 && state.selection.has(item.path)) selectionMenu(node, how);
      else itemMenu(item, node, how);
    });
    node.draggable = !('ontouchstart' in window);
    node.addEventListener('dragstart', (e) => {
      const paths = state.selection.has(item.path) ? [...state.selection] : [item.path];
      e.dataTransfer.setData('application/x-sfagents-paths', JSON.stringify(paths));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    if (item.kind === 'folder') {
      node.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('application/x-sfagents-paths')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        node.classList.add('drop-target');
      });
      node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
      node.addEventListener('drop', (e) => {
        node.classList.remove('drop-target');
        const data = e.dataTransfer.getData('application/x-sfagents-paths');
        if (!data) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = JSON.parse(data).filter((p) => p !== item.path);
        if (paths.length) transfer(e.altKey ? 'copy' : 'move', paths, item.path);
      });
    }
  }

  function listRow(item) {
    const node = el('button', `fm-row${state.selection.has(item.path) ? ' selected' : ''}`);
    node.type = 'button';
    if (state.selecting) {
      const check = el('span', 'fm-check');
      check.append(sym(state.selection.has(item.path) ? 'checkmark.circle.fill' : 'circle', 22));
      node.append(check);
    }
    node.append(iconFor(item, 40));
    const text = el('span', 'fm-row-text');
    text.append(el('span', 'fm-row-name', item.name));
    const sub = el('span', 'fm-row-sub', state.results ? `${baseName(parentOf(item.path) ?? '')} · ${subtitle(item)}` : subtitle(item));
    text.append(sub);
    node.append(text);
    if (!state.selecting) {
      const more = el('span', 'fm-row-more');
      more.setAttribute('role', 'button');
      more.setAttribute('aria-label', `More for ${item.name}`);
      more.append(sym('ellipsis', 16));
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        itemMenu(item, node, null);
      });
      node.append(more);
    }
    node.setAttribute('aria-label', `${item.name}, ${item.type}, ${subtitle(item)}`);
    bindItem(node, item);
    return node;
  }

  function tile(item) {
    const node = el('button', `fm-tile${state.selection.has(item.path) ? ' selected' : ''}`);
    node.type = 'button';
    const icon = iconFor(item, 76);
    node.append(icon);
    if (state.selecting) {
      const check = el('span', 'fm-check');
      check.append(sym(state.selection.has(item.path) ? 'checkmark.circle.fill' : 'circle', 22));
      node.append(check);
    }
    node.append(el('span', 'fm-tile-name', item.name), el('span', 'fm-tile-sub', item.kind === 'folder' ? (Number.isFinite(item.items) ? plural(item.items, 'item') : '') : bytesText(item.size, false)));
    node.setAttribute('aria-label', `${item.name}, ${item.type}, ${subtitle(item)}`);
    bindItem(node, item);
    return node;
  }

  // ---------------------------------------------------------------- selection

  function setSelecting(on) {
    state.selecting = on;
    if (!on) state.selection.clear();
    if (state.path === null) renderBrowse();
    else renderFolder();
  }

  function toggleSelect(item) {
    if (state.selection.has(item.path)) state.selection.delete(item.path);
    else state.selection.add(item.path);
    renderFolder();
  }

  function selectedItems() {
    const all = state.results ?? state.listing?.entries ?? [];
    return all.filter((e) => state.selection.has(e.path));
  }

  function renderToolbar() {
    const items = selectedItems();
    const none = !items.length;
    const inTrash = state.path === state.locations?.trash;
    const btn = (symbol, label, action, cls = '') => {
      const b = el('button', `fm-tool ${cls}`);
      b.type = 'button';
      b.disabled = none;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.append(sym(symbol, 20));
      b.addEventListener('click', (e) => action(e.currentTarget));
      return b;
    };
    toolbar.replaceChildren(
      btn('square.and.arrow.up', 'Share or download', () => shareItems(items)),
      inTrash ? btn('arrow.uturn.left', 'Put Back', () => restore(items)) : btn('folder', 'Move', () => moveOrCopy('move', items)),
      btn('doc.on.doc', 'Copy to…', () => moveOrCopy('copy', items)),
      btn('trash', inTrash ? 'Delete Immediately' : 'Delete', () => removeItems(items), 'destructive'),
      btn('ellipsis.circle', 'More', (b) => selectionMenu(b, null)),
    );
  }

  // ---------------------------------------------------------------- actions

  function activate(item) {
    if (item.kind === 'folder') navigate(item.path);
    else quickLook(item);
  }

  function quickLook(item) {
    if (openAsThread(item.path)) return;
    const siblings = (state.results ?? visibleEntries()).filter((e) => e.kind !== 'folder');
    openQuickLook({
      item,
      source: [...content.querySelectorAll('[data-path]')].find((n) => n.dataset.path === item.path),
      items: siblings.length ? siblings : [item],
      iconFor,
      actions: { share: (i) => shareItems([i]), download: (i) => download([i]), info: (i) => getInfo(i), ask: (i) => askAgent([i]), menu: (i, anchor) => itemMenu(i, anchor, null, true) },
      onSaved: () => refresh({ quiet: true }),
    });
  }

  async function runJob(promise, verb) {
    let t = null;
    try {
      const job = await promise;
      if (job.state === 'running') {
        t = toast(job.label, { progress: 0, cancel: () => postJson('/api/files/jobs/cancel', { id: job.id }) });
      }
      const result = await waitJob(job, (j) => {
        if (!t) return;
        const frac = j.total ? j.done / j.total : null;
        t.set(j.current ? `${j.label} — ${j.current}` : j.label, frac);
      });
      t?.close();
      return result;
    } catch (error) {
      t?.close();
      if (error.status === 499) {
        toast('Cancelled', { timeout: 1800 });
        return null;
      }
      throw Object.assign(error, { verb });
    } finally {
      refresh({ quiet: true });
    }
  }

  /** Runs a copy or move, asking what to do about items with the same names. */
  async function withConflicts(run) {
    try {
      return await run('ask');
    } catch (error) {
      if (error.status !== 409 || !error.data?.conflicts) throw error;
      const clashes = error.data.conflicts;
      const { action } = await alertDialog({
        title: clashes.length === 1 ? `An item named “${clashes[0].name}” already exists in this location.` : `${clashes.length} items with the same names already exist here.`,
        message: 'Do you want to replace it with the one you’re moving, or keep both?',
        actions: [
          { label: 'Keep Both', value: 'keep', role: 'default' },
          { label: 'Replace', value: 'replace', role: 'destructive' },
          ...(clashes.length > 1 ? [{ label: 'Skip These', value: 'skip' }] : []),
          { label: 'Stop', value: 'stop', role: 'cancel' },
        ],
      });
      if (!action || action === 'stop') return null;
      return run(action);
    }
  }

  async function transfer(kind, paths, dest) {
    try {
      const result = await withConflicts((conflict) => runJob(postJson(`/api/files/${kind}`, { paths, dest, conflict }), kind));
      if (result && state.selecting) setSelecting(false);
      return result;
    } catch (error) {
      await showError(error.message, kind === 'move' ? "Couldn't move" : "Couldn't copy");
      return null;
    }
  }

  async function moveOrCopy(kind, items) {
    const dest = await pickFolder({ title: `${kind === 'move' ? 'Move' : 'Copy'} ${items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item')}`, confirm: kind === 'move' ? 'Move' : 'Copy', start: state.path });
    if (dest) await transfer(kind, items.map((i) => i.path), dest);
  }

  async function rename(item) {
    const dot = item.kind === 'folder' ? -1 : item.name.lastIndexOf('.');
    const name = await promptDialog('Rename', item.name, 'Rename', { select: [0, dot > 0 ? dot : item.name.length] });
    if (!name || name === item.name) return;
    try {
      const entry = await postJson('/api/files/rename', { path: item.path, name });
      state.pendingSelect = entry.path;
      if (state.favorites.includes(item.path)) {
        state.favorites = state.favorites.map((f) => (f === item.path ? entry.path : f));
        write('favorites', state.favorites);
      }
      await refresh();
    } catch (error) {
      await showError(error.message, `Couldn't rename “${item.name}”`);
    }
  }

  async function newFolder() {
    const name = await promptDialog('New Folder', 'untitled folder', 'Create');
    if (!name) return;
    try {
      const entry = await postJson('/api/files/mkdir', { dir: state.path, name });
      state.pendingSelect = entry.path;
      await refresh();
    } catch (error) {
      await showError(error.message, "Couldn't create the folder");
    }
  }

  async function newTextFile() {
    const name = await promptDialog('New Text File', 'untitled.txt', 'Create', { select: [0, 8] });
    if (!name) return;
    try {
      const entry = await postJson('/api/files/create', { dir: state.path, name, text: '' });
      await refresh();
      quickLook(entry);
    } catch (error) {
      await showError(error.message, "Couldn't create the file");
    }
  }

  async function removeItems(items) {
    const inTrash = state.path === state.locations?.trash || items.every((i) => state.locations?.trash && parentOf(i.path) === state.locations.trash);
    if (inTrash) return deleteForever(items);
    try {
      const result = await runJob(postJson('/api/files/trash', { paths: items.map((i) => i.path) }), 'trash');
      if (!result) return;
      if (result.failed?.length) await showError(result.failed.map((f) => `${baseName(f.path)}: ${f.error}`).join('\n'), "Some items couldn't be moved to the Trash");
      if (state.selecting) setSelecting(false);
      const trashed = result.trashed.filter((t) => t.trashPath);
      const t = toast(trashed.length || result.trashed.length ? `Moved ${result.trashed.length === 1 ? `“${baseName(result.trashed[0].path)}”` : plural(result.trashed.length, 'item')} to the Trash` : 'Moved to the Trash', {
        symbol: 'trash',
        timeout: 5000,
        ...(trashed.length ? { cancel: () => (t.close(), restore(trashed.map((x) => ({ path: x.trashPath, name: baseName(x.path) })))), cancelLabel: 'Undo' } : {}),
      });
    } catch (error) {
      const permanent = await confirmDialog(`Couldn't move ${items.length === 1 ? `“${items[0].name}”` : 'these items'} to the Trash`, `${error.message}\nDelete ${items.length === 1 ? 'it' : 'them'} immediately instead? This can't be undone.`, 'Delete', true);
      if (permanent) await deleteForever(items, true);
    }
  }

  async function deleteForever(items, confirmed = false) {
    if (!confirmed) {
      const ok = await confirmDialog(items.length === 1 ? `Delete “${items[0].name}” immediately?` : `Delete ${plural(items.length, 'item')} immediately?`, "You can't undo this action.", 'Delete', true);
      if (!ok) return;
    }
    try {
      await runJob(postJson('/api/files/delete', { paths: items.map((i) => i.path) }), 'delete');
      if (state.selecting) setSelecting(false);
    } catch (error) {
      await showError(error.message, "Couldn't delete");
    }
  }

  async function restore(items) {
    try {
      const result = await runJob(postJson('/api/files/restore', { paths: items.map((i) => i.path) }), 'restore');
      if (result?.failed?.length) await showError(result.failed.map((f) => `${baseName(f.path)}: ${f.error}`).join('\n'), "Some items couldn't be put back");
      if (state.selecting) setSelecting(false);
      if (result?.restored?.length) toast(`Put back ${result.restored.length === 1 ? `“${baseName(result.restored[0])}”` : plural(result.restored.length, 'item')}`, { symbol: 'arrow.uturn.left', timeout: 2500 });
    } catch (error) {
      await showError(error.message, "Couldn't put back");
    }
  }

  async function emptyTrash() {
    const ok = await confirmDialog('Empty the Trash?', "Everything in the Trash will be deleted immediately. You can't undo this action.", 'Empty Trash', true);
    if (!ok) return;
    try {
      await runJob(postJson('/api/files/empty-trash', {}), 'empty');
    } catch (error) {
      await showError(error.message, "Couldn't empty the Trash");
    }
  }

  async function duplicate(items) {
    try {
      const result = await runJob(postJson('/api/files/duplicate', { paths: items.map((i) => i.path) }), 'duplicate');
      if (result?.paths?.length === 1) state.pendingSelect = result.paths[0];
      if (state.selecting) setSelecting(false);
    } catch (error) {
      await showError(error.message, "Couldn't duplicate");
    }
  }

  async function compress(items) {
    try {
      const result = await runJob(postJson('/api/files/compress', { paths: items.map((i) => i.path) }), 'compress');
      if (result?.path) state.pendingSelect = result.path;
      if (state.selecting) setSelecting(false);
    } catch (error) {
      await showError(error.message, "Couldn't compress");
    }
  }

  async function extract(item) {
    try {
      const result = await runJob(postJson('/api/files/extract', { path: item.path }), 'extract');
      if (result?.path) state.pendingSelect = result.path;
      if (result?.skipped?.length) await showError(`${plural(result.skipped.length, 'item')} in the archive could not be extracted safely and were skipped.`, 'Uncompressed with exceptions');
    } catch (error) {
      await showError(error.message, `Couldn't uncompress “${item.name}”`);
    }
  }

  function download(items) {
    const a = el('a');
    a.href = items.length === 1 && items[0].kind !== 'folder' ? rawUrl(items[0].path, true) : zipUrl(items.map((i) => i.path));
    a.download = items.length === 1 && items[0].kind !== 'folder' ? items[0].name : '';
    document.body.append(a);
    a.click();
    a.remove();
  }

  /** The system share sheet with the files themselves where the browser can; a download otherwise. */
  async function shareItems(items) {
    const files = items.filter((i) => i.kind !== 'folder');
    const total = files.reduce((a, i) => a + (i.size ?? 0), 0);
    if (files.length === items.length && files.length && total <= 64 * 1024 * 1024 && navigator.canShare) {
      try {
        const blobs = await Promise.all(files.map(async (i) => new File([await (await fetch(rawUrl(i.path))).blob()], i.name, { type: i.mime || 'application/octet-stream' })));
        if (navigator.canShare({ files: blobs })) {
          await navigator.share({ files: blobs });
          return;
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    download(items);
  }

  async function askAgent(items) {
    const files = items.filter((i) => i.kind !== 'folder');
    if (!files.length) return;
    try {
      for (const f of files) {
        const { attachment } = await postJson('/api/files/attach', { path: f.path });
        options.attach(attachment);
      }
      close();
      toast(files.length === 1 ? `“${files[0].name}” was added to your message` : `${plural(files.length, 'file')} were added to your message`, { symbol: 'sparkles', timeout: 2600 });
    } catch (error) {
      await showError(error.message, "Couldn't attach");
    }
  }

  async function copyPaths(items) {
    const ok = await copyText(items.map((i) => i.path).join('\n'));
    toast(ok ? (items.length === 1 ? 'Path copied' : 'Paths copied') : "Couldn't copy to the clipboard", { symbol: 'link', timeout: 1800 });
  }

  function toggleFavorite(item) {
    if (state.favorites.includes(item.path)) state.favorites = state.favorites.filter((f) => f !== item.path);
    else state.favorites = [...state.favorites, item.path];
    write('favorites', state.favorites);
    if (state.path === null) renderBrowse();
  }

  function setClipboard(mode, items) {
    state.clipboard = { mode, paths: items.map((i) => i.path) };
    toast(mode === 'cut' ? `${items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item')} will move when you paste` : `${items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item')} copied`, { symbol: mode === 'cut' ? 'scissors' : 'doc.on.doc', timeout: 2000 });
    if (state.selecting) setSelecting(false);
  }

  async function paste() {
    const c = state.clipboard;
    if (!c || state.path === null) return;
    const result = await transfer(c.mode === 'cut' ? 'move' : 'copy', c.paths, state.path);
    if (result && c.mode === 'cut') state.clipboard = null;
  }

  // ---------------------------------------------------------------- Get Info

  function getInfo(item) {
    openPeek({
      title: item.name,
      symbol: 'info.circle',
      build(ctx) {
        const head = peekEl('div', 'fm-info-head');
        head.append(iconFor(item, 64));
        const text = peekEl('div', 'fm-info-text');
        const name = peekEl('strong', '', item.name);
        const kind = peekEl('span', '', item.type);
        text.append(name, kind);
        head.append(text);
        const facts = group([]);
        const list = facts.querySelector('.sf-group');
        ctx.body.append(head, facts);
        const set = (rows) => list.replaceChildren(...rows.filter(Boolean));
        getJson('/api/files/info', { path: item.path })
          .then(async (i) => {
            const where = parentOf(i.path) ?? i.path;
            const rows = () => [
              row('Kind', i.type),
              row('Size', i.kind === 'folder' ? sizeText ?? 'Calculating…' : `${bytesText(i.size, false)} (${(i.size ?? 0).toLocaleString()} bytes)`),
              i.kind === 'folder' ? row('Contains', Number.isFinite(i.items) ? plural(i.items, 'item') : DASH) : null,
              i.archive ? row('Archive', `${plural(i.archive.entries, 'item')}, ${bytesText(i.archive.size, false)} uncompressed`) : null,
              row('Where', where, { title: where, chevron: true, onClick: () => (ctx.close(), navigate(where, { select: i.path })) }),
              row('Created', fullDate(i.created)),
              row('Modified', fullDate(i.modified)),
              row('Opened', fullDate(i.accessed)),
              i.owner ? row('Owner', i.owner) : null,
              i.mode ? row('Permissions', i.mode) : null,
              row('Can be changed', i.writable ? 'Yes' : 'No (read-only)'),
              i.link ? row('Original', i.link.target, { title: i.link.target }) : null,
              row('Path', i.path, { title: i.path, onClick: () => copyPaths([i]) }),
            ];
            let sizeText = null;
            set(rows());
            if (i.kind === 'folder') {
              const s = await getJson('/api/files/size', { path: i.path });
              sizeText = `${bytesText(s.size, false)} for ${plural(s.files, 'file')}${s.complete ? '' : ' (so far)'}`;
              set(rows());
            }
          })
          .catch((error) => list.replaceChildren(peekEl('p', 'ui-empty', error.message)));
        const actions = peekEl('div', 'ui-actions');
        const b = (label, symbol, run, role) =>
          peekButton(label, {
            symbol,
            role,
            onClick: () => {
              ctx.close();
              run();
            },
          });
        actions.append(b(item.kind === 'folder' ? 'Open' : 'Quick Look', item.kind === 'folder' ? 'folder' : 'eye', () => activate(item)), b('Rename', 'pencil', () => rename(item)), b('Copy Path', 'link', () => copyPaths([item])));
        ctx.body.append(actions);
      },
    });
  }

  // ---------------------------------------------------------------- menus

  function preview(item) {
    const card = el('div', 'fm-preview');
    card.append(iconFor(item, 64));
    const text = el('div', 'fm-preview-text');
    text.append(el('strong', '', item.name), el('span', '', item.type), el('span', 'fm-preview-sub', item.kind === 'folder' ? (Number.isFinite(item.items) ? plural(item.items, 'item') : '') : `${bytesText(item.size, false)} · ${dateText(item.modified, true)}`));
    card.append(text);
    return card;
  }

  const pointRect = ({ x, y }) => ({ left: x, top: y, right: x, bottom: y, width: 0, height: 0 });

  function itemMenu(item, anchor, how, fromQuickLook = false) {
    const inTrash = state.locations?.trash && parentOf(item.path) === state.locations.trash;
    const folder = item.kind === 'folder';
    const zip = /\.zip$/i.test(item.name);
    const fav = state.favorites.includes(item.path);
    const writable = state.listing ? state.listing.writable : true;
    closeMenu();
    // A right-click opens the menu at the pointer, as on a Mac; a long press lifts the item.
    const atPointer = how && !how.pointer && Number.isFinite(how.x);
    showMenu({
      anchor: atPointer ? pointRect(how) : anchor,
      preview: atPointer ? undefined : preview(item),
      pointer: how?.pointer ?? undefined,
      quick: [
        { label: 'Share', symbol: 'square.and.arrow.up', action: () => shareItems([item]) },
        { label: 'Download', symbol: 'tray.and.arrow.down', action: () => download([item]) },
        { label: 'Info', symbol: 'info.circle', action: () => getInfo(item) },
      ],
      groups: [
        fromQuickLook ? [] : [folder ? { label: 'Open', symbol: 'folder', action: () => navigate(item.path) } : { label: 'Quick Look', symbol: 'eye', action: () => quickLook(item) }, ...(!folder ? [{ label: 'Open in New Tab', symbol: 'arrow.up.right.square', action: () => window.open(rawUrl(item.path), '_blank', 'noopener') }] : [])],
        inTrash
          ? [{ label: 'Put Back', symbol: 'arrow.uturn.left', action: () => restore([item]) }]
          : [
              { label: 'Rename', symbol: 'pencil', action: () => rename(item), disabled: !writable },
              { label: 'Duplicate', symbol: 'plus.square.on.square', action: () => duplicate([item]), disabled: !writable },
              { label: 'Move', symbol: 'folder', action: () => moveOrCopy('move', [item]), disabled: !writable },
              { label: 'Copy to…', symbol: 'doc.on.doc', action: () => moveOrCopy('copy', [item]) },
              zip ? { label: 'Uncompress', symbol: 'archivebox', action: () => extract(item), disabled: !writable } : { label: 'Compress', symbol: 'archivebox', action: () => compress([item]), disabled: !writable },
            ],
        [
          { label: 'Copy', symbol: 'doc.on.doc', action: () => setClipboard('copy', [item]) },
          ...(inTrash ? [] : [{ label: 'Cut', symbol: 'scissors', action: () => setClipboard('cut', [item]), disabled: !writable }]),
          { label: 'Copy Path', symbol: 'link', action: () => copyPaths([item]) },
        ],
        [
          ...(!folder ? [{ label: 'Ask SF Agents', symbol: 'sparkles', action: () => askAgent([item]) }] : []),
          ...(folder ? [{ label: fav ? 'Remove from Favorites' : 'Add to Favorites', symbol: fav ? 'star.fill' : 'star', action: () => toggleFavorite(item) }] : []),
          ...(state.results || state.path === null ? [{ label: 'Show in Enclosing Folder', symbol: 'folder', action: () => navigate(parentOf(item.path), { select: item.path }) }] : []),
          ...(!state.selecting && state.path !== null ? [{ label: 'Select', symbol: 'checkmark.circle', action: () => (setSelecting(true), toggleSelect(item)) }] : []),
        ],
        state.path === null && !inTrash ? [] : [inTrash ? { label: 'Delete Immediately', symbol: 'trash', role: 'destructive', action: () => deleteForever([item]) } : { label: 'Delete', symbol: 'trash', role: 'destructive', action: () => removeItems([item]), disabled: !writable }],
      ],
    });
  }

  function selectionMenu(anchor, how) {
    const items = selectedItems();
    if (!items.length) return;
    const inTrash = state.path === state.locations?.trash;
    showMenu({
      anchor: how && !how.pointer && Number.isFinite(how.x) ? pointRect(how) : anchor,
      align: 'end',
      pointer: how?.pointer ?? undefined,
      title: plural(items.length, 'item'),
      groups: [
        [
          { label: 'Download', symbol: 'tray.and.arrow.down', action: () => download(items) },
          ...(inTrash ? [{ label: 'Put Back', symbol: 'arrow.uturn.left', action: () => restore(items) }] : [{ label: 'Duplicate', symbol: 'plus.square.on.square', action: () => duplicate(items) }, { label: 'Compress', symbol: 'archivebox', action: () => compress(items) }]),
        ],
        [
          { label: 'Copy', symbol: 'doc.on.doc', action: () => setClipboard('copy', items) },
          ...(inTrash ? [] : [{ label: 'Cut', symbol: 'scissors', action: () => setClipboard('cut', items) }]),
          { label: 'Copy Paths', symbol: 'link', action: () => copyPaths(items) },
          ...(items.some((i) => i.kind !== 'folder') ? [{ label: 'Ask SF Agents', symbol: 'sparkles', action: () => askAgent(items) }] : []),
        ],
      ],
    });
  }

  function moreMenu() {
    const p = state.path;
    const inTrash = p !== null && p === state.locations?.trash;
    const writable = state.listing?.writable ?? false;
    const fav = p !== null && state.favorites.includes(p);
    showMenu({
      anchor: moreBtn.el,
      align: 'end',
      quick:
        p === null
          ? undefined
          : [
              { label: 'Upload', symbol: 'tray.and.arrow.up', action: () => picker.click(), disabled: !writable },
              { label: 'New Folder', symbol: 'folder.badge.plus', action: () => newFolder(), disabled: !writable },
              { label: 'Select', symbol: 'checkmark.circle', action: () => setSelecting(true) },
            ],
      groups: [
        p === null ? [] : [{ label: 'New Text File', symbol: 'square.and.pencil', action: () => newTextFile(), disabled: !writable || inTrash }, ...(state.clipboard ? [{ label: `Paste ${plural(state.clipboard.paths.length, 'item')}`, symbol: 'doc.on.clipboard', action: () => paste(), disabled: !writable }] : [])],
        p === null
          ? []
          : [
              { label: 'Icons', symbol: 'square.grid.2x2', checked: state.view === 'grid', action: () => setView('grid') },
              { label: 'List', symbol: 'list.bullet', checked: state.view === 'list', action: () => setView('list') },
              {
                label: 'Sort By',
                detail: `${SORTS[state.sort.key].label}${state.sort.desc ? ', descending' : ''}`,
                submenu: {
                  title: 'Sort By',
                  groups: [
                    Object.entries(SORTS).map(([k, s]) => ({ label: s.label, checked: state.sort.key === k, action: () => setSort(k) })),
                    [{ label: state.sort.desc ? 'Ascending' : 'Descending', symbol: 'arrow.up.arrow.down', action: () => setSort(state.sort.key, !state.sort.desc) }],
                  ],
                },
              },
            ],
        [{ label: state.hidden ? 'Hide Hidden Files' : 'Show Hidden Files', symbol: state.hidden ? 'eye.slash' : 'eye', action: () => ((state.hidden = !state.hidden), write('hidden', state.hidden), refresh()) }],
        p === null
          ? [{ label: 'Refresh', symbol: 'arrow.clockwise', action: () => ((state.locations = null), refresh()) }]
          : [
              { label: fav ? 'Remove from Favorites' : 'Add to Favorites', symbol: fav ? 'star.fill' : 'star', action: () => toggleFavorite(folderItem(p)) },
              { label: 'Get Info', symbol: 'info.circle', action: () => getInfo(state.listing ? { ...folderItem(p), items: state.listing.entries.length } : folderItem(p)) },
              { label: 'Copy Path', symbol: 'link', action: () => copyPaths([folderItem(p)]) },
              { label: 'Download as ZIP', symbol: 'tray.and.arrow.down', action: () => download([folderItem(p)]) },
              { label: 'Refresh', symbol: 'arrow.clockwise', action: () => refresh() },
            ],
        inTrash ? [{ label: 'Empty Trash', symbol: 'trash', role: 'destructive', action: () => emptyTrash() }] : [],
      ],
    });
  }

  function setView(v) {
    state.view = v;
    write('view', v);
    renderFolder();
  }

  function setSort(key, desc = key === state.sort.key ? state.sort.desc : key === 'date' || key === 'size') {
    state.sort = { key, desc };
    write('sort', state.sort);
    renderFolder();
  }

  // ---------------------------------------------------------------- uploads

  function upload(files) {
    if (!files.length || state.path === null) return;
    const dest = state.path;
    const jobs = [];
    const t = toast(`Uploading ${files.length === 1 ? `“${files[0].name}”` : plural(files.length, 'file')}`, {
      progress: 0,
      symbol: 'tray.and.arrow.up',
      cancel: () => jobs.forEach((j) => j.cancel()),
    });
    const total = files.reduce((a, f) => a + f.size, 0) || 1;
    const update = () => {
      const done = jobs.reduce((a, j) => a + j.progress * j.size, 0);
      t.set(undefined, done / total);
    };
    for (const f of files) jobs.push(new UploadJob(f, update, { dest }));
    Promise.allSettled(jobs.map((j) => j.promise)).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      const placed = jobs.filter((j) => j.placed).map((j) => j.placed);
      t.set(failed.length ? `${plural(placed.length, 'file')} uploaded, ${failed.length} failed` : `Uploaded ${placed.length === 1 ? `“${placed[0].name}”` : plural(placed.length, 'file')}`, null);
      t.close(failed.length ? 4000 : 1600);
      if (placed.length === 1 && state.path === dest) state.pendingSelect = placed[0].path;
      if (state.path === dest) refresh();
      const cancelled = jobs.every((j) => j.state === 'cancelled');
      if (failed.length && !cancelled) showError(jobs.filter((j) => j.state === 'failed').map((j) => `${j.name}: ${j.error}`).join('\n'), 'Some files were not uploaded');
    });
  }

  // Dropping files from the computer uploads them here.
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  function wireSheet() {
    picker.addEventListener('change', () => {
      upload([...picker.files]);
      picker.value = '';
    });
    let dragDepth = 0;
    root.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || state.path === null) return;
      dragDepth++;
      dropHint.hidden = false;
    });
    root.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropHint.hidden = true;
    });
    root.addEventListener('dragover', (e) => {
      if (hasFiles(e) && state.path !== null) e.preventDefault();
    });
    root.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      dropHint.hidden = true;
      upload([...e.dataTransfer.files]);
    });
    doneBtn.el.addEventListener('click', () => setSelecting(false));
    moreBtn.el.addEventListener('click', () => moreMenu());
    statsBtn.el.addEventListener('click', () => {
      statsOpen = !statsOpen;
      sheet.header.setLayout(headerLayout());
    });
  }

  // ---------------------------------------------------------------- folder picker (Move, Copy)

  function pickFolder({ title: heading, confirm, start }) {
    return new Promise((resolve) => {
      // The same kind of sheet as Files itself: grabber, close button on the left.
      let result = null;
      let cur = start;
      const add = createButton({ symbol: 'folder.badge.plus', aria: 'New Folder', size: 'large' });
      const head = standardHeader({ title: heading, close: true, trailing: [add.el] });
      const where = el('div', 'fm-picker-where');
      const go = createButton({ label: confirm, aria: confirm, size: 'large', tint: 'action' });
      const picker = createSheet({
        kind: 'button',
        detents: ['large'],
        handle: true,
        label: heading,
        header: { edge: 'top', layout: head.layout, layouts: head.layouts },
        footer: { edge: 'bottom', layout: 'main', layouts: { main: [[{ id: 'where', node: where, size: 'fill', height: 48, glass: false }, { id: 'go', node: go.el, size: 140, height: 48 }]] } },
        onClose: () => resolve(result),
      });
      picker.layer.el.classList.add('fm-picker-layer');
      picker.el.classList.add('fm-picker');
      const list = picker.body;
      const finish = (value) => {
        result = value;
        picker.close();
      };
      go.el.addEventListener('click', () => cur && finish(cur));
      add.el.addEventListener('click', async () => {
        if (!cur) return;
        const name = await promptDialog('New Folder', 'untitled folder', 'Create');
        if (!name) return;
        try {
          const entry = await postJson('/api/files/mkdir', { dir: cur, name });
          show(entry.path);
        } catch (error) {
          await showError(error.message, "Couldn't create the folder");
        }
      });
      picker.present('large');
      const line = (name, symbol, color, onClick, detail) => {
        const b = el('button', 'fm-place');
        b.type = 'button';
        const icon = el('span', 'fm-place-icon');
        icon.style.color = color;
        icon.append(sym(symbol, 20));
        const text = el('span', 'fm-place-text');
        text.append(el('span', 'fm-place-name', name));
        if (detail) text.append(el('span', 'fm-place-detail', detail));
        b.append(icon, text, sym('chevron.right', 13));
        b.addEventListener('click', onClick);
        return b;
      };
      async function show(p) {
        cur = p;
        go.setDisabled?.(!p);
        add.setDisabled?.(!p);
        list.replaceChildren(el('div', 'fm-loading'));
        if (p === null) {
          where.textContent = 'Choose a folder';
          const loc = state.locations ?? (await loadLocations());
          const nodes = [...loc.places.map((x) => line(x.name, PLACE_ICONS[x.id] ?? 'folder.fill', '#5ac8fa', () => show(x.path))), ...(loc.project ? [line('SF Agents project', 'cube.box', '#bf5af2', () => show(loc.project))] : []), ...(state.snapshot?.drives ?? loc.drives ?? []).map((d) => line(d.name, 'tray.full.fill', '#8e8e93', () => show(d.mount), d.mount))];
          list.replaceChildren(section(null, nodes));
          return;
        }
        where.textContent = p;
        try {
          const l = await getJson('/api/files/list', { path: p, hidden: state.hidden });
          if (cur !== p) return;
          const up = parentOf(p);
          const nodes = [line(up ? `‹ ${baseName(up)}` : '‹ Browse', 'chevron.left', '#0a84ff', () => show(up ?? null))];
          for (const e of sorted(l.entries.filter((x) => x.kind === 'folder'), { key: 'name' })) nodes.push(line(e.name, 'folder.fill', '#5ac8fa', () => show(e.path), Number.isFinite(e.items) ? plural(e.items, 'item') : ''));
          list.replaceChildren(section(null, nodes));
          go.setDisabled?.(!l.writable);
          if (!l.writable) where.textContent = `${p} (read-only)`;
        } catch (error) {
          list.replaceChildren(el('p', 'ui-empty', error.message), line('Browse', 'chevron.left', '#0a84ff', () => show(null)));
          go.setDisabled?.(true);
        }
      }
      show(start);
    });
  }

  // ---------------------------------------------------------------- keyboard

  function focusedItem() {
    const node = document.activeElement?.closest?.('.fm-row, .fm-tile');
    if (!node) return null;
    return (state.results ?? state.listing?.entries ?? []).find((e) => e.path === node.dataset.path) ?? null;
  }

  window.addEventListener('keydown', (e) => {
    if (!state.open || e.defaultPrevented || document.querySelector('.sf-pop, .ql-layer, .sf-sheet[data-kind="window"], .fm-picker-layer')) return;
    if (e.target !== search && e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (e.target === search) {
      if (e.key === 'Escape') {
        search.value = '';
        onSearch();
        search.blur();
        e.preventDefault();
      }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const item = focusedItem();
    const targets = state.selection.size ? selectedItems() : item ? [item] : [];
    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.selecting) setSelecting(false);
      else close();
    } else if (mod && e.key.toLowerCase() === 'a' && state.listing) {
      e.preventDefault();
      if (!state.selecting) setSelecting(true);
      for (const x of visibleEntries()) state.selection.add(x.path);
      renderFolder();
    } else if (mod && e.key.toLowerCase() === 'c' && targets.length) {
      e.preventDefault();
      setClipboard('copy', targets);
    } else if (mod && e.key.toLowerCase() === 'x' && targets.length) {
      e.preventDefault();
      setClipboard('cut', targets);
    } else if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      paste();
    } else if ((e.key === 'Delete' || (mod && e.key === 'Backspace')) && targets.length) {
      e.preventDefault();
      removeItems(targets);
    } else if (e.key === 'F2' && item) {
      e.preventDefault();
      rename(item);
    } else if (e.key === ' ' && item && item.kind !== 'folder') {
      e.preventDefault();
      quickLook(item);
    } else if (mod && e.key === 'ArrowUp' && state.path !== null) {
      e.preventDefault();
      navigate(upOf(state.path));
    } else if (mod && e.key.toLowerCase() === 'i' && item) {
      e.preventDefault();
      getInfo(item);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod) {
      const nodes = [...content.querySelectorAll('.fm-row, .fm-tile, .fm-place')];
      if (!nodes.length) return;
      const i = nodes.indexOf(document.activeElement);
      const cols = state.view === 'grid' && content.querySelector('.fm-grid') ? Math.max(1, Math.round(content.querySelector('.fm-grid').clientWidth / (nodes[0].getBoundingClientRect().width + 8))) : 1;
      const step = e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : e.key === 'ArrowRight' ? 1 : -1;
      if (cols === 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      nodes[Math.max(0, Math.min(nodes.length - 1, i < 0 ? 0 : i + step))].focus();
    }
  });

  // ---------------------------------------------------------------- search

  let searchTimer = 0;
  let searchSeq = 0;
  function onSearch() {
    state.query = search.value;
    clearTimeout(searchTimer);
    if (state.query.trim().length < 2) {
      state.results = null;
      state.searching = false;
      renderFolder();
      return;
    }
    renderFolder();
    // Deeper results from the folders inside, after a pause in typing.
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      state.searching = true;
      try {
        const r = await getJson('/api/files/search', { path: state.path, q: state.query, hidden: state.hidden });
        if (seq !== searchSeq || !state.query.trim()) return;
        state.results = sorted(r.results, state.sort);
      } catch {
        state.results = null;
      } finally {
        if (seq === searchSeq) {
          state.searching = false;
          renderFolder();
        }
      }
    }, 450);
  }
  search.addEventListener('input', onSearch);

  // ---------------------------------------------------------------- open / close

  back.addEventListener('click', () => navigate(upOf(state.path)));
  selectAll.addEventListener('click', () => {
    const all = visibleEntries();
    if (state.selection.size === all.length) state.selection.clear();
    else for (const x of all) state.selection.add(x.path);
    renderFolder();
  });
  let statsTimer = 0;
  async function pollStats() {
    clearTimeout(statsTimer);
    if (!state.open) return;
    if (!document.hidden && !document.querySelector('.sf-sheet[data-kind="window"]')) {
      try {
        renderStats(await getJson('/api/system'));
      } catch {
        // keep the last readings
      }
    }
    statsTimer = setTimeout(pollStats, 2000);
  }

  let listTimer = 0;
  function pollList() {
    clearTimeout(listTimer);
    if (!state.open) return;
    if (!document.hidden && !document.querySelector('.sf-pop, .ql-layer, .fm-picker-layer') && state.path !== null && !state.results) refresh({ quiet: true });
    listTimer = setTimeout(pollList, 5000);
  }

  /** Opens the sheet at `path`, or where it was left. */
  async function open({ path, select = null, from = null } = {}) {
    if (path !== undefined) {
      state.path = path;
      state.pendingSelect = select;
      write('path', path);
    }
    if (state.open) {
      if (path !== undefined) navigate(path, { select, push: false });
      return;
    }
    state.open = true;
    options.onOpenChange?.(true);
    buildSheet(from ?? pendingFrom);
    renderHeader();
    content.replaceChildren(el('div', 'fm-loading'));
    if (state.snapshot) renderStats(state.snapshot);
    else if (state.locations?.drives?.length) renderDrives({ drives: state.locations.drives, platform: state.locations.platform });
    pollStats();
    await refresh();
    pollList();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    clearTimeout(statsTimer);
    clearTimeout(listTimer);
    closeMenu();
    sheet?.close();
  }

  function finishClose() {
    // Closed by a drag or the scrim as well as by close().
    if (state.open) {
      state.open = false;
      clearTimeout(statsTimer);
      clearTimeout(listTimer);
    }
    sheet = null;
    options.onOpenChange?.(false);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.open) {
      pollStats();
      pollList();
    }
  });

  /** Quick Look for one file, from outside the file manager (an artifact in the chat). */
  /** A thread between agents is a file in .sfagents/threads: it opens as a conversation. */
  function openAsThread(p) {
    const m = /[\\/]\.sfagents[\\/]threads[\\/]([^\\/]+)\.md$/.exec(p);
    if (!m || !options.openThread) return false;
    options.openThread(m[1]);
    return true;
  }

  async function quickLookFile(p, { edit = false } = {}) {
    if (!edit && openAsThread(p)) return;
    const item = await getJson('/api/files/info', { path: p });
    openQuickLook({
      item,
      edit,
      items: [item],
      iconFor,
      actions: {
        share: (i) => shareItems([i]),
        download: (i) => download([i]),
        info: (i) => getInfo(i),
        ask: (i) => askAgent([i]),
        menu: (i, anchor) =>
          showMenu({
            anchor,
            groups: [
              [{ label: 'Show in Files', symbol: 'folder', action: () => (state.open ? navigate(parentOf(i.path), { select: i.path }) : open({ path: parentOf(i.path), select: i.path })) }],
              [{ label: 'Download', symbol: 'arrow.down.circle', action: () => download([i]) }],
            ],
          }),
      },
    });
  }

  return {
    open,
    close,
    quickLookFile,
    navigate: (p, o) => (state.open ? navigate(p, o) : open({ path: p, select: o?.select ?? null })),
    get isOpen() {
      return state.open;
    },
  };
}
