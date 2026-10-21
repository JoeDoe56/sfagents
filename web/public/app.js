/**
 * SF Agents web client: iMessage-style conversation, an Apple Maps-style
 * bottom bar that pulls up into a sheet of artifacts, up2k uploads and
 * sfgl glass.
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { createContentTransitions } from './vendor/sfgl/src/transitions/content.js';
import { initialTier } from './vendor/sfgl/src/core/quality.js';
import { renderMarkdown, looksLikeMarkdown, escapeHtml } from './markdown.js';
import { setupGlass } from './glass.js';
import { GLASS, SEND_TINT } from './glassvalues.js';
import { createSheet } from './sheet.js';
import { renderTiles, createViewer } from './artifacts.js';
import { UploadJob } from './up2k.js';
import { createRail } from './rail.js';
import { createMonitor } from './monitor.js';
import { openMonitorWindow } from './windows.js';
import { peekOpen } from './peek.js';
import { createFileManager } from './files.js';
import { openSheet, sheetOpen, setSheetGlass } from './modalsheet.js';
import { createFilesGlass } from './filesglass.js';
import { openAgentSheet, agentSheetOpen } from './agentsheet.js';
import { createGradientUnderlay } from './vendor/sfgl/src/underlay/gradient.js';
import { onHold } from './menu.js';
import { installPress, registerGlass } from './press.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const chat = $('chat');
const thread = $('thread');
const bar = $('bar');
const row = $('row');
const field = $('field');
const input = $('input');
const send = $('send');
const attachBtn = $('attach');
const mic = $('mic');
const picker = $('picker');
const attachmentsEl = $('attachments');
const sheetScroll = $('sheetScroll');

for (const el of document.querySelectorAll('i[data-symbol]')) applySymbol(el, el.dataset.symbol, el.dataset.size ? { size: Number(el.dataset.size) } : {});

const coarse = matchMedia('(pointer: coarse)').matches;
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ state

const state = {
  agent: null,
  items: [],
  more: false,
  artifacts: [],
  live: null, // { id, segments: [{kind, id, text, status}] }
  approvals: [],
  notices: [],
  limits: { maxUploadBytes: Infinity, maxAttachments: 20, maxMessageChars: 400000 },
  connected: false,
};
const answered = new Map(); // approval id → decision (kept briefly so the card shows the answer)
let queued = null; // a message typed while the agent was working

// ------------------------------------------------------------------ scrolling

function nearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
}

// Follow new content (streaming text, images finishing loading) while the reader is at the bottom.
let stick = true;
let programmaticScroll = false;
function scrollToBottom() {
  programmaticScroll = true;
  chat.scrollTop = chat.scrollHeight;
  stick = true;
}
chat.addEventListener('scroll', () => {
  if (programmaticScroll) {
    programmaticScroll = false;
    return;
  }
  stick = nearBottom();
}, { passive: true });
// The chat itself resizes when an on-screen keyboard shrinks the stage.
const followResize = new ResizeObserver(() => {
  if (stick) scrollToBottom();
});
followResize.observe(thread);
followResize.observe(chat);

// ------------------------------------------------------------------ glass

// App settings (this device only), kept in localStorage.
const QUALITIES = ['auto', 'superfluid', 'glass', 'lite', 'frost', 'static'];
function readSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(`sfagents.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeSetting(key, value) {
  try {
    localStorage.setItem(`sfagents.${key}`, JSON.stringify(value));
  } catch {
    // private mode or storage blocked: the setting lasts for this page only
  }
}
const settings = {
  quality: QUALITIES.includes(params.get('quality')) ? params.get('quality') : QUALITIES.includes(readSetting('quality', 'auto')) ? readSetting('quality', 'auto') : 'auto',
  enterSends: readSetting('enterSends', !coarse) === true,
};

const glassApi = setupGlass({ stage, chat, thread, quality: settings.quality });
registerGlass(glassApi.glass);
installPress();
const { surface } = glassApi;
setSheetGlass((o) => createFilesGlass({ ...o, quality: settings.quality, units: '.ui-row, .ag-unit, .settings-group > *' }));
const SEND_FADE = { duration: 260, easing: 'easeInOut' };
const barLens = surface.lens(bar, GLASS.bar);
surface.lens(field, GLASS.control);
const sendLens = surface.lens(send, GLASS.control);
surface.lens($('monitor'), { ...GLASS.tile, clip: sheetScroll });
// The expand button is a small glass circle on top of the monitor's glass.
surface.lens($('monExpand'), { ...GLASS.control, layer: 2, clip: sheetScroll });
surface.lens($('settingsBtn'), { ...GLASS.control, clip: sheetScroll });
surface.lens($('spareBtn'), { ...GLASS.control, clip: sheetScroll });
window.sfagents = { glass: glassApi.glass, surface, barLens };

function syncTileLenses() {
  const tiles = [...document.querySelectorAll('.tiles .tile')];
  surface.syncGroup('tiles', tiles, { ...GLASS.tile, clip: sheetScroll });
  glassApi.glass.requestRender();
}

// ------------------------------------------------------------------ sheet

let clearance = 100;
let rail = null; // created below; the sheet lays out first
const railEl = $('rail');
const sheet = createSheet({
  bar,
  row,
  grabber: $('grabber'),
  scroller: sheetScroll,
  onLayout: ({ t, opaque, rect, collapsedClearance }) => {
    glassApi.setSheet({ ...rect, opaque });
    // The topic rail sits above the collapsed bar and hides while the sheet is up.
    railEl.style.bottom = `${Math.round(collapsedClearance + 12)}px`;
    railEl.classList.toggle('covered', t > 0.03);
    if (Math.abs(collapsedClearance - clearance) > 0.5) {
      const atBottom = nearBottom();
      clearance = collapsedClearance;
      thread.style.setProperty('--chat-bottom', `${Math.round(clearance + 18)}px`);
      if (atBottom) scrollToBottom();
    }
  },
  onDetent: (name) => {
    if (name !== 'collapsed') syncTileLenses();
    updateMonitor();
  },
});
sheetScroll.addEventListener('scroll', () => glassApi.glass.requestRender(), { passive: true });

// ------------------------------------------------------------------ resource monitor

const monitor = createMonitor({
  root: $('monitor'),
  expandButton: $('monExpand'),
  // Drives arriving or leaving change the monitor's height.
  onDrivesChange: () => glassApi.glass.requestRender(),
  // A stat opens its window straight from the sheet.
  onOpen: (key, cell) => openMonitorWindow(key, { from: cell, openInFiles: (path, opts) => openFiles(path, opts) }),
});
/** Read the machine only while the sheet (and so the monitor) is open. */
function updateMonitor() {
  // Paused under a window: the window reads the same things in more detail.
  monitor.setActive(sheet.detent !== 'collapsed' && !document.hidden && !peekOpen() && !document.body.classList.contains('files-open'));
}
document.addEventListener('visibilitychange', updateMonitor);
window.addEventListener('peekchange', updateMonitor);
window.sfagents.monitor = monitor;

