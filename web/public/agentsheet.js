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
import { createRow, createSection, createGroup, icon as sfIcon } from './vendor/sfgl/src/ui/index.js';
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
    parts.agentRow.setValue(a?.name ?? a?.id ?? 'Agent');
    // Accounts are the saved agent's (another agent's show once it is saved).
    const sameAgent = staged.agent === saved.agent;
    const accounts = sameAgent ? (info?.accounts ?? []) : [];
    const account = accounts.find((x) => x.name === staged.account) ?? accounts[0];
    parts.accountRow.el.hidden = !sameAgent || accounts.length === 0;
    parts.accountRow.setValue(account?.name ?? '');
    parts.accountRow.update({ accessory: accounts.length < 2 ? 'none' : 'menu', disabled: accounts.length < 2 });
    // The account row changes the medium height.
    requestAnimationFrame(() => ctx.refresh());
    parts.agentSection.setNote((sameAgent ? account?.model : null) ?? a?.model ?? '');
    parts.agentRow.setSubtitle(a?.description ?? '');
    const levels = levelsOf();
    const value = staged.reasoning && levels.includes(staged.reasoning) ? staged.reasoning : 'medium';
    parts.level.textContent = staged.reasoning ? (LEVEL_NAMES[value] ?? value) : 'Default';
    if (animate) slider.set(value);
    parts.agentRow.update({ accessory: agents.length < 2 && !!agents.length ? 'none' : 'menu', disabled: agents.length < 2 && !!agents.length });
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
    showMenu({ anchor: parts.accountRow.anchor, align: 'end', placement: 'cover', title: listed.length > 1 ? 'In order: the next takes over at a limit' : undefined, groups: [listed.map(item), others.map(item)] });
  }

  function pickAgent() {
    if (!agents.length) return;
    showMenu({
      anchor: parts.agentRow.anchor,
      align: 'end',
      placement: 'cover',
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
      // The agent and its account: rows with a pop-up value, as Calendar's are.
      parts.agentRow = createRow({ title: 'Agent', value: info?.name ?? info?.id ?? 'Agent', accessory: 'menu', wrap: true, onTap: pickAgent });
      parts.accountRow = createRow({ title: 'Account', value: info?.account ?? '', accessory: 'menu', onTap: pickAccount });
      parts.accountRow.el.hidden = true;
      parts.agentSection = createSection({ rows: [parts.agentRow, parts.accountRow], note: info?.model ?? '' });
      const line = parts.agentSection.el;

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
      body.append(line, effort, bar.element, marker, parts.details);
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
      parts.details.replaceChildren(el('p', 'sf-section-note', error.message));
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

    const key = (color) => {
      const dot = el('span', 'ag-dot-key');
      dot.style.background = color;
      return dot;
    };
    const legendRow = (color, label, tokens, extra) =>
      createRow({ leadingNode: key(color), title: label, value: `${tokensText(tokens)}${extra ? ` · ${extra}` : ''}` });
    const legend = [];
    for (const cat of c.categories) {
      if (cat.tokens <= 0 && cat.id !== 'messages') continue;
      legend.push(legendRow(CATEGORY_COLORS[cat.id], cat.label, cat.tokens, pct(cat.tokens / total)));
    }
    legend.push(legendRow('repeating-linear-gradient(135deg, rgba(235,235,245,0.5) 0 2px, transparent 2px 4px)', 'Reserved for the turn', c.reserve, pct(c.reserve / total)));
    legend.push(legendRow('rgba(120,120,128,0.35)', 'Free', c.free, pct(c.free / total)));

    const usage = createSection({ title: 'Usage', rows: [], note: '' });
    usage.el.querySelector('.sf-group').before(strip, head);
    usage.group.add(...legend);
    const sections = [usage.el];

    if (c.problem) sections.push(createSection({ rows: [createRow({ title: c.problem, wrap: true, destructive: true })] }).el);

    // Tools, per family, expandable like Qwen Code's per-tool lists.
    const families = c.categories.filter((cat) => cat.items?.length);
    if (families.length) {
      const group = createGroup();
      for (const cat of families) {
        const kids = cat.items.map((it) =>
          createRow({ title: it.name, value: `${it.detail ? `${it.detail} · ` : ''}${tokensText(it.tokens)}` }),
        );
        for (const k of kids) k.el.classList.add('nested');
        const chevron = sfIcon('chevron.right', 12);
        chevron.classList.add('sf-row-chevron');
        let openFamily = false;
        const head = createRow({
          leadingNode: key(CATEGORY_COLORS[cat.id]),
          title: `${cat.label} (${cat.items.length})`,
          value: tokensText(cat.tokens),
          accessoryNode: chevron,
          onTap: () => {
            openFamily = !openFamily;
            chevron.classList.toggle('open', openFamily);
            if (openFamily) {
              let after = head.el;
              for (const k of kids) {
                after.after(k.el);
                after = k.el;
              }
            } else for (const k of kids) k.el.remove();
            ctx.refresh();
          },
        });
        group.add(head);
      }
      sections.push(createSection({ title: 'Tools', group }).el);
    }

    // The window itself.
    const fact = (label, value) => createRow({ title: label, value, wrap: true });
    const facts = [
      fact('Model', c.model),
      fact("Model's context window", c.modelWindow ? `${tokensText(c.modelWindow)} tokens` : 'Not reported'),
      fact('Working budget', `${tokensText(c.budget)} tokens`),
      fact('Kept free for each turn', `${tokensText(c.reserve)} tokens`),
      fact('Recent exchanges kept', `${c.exchanges.included} of ${c.exchanges.sinceReset} (up to ${c.exchanges.recentLimit})`),
      fact('Sections in the index', `${c.sections.shown} of ${c.sections.total}`),
    ];
    if (c.lastRequest) {
      const u = c.lastRequest.usage;
      facts.push(fact('Last request', `${tokensText(u.promptTokens)} in · ${tokensText(u.completionTokens)} out`));
      if (Number.isFinite(u.cost)) facts.push(fact('Last request cost', `$${u.cost.toFixed(u.cost < 0.01 ? 4 : 3)}`));
    }
    sections.push(createSection({ title: 'Window', rows: facts }).el);

    const reset = createRow({
      title: 'Start a Fresh Context',
      destructive: true,
      center: true,
      disabled: !!c.running,
      onTap: async () => {
        const ok = await confirmDialog('Start a fresh context?', 'Later replies will not see the earlier messages. They stay stored, and the agent can still search and fetch them.', 'Start Fresh', true);
        if (!ok) return;
        try {
          context = await postJson('/api/agent', { action: 'reset-context' });
          render();
          toast('The next reply starts from a fresh context', { symbol: 'sparkles', timeout: 2200 });
        } catch (error) {
          showError(error.message, "Couldn't start a fresh context");
        }
      },
    });
    sections.push(createSection({ rows: [reset], note: 'Token counts are estimates (about four characters per token); the last request shows what the provider reported.' }).el);
    d.append(...sections);
    ctx.refresh();
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
