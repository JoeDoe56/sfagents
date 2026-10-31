/**
 * GenUI views as text, for the terminal: the same values, layouts, controls,
 * tables and charts the web interface draws (web/public/genui.js), as lines.
 * In the chat a view is shown as it stands; its pane (genuiPane) numbers the
 * controls so the person can press, toggle, choose and type, and what they
 * change is written back to the view's file as on the pages.
 */

import { clean, color } from './ansi.js';
import { textWidth, truncate, wrap } from './width.js';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_REPEAT = 500;

export interface ViewDoc {
  title?: string;
  view?: unknown;
  data?: unknown;
  state?: Record<string, unknown>;
}

type Node = Record<string, any>;
type Scope = { state: unknown; data: unknown; item?: unknown; index?: number; event?: unknown };

// ------------------------------------------------------------------ values (as genui.js)

export function lookup(path: string, scope: Record<string, unknown>): unknown {
  const parts = String(path).split('.');
  let cur: unknown = scope[parts[0]!];
  for (const p of parts.slice(1)) {
    if (cur === null || cur === undefined || FORBIDDEN.has(p)) return undefined;
    if (typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);

const OPS: Record<string, (...a: any[]) => unknown> = {
  eq: (a, b) => a === b || (a != null && b != null && String(a) === String(b)),
  ne: (a, b) => !OPS.eq!(a, b),
  gt: (a, b) => num(a) > num(b),
  gte: (a, b) => num(a) >= num(b),
  lt: (a, b) => num(a) < num(b),
  lte: (a, b) => num(a) <= num(b),
  and: (...a) => a.every(Boolean),
  or: (...a) => a.some(Boolean),
  not: (a) => !a,
  add: (...a) => a.reduce((s: number, x) => s + (num(x) || 0), 0),
  sub: (a, b) => num(a) - num(b),
  mul: (...a) => a.reduce((s: number, x) => s * num(x), 1),
  div: (a, b) => (num(b) === 0 ? NaN : num(a) / num(b)),
  concat: (...a) => a.map(text).join(''),
  formatNumber: (n, digits) => {
    const x = num(n);
    if (!Number.isFinite(x)) return '';
    const d = Number.isInteger(num(digits)) ? Math.max(0, Math.min(10, num(digits))) : undefined;
    return x.toLocaleString(undefined, d === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: d, maximumFractionDigits: d });
  },
};

/** A value: literals as they are, bindings and operators against `scope`. */
export function ev(v: unknown, scope: Scope, depth = 0): any {
  if (depth > 32 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => ev(x, scope, depth + 1));
  const o = v as Record<string, unknown>;
  if (typeof o.$ === 'string') return lookup(o.$, scope as unknown as Record<string, unknown>);
  if (typeof o.$op === 'string') {
    const fn = OPS[o.$op];
    return fn ? fn(...((o.args as unknown[]) ?? []).map((x) => ev(x, scope, depth + 1))) : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = ev(x, scope, depth + 1);
  return out;
}

export const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Sets `state.a.b` in `state`. */
export function setPath(state: Record<string, unknown>, path: string, value: unknown): void {
  const parts = String(path).split('.').slice(1);
  if (!parts.length || parts.some((p) => FORBIDDEN.has(p))) return;
  let cur: any = state;
  for (const p of parts.slice(0, -1)) {
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(p) ? [] : {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]!] = clone(value);
}

// ------------------------------------------------------------------ what a view does

/** What a view's actions reach outside it. */
export interface ViewEffects {
  send(text: string): void;
  copy(text: string): void;
  open(url: string): void;
}

/** A view while the person uses it: its state, and each layout's own (tab, slide, open popover, table page). */
export class ViewModel {
  state: Record<string, unknown>;
  readonly ui = new Map<string, Record<string, any>>();

  constructor(readonly doc: ViewDoc) {
    this.state = clone(doc.state ?? {});
  }

  scope(): Scope {
    return { state: this.state, data: this.doc.data ?? {} };
  }

  /** Runs a node's actions for one event; true when the state changed. */
  run(n: Node, name: string, scope: Scope, event: unknown, fx: ViewEffects): boolean {
    const actions = n.on?.[name];
    if (!Array.isArray(actions)) return false;
    const s = { ...scope, event };
    let touched = false;
    for (const act of actions) {
      if (!act || typeof act !== 'object') continue;
      switch (act.do) {
        case 'set':
          setPath(this.state, act.path, ev(act.value, s));
          touched = true;
          break;
        case 'toggle':
          setPath(this.state, act.path, !lookup(act.path, { state: this.state }));
          touched = true;
          break;
        case 'copy':
          fx.copy(text(ev(act.text, s)));
          break;
        case 'open': {
          const url = text(ev(act.url, s)).trim();
          if (/^https?:\/\//i.test(url)) fx.open(url);
          break;
        }
        case 'send': {
          const t = text(ev(act.text, s)).trim();
          if (t) fx.send(t);
          break;
        }
      }
    }
    return touched;
  }

  /** A bound control's new value (and its change actions); true when the state changed. */
  setBound(n: Node, scope: Scope, value: unknown, fx: ViewEffects): boolean {
    if (n.bind?.$) setPath(this.state, n.bind.$, value);
    const ran = n.on?.change ? this.run(n, 'change', scope, { value }, fx) : false;
    return !!n.bind?.$ || ran;
  }
}

/** Something in a view the person can use: what it is and where. */
export interface ViewControl {
  kind: 'control' | 'submit' | 'tabs' | 'carousel' | 'popover' | 'row' | 'pages';
  node: Node;
  scope: Scope;
  path: string;
  /** A table row: its key and the row. */
  row?: { key: unknown; value: Record<string, unknown> };
  /** A tab bar or a carousel: how many there are. */
  count?: number;
}

/** One line group of a drawn view; `control` makes it pickable in the pane. */
export interface ViewLine {
  lines: string[];
  control?: ViewControl;
}

const TONES: Record<string, (s: string) => string> = {
  muted: color.dim,
  accent: color.cyan,
  success: color.green,
  warning: color.yellow,
  danger: color.red,
};
const SERIES = [color.blue, color.green, color.yellow, color.magenta, color.cyan, color.red];
const SERIES_NAMES = ['blue', 'green', 'yellow', 'purple', 'teal', 'red'];
const tintOf = (s: Node, i: number) => SERIES[SERIES_NAMES.indexOf(s.color) >= 0 ? SERIES_NAMES.indexOf(s.color) : i % SERIES.length]!;

/** Draws a view as lines `width` wide. */
export function drawView(m: ViewModel, width: number): ViewLine[] {
  const out: ViewLine[] = [];
  if (m.doc.view) node(m.doc.view as Node, 'v', m.scope(), '', Math.max(20, width));
  return out;

  function push(prefix: string, text: string, w: number, style: (s: string) => string = (s) => s, control?: ViewControl) {
    const lines = wrap(clean(text), Math.max(8, w - textWidth(prefix))).map((l) => prefix + style(l));
    out.push({ lines: lines.length ? lines : [prefix], ...(control ? { control } : {}) });
  }

  function node(n: Node, path: string, scope: Scope, prefix: string, w: number): void {
    if (!n || typeof n !== 'object') return;
    if (n.repeat) {
      const list = ev(n.repeat, scope);
      if (!Array.isArray(list)) return;
      list.slice(0, MAX_REPEAT).forEach((item, index) => {
        const key = n.key && item && typeof item === 'object' ? text(item[n.key]) : String(index);
        one(n, `${path}[${key}]`, { ...scope, item, index }, prefix, w);
      });
      return;
    }
    one(n, path, scope, prefix, w);
  }

  function kids(n: Node, path: string, scope: Scope, prefix: string, w: number) {
    (Array.isArray(n.children) ? n.children : []).forEach((c: Node, i: number) => node(c, `${path}.${i}`, scope, prefix, w));
  }

  function one(n: Node, path: string, scope: Scope, prefix: string, w: number): void {
    if (n.when !== undefined && !ev(n.when, scope)) return;
    switch (n.type) {
      case 'layout':
        return layout(n, path, scope, prefix, w);
      case 'text':
        return textNode(n, scope, prefix, w);
      case 'control':
        return control(n, path, scope, prefix, w);
      case 'table':
        return table(n, path, scope, prefix, w);
      case 'chart':
        return chart(n, scope, prefix, w);
    }
  }

  function layout(n: Node, path: string, scope: Scope, prefix: string, w: number) {
    const st = m.ui.get(path) ?? {};
    const title = text(ev(n.title, scope));
    switch (n.kind) {
      case 'spacer':
        return void out.push({ lines: [prefix] });
      case 'divider':
        return void out.push({ lines: [prefix + color.dim('─'.repeat(Math.max(4, w - textWidth(prefix))))] });
      case 'card':
        if (title) push(prefix, title, w, color.bold);
        else out.push({ lines: [prefix + color.dim('┌')] });
        return kids(n, path, scope, `${prefix}${color.dim('│')} `, w);
      case 'tabs': {
        const list = Array.isArray(n.children) ? n.children : [];
        const labels = (ev(n.labels, scope) ?? []) as unknown[];
        const sel = Math.min(st.tab ?? 0, Math.max(0, list.length - 1));
        const bar = list.map((_: unknown, i: number) => (i === sel ? color.bold(`[${text(labels[i]) || `Tab ${i + 1}`}]`) : ` ${text(labels[i]) || `Tab ${i + 1}`} `)).join(' ');
        out.push({ lines: [prefix + bar], control: { kind: 'tabs', node: n, scope, path, count: list.length } });
        if (list[sel]) node(list[sel], `${path}.${sel}`, scope, `${prefix}  `, w);
        return;
      }
      case 'carousel': {
        const list = Array.isArray(n.children) ? n.children : [];
        const at = Math.min(st.slide ?? 0, Math.max(0, list.length - 1));
        if (list.length > 1) out.push({ lines: [prefix + color.dim(`‹ ${at + 1} of ${list.length} ›`)], control: { kind: 'carousel', node: n, scope, path, count: list.length } });
        if (list[at]) node(list[at], `${path}.${at}`, scope, prefix, w);
        return;
      }
      case 'popover': {
        const label = text(ev(n.label, scope)) || 'More';
        out.push({ lines: [`${prefix}${color.cyan(`[ ${clean(label)} ${st.open ? '▴' : '▾'} ]`)}`], control: { kind: 'popover', node: n, scope, path } });
        if (st.open) kids(n, path, scope, `${prefix}  `, w);
        return;
      }
      case 'form':
        if (title) push(prefix, title, w, color.bold);
        kids(n, path, scope, prefix, w);
        out.push({ lines: [`${prefix}${color.cyan(color.bold(`[ ${clean(text(ev(n.submitLabel, scope)) || 'Submit')} ]`))}`], control: { kind: 'submit', node: n, scope, path } });
        return;
      default:
        // row, column, grid, scroll: one under the other.
        if (title) push(prefix, title, w, color.bold);
        return kids(n, path, scope, prefix, w);
    }
  }

  function textNode(n: Node, scope: Scope, prefix: string, w: number) {
    let value = text(ev(n.value, scope));
    const tone = TONES[n.tone as string];
    const strong = n.weight === 'bold' || n.size === 'title' || n.size === 'headline';
    const style = (s: string) => {
      const t = tone ? tone(s) : s;
      return strong ? color.bold(t) : n.size === 'small' ? color.dim(t) : t;
    };
    if (n.format === 'code') {
      for (const l of value.split(/\r?\n/)) out.push({ lines: [prefix + color.dim('│ ') + truncate(clean(l), Math.max(8, w - textWidth(prefix) - 2))] });
      return;
    }
    if (n.format === 'markdown') value = value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
    for (const para of value.split(/\r?\n/)) {
      const md = n.format === 'markdown' ? /^(#{1,6})\s+(.*)$/.exec(para) : null;
      if (md) push(prefix, md[2]!, w, (s) => color.bold(s));
      else push(prefix, para, w, style);
    }
  }

  function options(n: Node, scope: Scope): Array<{ label: string; value: unknown }> {
    const list = ev(n.options, scope);
    if (!Array.isArray(list)) return [];
    return list.map((o) => (o && typeof o === 'object' ? { label: text(o.label), value: o.value } : { label: text(o), value: o }));
  }

  function control(n: Node, path: string, scope: Scope, prefix: string, w: number) {
    const label = text(ev(n.label, scope));
    const disabled = !!ev(n.disabled, scope);
    const help = text(ev(n.help, scope));
    const current = n.bind?.$ ? lookup(n.bind.$, scope as unknown as Record<string, unknown>) : undefined;
    const c: ViewControl | undefined = disabled ? undefined : { kind: 'control', node: n, scope, path };
    const dim = disabled ? color.dim : (s: string) => s;
    const named = label ? `${color.dim(`${clean(label)}:`)} ` : '';
    let line: string;
    switch (n.kind) {
      case 'button': {
        const style = n.style === 'primary' ? (s: string) => color.cyan(color.bold(s)) : n.style === 'danger' ? color.red : color.cyan;
        line = (disabled ? color.dim : style)(`[ ${clean(label || 'OK')} ]`);
        break;
      }
      case 'checkbox':
        line = dim(`${current ? '[x]' : '[ ]'} ${clean(label)}`);
        break;
      case 'switch':
        line = dim(`${current ? color.green('(●  on)') : '(off  ○)'} ${clean(label)}`);
        break;
      case 'select': {
        const o = options(n, scope).find((x) => OPS.eq!(x.value, current));
        line = `${named}${dim(o ? `‹${clean(o.label)}›` : color.dim(`‹${clean(text(ev(n.placeholder, scope)) || 'Choose…')}›`))}`;
        break;
      }
      case 'radio':
      case 'segmented':
        line = named + options(n, scope).map((o) => (OPS.eq!(o.value, current) ? color.bold(`(•) ${clean(o.label)}`) : dim(`( ) ${clean(o.label)}`))).join('  ');
        break;
      case 'slider': {
        const min = typeof n.min === 'number' ? n.min : 0;
        const max = typeof n.max === 'number' ? n.max : 100;
        const v = Number.isFinite(num(current)) ? num(current) : min;
        const span = 16;
        const full = Math.round(Math.min(1, Math.max(0, max > min ? (v - min) / (max - min) : 0)) * span);
        line = `${named}${color.cyan('━'.repeat(full))}●${color.dim('─'.repeat(span - full))} ${v}`;
        break;
      }
      default: {
        // text, textarea, number, date
        const shown = current === undefined || current === null || current === '' ? color.dim(clean(text(ev(n.placeholder, scope)) || '(empty)')) : clean(String(current)).replace(/\n/g, ' ⏎ ');
        line = `${named}${dim(`${shown}`)}${disabled ? '' : color.dim(' ✎')}`;
      }
    }
    out.push({ lines: wrap(line, Math.max(8, w - textWidth(prefix))).map((l) => prefix + l), ...(c ? { control: c } : {}) });
    if (help) push(`${prefix}  `, help, w, color.dim);
  }

  function table(n: Node, path: string, scope: Scope, prefix: string, w: number) {
    const st = m.ui.get(path) ?? {};
    const columns = ((ev(n.columns, scope) ?? []) as Node[]).filter((c) => c && typeof c.key === 'string');
    const all = ((ev(n.rows, scope) ?? []) as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
    const cap = text(ev(n.caption, scope));
    if (cap) push(prefix, cap, w, color.bold);
    if (!columns.length) return;
    const size = typeof n.pageSize === 'number' ? n.pageSize : 25;
    const pages = Math.max(1, Math.ceil(all.length / size));
    const page = Math.min(st.page ?? 0, pages - 1);
    const rows = all.slice(page * size, page * size + size);
    const cells = rows.map((r) => columns.map((c) => clean(formatCell(r[c.key], c))));
    const head = columns.map((c) => clean(String(c.label ?? c.key)));
    const room = Math.max(8, w - textWidth(prefix) - 2 - (columns.length - 1) * 2);
    let widths = columns.map((_, i) => Math.max(textWidth(head[i]!), ...cells.map((r) => textWidth(r[i]!))));
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > room) widths = widths.map((x) => Math.max(3, Math.floor((x / total) * room)));
    const right = (c: Node) => c.align === 'end' || (!c.align && ['number', 'percent', 'currency'].includes(c.format));
    const cell = (s: string, i: number) => {
      const t = truncate(s, widths[i]!);
      const pad = ' '.repeat(Math.max(0, widths[i]! - textWidth(t)));
      return right(columns[i]!) ? pad + t : t + pad;
    };
    out.push({ lines: [`${prefix}  ${color.bold(head.map(cell).join('  '))}`] });
    out.push({ lines: [`${prefix}  ${color.dim(widths.map((x) => '─'.repeat(x)).join('  '))}`] });
    const selectable = !!ev(n.selectable, scope);
    const selected = n.bind?.$ ? lookup(n.bind.$, scope as unknown as Record<string, unknown>) : st.selected;
    rows.forEach((r, i) => {
      const key = n.rowKey && r[n.rowKey] !== undefined ? r[n.rowKey] : r.id !== undefined ? r.id : page * size + i;
      const on = selectable && selected !== undefined && OPS.eq!(selected, key);
      const line = `${prefix}${on ? color.cyan('▸ ') : '  '}${cells[i]!.map(cell).join('  ')}`;
      out.push({ lines: [on ? color.bold(line) : line], ...(selectable ? { control: { kind: 'row' as const, node: n, scope, path, row: { key, value: r } } } : {}) });
    });
    if (!rows.length) out.push({ lines: [`${prefix}  ${color.dim('No rows.')}`] });
    if (pages > 1) out.push({ lines: [`${prefix}  ${color.dim(`‹ page ${page + 1} of ${pages} ›`)}`], control: { kind: 'pages', node: n, scope, path, count: pages } });
  }

  function chart(n: Node, scope: Scope, prefix: string, w: number) {
    const rows = ((ev(n.data, scope) ?? []) as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').slice(0, MAX_REPEAT);
    const series = ((ev(n.series, scope) ?? []) as Node[]).filter((s) => s && typeof s.y === 'string');
    const unit = n.unit ? ` ${clean(String(n.unit))}` : '';
    const title = text(ev(n.title, scope));
    if (title) push(prefix, title, w, color.bold);
    if (!rows.length || !series.length) return void out.push({ lines: [`${prefix}${color.dim('No data.')}`] });
    const labels = rows.map((r) => clean(text(r[n.x])));
    const lw = Math.min(18, Math.max(...labels.map(textWidth)));
    const short = (v: number) => (Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '–');
    if (n.kind === 'pie') {
      const s = series[0]!;
      const vals = rows.map((r) => Math.max(0, num(r[s.y]) || 0));
      const sum = vals.reduce((a, b) => a + b, 0) || 1;
      const span = Math.max(6, Math.min(30, w - textWidth(prefix) - lw - 22));
      vals.forEach((v, i) => {
        const tint = SERIES[i % SERIES.length]!;
        out.push({ lines: [`${prefix}${truncate(labels[i]!, lw).padEnd(lw)} ${tint('█'.repeat(Math.round((v / sum) * span)))} ${short(v)}${unit} ${color.dim(`(${Math.round((v / sum) * 100)}%)`)}`] });
      });
      return;
    }
    const values = rows.flatMap((r) => series.map((s) => num(r[s.y]))).filter(Number.isFinite);
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const span = Math.max(6, Math.min(40, w - textWidth(prefix) - lw - 16));
    if (series.length > 1) out.push({ lines: [prefix + series.map((s, i) => tintOf(s, i)(`■ ${clean(String(s.label ?? s.y))}`)).join('  ')] });
    rows.forEach((r, i) => {
      series.forEach((s, j) => {
        const v = num(r[s.y]);
        const len = max - min > 0 && Number.isFinite(v) ? Math.round((Math.abs(v) / (max - min)) * span) : 0;
        const tint = tintOf(s, j);
        const name = j === 0 ? truncate(labels[i]!, lw).padEnd(lw) : ' '.repeat(lw);
        out.push({ lines: [`${prefix}${name} ${tint((v < 0 ? '▒' : '█').repeat(len))} ${short(v)}${unit}`] });
      });
    });
  }
}

function formatCell(v: unknown, col: Node): string {
  if (v === undefined || v === null) return '';
  const x = num(v);
  switch (col.format) {
    case 'number':
      return Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: 2 }) : text(v);
    case 'percent':
      return Number.isFinite(x) ? x.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 1 }) : text(v);
    case 'currency':
      try {
        return Number.isFinite(x) ? x.toLocaleString(undefined, { style: 'currency', currency: col.currency || 'USD' }) : text(v);
      } catch {
        return x.toLocaleString();
      }
    case 'date': {
      const d = new Date(text(v));
      return Number.isNaN(d.getTime()) ? text(v) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    default:
      return text(v);
  }
}

/** The options of a select, radio or segmented control. */
export function controlOptions(n: Node, scope: Scope): Array<{ label: string; value: unknown }> {
  const list = ev(n.options, scope);
  if (!Array.isArray(list)) return [];
  return list.map((o) => (o && typeof o === 'object' ? { label: text(o.label), value: o.value } : { label: text(o), value: o }));
}