// ------------------------------------------------------------------ time stamps

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function stampHtml(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  let day;
  if (sameDay(d, now)) day = 'Today';
  else if (sameDay(d, yesterday)) day = 'Yesterday';
  else if (now - d < 6 * 864e5) day = d.toLocaleDateString(undefined, { weekday: 'long' });
  else day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  return `<b>${escapeHtml(day)}</b> ${escapeHtml(time)}`;
}

// ------------------------------------------------------------------ thread rendering

function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

/** Flattens items, the live run and approvals into keyed render entries. */
function entries() {
  const out = [];
  let lastTime = 0;
  const push = (e) => out.push(e);
  if (state.more) push({ key: 'more', type: 'more' });
  for (const it of state.items) {
    const t = new Date(it.time).getTime();
    if (Number.isFinite(t) && (it.kind === 'user' || it.kind === 'assistant') && (!lastTime || t - lastTime > 60 * 60 * 1000)) {
      push({ key: `stamp:${it.id}`, type: 'stamp', time: it.time });
    }
    if (Number.isFinite(t) && (it.kind === 'user' || it.kind === 'assistant')) lastTime = t;
    if (it.kind === 'user') push({ key: it.id, type: 'msg', side: 'out', text: it.text, attachments: it.attachments });
    else if (it.kind === 'assistant') push({ key: it.id, type: 'msg', side: 'in', text: it.text, rich: true });
    else if (it.kind === 'activity') push({ key: it.id, type: 'activity', text: it.text, status: it.status });
    else push({ key: it.id, type: 'notice', text: it.text, level: /^Error/.test(it.text) ? 'error' : '' });
  }
  if (state.live) {
    for (const seg of state.live.segments) {
      if (seg.kind === 'text') push({ key: `live:${state.live.id}:${seg.id}`, type: 'msg', side: 'in', text: seg.text, rich: true });
      else push({ key: `live:${state.live.id}:${seg.id}`, type: 'activity', text: seg.text, status: seg.status });
    }
    const last = state.live.segments[state.live.segments.length - 1];
    const waiting = !last || last.kind !== 'text' || state.live.stalled;
    if (waiting && !state.approvals.length) push({ key: `typing:${state.live.id}`, type: 'typing' });
  }
  for (const a of state.approvals) push({ key: `approval:${a.id}`, type: 'approval', approval: a, decision: answered.get(a.id) });
  for (const n of state.notices) push({ key: `notice:${n.id}`, type: 'notice', text: n.text, level: n.level });
  // Group bubbles: first of a run gets spacing, last gets the tail.
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.type !== 'msg' && e.type !== 'typing') continue;
    const side = e.type === 'typing' ? 'in' : e.side;
    const prev = out[i - 1];
    const next = out[i + 1];
    const sideOf = (x) => (x && x.type === 'msg' ? x.side : x && x.type === 'typing' ? 'in' : null);
    e.first = sideOf(prev) !== side;
    e.tail = sideOf(next) !== side;
  }
  return out;
}

