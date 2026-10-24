/**
 * Search: the whole conversation (every message, also ones not loaded yet)
 * and the artifacts (titles and the text of their files). Tapping a message
 * jumps to it in the chat; tapping an artifact opens it.
 */

import { getJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { createField, createRow, createSection, icon as sfIcon } from './vendor/sfgl/src/ui/index.js';
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
      const field = createField({
        placeholder: 'Messages and artifacts',
        look: 'card',
        multiline: false,
        maxRows: 1,
        inputMode: 'search',
        autocapitalize: 'off',
        aria: 'Search',
        leading: [sfIcon('magnifyingglass', 15)],
        onInput: () => {
          clearTimeout(timer);
          timer = setTimeout(run, 220);
        },
        onSubmit: () => {
          clearTimeout(timer);
          run();
        },
      });
      input = field.input;
      input.setAttribute('enterkeyhint', 'search');
      input.autocomplete = 'off';
      const box = field.el;
      results = el('div', 'sr-results');
      sheet.body.append(box, results);
      results.append(el('p', 'sf-section-note sr-empty', 'Search every message in the conversation and the text of every artifact.'));
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
      results.replaceChildren(el('p', 'sf-section-note sr-empty', 'Search every message in the conversation and the text of every artifact.'));
      return;
    }
    let data;
    try {
      data = await getJson('/api/search', { q });
    } catch (error) {
      if (mine === seq) results.replaceChildren(el('p', 'sf-section-note sr-empty', error.message));
      return;
    }
    if (mine !== seq) return;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const parts = [];
    if (data.artifacts.length) {
      const rows = data.artifacts.map((a) => {
        const title = el('span');
        title.append(highlighted(a.title, words));
        const sub = el('span');
        if (a.excerpt) sub.append(highlighted(a.excerpt, words));
        return createRow({ titleContent: title, subtitleContent: a.excerpt ? sub : undefined, wrap: true, onTap: () => { ctx.close(); hooks.onArtifact(a.id); } });
      });
      parts.push(createSection({ title: `Artifacts (${data.artifacts.length})`, rows }).el);
    }
    const rows = data.messages.map((m) => {
      const who = m.role === 'user' ? 'You' : hooks.agentName(m.agent);
      const ex = el('span');
      ex.append(highlighted(m.excerpt, words));
      return createRow({
        titleContent: ex,
        subtitle: [who, m.section, relativeTime(m.time)].filter(Boolean).join(' · '),
        wrap: true,
        onTap: () => {
          ctx.close();
          hooks.onMessage(m.id);
        },
      });
    });
    parts.push(
      createSection({
        title: data.messages.length ? `Messages (${data.messages.length})` : 'Messages',
        rows,
        note: data.messages.length ? '' : 'No messages contain all of these words.',
      }).el,
    );
    results.replaceChildren(...parts);
    ctx.refresh();
  }

  current = { ctx, close: () => ctx.close() };
  return current;
}
