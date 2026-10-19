/**
 * The resource monitor at the top of the sheet: CPU, GPU, memory, disk and
 * network activity, the computer's and SF Agents' uptimes, and a bar per
 * drive showing how full it is.
 *
 * It is built from independent pieces (a header with the expand button, a
 * flat list of stat cells, a strip of drive bars) so a later full-screen
 * file manager can lay the same pieces out differently: the expand button
 * becoming a close button with the stats in a row beside it, the drive bars
 * along the bottom.
 *
 * Readings come from GET /api/system (Libre Hardware Monitor when it runs,
 * the operating system otherwise) every two seconds while the monitor is on
 * screen. Changing numbers use sfgl's content transition, the way Apple
 * animates numeric text.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { createContentTransitions } from './vendor/sfgl/src/transitions/content.js';

const POLL_MS = 2000;
const DASH = '—';

/** Cells in reading order; each has a value line and up to two smaller lines. */
const STATS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'gpu', label: 'GPU' },
  { key: 'memory', label: 'Memory' },
  { key: 'disk', label: 'Disk' },
  { key: 'network', label: 'Network', wide: true },
  { key: 'uptime', label: 'Uptime' },
  { key: 'sfagents', label: 'SF Agents' },
];

// ------------------------------------------------------------------ formatting

/**
 * Sizes as the platform's own tools show them: decimal units on macOS (as
 * Finder does), binary elsewhere (as Windows and `df -h` do, labelled GB).
 * Memory and VRAM are always binary: a 16 GB module is 16 × 1024³ bytes.
 */
export function formatBytes(n, binary = true) {
  if (!Number.isFinite(n) || n < 0) return { num: DASH, unit: '', scale: 1 };
  const step = binary ? 1024 : 1000;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= step ** (i + 1) * 0.9995 && i < units.length - 1) i++;
  const v = n / step ** i;
  const num = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v));
  return { num, unit: units[i], scale: step ** i };
}

/** "3.5/8.0 GB": both in the total's unit. */
export function formatUsedTotal(used, total, binary = true) {
  if (!Number.isFinite(used) || !(total > 0)) return DASH;
  const t = formatBytes(total, binary);
  const u = used / t.scale;
  const digits = Number(t.num) < 10 ? 1 : 0;
  return `${u.toFixed(digits)}/${t.num} ${t.unit}`;
}

