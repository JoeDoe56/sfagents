/**
 * Search: the whole conversation (every message, also ones not loaded yet)
 * and the artifacts (titles and the text of their files). Tapping a message
 * jumps to it in the chat; tapping an artifact opens it.
 */

import { getJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { relativeTime } from './artifacts.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Wraps the query's words in <mark> (text only; no HTML from the result is used). */
function highlighted(text, words) {
  const frag = document.createDocumentFragment();
  if (!words.length) {
    frag.append(text);
    return frag;
  }
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  let last = 0;
  for (const m of text.matchAll(re)) {
    frag.append(text.slice(last, m.index));
    frag.append(el('mark', '', m[0]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

let current = null;

/**
 * @param {{onMessage: (id: string) => void, onArtifact: (id: string) => void, agentName: (id: string) => string}} hooks
 */
export function openSearch(hooks) {
  if (current) return current;
  let input;
  let results;
  let timer = 0;
  let seq = 0;

  const ctx = openSheet({
    title: 'Search',
    detents: ['large'],
    className: 'sr-sheet',
    build(sheet) {
      const box = el('label', 'ui-search sr-field');
      const icon = el('i');
      applySymbol(icon, 'magnifyingglass', { size: 14 });
      input = el('input');
      input.type = 'search';
      input.placeholder = 'Messages and artifacts';
      input.setAttribute('enterkeyhint', 'search');
      input.autocomplete = 'off';
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(run, 220);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          clearTimeout(timer);
          run();
        }
      });
      box.append(icon, input);
      results = el('div', 'sr-results');
      sheet.body.append(box, results);
      results.append(el('p', 'ui-empty', 'Search every message in the conversation and the text of every artifact.'));
    },
    onClose: () => {
      clearTimeout(timer);
      current = null;
    },
  });
  setTimeout(() => input.focus(), 320);

  async function run() {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) {
      results.replaceChildren(el('p', 'ui-empty', 'Search every message in the conversation and the text of every artifact.'));
      return;
    }
    let data;
    try {
      data = await getJson('/api/search', { q });
    } catch (error) {
      if (mine === seq) results.replaceChildren(el('p', 'ui-empty', error.message));
      return;
    }
    if (mine !== seq) return;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const parts = [];
    if (data.artifacts.length) {
      const s = el('section', 'ui-section');
      s.append(el('h3', 'ui-section-title', `Artifacts (${data.artifacts.length})`));
      const g = el('div', 'ui-group');
      for (const a of data.artifacts) {
        const row = el('button', 'ui-row tappable sr-row');
        row.type = 'button';
        const text = el('span', 'ui-row-label sr-text');
        const title = el('strong');
        title.append(highlighted(a.title, words));
        text.append(title);
        if (a.excerpt) {
          const ex = el('small', 'ui-row-hint');
          ex.append(highlighted(a.excerpt, words));
          text.append(ex);
        }
        row.append(text);
        row.addEventListener('click', () => {
          ctx.close();
          hooks.onArtifact(a.id);
        });
        g.append(row);
      }
      s.append(g);
      parts.push(s);
    }
    const s = el('section', 'ui-section');
    s.append(el('h3', 'ui-section-title', data.messages.length ? `Messages (${data.messages.length})` : 'Messages'));
    if (data.messages.length) {
      const g = el('div', 'ui-group');
      for (const m of data.messages) {
        const row = el('button', 'ui-row tappable sr-row');
        row.type = 'button';
        const text = el('span', 'ui-row-label sr-text');
        const who = m.role === 'user' ? 'You' : hooks.agentName(m.agent);
        text.append(el('small', 'sr-meta', [who, m.section, relativeTime(m.time)].filter(Boolean).join(' · ')));
        const ex = el('span', 'sr-excerpt');
        ex.append(highlighted(m.excerpt, words));
        text.append(ex);
        row.append(text);
        row.addEventListener('click', () => {
          ctx.close();
          hooks.onMessage(m.id);
        });
        g.append(row);
      }
      s.append(g);
    } else s.append(el('p', 'ui-caption', 'No messages contain all of these words.'));
    parts.push(s);
    results.replaceChildren(...parts);
    ctx.refresh();
  }

  current = { ctx, close: () => ctx.close() };
  return current;
}
