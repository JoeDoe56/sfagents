/**
 * The send button's sheet: the agent, its reasoning effort and how full its
 * working context is. The medium detent shows the agent (a pop-up button
 * that opens a menu of the project's agents, as Calendar's do), the
 * reasoning slider and the context bar; the large one adds the context
 * breakdown, in the spirit of Qwen Code's /context, laid out the Apple way.
 * Changes are staged: the check button saves them, the close button, a swipe
 * down or Escape drop them.
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { showError, confirmDialog, toast } from './dialogs.js';
import { showMenu } from './menu.js';

const LEVEL_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sym(name, size) {
  const i = el('i');
  applySymbol(i, name, { size });
  return i;
}

export function tokensText(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}M`;
}

const pct = (x) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

// ------------------------------------------------------------------ the slider

/**
 * ChatGPT's effort slider, the Apple way: a glass capsule with a dot per
 * level; the chosen range fills blue up to a white knob. The knob follows
 * the finger, the track stretches a little past either end, and on release
 * the knob springs to the nearest level. Arrow keys step; a tap jumps.
 */
export function effortSlider({ levels, value, onInput, onChange, label, onMove }) {
  const root = el('div', 'ag-slider');
  root.setAttribute('role', 'slider');
  root.tabIndex = 0;
  root.setAttribute('aria-label', label);
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', String(levels.length - 1));
  const track = el('div', 'ag-track');
  const fill = el('div', 'ag-fill');
  const dots = levels.map(() => el('span', 'ag-dot'));
  const knob = el('div', 'ag-knob');
  track.append(...dots, fill, knob);
  root.append(track);

  const KNOB = 32;
  const FILL_PAD = 4; // fill inset inside the track
  const RING = 4; // blue around the knob
  let index = Math.max(0, levels.indexOf(value));
  let pos = index; // continuous position in levels
  let dragging = null;
  let anim = 0;

  function geometry() {
    const w = track.clientWidth;
    const first = FILL_PAD + RING + KNOB / 2;
    const last = w - first;
    return { w, first, step: (last - first) / Math.max(1, levels.length - 1) };
  }

  function draw(p, stretch = 0) {
    track.style.left = stretch < 0 ? `${stretch}px` : '0px';
    track.style.right = stretch > 0 ? `${-stretch}px` : '0px';
    const { first, step } = geometry();
    const cx = first + p * step;
    knob.style.translate = `${cx - KNOB / 2}px 0`;
    fill.style.width = `${cx + KNOB / 2 + RING - FILL_PAD}px`;
    dots.forEach((d, i) => {
      d.style.left = `${first + i * step}px`;
      d.classList.toggle('under', first + i * step <= cx + 1);
    });
    if (stretch || track.dataset.moved) onMove?.();
    track.dataset.moved = stretch ? '1' : '';
    const nearest = Math.round(Math.max(0, Math.min(levels.length - 1, p)));
    if (nearest !== shown) {
      shown = nearest;
      onInput?.(levels[nearest]);
      if (dragging) navigator.vibrate?.(4);
    }
    root.setAttribute('aria-valuenow', String(nearest));
    root.setAttribute('aria-valuetext', LEVEL_NAMES[levels[nearest]] ?? levels[nearest]);
  }
  let shown = index;

  function animateTo(target, from = pos) {
    cancelAnimationFrame(anim);
    const start = performance.now();
    const ms = reduced.matches ? 0 : 380;
    const fromStretch = parseFloat(track.dataset.stretch || '0');
    const step = (now) => {
      const t = ms ? Math.min(1, (now - start) / ms) : 1;
      // A spring with a small overshoot.
      const e = 1 - Math.exp(-7 * t) * Math.cos(5.2 * t);
      pos = from + (target - from) * (t >= 1 ? 1 : e);
      draw(pos, fromStretch * (1 - Math.min(1, t * 2)));
      if (t < 1) anim = requestAnimationFrame(step);
      else track.dataset.stretch = '0';
    };
    anim = requestAnimationFrame(step);
  }

  function commit(next) {
    const changed = next !== index;
    index = next;
    animateTo(next);
    if (changed) onChange?.(levels[next]);
  }

  function posAt(clientX) {
    const r = track.getBoundingClientRect();
    const { first, step } = geometry();
    return (clientX - r.left - first) / step;
  }

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cancelAnimationFrame(anim);
    const p = posAt(e.clientX);
    const onKnob = Math.abs(p - pos) < 0.6;
    dragging = { id: e.pointerId, startX: e.clientX, offset: onKnob ? pos - p : 0, moved: false, tapTo: Math.round(Math.max(0, Math.min(levels.length - 1, p))) };
    root.setPointerCapture(e.pointerId);
    root.classList.add('active');
    e.preventDefault();
  });
  root.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    if (!dragging.moved && Math.abs(e.clientX - dragging.startX) < 4) return;
    dragging.moved = true;
    let p = posAt(e.clientX) + dragging.offset;
    const max = levels.length - 1;
    let stretch = 0;
    const { step } = geometry();
    if (p < 0) {
      stretch = Math.max(-24, p * step * 0.3);
      p = 0;
    } else if (p > max) {
      stretch = Math.min(24, (p - max) * step * 0.3);
      p = max;
    }
    pos = p;
    track.dataset.stretch = String(stretch);
    draw(pos, stretch);
  });
  const release = (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const d = dragging;
    dragging = null;
    root.classList.remove('active');
    commit(d.moved ? Math.round(pos) : d.tapTo);
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('keydown', (e) => {
    const map = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (e.key in map) {
      e.preventDefault();
      commit(Math.max(0, Math.min(levels.length - 1, index + map[e.key])));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      commit(e.key === 'Home' ? 0 : levels.length - 1);
    }
  });
  new ResizeObserver(() => {
    if (!dragging && !track.dataset.moved) draw(pos);
  }).observe(root);
  requestAnimationFrame(() => draw(pos));

  return {
    element: root,
    set(v) {
      const i = levels.indexOf(v);
      if (i < 0 || i === index || dragging) return;
      index = i;
      animateTo(i);
    },
  };
}

