/**
 * The agent tree: a sheet opened from the agent sheet that draws who can
 * message whom. The agent replying now is the root; each agent's grants are
 * its children, with the number of threads it may run with each. An agent
 * reached a second time (a cycle, or two parents) shows as a short link back
 * to where it is drawn. Agents the root cannot reach are listed after it.
 * Agents working in a thread right now pulse; the sheet follows the threads
 * while it is open.
 */

import { getJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { showMenu } from './menu.js';
import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { showError } from './dialogs.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A steady hue per agent, so an agent has the same color wherever it appears. */
function hueOf(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/**
 * Lays the graph out as a tree from `rootId`: depth first, in grant order.
 * @returns {{tree: object | null, unreached: object[]}}
 */
export function layoutTree(agents, rootId) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const drawn = new Set();
  const build = (id, max, path) => {
    const agent = byId.get(id);
    if (!agent) return { id, missing: true, max, children: [] };
    if (drawn.has(id)) return { id, agent, max, ref: true, cycle: path.includes(id), children: [] };
    drawn.add(id);
    return { id, agent, max, children: (agent.grants ?? []).map((g) => build(g.agent, g.max, [...path, id])) };
  };
  const tree = byId.has(rootId) ? build(rootId, undefined, []) : null;
  const unreached = [];
  for (const a of agents) if (!drawn.has(a.id)) unreached.push(build(a.id, undefined, []));
  return { tree, unreached };
}

/**
 * @param {{current?: string, onEditFile?: (file: string) => void, onUseAgent?: (id: string) => void}} [o]
 */
export function openAgentTree(o = {}) {
  let agents = [];
  let current = o.current ?? null;
  let busy = new Map(); // agent id → threads it is working in now
  let root = null;
  let timer = 0;
  const nodes = new Map(); // agent id → its drawn card (for the live state)

  function busyFrom(threads) {
    const out = new Map();
    for (const t of threads ?? []) {
      if (!t.busy) continue;
      // The replier works; the writer waits on it or keeps going.
      const replier = t.agents?.[1];
      if (replier) out.set(replier, (out.get(replier) ?? 0) + 1);
    }
    return out;
  }

  function showBusy() {
    for (const [id, cards] of nodes) {
      const n = busy.get(id) ?? 0;
      for (const card of cards) {
        card.classList.toggle('working', n > 0);
        const badge = card.querySelector('.tree-live');
        if (badge) badge.textContent = n ? (n > 1 ? `Working in ${n} threads` : 'Working') : '';
      }
    }
  }

  function menuFor(node, card) {
    const a = node.agent;
    if (!a) return;
    showMenu({
      anchor: card,
      align: 'start',
      title: a.description || undefined,
      groups: [
        [
          a.id !== current && o.onUseAgent ? { label: 'Use This Agent', symbol: 'checkmark.circle', action: () => o.onUseAgent(a.id) } : null,
          a.file && o.onEditFile ? { label: 'Edit Agent File', symbol: 'square.and.pencil', action: () => o.onEditFile(a.file) } : null,
        ].filter(Boolean),
      ],
    });
  }

  function card(node, isRoot) {
    const a = node.agent;
    const c = el(node.ref || node.missing ? 'div' : 'button', 'tree-card');
    if (c.tagName === 'BUTTON') c.type = 'button';
    if (isRoot) c.classList.add('root');
    if (node.ref) c.classList.add('ref');
    if (node.missing) c.classList.add('missing');
    const hue = hueOf(node.id);
    c.style.setProperty('--hue', String(hue));
    const avatar = el('span', 'tree-avatar', (a?.name ?? node.id).trim().charAt(0).toUpperCase());
    const text = el('span', 'tree-text');
    const name = el('span', 'tree-name', a?.name ?? node.id);
    if (a && a.id === current && !node.ref) name.append(el('span', 'tree-tag', 'Replying'));
    text.append(name);
    let sub = '';
    if (node.missing) sub = 'Not loaded: no agent file with this name';
    else if (node.ref) sub = node.cycle ? 'Messages back up the tree (drawn above)' : 'Also reached from another agent (drawn above)';
    else sub = [a.model, a.prompts?.length ? a.prompts.map((p) => p.split(/[\\/]/).pop()).join(', ') : null].filter(Boolean).join(' · ');
    if (sub) text.append(el('span', 'tree-sub', sub));
    const live = el('span', 'tree-live');
    text.append(live);
    c.append(avatar, text);
    if (node.ref) {
      const back = el('i', 'tree-ref');
      applySymbol(back, 'arrow.uturn.left', { size: 13 });
      c.append(back);
    }
    if (node.max !== undefined) {
      const edge = el('span', 'tree-edge', node.max > 1 ? `×${node.max}` : '');
      edge.title = `Up to ${node.max} thread${node.max === 1 ? '' : 's'} at once`;
      c.prepend(edge);
    }
    if (node.ref) {
      // A link back: shows where the agent is drawn.
      c.setAttribute('role', 'button');
      c.tabIndex = 0;
      c.style.cursor = 'pointer';
      const go = () => {
        const target = nodes.get(node.id)?.[0];
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('flash');
        void target.offsetWidth;
        target.classList.add('flash');
      };
      c.addEventListener('click', go);
      c.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
    }
    if (c.tagName === 'BUTTON') {
      c.setAttribute('aria-label', `${a.name ?? a.id}${sub ? `, ${sub}` : ''}`);
      c.addEventListener('click', () => menuFor(node, c));
    }
    if (a) {
      if (!nodes.has(a.id)) nodes.set(a.id, []);
      nodes.get(a.id).push(c);
    }
    return c;
  }

  function branch(node, isRoot = false) {
    const li = el('li', 'tree-node');
    li.append(card(node, isRoot));
    if (node.children.length) {
      const ul = el('ul', 'tree-children');
      for (const child of node.children) ul.append(branch(child));
      li.append(ul);
    }
    return li;
  }

  function render(body) {
    nodes.clear();
    body.replaceChildren();
    const { tree, unreached } = layoutTree(agents, current);
    if (tree) {
      const ul = el('ul', 'tree-root');
      ul.append(branch(tree, true));
      body.append(ul);
    }
    if (unreached.length) {
      body.append(el('h3', 'tree-heading', tree ? `Not reachable from ${tree.agent?.name ?? current}` : 'Agents'));
      const ul = el('ul', 'tree-root');
      for (const n of unreached) ul.append(branch(n, !tree));
      body.append(ul);
    }
    if (!agents.length) body.append(el('p', 'tree-note', 'No agents are loaded.'));
    body.append(
      el(
        'p',
        'tree-note',
        'A line means the agent above may start a conversation with the one below (×N: that many at once). The agent it starts can always write back, and both keep working while they talk.',
      ),
    );
    showBusy();
  }

  async function load(body) {
    try {
      const [all, threads] = await Promise.all([getJson('/api/agents'), getJson('/api/threads').catch(() => ({ threads: [] }))]);
      agents = all.agents ?? [];
      current = o.current ?? all.current ?? current;
      busy = busyFrom(threads.threads);
      render(body);
    } catch (error) {
      showError(error.message, "Couldn't load the agents");
    }
  }

  async function poll() {
    try {
      const threads = await getJson('/api/threads');
      busy = busyFrom(threads.threads);
      showBusy();
    } catch {
      // the next poll tries again
    }
  }

  const ctx = openSheet({
    title: 'Agent Tree',
    detents: ['large'],
    className: 'tree-sheet',
    build(sheet) {
      root = el('div', 'tree');
      sheet.body.append(root);
      load(root);
      timer = setInterval(poll, 2000);
    },
    onClose: () => clearInterval(timer),
  });
  return ctx;
}