function bubbleHtml(e) {
  if (e.rich && looksLikeMarkdown(e.text)) return { html: renderMarkdown(e.text), rich: true };
  return { html: escapeHtml(e.text), rich: false };
}

function buildEntry(e) {
  let el;
  switch (e.type) {
    case 'more': {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'load-more';
      el.textContent = 'Show earlier messages';
      el.addEventListener('click', loadEarlier);
      break;
    }
    case 'stamp':
      el = document.createElement('div');
      el.className = 'stamp';
      el.innerHTML = stampHtml(e.time);
      break;
    case 'msg': {
      el = document.createElement('div');
      el.className = `msg ${e.side}${e.first ? ' first' : ''}${e.tail ? ' tail-room' : ''}`;
      if (e.attachments?.length) {
        const media = document.createElement('div');
        media.className = 'media';
        for (const a of e.attachments) {
          if (/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(a.mime)) {
            const img = document.createElement('img');
            img.src = a.url;
            img.alt = a.name;
            img.loading = 'lazy';
            img.decoding = 'async';
            const link = document.createElement('a');
            link.href = a.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.append(img);
            media.append(link);
          } else {
            const chip = document.createElement('a');
            chip.className = 'file-chip';
            chip.href = a.url;
            chip.target = '_blank';
            chip.rel = 'noopener';
            const icon = document.createElement('i');
            applySymbol(icon, 'doc', { size: 16 });
            const name = document.createElement('span');
            name.textContent = a.name;
            chip.append(icon, name);
            media.append(chip);
          }
        }
        el.append(media);
      }
      if (e.text && e.text.trim()) {
        const b = document.createElement('div');
        const { html, rich } = bubbleHtml(e);
        b.className = `bubble${rich ? ' rich' : ''}${e.tail ? ' tail' : ''}`;
        b.innerHTML = html;
        el.append(b);
      }
      break;
    }
    case 'typing': {
      el = document.createElement('div');
      el.className = `msg in${e.first ? ' first' : ''} tail-room`;
      const t = document.createElement('div');
      t.className = 'typing';
      t.setAttribute('aria-label', 'The agent is working');
      t.innerHTML = '<span></span><span></span><span></span>';
      el.append(t);
      break;
    }
    case 'activity':
      el = document.createElement('div');
      el.className = `activity ${e.status || ''}`;
      el.textContent = e.text;
      break;
    case 'notice':
      el = document.createElement('div');
      el.className = `notice ${e.level || ''}`;
      el.textContent = e.text;
      break;
    case 'approval':
      el = buildApproval(e.approval, e.decision);
      break;
  }
  return el;
}

function signature(e) {
  switch (e.type) {
    case 'msg':
      return `msg|${e.side}|${e.first}|${e.tail}|${hashText(e.text || '')}|${(e.attachments || []).length}`;
    case 'activity':
      return `act|${e.status}|${e.text}`;
    case 'typing':
      return `typing|${e.first}`;
    case 'approval':
      return `approval|${e.decision || ''}`;
    case 'stamp':
      return `stamp|${e.time}`;
    default:
      return `${e.type}|${e.text || ''}`;
  }
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const follow = stick || nearBottom();
    const wanted = entries();
    const existing = new Map([...thread.children].map((el) => [el.dataset.key, el]));
    const nodes = wanted.map((e) => {
      const sig = signature(e);
      let el = existing.get(e.key);
      if (!el || el.dataset.sig !== sig) {
        el?.remove();
        el = buildEntry(e);
        el.dataset.key = e.key;
        el.dataset.sig = sig;
      }
      existing.delete(e.key);
      return el;
    });
    for (const stale of existing.values()) stale.remove();
    nodes.forEach((el, i) => {
      if (thread.children[i] !== el) thread.insertBefore(el, thread.children[i] ?? null);
    });
    if (follow) scrollToBottom();
  });
}




async function loadEarlier() {
  const first = state.items[0];
  if (!first) return;
  stick = false;
  const res = await fetch(`/api/messages?before=${first.seq}`);
  if (!res.ok) return;
  const data = await res.json();
  const known = new Set(state.items.map((i) => i.id));
  const prevHeight = chat.scrollHeight;
  state.items = [...data.items.filter((i) => !known.has(i.id)), ...state.items];
  state.more = data.more;
  render();
  requestAnimationFrame(() => {
    chat.scrollTop += chat.scrollHeight - prevHeight;
  });
}

// ------------------------------------------------------------------ topic rail

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function anchorFor(section) {
  return thread.querySelector(`[data-key="${CSS.escape(section.first.id)}"]`);
}

