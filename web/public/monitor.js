/**
 * The resource monitor at the top of the sheet: CPU, GPU, memory, disk and
 * network activity, the computer's and SF Agents' uptimes, and a bar per
 * drive showing how full it is.
 *
 * It is built from independent pieces (a header with the expand button, a
 * flat list of stat cells, a strip of drive bars) so a later full-screen
 * file manager can lay the same pieces out differently: the expand button
 * becoming a close button, the stats in a row beside it, the drive bars
 * along the bottom.
 *
 * Readings come from GET /api/system every two seconds while the monitor
 * is on screen. Changing numbers use sfgl's content transition, the way
 * Apple animates numeric text.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { createContentTransitions } from './vendor/sfgl/src/transitions/content.js';

const POLL_MS = 2000;
const DASH = '—';

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

/** Decimal units, as Finder and Settings show storage. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return { num: DASH, unit: '' };
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const num = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v));
  return { num, unit: units[i] };
}

export function formatRate(n) {
  if (!Number.isFinite(n)) return { num: DASH, unit: '' };
  // Below a kilobyte a second reads as idle.
  if (n < 1000) return { num: '0', unit: 'KB/s' };
  const b = formatBytes(n);
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
const temperature = (c) => (Number.isFinite(c) ? `${Math.round(c)} °C` : null);

/** What each cell shows: a value (number and unit) and a smaller line under it. */
export function describeStats(s) {
  const out = {};
  const cpuTemp = temperature(s.cpu?.temperature);
  out.cpu = {
    num: percent(s.cpu?.usage),
    unit: Number.isFinite(s.cpu?.usage) ? '%' : '',
    sub: cpuTemp ?? (s.cpu?.cores ? `${s.cpu.cores} cores` : ''),
  };
  if (s.gpu) {
    out.gpu = { num: percent(s.gpu.usage), unit: Number.isFinite(s.gpu.usage) ? '%' : '', sub: temperature(s.gpu.temperature) ?? s.gpu.name ?? '' };
  } else {
    out.gpu = { num: DASH, unit: '', sub: 'Not available' };
  }
  if (s.memory?.total) {
    // Both in the total's unit, so it stays short: "0.8 of 8.4 GB".
    const total = formatBytes(s.memory.total);
    const scale = s.memory.total / Number(total.num);
    const used = s.memory.used / scale;
    out.memory = { num: percent(s.memory.used / s.memory.total), unit: '%', sub: `${used < 10 ? used.toFixed(1) : Math.round(used)} of ${total.num} ${total.unit}` };
  } else {
    out.memory = { num: DASH, unit: '', sub: '' };
  }
  if (s.disk) {
    const io = formatRate(s.disk.read + s.disk.write);
    out.disk = Number.isFinite(s.disk.busy)
      ? { num: percent(s.disk.busy), unit: '%', sub: `${io.num} ${io.unit}` }
      : { num: io.num, unit: io.unit, sub: 'I/O' };
  } else {
    out.disk = { num: DASH, unit: '', sub: 'Not available' };
  }
  if (s.network) {
    const down = formatRate(s.network.down);
    const up = formatRate(s.network.up);
    out.network = { num: down.num, unit: down.unit, sub: `${up.num} ${up.unit}`, down: true };
  } else {
    out.network = { num: DASH, unit: '', sub: 'Not available' };
  }
  out.uptime = { num: formatDuration(s.uptime?.system), unit: '', sub: 'Computer' };
  out.sfagents = { num: formatDuration(s.uptime?.sfagents), unit: '', sub: 'This session' };
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
    const arrow = el('i', 'stat-arrow');
    const num = el('span', 'stat-num', DASH);
    const unit = el('span', 'stat-unit', '');
    const sub = el('span', 'stat-sub', '');
    const subArrow = el('i', 'stat-arrow');
    const subText = el('span', 'stat-subtext', '');
    if (stat.key === 'network') {
      applySymbol(arrow, 'arrow.down', { size: 11 });
      applySymbol(subArrow, 'arrow.up', { size: 9 });
      value.append(arrow);
      sub.append(subArrow);
    }
    value.append(num, unit);
    sub.append(subText);
    cell.append(label, value, sub);
    statsEl.append(cell);
    cells.set(stat.key, { cell, num, unit, subText });
  }

  // Numbers change in place, so only the digits that differ animate.
  const transitions = createContentTransitions({ root, include: '.stat-value, .stat-sub, .drive-pct, .mon-host' });
  transitions.start();

  const driveNodes = new Map(); // mount → { node, name, pct, fill }

  // The trailing fade shows only while there is more to scroll to.
  function updateFade() {
    const more = drivesEl.scrollWidth - drivesEl.clientWidth - drivesEl.scrollLeft > 2;
    drivesEl.classList.toggle('more', drivesEl.classList.contains('scrolls') && more);
  }
  drivesEl.addEventListener('scroll', updateFade, { passive: true });

  function renderDrives(drives) {
    const seen = new Set();
    drives.forEach((d, i) => {
      seen.add(d.mount);
      let entry = driveNodes.get(d.mount);
      if (!entry) {
        const node = el('div', 'drive');
        const top = el('div', 'drive-top');
        const name = el('span', 'drive-name');
        const pct = el('span', 'drive-pct');
        const bar = el('div', 'drive-bar');
        const fill = el('span', 'drive-fill');
        bar.append(fill);
        top.append(name, pct);
        node.append(top, bar);
        entry = { node, name, pct, fill };
        driveNodes.set(d.mount, entry);
      }
      const fraction = d.total > 0 ? Math.max(0, Math.min(1, d.used / d.total)) : 0;
      setText(entry.name, d.name);
      setText(entry.pct, `${Math.round(fraction * 100)}%`);
      entry.fill.style.width = `${(fraction * 100).toFixed(2)}%`;
      entry.node.classList.toggle('warn', fraction >= 0.8 && fraction < 0.9);
      entry.node.classList.toggle('full', fraction >= 0.9);
      const used = formatBytes(d.used);
      const total = formatBytes(d.total);
      const free = formatBytes(d.total - d.used);
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
    updateFade();
    drivesEl.hidden = drives.length === 0;
    onDrivesChange?.();
  }

  function render(snapshot) {
    setText(host, snapshot.host || 'This computer');
    const stats = describeStats(snapshot);
    for (const [key, v] of Object.entries(stats)) {
      const c = cells.get(key);
      if (!c) continue;
      setText(c.num, v.num);
      setText(c.unit, v.unit);
      setText(c.subText, v.sub);
      c.cell.classList.toggle('unavailable', v.num === DASH);
    }
    renderDrives(snapshot.drives || []);
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