// ------------------------------------------------------------------ the context bar

/** A bar like the drives': label, used/total and percentage on one line inside it. */
export function usageBar(label) {
  const root = el('div', 'usage-bar ag-unit');
  const fill = el('span', 'usage-fill');
  const text = el('span', 'usage-text');
  const name = el('span', 'usage-name', label);
  const amount = el('span', 'usage-amount', '');
  const percent = el('span', 'usage-pct', '');
  text.append(name, amount, percent);
  root.append(fill, text);
  return {
    element: root,
    set(used, total, amountText) {
      const f = total > 0 ? used / total : 0;
      fill.style.width = `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)}%`;
      root.classList.toggle('warn', f >= 0.8 && f < 0.9);
      root.classList.toggle('full', f >= 0.9);
      amount.textContent = amountText;
      percent.textContent = pct(f);
      root.setAttribute('aria-label', `${label}: ${amountText}, ${pct(f)}`);
    },
  };
}

// ------------------------------------------------------------------ the sheet

const CATEGORY_COLORS = {
  system: '#bf5af2',
  builtin: '#0a84ff',
  mcp: '#64d2ff',
  agents: '#ff9f0a',
  conversation: '#30d158',
  index: '#ffd60a',
  messages: '#ff375f',
};

let current = null;

/** Opens the sheet (or brings the open one forward). Returns a handle the app refreshes after each reply. */
export function openAgentSheet({ agent, onSaved, onEditFile } = {}) {
  if (current) return current;
  let info = agent ?? null;
  let context = null;
  let slider = null;
  let bar = null;
  const parts = {};
  // The project's agents (for the menu), what is saved, and what is staged.
  let agents = [];
  let saved = { agent: info?.id ?? null, reasoning: info?.reasoning ?? null, account: info?.account ?? null };
  const staged = { ...saved };
  const levelsOf = () => info?.levels ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  const agentById = (id) => agents.find((a) => a.id === id);

  function stagedAgent() {
    return agentById(staged.agent) ?? info;
  }

  /** Shows the staged agent and effort, and marks the sheet changed when they differ from what is saved. */
  const changed = () => staged.agent !== saved.agent || (staged.reasoning ?? null) !== (saved.reasoning ?? null) || (staged.account ?? null) !== (saved.account ?? null);

  function showStaged(animate = true) {
    const a = stagedAgent();
    parts.agentName.textContent = a?.name ?? a?.id ?? 'Agent';
    // Accounts are the saved agent's (another agent's show once it is saved).
    const sameAgent = staged.agent === saved.agent;
    const accounts = sameAgent ? (info?.accounts ?? []) : [];
    const account = accounts.find((x) => x.name === staged.account) ?? accounts[0];
    parts.accountRow.hidden = !sameAgent || accounts.length === 0;
    parts.accountName.textContent = account?.name ?? '';
    parts.accountPicker.disabled = accounts.length < 2;
    // The account row changes the medium height.
    requestAnimationFrame(() => ctx.refresh());
    parts.agentModel.textContent = (sameAgent ? account?.model : null) ?? a?.model ?? '';
    parts.agentDesc.textContent = a?.description ?? '';
    parts.agentDesc.hidden = !a?.description;
    const levels = levelsOf();
    const value = staged.reasoning && levels.includes(staged.reasoning) ? staged.reasoning : 'medium';
    parts.level.textContent = staged.reasoning ? (LEVEL_NAMES[value] ?? value) : 'Default';
    if (animate) slider.set(value);
    parts.picker.disabled = agents.length < 2 && !!agents.length;
    ctx.setDirty(changed());
  }

  function pickAccount() {
    const accounts = info?.accounts ?? [];
    if (accounts.length < 2) return;
    const listed = accounts.filter((a) => a.listed);
    const others = accounts.filter((a) => !a.listed);
    const item = (a) => ({
      label: a.name,
      detail: [a.model, a.available ? null : 'not set up'].filter(Boolean).join(' · '),
      checked: a.name === (staged.account ?? accounts[0].name),
      disabled: !a.available,
      action: () => {
        staged.account = a.name;
        showStaged(false);
      },
    });
    showMenu({ anchor: parts.accountPicker, align: 'end', title: listed.length > 1 ? 'In order: the next takes over at a limit' : undefined, groups: [listed.map(item), others.map(item)] });
  }

  function pickAgent() {
    if (!agents.length) return;
    showMenu({
      anchor: parts.picker,
      align: 'end',
      groups: [
        agents.map((a) => ({
          label: a.name ?? a.id,
          detail: a.model,
          checked: a.id === staged.agent,
          action: () => {
            if (a.id === staged.agent) return;
            staged.agent = a.id;
            staged.account = a.id === saved.agent ? saved.account : null;
            // Each agent keeps its own effort.
            staged.reasoning = a.id === saved.agent ? saved.reasoning : (a.reasoning ?? null);
            showStaged();
          },
        })),
      ],
    });
  }

  // The gear opens the agent's file in the file manager's editor.
  const gear = el('button', 'ms-close ag-gear');
  gear.type = 'button';
  gear.dataset.glass = 'control';
  gear.setAttribute('aria-label', 'Edit the agent file');
  gear.append(sym('gear', 19));
  gear.addEventListener('click', () => {
    const a = stagedAgent();
    if (a?.file) onEditFile?.(a.file);
  });
  const ctx = openSheet({
    title: 'Agent',
    detents: ['medium', 'large'],
    className: 'ag-sheet',
    trailing: gear,
    build(sheet) {
      const body = sheet.body;
      // The agent: a row with a pop-up button, as Calendar's are.
      const line = el('div', 'ag-agent ag-unit');
      const text = el('div', 'ag-agent-text');
      parts.agentDesc = el('span', 'ag-agent-desc', '');
      parts.agentDesc.hidden = true;
      text.append(el('span', 'ag-agent-label', 'Agent'), parts.agentDesc);
      parts.picker = el('button', 'ag-picker');
      parts.picker.type = 'button';
      parts.picker.setAttribute('aria-haspopup', 'menu');
      parts.agentName = el('span', 'ag-picker-name', info?.name ?? info?.id ?? 'Agent');
      const chevrons = el('span', 'ag-chevrons');
      chevrons.append(sym('chevron.up', 8), sym('chevron.down', 8));
      parts.picker.append(parts.agentName, chevrons);
      parts.picker.addEventListener('click', pickAgent);
      line.append(text, parts.picker);
      parts.agentModel = el('p', 'ag-model ag-unit', info?.model ?? '');
      // The account (provider) it replies with: its file's list, failover order, or another of the same kind.
      parts.accountRow = el('div', 'ag-agent ag-account ag-unit');
      const accText = el('div', 'ag-agent-text');
      accText.append(el('span', 'ag-agent-label', 'Account'));
      parts.accountPicker = el('button', 'ag-picker');
      parts.accountPicker.type = 'button';
      parts.accountPicker.setAttribute('aria-haspopup', 'menu');
      parts.accountName = el('span', 'ag-picker-name', info?.account ?? '');
      const chev2 = el('span', 'ag-chevrons');
      chev2.append(sym('chevron.up', 8), sym('chevron.down', 8));
      parts.accountPicker.append(parts.accountName, chev2);
      parts.accountPicker.addEventListener('click', pickAccount);
      parts.accountRow.append(accText, parts.accountPicker);
      parts.accountRow.hidden = true;

      const effort = el('div', 'ag-effort');
      const label = el('p', 'ag-label ag-unit');
      label.append(el('strong', '', 'Reasoning'), (parts.level = el('span', '', '')));
      const levels = info?.levels ?? ['low', 'medium', 'high', 'xhigh', 'max'];
      const value = info?.reasoning && levels.includes(info.reasoning) ? info.reasoning : 'medium';
      parts.level.textContent = info?.reasoning ? LEVEL_NAMES[value] : 'Default';
      slider = effortSlider({
        levels,
        value,
        label: 'Reasoning effort',
        onMove: () => sheet.invalidateGlass(),
        onInput: (v) => (parts.level.textContent = LEVEL_NAMES[v] ?? v),
        onChange: (v) => {
          staged.reasoning = v;
          showStaged(false);
        },
      });
      effort.append(label, slider.element);

      bar = usageBar('Context');
      bar.set(0, 1, '');
      const marker = el('div', 'ag-medium-end');
      marker.dataset.mediumEnd = '';

      parts.details = el('div', 'ag-details');
      body.append(line, parts.accountRow, parts.agentModel, effort, bar.element, marker, parts.details);
      // The slider's capsule is Liquid Glass, as ChatGPT's is.
      sheet.addGlass(slider.element.querySelector('.ag-track'), 'control');
    },
    onConfirm: async () => {
      const body = {};
      if (staged.agent && staged.agent !== saved.agent) body.agent = staged.agent;
      else if ((staged.account ?? null) !== (saved.account ?? null) && staged.account) body.account = staged.account;
      if ((staged.reasoning ?? null) !== (saved.reasoning ?? null) || body.agent) body.reasoning = staged.reasoning;
      if (!Object.keys(body).length) return true;
      try {
        info = await postJson('/api/agent', body);
        saved = { agent: info.id, reasoning: info.reasoning, account: info.account ?? null };
        onSaved?.(info);
        return true;
      } catch (error) {
        showError(error.message, "Couldn't change the agent");
        return false;
      }
    },
    onClose: () => {
      clearInterval(timer);
      current = null;
    },
  });

  async function loadContext() {
    try {
      context = await getJson('/api/agent/context');
      render();
    } catch (error) {
      parts.details.replaceChildren(el('p', 'ui-empty', error.message));
    }
  }

  async function loadAgent() {
    try {
      const [one, all] = await Promise.all([getJson('/api/agent'), getJson('/api/agents')]);
      const untouched = !changed();
      info = one;
      agents = all.agents;
      saved = { agent: info.id, reasoning: info.reasoning, account: info.account ?? null };
      if (untouched) Object.assign(staged, saved);
      showStaged();
    } catch {
      // the row keeps what the page knew
    }
  }

  function render() {
    const c = context;
    if (!c) return;
    bar.set(c.used, c.budget, `${tokensText(c.used)}/${tokensText(c.budget)}`);
    const d = parts.details;
    d.replaceChildren();

    // The whole budget, part by part.
    const total = c.budget;
    const strip = el('div', 'ag-strip ag-unit');
    for (const cat of c.categories) {
      if (cat.tokens <= 0) continue;
      const seg = el('span');
      seg.style.flexGrow = String(cat.tokens);
      seg.style.background = CATEGORY_COLORS[cat.id];
      seg.title = `${cat.label}: ${tokensText(cat.tokens)}`;
      strip.append(seg);
    }
    const reserve = el('span', 'reserve');
    reserve.style.flexGrow = String(c.reserve);
    reserve.title = `Reserved for the turn: ${tokensText(c.reserve)}`;
    const free = el('span', 'free');
    free.style.flexGrow = String(Math.max(0, c.free));
    strip.append(reserve, free);

    const head = el('div', 'ag-summary ag-unit');
    head.append(el('strong', '', `${tokensText(c.used)} of ${tokensText(total)} tokens`), el('span', '', `${pct(c.used / total)} used · ${tokensText(c.free)} free`));

    const legend = el('div', 'ui-group');
    const legendRow = (color, label, tokens, extra, cls = '') => {
      const r = el('div', `ui-row ag-legend ${cls}`);
      const dot = el('span', 'ag-dot-key');
      dot.style.background = color;
      r.append(dot, el('span', 'ui-row-label', label), el('span', 'ui-row-value', `${tokensText(tokens)}${extra ? ` · ${extra}` : ''}`));
      return r;
    };
    for (const cat of c.categories) {
      if (cat.tokens <= 0 && cat.id !== 'messages') continue;
      legend.append(legendRow(CATEGORY_COLORS[cat.id], cat.label, cat.tokens, pct(cat.tokens / total)));
    }
    legend.append(legendRow('repeating-linear-gradient(135deg, rgba(235,235,245,0.5) 0 2px, transparent 2px 4px)', 'Reserved for the turn', c.reserve, pct(c.reserve / total)));
    legend.append(legendRow('rgba(120,120,128,0.35)', 'Free', c.free, pct(c.free / total)));

    const sections = [section('Usage', [strip, head, legend])];

    if (c.problem) sections.push(section(null, [el('p', 'ag-problem', c.problem)]));

    // Tools, per family, expandable like Qwen Code's per-tool lists.
    const families = c.categories.filter((cat) => cat.items?.length);
    if (families.length) {
      const list = el('div', 'ui-group');
      for (const cat of families) {
        const det = el('details', 'ag-family');
        const sum = el('summary', 'ui-row');
        const dot = el('span', 'ag-dot-key');
        dot.style.background = CATEGORY_COLORS[cat.id];
        sum.append(dot, el('span', 'ui-row-label', `${cat.label} (${cat.items.length})`), el('span', 'ui-row-value', tokensText(cat.tokens)), sym('chevron.right', 11));
        det.append(sum);
        for (const it of cat.items) {
          const r = el('div', 'ui-row ag-item');
          r.append(el('span', 'ui-row-label', it.name), el('span', 'ui-row-value', `${it.detail ? `${it.detail} · ` : ''}${tokensText(it.tokens)}`));
          det.append(r);
        }
        list.append(det);
      }
      sections.push(section('Tools', [list]));
    }

    // The window itself.
    const facts = el('div', 'ui-group');
    const fact = (label, value) => {
      const r = el('div', 'ui-row');
      r.append(el('span', 'ui-row-label', label), el('span', 'ui-row-value', value));
      return r;
    };
    facts.append(
      fact('Model', c.model),
      fact("Model's context window", c.modelWindow ? `${tokensText(c.modelWindow)} tokens` : 'Not reported'),
      fact('Working budget', `${tokensText(c.budget)} tokens`),
      fact('Kept free for each turn', `${tokensText(c.reserve)} tokens`),
      fact('Recent exchanges kept', `${c.exchanges.included} of ${c.exchanges.sinceReset} (up to ${c.exchanges.recentLimit})`),
      fact('Sections in the index', `${c.sections.shown} of ${c.sections.total}`),
    );
    if (c.lastRequest) {
      const u = c.lastRequest.usage;
      facts.append(fact('Last request', `${tokensText(u.promptTokens)} in · ${tokensText(u.completionTokens)} out`));
      if (Number.isFinite(u.cost)) facts.append(fact('Last request cost', `$${u.cost.toFixed(u.cost < 0.01 ? 4 : 3)}`));
    }
    sections.push(section('Window', [facts]));

    const reset = el('button', 'ui-button destructive ag-reset', 'Start a Fresh Context');
    reset.type = 'button';
    reset.disabled = !!c.running;
    reset.addEventListener('click', async () => {
      const ok = await confirmDialog('Start a fresh context?', 'Later replies will not see the earlier messages. They stay stored, and the agent can still search and fetch them.', 'Start Fresh', true);
      if (!ok) return;
      try {
        context = await postJson('/api/agent', { action: 'reset-context' });
        render();
        toast('The next reply starts from a fresh context', { symbol: 'sparkles', timeout: 2200 });
      } catch (error) {
        showError(error.message, "Couldn't start a fresh context");
      }
    });
    sections.push(section(null, [reset, el('p', 'ag-note', 'Token counts are estimates (about four characters per token); the last request shows what the provider reported.')]));
    d.append(...sections);
    ctx.refresh();
  }

  function section(title, nodes) {
    const s = el('section', 'ui-section');
    if (title) s.append(el('h3', 'ui-section-title', title));
    s.append(...nodes);
    return s;
  }

  loadAgent();
  loadContext();
  // While open, follow the conversation (a reply changes the messages part).
  const timer = setInterval(() => {
    if (!document.hidden) loadContext();
  }, 15_000);

  current = {
    refresh: () => loadContext(),
    setAgent: (a) => {
      // Another window changed it: follow, unless this sheet has its own changes.
      const untouched = !changed();
      info = { ...info, ...a };
      saved = { agent: info.id, reasoning: info.reasoning ?? null, account: info.account ?? null };
      if (untouched) {
        Object.assign(staged, saved);
        showStaged();
      }
    },
    close: () => ctx.close(),
  };
  return current;
}

export function agentSheetOpen() {
  return current !== null;
}
