/**
 * GenUI views: the agent's JSON views (files in the project's genui/ folder)
 * rendered inline in the chat. The server validates each file
 * (GET /api/artifacts/<id>/view); this module only draws what passed, and
 * still treats every value as untrusted text: nothing here sets innerHTML
 * from a view except through the escaping Markdown renderer and KaTeX.
 *
 * One model per view holds its document and state. What the person changes
 * goes back into the file's state (POST /api/artifacts/<id>/state), so a
 * reload, another device and the agent all see it. Each change redraws the
 * view; the focused text field is carried over so typing is not interrupted.
 */

import { renderMarkdown } from './markdown.js';
import { postJson } from './api.js';
import { COLORS } from './charts.js';

const MAX_REPEAT = 500;
const SAVE_DELAY = 500;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const PALETTE = ['blue', 'green', 'orange', 'purple', 'teal', 'pink', 'yellow', 'indigo', 'gray'];
const COLOR = { ...COLORS, red: '#ff453a' };

// ------------------------------------------------------------------ models

/** id → model: { doc, state, version, errors, saving, dirty, views: Set<View> } */
const models = new Map();

function modelFor(id) {
  let m = models.get(id);
  if (!m) {
    m = { id, doc: null, state: {}, version: -1, errors: null, dirty: false, timer: 0, views: new Set(), loading: null };
    models.set(id, m);
  }
  return m;
}

async function load(m, version) {
  if (m.loading) return m.loading;
  m.loading = (async () => {
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(m.id)}/view?v=${version}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      m.version = version;
      if (!body.doc) {
        m.errors = body.errors?.length ? body.errors : ['The view could not be read.'];
        return;
      }
      m.errors = null;
      const same = m.doc && JSON.stringify(withoutState(m.doc)) === JSON.stringify(withoutState(body.doc));
      m.doc = body.doc;
      // The person's unsaved changes win over the file until they are written.
      if (!m.dirty) m.state = clone(body.doc.state ?? {});
      if (same && !m.dirty && JSON.stringify(m.state) === JSON.stringify(body.doc.state ?? {}) && m.drawn) return;
    } catch (error) {
      m.errors = [`The view could not be loaded: ${error.message}`];
    } finally {
      m.loading = null;
    }
    m.drawn = true;
    for (const v of m.views) v.draw();
  })();
  return m.loading;
}

const withoutState = (doc) => ({ ...doc, state: undefined });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function changed(m) {
  m.dirty = true;
  clearTimeout(m.timer);
  m.timer = setTimeout(() => save(m), SAVE_DELAY);
  for (const v of m.views) v.draw();
}

async function save(m) {
  const state = clone(m.state);
  try {
    await postJson(`/api/artifacts/${encodeURIComponent(m.id)}/state`, { state });
    if (JSON.stringify(state) === JSON.stringify(m.state)) m.dirty = false;
  } catch (error) {
    for (const v of m.views) v.notice(`Your changes could not be saved: ${error.message}`);
  }
}

/** The artifacts changed: views whose file changed load it again. */
export function refreshViews(artifacts) {
  for (const a of artifacts) {
    if (a.type !== 'genui') continue;
    const m = models.get(a.id);
    if (!m) continue;
    for (const v of m.views) {
      if (v.shown && !v.root.isConnected) v.dispose();
      else v.setArtifact(a);
    }
    if (m.views.size && a.version !== m.version) load(m, a.version);
  }
}

// ------------------------------------------------------------------ values

