/** Drawing helpers shared by the terminal interface and its panes. */

import { stripAnsiAndControl } from '@sfagents/core';

export const esc = (code: string) => `\u001b[${code}`;
export const color = {
  dim: (s: string) => `${esc('2m')}${s}${esc('22m')}`,
  bold: (s: string) => `${esc('1m')}${s}${esc('22m')}`,
  inverse: (s: string) => `${esc('7m')}${s}${esc('27m')}`,
  red: (s: string) => `${esc('31m')}${s}${esc('39m')}`,
  green: (s: string) => `${esc('32m')}${s}${esc('39m')}`,
  yellow: (s: string) => `${esc('33m')}${s}${esc('39m')}`,
  blue: (s: string) => `${esc('34m')}${s}${esc('39m')}`,
  magenta: (s: string) => `${esc('35m')}${s}${esc('39m')}`,
  cyan: (s: string) => `${esc('36m')}${s}${esc('39m')}`,
};

export const clean = (text: string) => stripAnsiAndControl(text).replace(/\t/g, '  ');

export function timeText(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

export function stampText(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = same(d, now) ? 'Today' : same(d, yesterday) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${timeText(iso)}`;
}

export function bytesText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function percentText(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return '—';
  const p = share * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
}

export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function bar(share: number | null | undefined, width = 12): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return color.dim('·'.repeat(width));
  const full = Math.round(Math.min(1, Math.max(0, share)) * width);
  const fill = '█'.repeat(full);
  const tint = share > 0.85 ? color.red : share > 0.6 ? color.yellow : color.green;
  return `${tint(fill)}${color.dim('░'.repeat(width - full))}`;
}