export function formatRate(n) {
  if (!Number.isFinite(n)) return { num: DASH, unit: '' };
  // Below a kilobyte a second reads as idle.
  if (n < 1000) return { num: '0', unit: 'KB/s' };
  const b = formatBytes(n, false);
  return { num: b.num, unit: `${b.unit}/s` };
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return DASH;
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

const percent = (x) => (Number.isFinite(x) ? String(Math.round(Math.max(0, Math.min(1, x)) * 100)) : DASH);
const percentText = (x) => (Number.isFinite(x) ? `${percent(x)}%` : DASH);
const temperature = (c) => (Number.isFinite(c) ? `${Math.round(c)} °C` : null);

/**
 * What each cell shows: the value (number, unit, and an optional symbol or
 * letter before it) and up to two smaller lines, each with an optional
 * symbol or letter. `missing` is what a line says when the reading is not
 * available (with a hint about Libre Hardware Monitor on Windows without it).
 */
export function describeStats(s) {
  const missing = s.hint ? 'Needs LHM' : 'Not available';
  const pctValue = (x) => ({ num: percent(x), unit: Number.isFinite(x) ? '%' : '' });
  const out = {};

  // CPU: total use, temperature, cores.
  const cores = s.cpu?.cores ? `${s.cpu.cores} cores` : s.cpu?.threads ? `${s.cpu.threads} threads` : '';
  out.cpu = { ...pctValue(s.cpu?.usage), lines: [{ text: temperature(s.cpu?.temperature) ?? missing }, { text: cores }] };

  // GPU: total use, temperature, VRAM used/total.
  if (s.gpu) {
    out.gpu = {
      ...pctValue(s.gpu.usage),
      lines: [{ text: temperature(s.gpu.temperature) ?? missing }, { text: s.gpu.memory ? formatUsedTotal(s.gpu.memory.used, s.gpu.memory.total) : missing }],
    };
  } else {
    out.gpu = { num: DASH, unit: '', lines: [{ text: missing }, { text: '' }] };
  }

  out.memory = s.memory?.total
    ? { ...pctValue(s.memory.used / s.memory.total), lines: [{ text: formatUsedTotal(s.memory.used, s.memory.total) }] }
    : { num: DASH, unit: '', lines: [{ text: '' }] };

  // Disk, laid out like the network: reading on the value line, writing under it.
  if (s.disk && (Number.isFinite(s.disk.read) || Number.isFinite(s.disk.write))) {
    out.disk = { ...pctValue(s.disk.read), tag: 'R', lines: [{ tag: 'W', text: percentText(s.disk.write) }] };
  } else if (s.disk) {
    // No activity figures (macOS without Libre Hardware Monitor): the rates instead.
    const r = formatRate(s.disk.readRate);
    const w = formatRate(s.disk.writeRate);
    out.disk = { num: r.num, unit: r.unit, tag: 'R', lines: [{ tag: 'W', text: `${w.num} ${w.unit}` }] };
  } else {
    out.disk = { num: DASH, unit: '', lines: [{ text: missing }] };
  }

  if (s.network) {
    const down = formatRate(s.network.down);
    const up = formatRate(s.network.up);
    out.network = { num: down.num, unit: down.unit, symbol: 'arrow.down', lines: [{ symbol: 'arrow.up', text: `${up.num} ${up.unit}` }] };
  } else {
    out.network = { num: DASH, unit: '', lines: [{ text: missing }] };
  }

  out.uptime = { num: formatDuration(s.uptime?.system), unit: '', lines: [{ text: 'Computer' }] };
  out.sfagents = { num: formatDuration(s.uptime?.sfagents), unit: '', lines: [{ text: 'This session' }] };
  return out;
}

// ------------------------------------------------------------------ view

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** The slot before a value or line: an SF Symbol, a letter (R, W), or nothing. */
function setMark(node, item, size) {
  const key = item.symbol ? `s:${item.symbol}` : item.tag ? `t:${item.tag}` : '';
  if (node.dataset.mark === key) return;
  node.dataset.mark = key;
  node.replaceChildren();
  node.hidden = !key;
  if (item.symbol) {
    const i = el('i');
    applySymbol(i, item.symbol, { size });
    node.append(i);
  } else if (item.tag) {
    node.append(document.createTextNode(item.tag));
  }
  node.classList.toggle('tag', !!item.tag);
}

export function createMonitor({ root, expandButton, onDrivesChange }) {
  const host = root.querySelector('.mon-host');
  const statsEl = root.querySelector('.mon-stats');
  const drivesEl = root.querySelector('.mon-drives');
  const cells = new Map();

  for (const stat of STATS) {
    const cell = el('div', `stat${stat.wide ? ' wide' : ''}`);
    cell.dataset.stat = stat.key;
    const label = el('span', 'stat-label', stat.label);
    const value = el('span', 'stat-value');
    const mark = el('span', 'stat-mark');
    const num = el('span', 'stat-num', DASH);
    const unit = el('span', 'stat-unit', '');
    value.append(mark, num, unit);
    cell.append(label, value);
    const lines = [0, 1].map(() => {
      const line = el('span', 'stat-sub');
      const lineMark = el('span', 'stat-mark');
      const text = el('span', 'stat-subtext', '');
      line.append(lineMark, text);
      cell.append(line);
      return { line, mark: lineMark, text };
    });
    statsEl.append(cell);
    cells.set(stat.key, { cell, mark, num, unit, lines });
  }

  // Numbers change in place, so only the digits that differ animate.
  const transitions = createContentTransitions({ root, include: '.stat-value, .stat-sub, .drive-figures, .mon-host' });
  transitions.start();

  const driveNodes = new Map(); // mount → { node, name, size, pct, fill }

  // The trailing fade shows only while there is more to scroll to.
  function updateFade() {
    const more = drivesEl.scrollWidth - drivesEl.clientWidth - drivesEl.scrollLeft > 2;
    drivesEl.classList.toggle('more', drivesEl.classList.contains('scrolls') && more);
  }
  drivesEl.addEventListener('scroll', updateFade, { passive: true });

  function renderDrives(drives, binary) {
    const seen = new Set();
    drives.forEach((d, i) => {
      seen.add(d.mount);
      let entry = driveNodes.get(d.mount);
      if (!entry) {
        const node = el('div', 'drive');
        const top = el('div', 'drive-top');
        const name = el('span', 'drive-name');
        const figures = el('span', 'drive-figures');
        const size = el('span', 'drive-size');
        const pct = el('span', 'drive-pct');
        figures.append(size, pct);
        const bar = el('div', 'drive-bar');
        const fill = el('span', 'drive-fill');
        bar.append(fill);
        // Name above the bar; used/total and the percentage together under it.
        top.append(name);
        node.append(top, bar, figures);
        entry = { node, name, size, pct, fill };
        driveNodes.set(d.mount, entry);
      }
      const fraction = d.total > 0 ? Math.max(0, Math.min(1, d.used / d.total)) : 0;
      setText(entry.name, d.name);
      setText(entry.size, formatUsedTotal(d.used, d.total, binary));
      setText(entry.pct, `${Math.round(fraction * 100)}%`);
      entry.fill.style.width = `${(fraction * 100).toFixed(2)}%`;
      entry.node.classList.toggle('warn', fraction >= 0.8 && fraction < 0.9);
      entry.node.classList.toggle('full', fraction >= 0.9);
      const used = formatBytes(d.used, binary);
      const total = formatBytes(d.total, binary);
      const free = formatBytes(d.total - d.used, binary);
      const detail = `${d.name}: ${used.num} ${used.unit} used of ${total.num} ${total.unit}, ${free.num} ${free.unit} free`;
      entry.node.title = `${detail} (${d.mount})`;
      entry.node.setAttribute('aria-label', detail);
      entry.node.setAttribute('role', 'img');
      if (drivesEl.children[i] !== entry.node) drivesEl.insertBefore(entry.node, drivesEl.children[i] ?? null);
    });
    for (const [mount, entry] of driveNodes) {
      if (!seen.has(mount)) {
        entry.node.remove();
        driveNodes.delete(mount);
      }
    }
    // Up to three share the width; more scroll sideways.
    drivesEl.style.setProperty('--drive-count', String(Math.max(1, Math.min(3, drives.length))));
    drivesEl.classList.toggle('scrolls', drives.length > 3);
    drivesEl.hidden = drives.length === 0;
    updateFade();
    onDrivesChange?.();
  }

  function render(snapshot) {
    setText(host, snapshot.host || 'This computer');
    root.title = snapshot.hint || '';
    root.dataset.source = snapshot.source || '';
    const stats = describeStats(snapshot);
    for (const [key, v] of Object.entries(stats)) {
      const c = cells.get(key);
      if (!c) continue;
      setMark(c.mark, v, 11);
      setText(c.num, v.num);
      setText(c.unit, v.unit);
      c.lines.forEach((slot, i) => {
        const line = v.lines[i];
        slot.line.hidden = !line;
        if (!line) return;
        setMark(slot.mark, line, 9);
        setText(slot.text, line.text);
      });
      c.cell.classList.toggle('unavailable', v.num === DASH);
    }
    renderDrives(snapshot.drives || [], snapshot.platform !== 'darwin');
    root.classList.remove('loading');
  }

  let timer = 0;
  let active = false;
  let inFlight = false;

  async function poll() {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      const res = await fetch('/api/system', { cache: 'no-store' });
      if (res.ok) render(await res.json());
    } catch {
      // offline: keep the last readings
    } finally {
      inFlight = false;
      if (active) timer = setTimeout(poll, POLL_MS);
    }
  }

  expandButton.addEventListener('click', () => {
    // The file manager is not built yet; the button shows where it will open.
    expandButton.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(0.86)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
  });

  return {
    /** Polls while the monitor is on screen. */
    setActive(next) {
      if (next === active) return;
      active = next;
      clearTimeout(timer);
      if (active) poll();
    },
    render,
  };
}