/** Scrolls the conversation to a section's first message, loading older messages if needed. */
async function jumpToSection(section) {
  let el = anchorFor(section);
  for (let i = 0; !el && state.more && i < 100; i++) {
    await loadEarlier();
    await nextFrame();
    await nextFrame();
    el = anchorFor(section);
  }
  if (!el) {
    notice(`“${section.title}” starts in a message that is not shown yet.`);
    return;
  }
  // Include the time stamp right above, if there is one.
  const prev = el.previousElementSibling;
  const target = prev?.classList.contains('stamp') ? prev : el;
  const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
  stick = false;
  chat.scrollTo({ top: Math.max(0, target.offsetTop - 12 - safeTop), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  rail.setActive(section.id);
}

rail = createRail({
  root: railEl,
  dots: $('railDots'),
  list: $('railList'),
  onJump: (s) => jumpToSection(s),
});

/** The section whose first message is the last one above a line a third of the way down. */
let activeQueued = false;
function updateActiveSection() {
  if (activeQueued) return;
  activeQueued = true;
  requestAnimationFrame(() => {
    activeQueued = false;
    const line = chat.getBoundingClientRect().top + chat.clientHeight * 0.35;
    let current = null;
    for (const s of rail.sections) {
      const el = anchorFor(s);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= line) current = s.id;
      else break;
    }
    rail.setActive(current);
  });
}
chat.addEventListener('scroll', updateActiveSection, { passive: true });

function setSections(list) {
  rail.setSections(list || []);
  updateActiveSection();
}

// ------------------------------------------------------------------ approvals

function buildApproval(a, decision) {
  const card = document.createElement('div');
  card.className = `approval${decision ? ' done' : ''}`;
  const h = document.createElement('h3');
  h.textContent = decision ? `${a.title} — ${decision === 'deny' ? 'not allowed' : 'allowed'}` : a.title;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = `${a.agent} wants to use ${a.tool}`;
  card.append(h, who);
  if (a.detail) {
    const pre = document.createElement('pre');
    pre.textContent = a.detail;
    card.append(pre);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [label, value, primary] of [
    ["Don't Allow", 'deny', false],
    ['Always Allow', 'allow_always', false],
    ['Allow Once', 'allow_once', true],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', () => answerApproval(a.id, value));
    actions.append(b);
  }
  card.append(actions);
  return card;
}

async function answerApproval(id, decision) {
  answered.set(id, decision);
  render();
  await postJson(`/api/approvals/${encodeURIComponent(id)}`, { decision }).catch((error) => notice(error.message, 'error'));
}

// ------------------------------------------------------------------ server

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let noticeSeq = 0;
const recentNotices = new Map(); // text → time shown, to avoid repeating the same warning every turn
function notice(text, level = '') {
  const now = Date.now();
  if (now - (recentNotices.get(text) ?? 0) < 10 * 60 * 1000) return;
  recentNotices.set(text, now);
  const n = { id: ++noticeSeq, text: text.length > 240 ? `${text.slice(0, 239)}…` : text, level };
  state.notices.push(n);
  render();
  setTimeout(() => {
    state.notices = state.notices.filter((x) => x !== n);
    render();
  }, 8000);
}

function applySnapshot(s) {
  state.agent = s.agent;
  setGradientSeed(s.agent?.model);
  state.items = s.items;
  state.more = s.more;
  state.live = s.live;
  state.approvals = s.approvals;
  state.limits = s.limits || state.limits;
  setArtifacts(s.artifacts);
  setSections(s.sections);
  if (s.agent) document.title = `SF Agents · ${s.agent.id}`;
  for (const text of s.notices || []) notice(text);
  render();
  updateComposer();
  requestAnimationFrame(scrollToBottom);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    state.connected = true;
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener('user', (e) => {
    const { item } = JSON.parse(e.data);
    if (!state.items.some((i) => i.id === item.id)) state.items.push(item);
    render();
    requestAnimationFrame(scrollToBottom);
  });
  es.addEventListener('run_start', (e) => {
    const { run } = JSON.parse(e.data);
    state.live = { id: run, segments: [] };
    render();
    updateComposer();
  });
  es.addEventListener('delta', (e) => {
    const { run, text } = JSON.parse(e.data);
    if (!state.live || state.live.id !== run) return;
    const segs = state.live.segments;
    const last = segs[segs.length - 1];
    if (last && last.kind === 'text') last.text += text;
    else segs.push({ kind: 'text', id: `t${segs.length}`, text });
    render();
  });
  es.addEventListener('activity', (e) => {
    const { run, segment } = JSON.parse(e.data);
    if (!state.live || state.live.id !== run) return;
    state.live.segments.push(segment);
    render();
  });
  es.addEventListener('activity_end', (e) => {
    const { run, id, status } = JSON.parse(e.data);
    const seg = state.live?.id === run ? state.live.segments.find((s) => s.id === id) : null;
    if (seg) seg.status = status;
    render();
  });
  es.addEventListener('approval', (e) => {
    const { approval } = JSON.parse(e.data);
    if (!state.approvals.some((a) => a.id === approval.id)) state.approvals.push(approval);
    render();
  });
  es.addEventListener('approval_done', (e) => {
    const { id, decision } = JSON.parse(e.data);
    answered.set(id, decision);
    render();
    setTimeout(() => {
      state.approvals = state.approvals.filter((a) => a.id !== id);
      answered.delete(id);
      render();
    }, 1200);
  });
  es.addEventListener('agent', (e) => {
    const info = JSON.parse(e.data);
    if (state.agent) Object.assign(state.agent, { reasoning: info.reasoning, model: info.model });
    setGradientSeed(info.model);
    agentSheet?.setAgent?.(info);
  });
  es.addEventListener('notice', (e) => {
    const { text, level } = JSON.parse(e.data);
    notice(text, level === 'error' ? 'error' : '');
  });
  es.addEventListener('artifacts', (e) => setArtifacts(JSON.parse(e.data).artifacts));
  es.addEventListener('sections', (e) => setSections(JSON.parse(e.data).sections));
  es.addEventListener('run_end', (e) => {
    const data = JSON.parse(e.data);
    state.live = null;
    state.items = data.items;
    state.more = data.more;
    state.approvals = [];
    if (data.sections) setSections(data.sections);
    if (data.error && data.status !== 'ERROR') notice(data.error);
    render();
    updateComposer();
    if (agentSheetOpen()) agentSheet?.refresh();
    if (queued) {
      const next = queued;
      queued = null;
      submit(next);
    }
  });
  es.onerror = () => {
    state.connected = false;
  };
}

// ------------------------------------------------------------------ artifacts

const viewer = createViewer({
  root: $('viewer'),
  title: $('viewerTitle'),
  meta: $('viewerMeta'),
  body: $('viewerBody'),
  close: $('viewerClose'),
  pin: $('viewerPin'),
  open: $('viewerOpen'),
  download: $('viewerDownload'),
  onPin: (a, pinned) => pinArtifact(a, pinned),
});

async function pinArtifact(a, pinned) {
  try {
    await postJson(`/api/artifacts/${encodeURIComponent(a.id)}/pin`, { pinned });
  } catch (error) {
    notice(`Could not ${pinned ? 'pin' : 'unpin'} “${a.title}”: ${error.message}`, 'error');
  }
}

function setArtifacts(list) {
  state.artifacts = list || [];
  const handlers = { onOpen: (a) => viewer.show(a), onPin: pinArtifact };
  renderTiles($('pinned'), state.artifacts.filter((a) => a.pinned), handlers);
  renderTiles($('allArtifacts'), state.artifacts, handlers);
  viewer.refresh(state.artifacts);
  syncTileLenses();
}

// ------------------------------------------------------------------ composer

const pending = []; // { job, el, url }

function inputMax() {
  return Math.max(66, Math.min(innerHeight * (sheet.detent === 'collapsed' ? 0.45 : 0.3), 440));
}

function autosize() {
  input.style.height = '0px';
  const max = inputMax();
  const h = Math.max(22, Math.min(input.scrollHeight, max));
  input.style.height = `${h}px`;
  input.classList.toggle('scrolling', input.scrollHeight > max + 1);
}

function canSend() {
  return input.value.trim().length > 0 || pending.some((p) => p.job.state !== 'failed' && p.job.state !== 'cancelled');
}

// The send arrow comes and goes with sfgl's content transition (the same
// blur-and-scale used for changing text and symbols).
const sendIcon = send.querySelector('.send-icon');
const agentIcon = send.querySelector('.agent-icon');
const contentTransitions = createContentTransitions({ root: send, include: '.send-icon, .agent-icon' });
contentTransitions.start();
let shownSendable = false;
let shownIcon = 'agent';

// The model's own gradient, refracted by the circle while it is the agent
// button (sfgl's gradient underlay: drawn as if under the glass, over the
// real backdrop). As a send button it is plain blue.
const modelGradient = createGradientUnderlay({ seed: 'sfagents', strength: 0.62, margin: 12 });
let gradientSeed = null;
let stopGradient = null;
let gradientFade = 0;
function setGradientSeed(model) {
  if (!model || model === gradientSeed) return;
  gradientSeed = model;
  modelGradient.setSeed(model);
  glassApi.glass.requestRender();
}
function gradientWanted() {
  return !shownSendable && !document.hidden && !document.body.classList.contains('files-open') && !sheetOpen();
}
function updateGradient() {
  const want = gradientWanted();
  cancelAnimationFrame(gradientFade);
  const target = shownSendable ? 0 : 0.62;
  const from = modelGradient.strength;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) modelGradient.freeze(true);
  // Fade with the tint, so the blue and the gradient cross.
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 260);
    modelGradient.setStrength(from + (target - from) * t);
    glassApi.glass.requestRender();
    if (t < 1) gradientFade = requestAnimationFrame(step);
  };
  gradientFade = requestAnimationFrame(step);
  if (want && !stopGradient) stopGradient = modelGradient.animate(glassApi.glass, 24);
  else if (!want && stopGradient) {
    stopGradient();
    stopGradient = null;
  }
}
document.addEventListener('visibilitychange', updateGradient);
// The underlay stays attached: at strength 0 it draws nothing. (Changing lens
// options with setOptions would cancel the tint's running transition, which
// left the circle blue after a send.)
sendLens.setOptions({ underlay: modelGradient });
updateGradient();
window.addEventListener('sheetchange', updateGradient);

