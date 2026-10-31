/**
 * GenUI views: small interactive pieces (layouts, text and math, controls,
 * tables, charts) the agent writes as JSON files in the project's `genui/`
 * folder and shows with `sf-artifact`. The chat renders them inline.
 *
 * A view is inert data: no HTML, CSS or script. Values are literals or
 * bindings (`{"$": "state.x"}`) and a few operators (`{"$op": "add", ...}`);
 * actions only change the view's own state, copy text, open an http(s) link,
 * or send the person a message from the view. What the person changes is
 * written back into the file's `state`, so the view keeps it and the agent
 * can read it.
 *
 * This module is the one validator: `sf-artifact` runs it so the agent sees
 * its mistakes, and the web server runs it before a page renders a view.
 */

import fs from 'node:fs';
import { writeFileAtomic } from '../settings/home.js';

export const GENUI_VERSION = 1;

/** Largest number of nodes in one view (repeats count once). */
export const MAX_GENUI_NODES = 2000;
/** Deepest nesting of nodes and of values. */
export const MAX_GENUI_DEPTH = 32;
/** Largest `state` a view may keep, in characters of JSON. */
export const MAX_GENUI_STATE_CHARS = 200_000;
/** Most items a `repeat` shows. */
export const MAX_GENUI_REPEAT = 500;

export const GENUI_NODE_TYPES = ['layout', 'text', 'control', 'table', 'chart'] as const;
export const GENUI_LAYOUTS = ['column', 'row', 'grid', 'card', 'tabs', 'carousel', 'popover', 'scroll', 'form', 'spacer', 'divider'] as const;
export const GENUI_TEXT_FORMATS = ['plain', 'markdown', 'math', 'code'] as const;
export const GENUI_CONTROLS = ['button', 'text', 'textarea', 'number', 'select', 'radio', 'checkbox', 'switch', 'slider', 'date', 'segmented'] as const;
export const GENUI_CHARTS = ['bar', 'line', 'area', 'pie'] as const;
export const GENUI_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'not', 'add', 'sub', 'mul', 'div', 'concat', 'formatNumber'] as const;
export const GENUI_ACTIONS = ['set', 'toggle', 'send', 'copy', 'open'] as const;

const PATH = /^(state|data|item|index|event)(\.[A-Za-z_][A-Za-z0-9_]*|\.[0-9]+)*$/;
const STATE_PATH = /^state(\.[A-Za-z_][A-Za-z0-9_]*|\.[0-9]+)+$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys every node may have besides its own props. */
const ENVELOPE = ['type', 'id', 'when', 'repeat', 'key', 'on'];

/** Each node type's props: name → check. Unknown props are errors, so typos surface. */
type Check = (v: unknown, at: string, c: Ctx) => void;

interface Ctx {
  errors: string[];
  nodes: number;
}

