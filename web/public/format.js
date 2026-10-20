/** Number, size, rate, time and date formatting shared by the monitor, its windows and the file manager. */

export const DASH = '—';

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

export function bytesText(n, binary = true) {
  const b = formatBytes(n, binary);
  return b.unit ? `${b.num} ${b.unit}` : b.num;
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

export function rateText(n) {
  const r = formatRate(n);
  return r.unit ? `${r.num} ${r.unit}` : r.num;
}

/** Bits per second, as network adapters are rated ("1 Gbps"). */
export function bitsText(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return DASH;
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let i = 0;
  let v = bitsPerSecond;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && v % 1 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
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

/** Task Manager's up time: "3:04:12:55" (days:hours:minutes:seconds). */
export function clockDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return DASH;
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 86400)}:${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export const percent = (x) => (Number.isFinite(x) ? String(Math.round(Math.max(0, Math.min(1, x)) * 100)) : DASH);
export const percentText = (x) => (Number.isFinite(x) ? `${percent(x)}%` : DASH);
export const temperature = (c) => (Number.isFinite(c) ? `${Math.round(c)} °C` : null);

export function mhzText(mhz) {
  if (!Number.isFinite(mhz) || mhz <= 0) return DASH;
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
}

/** Dates the way Files shows them: "Today at 9:41 AM", "Yesterday at …", "Mar 3, 2025". */
export function dateText(ms, withTime = false) {
  if (!Number.isFinite(ms) || ms <= 0) return DASH;
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (same(d, now)) return withTime ? `Today at ${time}` : time;
  if (same(d, yesterday)) return withTime ? `Yesterday at ${time}` : 'Yesterday';
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  return withTime ? `${date} at ${time}` : date;
}

export function fullDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DASH;
  return new Date(ms).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