function updateComposer() {
  const running = !!state.live;
  const sendable = canSend();
  if (sendable !== shownSendable) {
    shownSendable = sendable;
    sendLens.transition({ tint: sendable ? SEND_TINT : GLASS.control.tint }, SEND_FADE);
    updateGradient();
  }
  // One icon at a time: the arrow to send, the agent mascot otherwise (the stop disc covers it while running).
  const icon = sendable ? 'send' : running ? 'none' : 'agent';
  if (icon !== shownIcon) {
    const leaving = shownIcon === 'send' ? sendIcon : shownIcon === 'agent' ? agentIcon : null;
    if (leaving && !leaving.hidden) contentTransitions.exit(contentTransitions.capture(leaving));
    sendIcon.hidden = icon !== 'send';
    agentIcon.hidden = icon !== 'agent';
    shownIcon = icon;
  }
  send.classList.toggle('can-send', sendable);
  send.classList.toggle('can-stop', running && !sendable);
  send.disabled = false;
  send.setAttribute('aria-label', sendable ? (running ? 'Send when the agent finishes' : 'Send') : running ? 'Stop' : 'Agent and context');
  attachmentsEl.hidden = pending.length === 0;
}

let agentSheet = null;
function showAgentSheet() {
  agentSheet = openAgentSheet({
    agent: state.agent ? { id: state.agent.id, model: state.agent.model, reasoning: state.agent.reasoning } : null,
    onReasoning: (info) => {
      if (state.agent) state.agent.reasoning = info.reasoning;
    },
  });
}

