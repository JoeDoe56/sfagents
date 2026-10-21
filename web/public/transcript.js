/**
 * A thread between two agents, shown as a conversation in a sheet. One
 * agent writes on the right (the one the chat linked from, else the first
 * of the pair), the other answers on the left; names head each run of
 * bubbles, as in a group chat. The sheet follows the thread while open.
 */

import { getJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { renderMarkdown, escapeHtml } from './markdown.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const looksRich = (t) => /(^|\n)\s*([#>*-]|\d+\.|```|\|)/.test(t) || /\*\*|`/.test(t);

let current = null;

/** Opens the thread `key`; `me` is the agent shown on the right. */
export function openTranscript(key, { me } = {}) {
  if (current?.key === key) return current;
  current?.close();
  let list = null;
  let info = null;
  let lastSig = '';

  const ctx = openSheet({
    title: 'Thread',
    detents: ['large'],
    className: 'tr-sheet',
    build(sheet) {
      list = el('div', 'tr-thread');
      list.append(el('p', 'tr-empty', 'Loading…'));
      sheet.body.append(list);
    },
    onClose: () => {
      if (current?.ctx === ctx) current = null;
    },
  });

  async function load() {
    let data;
    try {
      data = await getJson(`/api/threads/${encodeURIComponent(key)}`);
    } catch (error) {
      list.replaceChildren(el('p', 'tr-empty', error.message));
      return;
    }
    info = data.thread;
    const pair = info?.agents ?? key.split('--').slice(0, 2);
    const right = me && pair.includes(me) ? me : pair[0];
    ctx.setTitle(`${pair[0]} & ${pair[1]}${info?.instance > 1 ? ` (${info.instance})` : ''}`);
    const sig = JSON.stringify(data.items.map((i) => [i.id, i.text?.length, i.status]));
    if (sig === lastSig) return;
    lastSig = sig;
    const atBottom = ctx.body.scrollHeight - ctx.body.scrollTop - ctx.body.clientHeight < 40;
    render(data.items, right);
    if (atBottom) ctx.body.scrollTop = ctx.body.scrollHeight;
  }

  function render(items, right) {
    list.replaceChildren();
    if (!items.length) {
      list.append(el('p', 'tr-empty', 'No messages yet.'));
      return;
    }
    let prevWho = null;
    const rows = [];
    for (const it of items) {
      if (it.kind === 'activity' || it.kind === 'notice') {
        rows.push({ kind: 'line', text: it.text, status: it.status });
        prevWho = null;
        continue;
      }
      const who = it.agent ?? '';
      const side = who === right ? 'out' : 'in';
      rows.push({ kind: 'msg', who, side, text: it.text, first: who !== prevWho });
      prevWho = who;
    }
    rows.forEach((r, i) => {
      if (r.kind === 'line') {
        list.append(el('div', `activity ${r.status || ''}`, r.text));
        return;
      }
      const next = rows[i + 1];
      const tail = !next || next.kind !== 'msg' || next.who !== r.who;
      if (r.first) list.append(el('div', `tr-name ${r.side}`, r.who));
      const m = el('div', `msg ${r.side}${tail ? ' tail-room' : ''}`);
      const b = el('div', `bubble${tail ? ' tail' : ''}`);
      if (looksRich(r.text)) {
        b.classList.add('rich');
        b.innerHTML = renderMarkdown(r.text);
      } else b.innerHTML = escapeHtml(r.text);
      m.append(b);
      list.append(m);
    });
    ctx.refresh();
  }

  load().then(() => (ctx.body.scrollTop = ctx.body.scrollHeight));
  current = { key, ctx, refresh: load, close: () => ctx.close() };
  return current;
}

/** Called when the server says threads changed. */
export function refreshTranscript() {
  current?.refresh();
}