function lookup(path, scope) {
  const parts = String(path).split('.');
  let cur = scope[parts[0]];
  for (const p of parts.slice(1)) {
    if (cur === null || cur === undefined || FORBIDDEN.has(p)) return undefined;
    if (typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);

const OPS = {
  eq: (a, b) => a === b || (a != null && b != null && String(a) === String(b)),
  ne: (a, b) => !OPS.eq(a, b),
  gt: (a, b) => num(a) > num(b),
  gte: (a, b) => num(a) >= num(b),
  lt: (a, b) => num(a) < num(b),
  lte: (a, b) => num(a) <= num(b),
  and: (...a) => a.every(Boolean),
  or: (...a) => a.some(Boolean),
  not: (a) => !a,
  add: (...a) => a.reduce((s, x) => s + (num(x) || 0), 0),
  sub: (a, b) => num(a) - num(b),
  mul: (...a) => a.reduce((s, x) => s * num(x), 1),
  div: (a, b) => (num(b) === 0 ? NaN : num(a) / num(b)),
  concat: (...a) => a.map((x) => (x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(''),
  formatNumber: (n, digits) => {
    const x = num(n);
    if (!Number.isFinite(x)) return '';
    const d = Number.isInteger(num(digits)) ? Math.max(0, Math.min(10, num(digits))) : undefined;
    return x.toLocaleString(undefined, d === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: d, maximumFractionDigits: d });
  },
};

/** Evaluates a value: literals as they are, bindings and operators against `scope`. */
function ev(v, scope, depth = 0) {
  if (depth > 32 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => ev(x, scope, depth + 1));
  if (typeof v.$ === 'string') return lookup(v.$, scope);
  if (typeof v.$op === 'string') {
    const fn = OPS[v.$op];
    return fn ? fn(...(v.args ?? []).map((x) => ev(x, scope, depth + 1))) : undefined;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = ev(x, scope, depth + 1);
  return out;
}

const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Sets `state.a.b` in the model's state. */
function setPath(m, path, value) {
  const parts = String(path).split('.').slice(1);
  if (!parts.length || parts.some((p) => FORBIDDEN.has(p))) return;
  let cur = m.state;
  for (const p of parts.slice(0, -1)) {
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(p) ? [] : {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = clone(value);
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

// ------------------------------------------------------------------ math

let katex = null;
function loadKatex() {
  if (!katex) {
    katex = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/katex/katex.min.css';
      document.head.append(css);
      const s = document.createElement('script');
      s.src = 'vendor/katex/katex.min.js';
      s.onload = () => (window.katex ? resolve(window.katex) : reject(new Error('KaTeX did not load')));
      s.onerror = () => reject(new Error('KaTeX did not load'));
      document.head.append(s);
    });
  }
  return katex;
}

function mathInto(el, tex) {
  el.textContent = tex; // readable until KaTeX arrives, and if it never does
  loadKatex().then(
    (k) => {
      try {
        k.render(tex, el, { displayMode: true, throwOnError: false, trust: false, maxSize: 20, maxExpand: 200, output: 'htmlAndMathml' });
      } catch {
        el.textContent = tex;
      }
    },
    () => {},
  );
}

// ------------------------------------------------------------------ the view

/**
 * Mounts a view for artifact `a`. `send(text, a)` sends the person a message
 * from the view; `onSave(a, saved)` saves it to the artifacts or takes it out.
 */
export function mountView(a, { send, onSave, onOpen }) {
  const m = modelFor(a.id);
  const root = document.createElement('section');
  root.className = 'genui';
  root.dataset.view = a.id;
  const head = document.createElement('header');
  head.className = 'genui-head';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'genui-title';
  title.title = 'Open the view';
  title.addEventListener('click', () => onOpen?.(view.artifact));
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'genui-save';
  mark.innerHTML = '<svg viewBox="0 0 16 20" width="14" height="18" aria-hidden="true"><path d="M2 1.5h12a.5.5 0 0 1 .5.5v16.2a.4.4 0 0 1-.65.3L8 13.8l-5.85 4.7a.4.4 0 0 1-.65-.3V2a.5.5 0 0 1 .5-.5Z"/></svg>';
  mark.addEventListener('click', () => onSave?.(view.artifact, !view.artifact.saved));
  head.append(title, mark);
  const body = document.createElement('div');
  body.className = 'genui-body';
  const note = document.createElement('div');
  note.className = 'genui-notice';
  note.hidden = true;
  root.append(head, body, note);

  const ui = new Map(); // node path → its own UI state (tab, page, sort, open popover…)
  const view = {
    artifact: a,
    root,
    setArtifact(next) {
      view.artifact = next;
      title.textContent = m.doc?.title || next.title;
      mark.classList.toggle('on', !!next.saved);
      mark.setAttribute('aria-pressed', next.saved ? 'true' : 'false');
      mark.setAttribute('aria-label', next.saved ? 'Saved to artifacts. Remove it from the artifacts' : 'Save to artifacts');
      mark.title = next.saved ? 'Saved to artifacts' : 'Save to artifacts';
    },
    notice(t) {
      note.textContent = t;
      note.hidden = !t;
    },
    draw() {
      if (root.isConnected) view.shown = true;
      view.setArtifact(view.artifact);
      if (m.errors) {
        const box = document.createElement('div');
        box.className = 'genui-error';
        const h = document.createElement('strong');
        h.textContent = 'This view has a mistake, so it is not shown.';
        const list = document.createElement('ul');
        for (const e of m.errors.slice(0, 8)) {
          const li = document.createElement('li');
          li.textContent = e;
          list.append(li);
        }
        box.append(h, list);
        body.replaceChildren(box);
        return;
      }
      if (!m.doc) return;
      // Keep the focused field (and its caret) across the redraw.
      const active = root.contains(document.activeElement) ? document.activeElement : null;
      const keep = active?.dataset.gpath && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /^(text|number|search|date)$/.test(active.type))) ? active : null;
      const focusPath = active?.dataset.gpath;
      const ctx = { m, ui, view, send, keep, scope: { state: m.state, data: m.doc.data ?? {}, item: undefined, index: undefined, event: undefined } };
      const tree = node(m.doc.view, ctx, 'v');
      body.replaceChildren(...(tree ? [tree] : []));
      if (!keep && focusPath) body.querySelector(`[data-gpath="${CSS.escape(focusPath)}"]`)?.focus({ preventScroll: true });
    },
    dispose() {
      m.views.delete(view);
    },
  };
  m.views.add(view);
  view.setArtifact(a);
  title.textContent = a.title;
  const version = a.version ?? a.rev;
  if (m.version !== version || (!m.doc && !m.errors)) {
    body.textContent = 'Loading…';
    load(m, version);
  }
  if (m.doc || m.errors) view.draw();
  return view;
}

/** Runs a node's actions for one event (only ever from the person's own input). */
function run(ctx, n, name, scope, event) {
  const actions = n.on?.[name];
  if (!Array.isArray(actions)) return;
  const s = { ...scope, event };
  let touched = false;
  for (const act of actions) {
    switch (act.do) {
      case 'set':
        setPath(ctx.m, act.path, ev(act.value, s));
        touched = true;
        break;
      case 'toggle':
        setPath(ctx.m, act.path, !lookup(act.path, { state: ctx.m.state }));
        touched = true;
        break;
      case 'copy':
        navigator.clipboard?.writeText(text(ev(act.text, s))).catch(() => {});
        break;
      case 'open': {
        const url = safeUrl(ev(act.url, s));
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        break;
      }
      case 'send': {
        const t = text(ev(act.text, s)).trim();
        if (t) ctx.send(t, ctx.view.artifact);
        break;
      }
    }
  }
  if (touched) changed(ctx.m);
}

function bindValue(ctx, n, scope) {
  return n.bind ? lookup(n.bind.$, scope) : undefined;
}

function setBound(ctx, n, scope, value, eventValue = value) {
  if (n.bind) setPath(ctx.m, n.bind.$, value);
  if (n.on?.change) run(ctx, n, 'change', scope, { value: eventValue });
  else if (n.bind) changed(ctx.m);
}

/** One node (with `when` and `repeat`) as DOM, or null. */
function node(n, ctx, path, scope = ctx.scope) {
  if (!n || typeof n !== 'object') return null;
  if (n.repeat) {
    const list = ev(n.repeat, scope);
    const frag = document.createDocumentFragment();
    if (!Array.isArray(list)) return null;
    list.slice(0, MAX_REPEAT).forEach((item, index) => {
      const s = { ...scope, item, index };
      const key = n.key && item && typeof item === 'object' ? text(item[n.key]) : String(index);
      const el = one(n, ctx, `${path}[${key}]`, s);
      if (el) frag.append(el);
    });
    const wrap = document.createElement('div');
    wrap.className = 'genui-repeat';
    wrap.append(frag);
    return wrap;
  }
  return one(n, ctx, path, scope);
}

function one(n, ctx, path, scope) {
  if (n.when !== undefined && !ev(n.when, scope)) return null;
  switch (n.type) {
    case 'layout':
      return layout(n, ctx, path, scope);
    case 'text':
      return textNode(n, scope);
    case 'control':
      return control(n, ctx, path, scope);
    case 'table':
      return table(n, ctx, path, scope);
    case 'chart':
      return chart(n, ctx, path, scope);
    default:
      return null;
  }
}

function children(n, ctx, path, scope) {
  return (Array.isArray(n.children) ? n.children : []).map((c, i) => node(c, ctx, `${path}.${i}`, scope)).filter(Boolean);
}

function el(tag, className, textContent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
}

function styleBox(e, n) {
  if (typeof n.gap === 'number') e.style.gap = `${n.gap}px`;
  if (n.align) e.style.alignItems = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' }[n.align];
  if (n.justify) e.style.justifyContent = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between' }[n.justify];
}

// ------------------------------------------------------------------ layout

function layout(n, ctx, path, scope) {
  const st = ctx.ui.get(path) ?? {};
  switch (n.kind) {
    case 'spacer': {
      const e = el('div', 'genui-spacer');
      e.style.flexBasis = e.style.height = `${typeof n.size === 'number' ? n.size : 12}px`;
      return e;
    }
    case 'divider':
      return el('hr', 'genui-divider');
    case 'card': {
      const e = el('div', 'genui-card');
      const t = ev(n.title, scope);
      if (t !== undefined && t !== '') e.append(el('div', 'genui-card-title', text(t)));
      const inner = el('div', 'genui-column');
      styleBox(inner, n);
      inner.append(...children(n, ctx, path, scope));
      e.append(inner);
      return e;
    }
    case 'row':
    case 'column': {
      const e = el('div', `genui-${n.kind}`);
      styleBox(e, n);
      e.append(...children(n, ctx, path, scope));
      return e;
    }
    case 'grid': {
      const e = el('div', 'genui-grid');
      styleBox(e, n);
      e.style.gridTemplateColumns = `repeat(auto-fill, minmax(min(100%, ${typeof n.minWidth === 'number' ? n.minWidth : 140}px), 1fr))`;
      e.append(...children(n, ctx, path, scope));
      return e;
    }
    case 'scroll': {
      const e = el('div', 'genui-scroll');
      e.style.maxHeight = `${typeof n.maxHeight === 'number' ? n.maxHeight : 300}px`;
      e.tabIndex = 0;
      const inner = el('div', 'genui-column');
      styleBox(inner, n);
      inner.append(...children(n, ctx, path, scope));
      e.append(inner);
      const top = st.scrollTop ?? 0;
      requestAnimationFrame(() => (e.scrollTop = top));
      e.addEventListener('scroll', () => ctx.ui.set(path, { ...st, scrollTop: e.scrollTop }), { passive: true });
      return e;
    }
    case 'tabs': {
      const kids = Array.isArray(n.children) ? n.children : [];
      const labels = ev(n.labels, scope) ?? [];
      const sel = Math.min(st.tab ?? 0, Math.max(0, kids.length - 1));
      const e = el('div', 'genui-tabs');
      const bar = el('div', 'genui-tabbar');
      bar.setAttribute('role', 'tablist');
      kids.forEach((_, i) => {
        const b = el('button', i === sel ? 'on' : '', text(labels[i] ?? `Tab ${i + 1}`));
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(i === sel));
        b.tabIndex = i === sel ? 0 : -1;
        b.dataset.gpath = `${path}#tab${i}`;
        b.addEventListener('click', () => {
          ctx.ui.set(path, { ...st, tab: i });
          ctx.view.draw();
        });
        b.addEventListener('keydown', (e2) => {
          const d = e2.key === 'ArrowRight' ? 1 : e2.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e2.preventDefault();
          const next = (sel + d + kids.length) % kids.length;
          ctx.ui.set(path, { ...st, tab: next });
          ctx.view.draw();
          ctx.view.root.querySelector(`[data-gpath="${CSS.escape(`${path}#tab${next}`)}"]`)?.focus();
        });
        bar.append(b);
      });
      const panel = el('div', 'genui-column');
      panel.setAttribute('role', 'tabpanel');
      const child = kids[sel] ? node(kids[sel], ctx, `${path}.${sel}`, scope) : null;
      if (child) panel.append(child);
      e.append(bar, panel);
      return e;
    }
    case 'carousel': {
      const kids = children(n, ctx, path, scope);
      const at = Math.min(st.slide ?? 0, Math.max(0, kids.length - 1));
      const e = el('div', 'genui-carousel');
      e.setAttribute('aria-roledescription', 'carousel');
      const slide = el('div', 'genui-slide');
      slide.setAttribute('aria-label', `${at + 1} of ${kids.length}`);
      if (kids[at]) slide.append(kids[at]);
      const go = (i) => {
        ctx.ui.set(path, { ...st, slide: (i + kids.length) % kids.length });
        ctx.view.draw();
      };
      const nav = el('div', 'genui-carousel-nav');
      const prev = el('button', 'genui-round', '‹');
      prev.type = 'button';
      prev.setAttribute('aria-label', 'Previous');
      prev.addEventListener('click', () => go(at - 1));
      const dots = el('div', 'genui-dots');
      kids.forEach((_, i) => {
        const d = el('button', i === at ? 'on' : '');
        d.type = 'button';
        d.setAttribute('aria-label', `Show ${i + 1} of ${kids.length}`);
        d.addEventListener('click', () => go(i));
        dots.append(d);
      });
      const next = el('button', 'genui-round', '›');
      next.type = 'button';
      next.setAttribute('aria-label', 'Next');
      next.addEventListener('click', () => go(at + 1));
      nav.append(prev, dots, next);
      e.append(slide, ...(kids.length > 1 ? [nav] : []));
      // Swipes on touch screens.
      let x0 = null;
      slide.addEventListener('pointerdown', (p) => (x0 = p.clientX));
      slide.addEventListener('pointerup', (p) => {
        if (x0 !== null && Math.abs(p.clientX - x0) > 40) go(at + (p.clientX < x0 ? 1 : -1));
        x0 = null;
      });
      return e;
    }
    case 'popover': {
      const e = el('div', 'genui-popover');
      const b = el('button', 'genui-button secondary', text(ev(n.label, scope)) || 'More');
      b.type = 'button';
      b.dataset.gpath = path;
      b.setAttribute('aria-expanded', String(!!st.open));
      b.addEventListener('click', () => {
        ctx.ui.set(path, { ...st, open: !st.open });
        ctx.view.draw();
      });
      e.append(b);
      if (st.open) {
        const panel = el('div', 'genui-popover-panel genui-column');
        styleBox(panel, n);
        panel.append(...children(n, ctx, path, scope));
        panel.addEventListener('keydown', (k) => {
          if (k.key !== 'Escape') return;
          ctx.ui.set(path, { ...st, open: false });
          ctx.view.draw();
        });
        e.append(panel);
        // A press anywhere else closes it.
        const away = (p) => {
          if (!e.isConnected) return document.removeEventListener('pointerdown', away, true);
          if (e.contains(p.target)) return;
          document.removeEventListener('pointerdown', away, true);
          ctx.ui.set(path, { ...st, open: false });
          ctx.view.draw();
        };
        setTimeout(() => document.addEventListener('pointerdown', away, true));
      }
      return e;
    }
    case 'form': {
      const f = el('form', 'genui-form genui-column');
      styleBox(f, n);
      f.noValidate = false;
      f.append(...children(n, ctx, path, scope));
      const submit = el('button', 'genui-button primary', text(ev(n.submitLabel, scope)) || 'Submit');
      submit.type = 'submit';
      f.append(submit);
      f.addEventListener('submit', (e2) => {
        e2.preventDefault();
        if (!f.reportValidity()) return;
        run(ctx, n, 'submit', scope, { value: clone(ctx.m.state) });
      });
      return f;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ text

function textNode(n, scope) {
  const value = text(ev(n.value, scope));
  const cls = `genui-text size-${n.size ?? 'body'} tone-${n.tone ?? 'default'}${n.weight === 'bold' ? ' bold' : ''}`;
  switch (n.format) {
    case 'markdown': {
      const e = el('div', `${cls} genui-markdown`);
      e.innerHTML = renderMarkdown(value);
      return e;
    }
    case 'math': {
      const e = el('div', `${cls} genui-math`);
      e.setAttribute('role', 'math');
      e.setAttribute('aria-label', value);
      mathInto(e, value);
      return e;
    }
    case 'code': {
      const e = el('pre', `${cls} genui-code`);
      const c = el('code', '', value);
      if (n.language) c.dataset.language = n.language;
      e.append(c);
      return e;
    }
    default:
      return el('div', `${cls} genui-plain`, value);
  }
}

// ------------------------------------------------------------------ controls

function options(n, scope) {
  const list = ev(n.options, scope);
  if (!Array.isArray(list)) return [];
  return list.map((o) => (o && typeof o === 'object' ? { label: text(o.label), value: o.value } : { label: text(o), value: o }));
}

const same = (a, b) => OPS.eq(a, b);

function control(n, ctx, path, scope) {
  const label = text(ev(n.label, scope));
  const disabled = !!ev(n.disabled, scope);
  const required = !!ev(n.required, scope);
  const help = text(ev(n.help, scope));
  const current = bindValue(ctx, n, scope);
  const field = (input, inline = false) => {
    const wrap = el('label', `genui-field${inline ? ' inline' : ''}`);
    if (label && !inline) wrap.append(el('span', 'genui-label', label));
    wrap.append(input);
    if (label && inline) wrap.append(el('span', 'genui-label', label));
    if (help) wrap.append(el('span', 'genui-help', help));
    return wrap;
  };
  const tag = (input) => {
    input.dataset.gpath = path;
    input.disabled = disabled;
    if (required) input.required = true;
    return input;
  };
  switch (n.kind) {
    case 'button': {
      const b = tag(el('button', `genui-button ${n.style ?? 'secondary'}`, label || 'OK'));
      b.type = 'button';
      b.addEventListener('click', () => run(ctx, n, 'click', scope, { value: current }));
      return b;
    }
    case 'text':
    case 'number':
    case 'date':
    case 'textarea': {
      if (ctx.keep?.dataset.gpath === path) {
        // The field being typed in stays the same element.
        return ctx.keep.closest('.genui-field') ?? ctx.keep;
      }
      const input = tag(n.kind === 'textarea' ? el('textarea', 'genui-input') : el('input', 'genui-input'));
      if (n.kind !== 'textarea') input.type = n.kind;
      if (n.kind === 'textarea') input.rows = 3;
      const ph = text(ev(n.placeholder, scope));
      if (ph) input.placeholder = ph;
      if (n.kind === 'number') {
        if (typeof n.min === 'number') input.min = String(n.min);
        if (typeof n.max === 'number') input.max = String(n.max);
        if (typeof n.step === 'number') input.step = String(n.step);
      }
      input.value = current === undefined || current === null ? '' : String(current);
      const read = () => (n.kind === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value);
      input.addEventListener('input', () => {
        if (n.bind) setPath(ctx.m, n.bind.$, read());
        changed(ctx.m);
      });
      input.addEventListener('change', () => {
        if (n.on?.change) run(ctx, n, 'change', scope, { value: read() });
      });
      return field(input);
    }
    case 'select': {
      const s = tag(el('select', 'genui-input'));
      const opts = options(n, scope);
      if (!opts.some((o) => same(o.value, current))) {
        const blank = el('option', '', text(ev(n.placeholder, scope)) || 'Choose…');
        blank.value = '';
        blank.disabled = true;
        blank.selected = true;
        s.append(blank);
      }
      opts.forEach((o, i) => {
        const opt = el('option', '', o.label);
        opt.value = String(i);
        if (same(o.value, current)) opt.selected = true;
        s.append(opt);
      });
      s.addEventListener('change', () => {
        const o = opts[Number(s.value)];
        if (o) setBound(ctx, n, scope, o.value);
      });
      return field(s);
    }
    case 'radio':
    case 'segmented': {
      const opts = options(n, scope);
      const group = el('div', n.kind === 'segmented' ? 'genui-segmented' : 'genui-radios');
      group.setAttribute('role', 'radiogroup');
      if (label) group.setAttribute('aria-label', label);
      opts.forEach((o, i) => {
        const on = same(o.value, current);
        if (n.kind === 'segmented') {
          const b = tag(el('button', on ? 'on' : '', o.label));
          b.dataset.gpath = `${path}#${i}`;
          b.type = 'button';
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', String(on));
          b.addEventListener('click', () => setBound(ctx, n, scope, o.value));
          group.append(b);
        } else {
          const r = tag(el('input'));
          r.dataset.gpath = `${path}#${i}`;
          r.type = 'radio';
          r.name = `${ctx.view.artifact.id}:${path}`;
          r.checked = on;
          r.addEventListener('change', () => r.checked && setBound(ctx, n, scope, o.value));
          const l = el('label', 'genui-field inline');
          l.append(r, el('span', 'genui-label', o.label));
          group.append(l);
        }
      });
      if (n.kind === 'segmented' && !label) return group;
      const wrap = el('div', 'genui-field');
      if (label) wrap.append(el('span', 'genui-label', label));
      wrap.append(group);
      if (help) wrap.append(el('span', 'genui-help', help));
      return wrap;
    }
    case 'checkbox':
    case 'switch': {
      const c = tag(el('input', n.kind === 'switch' ? 'genui-switch' : 'genui-check'));
      c.type = 'checkbox';
      if (n.kind === 'switch') c.setAttribute('role', 'switch');
      c.checked = !!current;
      c.addEventListener('change', () => setBound(ctx, n, scope, c.checked));
      return field(c, true);
    }
    case 'slider': {
      const r = tag(el('input', 'genui-slider'));
      r.type = 'range';
      r.min = String(typeof n.min === 'number' ? n.min : 0);
      r.max = String(typeof n.max === 'number' ? n.max : 100);
      r.step = String(typeof n.step === 'number' ? n.step : 1);
      r.value = String(num(current) || Number(r.min));
      const out = el('output', 'genui-slider-value', r.value);
      r.addEventListener('input', () => {
        out.textContent = r.value;
        if (n.bind) setPath(ctx.m, n.bind.$, Number(r.value));
      });
      r.addEventListener('change', () => setBound(ctx, n, scope, Number(r.value)));
      const row = el('div', 'genui-slider-row');
      row.append(r, out);
      const wrap = el('div', 'genui-field');
      if (label) wrap.append(el('span', 'genui-label', label));
      wrap.append(row);
      if (help) wrap.append(el('span', 'genui-help', help));
      r.setAttribute('aria-label', label || 'Value');
      return wrap;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ table

function formatCell(v, col) {
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

function table(n, ctx, path, scope) {
  const st = ctx.ui.get(path) ?? {};
  const columns = (ev(n.columns, scope) ?? []).filter((c) => c && typeof c.key === 'string');
  let rows = ev(n.rows, scope);
  rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const keyOf = (r, i) => (n.rowKey && r[n.rowKey] !== undefined ? r[n.rowKey] : r.id !== undefined ? r.id : i);
  let shown = rows.map((r, i) => ({ r, key: keyOf(r, i) }));
  const query = (st.query ?? '').trim().toLowerCase();
  if (query) shown = shown.filter(({ r }) => columns.some((c) => text(r[c.key]).toLowerCase().includes(query)));
  if (st.sort) {
    const { key, dir } = st.sort;
    shown.sort((a, b) => {
      const x = a.r[key];
      const y = b.r[key];
      const nx = num(x);
      const ny = num(y);
      const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : text(x).localeCompare(text(y), undefined, { numeric: true });
      return dir === 'desc' ? -c : c;
    });
  }
  const size = typeof n.pageSize === 'number' ? n.pageSize : 0;
  const pages = size ? Math.max(1, Math.ceil(shown.length / size)) : 1;
  const page = Math.min(st.page ?? 0, pages - 1);
  const visible = size ? shown.slice(page * size, page * size + size) : shown;
  const selected = n.bind ? bindValue(ctx, n, scope) : st.selected;
  const set = (patch) => {
    ctx.ui.set(path, { ...st, ...patch });
    ctx.view.draw();
  };

  const wrap = el('div', 'genui-table');
  const cap = text(ev(n.caption, scope));
  if (ev(n.search, scope)) {
    const s = el('input', 'genui-input genui-search');
    s.type = 'search';
    s.placeholder = 'Search';
    s.setAttribute('aria-label', 'Search the table');
    s.value = st.query ?? '';
    s.dataset.gpath = `${path}#search`;
    s.addEventListener('input', () => {
      ctx.ui.set(path, { ...st, query: s.value, page: 0 });
      ctx.view.draw();
    });
    wrap.append(ctx.keep?.dataset.gpath === s.dataset.gpath ? ctx.keep : s);
  }
  const scroller = el('div', 'genui-table-scroll');
  const t = el('table');
  if (cap) t.append(el('caption', '', cap));
  const thead = el('thead');
  const hr = el('tr');
  for (const c of columns) {
    const th = el('th');
    th.scope = 'col';
    if (c.align) th.style.textAlign = c.align === 'start' ? 'left' : c.align === 'end' ? 'right' : 'center';
    else if (['number', 'percent', 'currency'].includes(c.format)) th.style.textAlign = 'right';
    const sorted = st.sort?.key === c.key ? st.sort.dir : null;
    if (c.sortable) {
      const b = el('button', 'genui-sort', c.label ?? c.key);
      b.type = 'button';
      b.dataset.gpath = `${path}#sort:${c.key}`;
      b.append(el('span', 'genui-sort-mark', sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''));
      th.setAttribute('aria-sort', sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none');
      b.addEventListener('click', () => set({ sort: { key: c.key, dir: sorted === 'asc' ? 'desc' : 'asc' } }));
      th.append(b);
    } else th.textContent = c.label ?? c.key;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  const selectable = !!ev(n.selectable, scope);
  for (const { r, key } of visible) {
    const tr = el('tr');
    const on = selectable && selected !== undefined && same(selected, key);
    if (selectable) {
      tr.className = `selectable${on ? ' on' : ''}`;
      tr.tabIndex = 0;
      tr.dataset.gpath = `${path}#row:${text(key)}`;
      tr.setAttribute('aria-selected', String(on));
      const pick = () => {
        if (n.bind) setPath(ctx.m, n.bind.$, key);
        else ctx.ui.set(path, { ...st, selected: key });
        if (n.on?.select) run(ctx, n, 'select', scope, { value: key, id: key, row: clone(r) });
        else if (n.bind) changed(ctx.m);
        else ctx.view.draw();
      };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (k) => {
        if (k.key === 'Enter' || k.key === ' ') {
          k.preventDefault();
          pick();
        }
      });
    }
    for (const c of columns) {
      const td = el('td', '', formatCell(r[c.key], c));
      if (c.align) td.style.textAlign = c.align === 'start' ? 'left' : c.align === 'end' ? 'right' : 'center';
      else if (['number', 'percent', 'currency'].includes(c.format)) td.style.textAlign = 'right';
      tr.append(td);
    }
    tbody.append(tr);
  }
  if (!visible.length) {
    const tr = el('tr');
    const td = el('td', 'genui-empty', query ? 'Nothing matches.' : 'No rows.');
    td.colSpan = Math.max(1, columns.length);
    tr.append(td);
    tbody.append(tr);
  }
  if (selectable) t.setAttribute('aria-multiselectable', 'false');
  t.append(thead, tbody);
  scroller.append(t);
  wrap.append(scroller);
  if (pages > 1) {
    const nav = el('div', 'genui-pager');
    const prev = el('button', 'genui-round', '‹');
    prev.type = 'button';
    prev.disabled = page === 0;
    prev.setAttribute('aria-label', 'Previous page');
    prev.addEventListener('click', () => set({ page: page - 1 }));
    const next = el('button', 'genui-round', '›');
    next.type = 'button';
    next.disabled = page >= pages - 1;
    next.setAttribute('aria-label', 'Next page');
    next.addEventListener('click', () => set({ page: page + 1 }));
    nav.append(prev, el('span', '', `${page + 1} of ${pages}`), next);
    wrap.append(nav);
  }
  return wrap;
}

// ------------------------------------------------------------------ chart

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) hi = lo + 1;
  const span = hi - lo;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= step0) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

const short = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })}B`;
  if (a >= 1e6) return `${(v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
  if (a >= 1e4) return `${(v / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

function chart(n, ctx, path, scope) {
  let rows = ev(n.data, scope);
  rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object').slice(0, MAX_REPEAT) : [];
  const series = (ev(n.series, scope) ?? []).filter((s) => s && typeof s.y === 'string');
  const unit = n.unit ? ` ${n.unit}` : '';
  const labels = rows.map((r) => text(r[n.x]));
  const colorOf = (s, i) => COLOR[s.color] ?? COLOR[PALETTE[i % PALETTE.length]];
  const wrap = el('figure', 'genui-chart');
  const title = text(ev(n.title, scope));
  if (title) wrap.append(el('figcaption', 'genui-chart-title', title));
  const readout = el('div', 'genui-chart-readout');
  readout.setAttribute('aria-live', 'polite');
  const select = (i) => {
    const r = rows[i];
    if (!r) return;
    readout.textContent = `${labels[i]}: ${series.map((s) => `${s.label ?? s.y} ${short(num(r[s.y]))}${unit}`).join(', ')}`;
    if (n.on?.select) run(ctx, n, 'select', scope, { value: r[n.x], id: r[n.x], row: clone(r) });
  };
  const hover = (i) => {
    const r = rows[i];
    if (r) readout.textContent = `${labels[i]}: ${series.map((s) => `${s.label ?? s.y} ${short(num(r[s.y]))}${unit}`).join(', ')}`;
  };
  const H = typeof n.height === 'number' ? n.height : 200;
  // Drawn at the view's width, so the labels keep their size.
  const W = Math.max(240, Math.min(900, (ctx.view.root.querySelector('.genui-body')?.clientWidth ?? 0) - 28)) || 360;
  const pic = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'genui-chart-svg', role: 'img' });
  // A text version of every value, for screen readers.
  const summary = `${title || 'Chart'}. ${rows.map((r, i) => `${labels[i]}: ${series.map((s) => `${s.label ?? s.y} ${text(r[s.y])}${unit}`).join(', ')}`).join('; ')}`;
  pic.setAttribute('aria-label', summary.slice(0, 2000));

  if (n.kind === 'pie') {
    const s = series[0];
    const vals = s ? rows.map((r) => Math.max(0, num(r[s.y]) || 0)) : [];
    const total = vals.reduce((a, b) => a + b, 0);
    const cx = W / 2;
    const cy = H / 2;
    const rad = H / 2 - 8;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (!total || !v) return;
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = v === total
        ? svg('circle', { cx, cy, r: rad })
        : svg('path', { d: `M${cx},${cy} L${cx + rad * Math.cos(a0)},${cy + rad * Math.sin(a0)} A${rad},${rad} 0 ${large} 1 ${cx + rad * Math.cos(a1)},${cy + rad * Math.sin(a1)} Z` });
      p.setAttribute('fill', COLOR[PALETTE[i % PALETTE.length]]);
      p.setAttribute('class', 'genui-mark');
      p.setAttribute('tabindex', '0');
      p.append(svg('title'));
      p.lastChild.textContent = `${labels[i]}: ${short(v)}${unit} (${Math.round((v / total) * 100)}%)`;
      p.addEventListener('pointerenter', () => hover(i));
      p.addEventListener('click', () => select(i));
      p.addEventListener('keydown', (k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), select(i)));
      pic.append(p);
      a0 = a1;
    });
    wrap.append(pic, readout);
    const legend = el('div', 'genui-legend');
    labels.forEach((l, i) => {
      const item = el('span', 'genui-legend-item', l);
      item.style.setProperty('--c', COLOR[PALETTE[i % PALETTE.length]]);
      legend.append(item);
    });
    wrap.append(legend);
    return wrap;
  }

  const values = rows.flatMap((r) => series.map((s) => num(r[s.y]))).filter(Number.isFinite);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const ticks = niceTicks(lo, hi);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const L = 44;
  const R = 8;
  const T = 8;
  const B = 24;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const y = (v) => T + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  for (const t of ticks) {
    pic.append(svg('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? 'genui-axis' : 'genui-grid' }));
    const lab = svg('text', { x: L - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'genui-tick' });
    lab.textContent = short(t);
    pic.append(lab);
  }
  const n0 = Math.max(1, rows.length);
  const band = plotW / n0;
  const every = Math.ceil(n0 / Math.max(1, Math.floor(plotW / 56)));
  labels.forEach((l, i) => {
    if (i % every) return;
    const lab = svg('text', { x: L + band * i + band / 2, y: H - 6, 'text-anchor': 'middle', class: 'genui-tick' });
    lab.textContent = l.length > 10 ? `${l.slice(0, 9)}…` : l;
    pic.append(lab);
  });
  if (n.kind === 'bar') {
    const groupW = band * 0.72;
    const barW = groupW / Math.max(1, series.length);
    rows.forEach((r, i) => {
      series.forEach((s, j) => {
        const v = num(r[s.y]);
        if (!Number.isFinite(v)) return;
        const x = L + band * i + (band - groupW) / 2 + barW * j;
        const top = y(Math.max(0, v));
        const h = Math.abs(y(v) - y(0));
        const rect = svg('rect', { x: x + 1, y: top, width: Math.max(1, barW - 2), height: Math.max(1, h), rx: Math.min(4, barW / 4), fill: colorOf(s, j), class: 'genui-mark', tabindex: 0 });
        rect.append(svg('title'));
        rect.lastChild.textContent = `${labels[i]}, ${s.label ?? s.y}: ${short(v)}${unit}`;
        rect.addEventListener('pointerenter', () => hover(i));
        rect.addEventListener('click', () => select(i));
        rect.addEventListener('keydown', (k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), select(i)));
        pic.append(rect);
      });
    });
  } else {
    series.forEach((s, j) => {
      const pts = rows.map((r, i) => [L + band * i + band / 2, num(r[s.y]), i]).filter((p) => Number.isFinite(p[1]));
      if (!pts.length) return;
      const d = pts.map(([x, v], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      if (n.kind === 'area') {
        const area = svg('path', { d: `${d} L${pts[pts.length - 1][0].toFixed(1)},${y(Math.max(yMin, 0))} L${pts[0][0].toFixed(1)},${y(Math.max(yMin, 0))} Z`, fill: colorOf(s, j), 'fill-opacity': 0.22 });
        pic.append(area);
      }
      pic.append(svg('path', { d, fill: 'none', stroke: colorOf(s, j), 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      for (const [x, v, i] of pts) {
        const dot = svg('circle', { cx: x, cy: y(v), r: pts.length > 40 ? 2 : 3.5, fill: colorOf(s, j), class: 'genui-mark', tabindex: 0 });
        dot.append(svg('title'));
        dot.lastChild.textContent = `${labels[i]}, ${s.label ?? s.y}: ${short(v)}${unit}`;
        dot.addEventListener('pointerenter', () => hover(i));
        dot.addEventListener('click', () => select(i));
        dot.addEventListener('keydown', (k) => (k.key === 'Enter' || k.key === ' ') && (k.preventDefault(), select(i)));
        pic.append(dot);
      }
    });
  }
  wrap.append(pic, readout);
  if (n.legend !== false && series.length > 1) {
    const legend = el('div', 'genui-legend');
    series.forEach((s, j) => {
      const item = el('span', 'genui-legend-item', s.label ?? s.y);
      item.style.setProperty('--c', colorOf(s, j));
      legend.append(item);
    });
    wrap.append(legend);
  }
  return wrap;
}