input.addEventListener('input', () => {
  autosize();
  updateComposer();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && settings.enterSends) {
    e.preventDefault();
    if (canSend()) submitFromComposer();
  }
});
send.addEventListener('click', () => {
  if (canSend()) submitFromComposer();
  else if (state.live) postJson('/api/cancel').catch((error) => notice(error.message, 'error'));
  else showAgentSheet();
});
// Holding the circle (or right-clicking it) opens the agent sheet even when it would send or stop.
onHold(send, () => showAgentSheet());
field.addEventListener('click', (e) => {
  if (e.target === field || e.target.classList.contains('field-line')) input.focus();
});

function submitFromComposer() {
  const text = input.value;
  const jobs = pending.filter((p) => p.job.state !== 'failed' && p.job.state !== 'cancelled').map((p) => p.job);
  if (text.length > state.limits.maxMessageChars) {
    notice(`Messages are limited to ${state.limits.maxMessageChars.toLocaleString()} characters.`, 'error');
    return;
  }
  input.value = '';
  for (const p of pending.splice(0)) {
    p.el.remove();
    if (p.job.state === 'failed') URL.revokeObjectURL(p.url);
  }
  autosize();
  updateComposer();
  const message = { text, jobs };
  if (state.live) {
    queued = message;
    notice('Your message will be sent when the agent finishes.');
    return;
  }
  submit(message);
}

async function submit({ text, jobs }) {
  try {
    if (jobs.length) {
      if (jobs.some((j) => j.state !== 'done')) notice(`Uploading ${jobs.length === 1 ? 'the attachment' : `${jobs.length} attachments`}…`);
      await Promise.all(jobs.map((j) => j.promise));
    }
    await postJson('/api/messages', { text, attachments: jobs.map((j) => j.attachment.id) });
  } catch (error) {
    notice(`Not sent: ${error.message}`, 'error');
    if (!input.value) {
      input.value = text;
      autosize();
      updateComposer();
    }
  }
}