const err = (c: Ctx, at: string, msg: string) => {
  if (c.errors.length < 40) c.errors.push(`${at}: ${msg}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBinding = (v: unknown): boolean => isObj(v) && ('$' in v || '$op' in v);

/** A value: a literal (any JSON) or a binding/operator. Objects with `$`/`$op` must be well formed. */
function value(v: unknown, at: string, c: Ctx, depth = 0): void {
  if (depth > MAX_GENUI_DEPTH) return err(c, at, 'nested too deeply');
  if (Array.isArray(v)) return v.forEach((x, i) => value(x, `${at}[${i}]`, c, depth + 1));
  if (!isObj(v)) return;
  if ('$' in v) {
    if (Object.keys(v).length !== 1) return err(c, at, 'a binding is {"$": "state.x"} with nothing else');
    if (typeof v.$ !== 'string' || !PATH.test(v.$)) err(c, at, `"${String(v.$)}" is not a path (state.…, data.…, item.…, index, event.…)`);
    return;
  }
  if ('$op' in v) {
    const keys = Object.keys(v).filter((k) => k !== '$op' && k !== 'args');
    if (keys.length) return err(c, at, `an operator has only "$op" and "args" (found "${keys[0]}")`);
    if (!(GENUI_OPS as readonly string[]).includes(String(v.$op))) err(c, at, `unknown operator "${String(v.$op)}" (one of ${GENUI_OPS.join(', ')})`);
    if (!Array.isArray(v.args)) return err(c, at, '"args" must be a list');
    return v.args.forEach((x, i) => value(x, `${at}.args[${i}]`, c, depth + 1));
  }
  for (const [k, x] of Object.entries(v)) value(x, `${at}.${k}`, c, depth + 1);
}

const str: Check = (v, at, c) => {
  if (typeof v !== 'string') err(c, at, 'must be a string');
};
const strOrBinding: Check = (v, at, c) => {
  if (isBinding(v)) value(v, at, c);
  else if (typeof v !== 'string' && typeof v !== 'number') err(c, at, 'must be text or a binding');
};
const bool: Check = (v, at, c) => {
  if (isBinding(v)) value(v, at, c);
  else if (typeof v !== 'boolean') err(c, at, 'must be true, false or a binding');
};
const num = (min: number, max: number): Check => (v, at, c) => {
  if (isBinding(v)) return value(v, at, c);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) err(c, at, `must be a number from ${min} to ${max}`);
};
const oneOf = (list: readonly string[]): Check => (v, at, c) => {
  if (typeof v !== 'string' || !list.includes(v)) err(c, at, `must be one of ${list.join(', ')}`);
};
const any: Check = (v, at, c) => value(v, at, c);
/** A list given literally or bound (`{"$": "data.rows"}`). */
const list = (item?: Check): Check => (v, at, c) => {
  if (isBinding(v)) return value(v, at, c);
  if (!Array.isArray(v)) return err(c, at, 'must be a list or a binding to one');
  v.forEach((x, i) => (item ? item(x, `${at}[${i}]`, c) : value(x, `${at}[${i}]`, c)));
};
const stateBinding: Check = (v, at, c) => {
  if (!isObj(v) || Object.keys(v).length !== 1 || typeof v.$ !== 'string' || !STATE_PATH.test(v.$)) err(c, at, 'must be {"$": "state.name"}');
};
const fields = (spec: Record<string, Check>, required: string[] = []): Check => (v, at, c) => {
  if (!isObj(v)) return err(c, at, 'must be an object');
  for (const k of required) if (!(k in v)) err(c, at, `needs "${k}"`);
  for (const [k, x] of Object.entries(v)) {
    const check = spec[k];
    if (!check) err(c, `${at}.${k}`, `unknown field (allowed: ${Object.keys(spec).join(', ')})`);
    else check(x, `${at}.${k}`, c);
  }
};
const option = (v: unknown, at: string, c: Ctx) => {
  if (typeof v === 'string' || typeof v === 'number') return;
  fields({ label: strOrBinding, value: any }, ['label', 'value'])(v, at, c);
};
const column = fields(
  { key: str, label: str, format: oneOf(['text', 'number', 'percent', 'currency', 'date']), align: oneOf(['start', 'center', 'end']), sortable: bool, currency: str },
  ['key'],
);
const series = fields({ y: str, label: str, color: oneOf(['blue', 'green', 'orange', 'purple', 'teal', 'pink', 'yellow', 'indigo', 'gray', 'red']) }, ['y']);

const PROPS: Record<(typeof GENUI_NODE_TYPES)[number], { props: Record<string, Check>; required?: string[]; events: string[] }> = {
  layout: {
    props: {
      kind: oneOf(GENUI_LAYOUTS),
      gap: num(0, 48),
      align: oneOf(['start', 'center', 'end', 'stretch']),
      justify: oneOf(['start', 'center', 'end', 'between']),
      minWidth: num(60, 800),
      maxHeight: num(60, 2000),
      size: num(0, 200),
      title: strOrBinding,
      label: strOrBinding,
      labels: list(strOrBinding),
      submitLabel: strOrBinding,
    },
    required: ['kind'],
    events: ['submit', 'change'],
  },
  text: {
    props: { value: strOrBinding, format: oneOf(GENUI_TEXT_FORMATS), language: str, size: oneOf(['small', 'body', 'headline', 'title']), tone: oneOf(['default', 'muted', 'accent', 'success', 'warning', 'danger']), weight: oneOf(['regular', 'bold']) },
    required: ['value'],
    events: [],
  },
  control: {
    props: {
      kind: oneOf(GENUI_CONTROLS),
      label: strOrBinding,
      bind: stateBinding,
      options: list(option),
      placeholder: strOrBinding,
      min: num(-1e15, 1e15),
      max: num(-1e15, 1e15),
      step: num(0, 1e15),
      disabled: bool,
      required: bool,
      style: oneOf(['primary', 'secondary', 'danger']),
      help: strOrBinding,
    },
    required: ['kind'],
    events: ['click', 'change'],
  },
  table: {
    props: { columns: list(column), rows: list(), rowKey: str, search: bool, pageSize: num(1, 500), selectable: bool, bind: stateBinding, caption: strOrBinding },
    required: ['columns', 'rows'],
    events: ['select'],
  },
  chart: {
    props: { kind: oneOf(GENUI_CHARTS), data: list(), x: str, series: list(series), height: num(80, 600), legend: bool, unit: str, title: strOrBinding },
    required: ['kind', 'data', 'x', 'series'],
    events: ['select'],
  },
};

const action = (v: unknown, at: string, c: Ctx) => {
  if (!isObj(v)) return err(c, at, 'an action must be an object like {"do": "set", ...}');
  switch (v.do) {
    case 'set':
      fields({ do: str, path: str, value: any }, ['path', 'value'])(v, at, c);
      return statePath(v.path, `${at}.path`, c);
    case 'toggle':
      fields({ do: str, path: str }, ['path'])(v, at, c);
      return statePath(v.path, `${at}.path`, c);
    case 'send':
    case 'copy':
      return fields({ do: str, text: strOrBinding }, ['text'])(v, at, c);
    case 'open':
      fields({ do: str, url: strOrBinding }, ['url'])(v, at, c);
      if (typeof v.url === 'string' && !/^https?:\/\//i.test(v.url)) err(c, `${at}.url`, 'only http:// and https:// links can be opened');
      return;
    default:
      return err(c, `${at}.do`, `must be one of ${GENUI_ACTIONS.join(', ')}`);
  }
};
function statePath(v: unknown, at: string, c: Ctx) {
  if (typeof v === 'string' && !STATE_PATH.test(v)) err(c, at, 'must be a path in state, like "state.choice"');
}

function node(v: unknown, at: string, c: Ctx, depth: number): void {
  if (depth > MAX_GENUI_DEPTH) return err(c, at, 'nested too deeply');
  if (++c.nodes > MAX_GENUI_NODES) {
    if (c.nodes === MAX_GENUI_NODES + 1) err(c, at, `a view has at most ${MAX_GENUI_NODES} nodes`);
    return;
  }
  if (!isObj(v)) return err(c, at, 'a node must be an object with a "type"');
  const type = v.type as keyof typeof PROPS;
  const spec = PROPS[type];
  if (!spec) return err(c, `${at}.type`, `must be one of ${GENUI_NODE_TYPES.join(', ')}${typeof v.type === 'string' ? ` (not "${v.type}")` : ''}`);
  for (const k of spec.required ?? []) if (!(k in v)) err(c, at, `a ${type} needs "${k}"`);
  for (const [k, x] of Object.entries(v)) {
    const where = `${at}.${k}`;
    if (k === 'type') continue;
    if (k === 'id' || k === 'key') str(x, where, c);
    else if (k === 'when') value(x, where, c);
    else if (k === 'repeat') {
      if (!isObj(x) || Object.keys(x).length !== 1 || typeof x.$ !== 'string' || !/^(state|data|item)(\.|$)/.test(x.$)) err(c, where, 'must be a binding to a list, like {"$": "data.items"}');
      else value(x, where, c);
    } else if (k === 'on') {
      if (!isObj(x)) {
        err(c, where, 'must map an event to a list of actions');
        continue;
      }
      for (const [ev, acts] of Object.entries(x)) {
        if (!spec.events.includes(ev)) err(c, `${where}.${ev}`, spec.events.length ? `a ${type} has the events ${spec.events.join(', ')}` : `a ${type} has no events`);
        if (!Array.isArray(acts)) err(c, `${where}.${ev}`, 'must be a list of actions');
        else acts.forEach((a, i) => action(a, `${where}.${ev}[${i}]`, c));
      }
    } else if (k === 'children') {
      if (type !== 'layout') err(c, where, 'only a layout has children');
      else if (!Array.isArray(x)) err(c, where, 'must be a list of nodes');
      else x.forEach((child, i) => node(child, `${where}[${i}]`, c, depth + 1));
    } else if (spec.props[k]) spec.props[k]!(x, where, c);
    else err(c, where, `a ${type} has no "${k}" (it has ${[...Object.keys(spec.props), ...ENVELOPE.filter((e) => e !== 'type')].join(', ')})`);
  }
  if (type === 'layout' && ['tabs', 'carousel', 'popover', 'scroll', 'form', 'column', 'row', 'grid', 'card'].includes(String(v.kind)) && !Array.isArray(v.children)) {
    err(c, at, `a ${String(v.kind)} layout needs "children"`);
  }
  if (type === 'layout' && v.kind === 'popover' && !('label' in v)) err(c, at, 'a popover needs "label" (the text of the button that opens it)');
  if (type === 'control' && ['select', 'radio', 'segmented'].includes(String(v.kind)) && !('options' in v)) err(c, at, `a ${String(v.kind)} needs "options"`);
  if (type === 'control' && v.kind !== 'button' && !('bind' in v)) err(c, at, `a ${String(v.kind)} control needs "bind", like {"$": "state.name"}`);
}

/** Problems with a view document; empty when it is valid. */
export function validateGenui(doc: unknown): string[] {
  const c: Ctx = { errors: [], nodes: 0 };
  if (!isObj(doc)) return ['the file must hold one JSON object with "version" and "view"'];
  for (const k of Object.keys(doc)) if (!['version', 'title', 'state', 'data', 'view'].includes(k)) err(c, k, 'unknown field (allowed: version, title, state, data, view)');
  if (doc.version !== GENUI_VERSION) err(c, 'version', `must be ${GENUI_VERSION}`);
  if ('title' in doc && typeof doc.title !== 'string') err(c, 'title', 'must be a string');
  if ('state' in doc && !isObj(doc.state)) err(c, 'state', 'must be an object');
  if ('data' in doc && !isObj(doc.data)) err(c, 'data', 'must be an object');
  if (isObj(doc.state) && JSON.stringify(doc.state).length > MAX_GENUI_STATE_CHARS) err(c, 'state', `is larger than ${MAX_GENUI_STATE_CHARS} characters`);
  for (const k of isObj(doc.state) ? Object.keys(doc.state) : []) if (!KEY.test(k)) err(c, `state.${k}`, 'state names are letters, digits and _');
  if (!('view' in doc)) err(c, 'view', 'is missing');
  else node(doc.view, 'view', c, 0);
  return c.errors;
}

/** Parses and validates view JSON text. */
export function parseGenui(text: string): { doc?: Record<string, unknown>; errors: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { errors: [`not valid JSON: ${(error as Error).message}`] };
  }
  const errors = validateGenui(doc);
  return errors.length ? { errors } : { doc: doc as Record<string, unknown>, errors };
}

/** The error text `sf-artifact` gives the agent for an invalid view. */
export function genuiErrorText(file: string, errors: readonly string[]): string {
  return `${file} is not a valid GenUI view, so the chat shows an error instead of it. Fix the file and run sf-artifact --id again to check it:\n${errors.map((e) => `- ${e}`).join('\n')}`;
}

/** Writes the person's `state` into a view file, keeping everything else. Throws when the file is not a valid view. */
export function writeGenuiState(file: string, state: unknown): Record<string, unknown> {
  if (!isObj(state)) throw new Error('"state" must be an object.');
  const { doc, errors } = parseGenui(fs.readFileSync(file, 'utf8'));
  if (!doc) throw new Error(`The view is not valid: ${errors[0]}`);
  const next = { ...doc, state };
  const problems = validateGenui(next);
  if (problems.length) throw new Error(`The state is not valid: ${problems[0]}`);
  writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** One line on a view's state for the agent, when the person sends a message from it. */
export function genuiStateSummary(file: string | undefined, limit = 1500): string | undefined {
  if (!file) return undefined;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!isObj(doc.state) || Object.keys(doc.state).length === 0) return undefined;
    const text = JSON.stringify(doc.state);
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  } catch {
    return undefined;
  }
}

export const GENUI_GUIDANCE = `<genui_guidance>
A GenUI view is a small interactive piece shown inline in the chat: a comparison, a form, a table to sort, a chart, a formula, choices to pick from. Write it as JSON in the project's genui/ folder and show it with sf-artifact (genui/plan-options.json --title "Plan options"). sf-artifact checks the file and lists any mistakes; after editing a view run sf-artifact --id <id> to check it again. Use a view when the person will interact with it or it shows data better than prose; use plain chat for everything else. Whole apps belong in an .html artifact.
Document: {"version": 1, "title"?, "state"?: {name: value}, "data"?: {...}, "view": node}.
Every node has "type" and may have "when" (show only if true), "repeat" ({"$": "data.items"}: one copy per item, with item and index) and "key", and "on" ({event: [actions]}).
- layout: "kind" column | row | grid | card | tabs | carousel | popover | scroll | form | spacer | divider, "children": [nodes]. Optional gap, align, justify, minWidth (grid), maxHeight (scroll), title (card), labels (tabs: one per child), label (popover: its button), submitLabel (form, event "submit"), size (spacer).
- text: "value", "format" plain | markdown | math (TeX, display) | code (+ language), size small | body | headline | title, tone muted | accent | success | warning | danger, weight bold.
- control: "kind" button | text | textarea | number | select | radio | checkbox | switch | slider | date | segmented, "label", "bind": {"$": "state.name"} (every kind but button), "options" [{"label","value"}] or ["a","b"], min/max/step, placeholder, help, disabled, required, style primary | secondary | danger (button). Events: click (button), change.
- table: "columns" [{"key","label","format": text|number|percent|currency|date,"sortable"}], "rows" (a list or {"$": "data.rows"}), rowKey, search, pageSize, selectable + bind (the selected row's key). Event: select.
- chart: "kind" bar | line | area | pie, "data" (rows), "x" (the key for labels), "series" [{"y": key, "label", "color"}], unit, legend, height, title. Event: select.
Values are literals or bindings: {"$": "state.x"}, {"$": "data.rows"}, {"$": "item.name"}, {"$": "event.value"}; operators {"$op": "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"and"|"or"|"not"|"add"|"sub"|"mul"|"div"|"concat"|"formatNumber", "args": [...]}.
Actions: {"do": "set", "path": "state.x", "value": v}, {"do": "toggle", "path": "state.x"}, {"do": "copy", "text": v}, {"do": "open", "url": "https://…"}, {"do": "send", "text": v}. "send" sends the person a message to you from the view, marked as from it, with the view's state; answer it like any message.
What the person changes is saved into the file's "state", so read the file to see their choices. Data is only what you put in the file: the view cannot fetch anything or load images.
Example: {"version":1,"state":{"plan":"pro"},"view":{"type":"layout","kind":"card","title":"Choose a plan","children":[{"type":"control","kind":"segmented","bind":{"$":"state.plan"},"options":[{"label":"Basic","value":"basic"},{"label":"Pro","value":"pro"}]},{"type":"control","kind":"button","label":"Use this plan","style":"primary","on":{"click":[{"do":"send","text":{"$op":"concat","args":["Go with ",{"$":"state.plan"}]}}]}}]}}
</genui_guidance>`;