// Attachments ----------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function addFiles(files) {
  for (const file of files) {
    if (pending.length >= state.limits.maxAttachments) {
      notice(`At most ${state.limits.maxAttachments} attachments per message.`, 'error');
      break;
    }
    if (file.size > state.limits.maxUploadBytes) {
      notice(`“${file.name}” is larger than the upload limit (${formatBytes(state.limits.maxUploadBytes)}).`, 'error');
      continue;
    }
    const el = document.createElement('div');
    el.className = 'pending';
    const url = /^image\//.test(file.type) ? URL.createObjectURL(file) : '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = file.name;
      el.append(img);
    } else {
      const f = document.createElement('div');
      f.className = 'file';
      const icon = document.createElement('i');
      applySymbol(icon, /^video\//.test(file.type) ? 'film' : /^audio\//.test(file.type) ? 'music.note' : 'doc', { size: 22 });
      const name = document.createElement('span');
      name.textContent = file.name;
      f.append(icon, name);
      el.append(f);
    }
    const progress = document.createElement('div');
    progress.className = 'progress';
    progress.innerHTML = '<svg viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="15"/><circle class="value" cx="18" cy="18" r="15" stroke-dasharray="94.25" stroke-dashoffset="94.25"/></svg>';
    const label = document.createElement('div');
    label.className = 'label';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    const x = document.createElement('i');
    applySymbol(x, 'xmark', { size: 10 });
    remove.append(x);
    el.append(progress, label, remove);
    const entry = { el, url, job: null };
    const ring = progress.querySelector('.value');
    entry.job = new UploadJob(file, (job) => {
      ring.setAttribute('stroke-dashoffset', String(94.25 * (1 - job.progress)));
      if (job.state === 'done') {
        progress.remove();
        label.textContent = url ? '' : formatBytes(job.size);
      } else if (job.state === 'failed') {
        el.classList.add('failed');
        label.textContent = 'Failed';
        el.title = job.error;
      } else if (job.state === 'hashing') {
        label.textContent = 'Preparing';
      } else if (job.state === 'uploading') {
        label.textContent = job.speed ? `${formatBytes(job.speed)}/s` : '';
      }
      updateComposer();
    });
    remove.addEventListener('click', () => {
      entry.job.cancel();
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      el.remove();
      if (url) URL.revokeObjectURL(url);
      updateComposer();
    });
    pending.push(entry);
    attachmentsEl.append(el);
  }
  updateComposer();
  input.focus();
}

/** Adds a file that is already on the server (the file manager's "Ask SF Agents") to the message. */
function addAttachmentRef(ref) {
  if (pending.length >= state.limits.maxAttachments) {
    notice(`At most ${state.limits.maxAttachments} attachments per message.`, 'error');
    return;
  }
  const el = document.createElement('div');
  el.className = 'pending';
  if (/^image\//.test(ref.mime ?? '')) {
    const img = document.createElement('img');
    img.src = `/api/uploads/${encodeURIComponent(ref.id)}`;
    img.alt = ref.name;
    el.append(img);
  } else {
    const f = document.createElement('div');
    f.className = 'file';
    const icon = document.createElement('i');
    applySymbol(icon, /^video\//.test(ref.mime ?? '') ? 'film' : /^audio\//.test(ref.mime ?? '') ? 'music.note' : 'doc', { size: 22 });
    const name = document.createElement('span');
    name.textContent = ref.name;
    f.append(icon, name);
    el.append(f);
  }
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = /^image\//.test(ref.mime ?? '') ? '' : formatBytes(ref.size ?? 0);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.setAttribute('aria-label', `Remove ${ref.name}`);
  const x = document.createElement('i');
  applySymbol(x, 'xmark', { size: 10 });
  remove.append(x);
  el.append(label, remove);
  // Already uploaded: a finished job.
  const job = { state: 'done', attachment: ref, size: ref.size ?? 0, progress: 1, promise: Promise.resolve(ref), cancel() {} };
  const entry = { el, url: '', job };
  remove.addEventListener('click', () => {
    const i = pending.indexOf(entry);
    if (i >= 0) pending.splice(i, 1);
    el.remove();
    updateComposer();
  });
  pending.push(entry);
  attachmentsEl.append(el);
  updateComposer();
}

attachBtn.addEventListener('click', () => picker.click());
picker.addEventListener('change', () => {
  addFiles([...picker.files]);
  picker.value = '';
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('dropHint').hidden = false;
});
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropHint').hidden = true;
});
addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
});
addEventListener('drop', (e) => {
  dragDepth = 0;
  $('dropHint').hidden = true;
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});

// Dictation -------------------------------------------------------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
if (!Recognition) {
  mic.classList.add('unavailable');
  mic.title = 'Dictation is not available in this browser';
}
mic.addEventListener('click', () => {
  if (!Recognition) {
    notice('Dictation is not available in this browser.');
    return;
  }
  if (recognition) {
    recognition.stop();
    return;
  }
  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  const base = input.value ? `${input.value.replace(/\s+$/, '')} ` : '';
  recognition.onresult = (e) => {
    let text = '';
    for (const r of e.results) text += r[0].transcript;
    input.value = base + text;
    autosize();
    updateComposer();
  };
  recognition.onerror = (e) => {
    if (e.error !== 'aborted' && e.error !== 'no-speech') notice(`Dictation stopped: ${e.error}`, 'error');
  };
  recognition.onend = () => {
    recognition = null;
    mic.classList.remove('listening');
    mic.setAttribute('aria-label', 'Dictate');
  };
  mic.classList.add('listening');
  mic.setAttribute('aria-label', 'Stop dictation');
  recognition.start();
});

// Settings ----------------------------------------------------------------

let settingsSheet = null;
let qualityButtons = [];

function showQuality() {
  if (!settingsSheet) return;
  for (const b of qualityButtons) b.setAttribute('aria-checked', String(b.dataset.value === settings.quality));
  const tier = glassApi.tier();
  settingsSheet.body.querySelector('#qualityHint').textContent =
    settings.quality === 'auto' ? `Chosen for this device: ${tier}. Lowers itself if frames get slow.` : `Drawing with: ${tier}.`;
}

function setQuality(q, persist = true) {
  settings.quality = q;
  if (persist) writeSetting('quality', q);
  const glass = glassApi.glass;
  glass.options.quality = q;
  if (q === 'auto') {
    glass.setTier(
      initialTier(glass.caps, {
        deviceMemory: navigator.deviceMemory,
        hardwareConcurrency: navigator.hardwareConcurrency,
        reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      }),
    );
  }
  glass.invalidate(true);
  requestAnimationFrame(showQuality);
}

/**
 * Settings: a sheet with a medium and a large detent. Changes are a draft
 * (glass quality previews at once) until the check button saves them; the
 * close button or a swipe down puts everything back.
 */
function openSettings() {
  if (settingsSheet) return;
  const saved = { quality: settings.quality, enterSends: settings.enterSends };
  const draft = { ...saved };
  settingsSheet = openSheet({
    title: 'Settings',
    detents: ['medium', 'large'],
    mediumHeight: () => Math.round(innerHeight * 0.52),
    build(ctx) {
      ctx.body.append($('settingsTemplate').content.cloneNode(true));
      for (const i of ctx.body.querySelectorAll('i[data-symbol]')) applySymbol(i, i.dataset.symbol);
      const dirty = () => ctx.setDirty(draft.quality !== saved.quality || draft.enterSends !== saved.enterSends);
      qualityButtons = [...ctx.body.querySelectorAll('#qualityChoice button')];
      for (const b of qualityButtons)
        b.addEventListener('click', () => {
          draft.quality = b.dataset.value;
          setQuality(draft.quality, false);
          dirty();
        });
      const enter = ctx.body.querySelector('#enterSends');
      enter.checked = draft.enterSends;
      enter.addEventListener('change', (e) => {
        draft.enterSends = e.target.checked;
        dirty();
      });
    },
    onConfirm: () => {
      writeSetting('quality', draft.quality);
      settings.enterSends = draft.enterSends;
      writeSetting('enterSends', draft.enterSends);
    },
    onClose: (confirmed) => {
      if (!confirmed && settings.quality !== saved.quality) setQuality(saved.quality, false);
      settingsSheet = null;
      qualityButtons = [];
    },
  });
  showQuality();
}

$('settingsBtn').addEventListener('click', openSettings);

// Keys --------------------------------------------------------------------

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && !viewer.open && !sheetOpen() && sheet.detent !== 'collapsed') sheet.set('collapsed');
});

addEventListener('resize', autosize);

// Keep the bar above on-screen keyboards that overlay the page (iOS Safari):
// size the stage to the visual viewport.
const vv = window.visualViewport;
if (vv) {
  // The stage covers exactly the visible part of the page. iOS pans the
  // visual viewport to reveal a focused field, so the stage follows its
  // offset as well as its height (the glass canvas measures where it really
  // is, so the glass stays on the bar). Pinch zoom is left alone.
  const fit = () => {
    const zoomed = Math.abs(vv.scale - 1) > 0.01;
    const follow = !zoomed && (vv.offsetTop > 0.5 || innerHeight - vv.height > 1);
    stage.style.top = follow ? `${vv.offsetTop}px` : '';
    stage.style.height = follow ? `${vv.height}px` : '';
    stage.style.bottom = follow ? 'auto' : '';
    // A keyboard (not a toolbar or a small resize) takes the bottom inset's place.
    sheet.setKeyboard(!zoomed && innerHeight - vv.height > 120);
    glassApi.glass.invalidate();
    sheet.relayout();
    glassApi.repaint();
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}
autosize();
updateComposer();
connect();

// ------------------------------------------------------------------ file manager

const fileManager = createFileManager({
  quality: () => settings.quality,
  openWindow: (key, from, openInFiles) => openMonitorWindow(key, { from, openInFiles }),
  attach: (ref) => addAttachmentRef(ref),
  onOpenChange: (open) => {
    document.body.classList.toggle('files-open', open);
    updateMonitor();
  },
});
window.sfagents.files = fileManager;

/** Opens the file manager at `path` (from a window's "Show in Files", a drive), growing out of the monitor. */
function openFiles(path, opts = {}) {
  if (fileManager.isOpen) fileManager.navigate(path, opts);
  else fileManager.open({ path, select: opts.select ?? null, from: $('monitor') });
}

const expand = $('monExpand');
expand.removeAttribute('aria-disabled');
expand.setAttribute('aria-label', 'Open Files');
expand.addEventListener('click', () => fileManager.open({ from: $('monitor') }));
// A drive bar opens that drive.
const drivesEl = $('monitor').querySelector('.mon-drives');
const openDrive = (e) => {
  const drive = e.target.closest('.drive');
  if (!drive?.dataset.mount) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  openFiles(drive.dataset.mount);
};
drivesEl.addEventListener('click', openDrive);
drivesEl.addEventListener('keydown', openDrive);
