/**
 * The left edge of the chat: one dot per repository any agent can reach
 * (clean or not, active or not). Holding a dot (or the edge) expands labels
 * into the chat: repository, a smaller branch, one short status. Dragging
 * over a label highlights it; releasing on it opens its window, releasing
 * anywhere else (or a cancelled pointer) dismisses without opening.
 * A click or Enter on a dot opens its window too.
 */

const HOLD_MS = 350;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {{chat: HTMLElement, onOpen: (repo: object, from: HTMLElement) => void}} o */
export function createGitEdge(o) {
  const edge = el('div', 'git-edge');
  edge.setAttribute('role', 'group');
  edge.setAttribute('aria-label', 'Repositories');
  const list = el('div', 'git-edge-list');
  edge.append(list);
  document.body.append(edge);

  let repos = [];
  let expanded = false;
  let over = null;
  let press = null;

  function place() {
    const r = o.chat.getBoundingClientRect();
    edge.style.left = `${Math.round(r.left)}px`;
    edge.style.maxWidth = `${Math.max(120, Math.round(r.width - 8))}px`;
    edge.style.top = `${Math.round(r.top + 60)}px`;
    edge.style.maxHeight = `${Math.max(80, Math.round(r.height - 200))}px`;
  }

  function render() {
    list.replaceChildren();
    for (const repo of repos) {
      const item = el('button', 'git-edge-item');
      item.type = 'button';
      item.dataset.id = repo.id;
      const dot = el('span', `git-edge-dot${repo.unavailable ? ' off' : ''}${repo.working?.length ? ' busy' : ''}${/conflict/i.test(repo.status) ? ' conflict' : ''}`);
      const label = el('span', 'git-edge-label');
      const name = el('span', 'git-edge-name', repo.name);
      const branch = el('span', 'git-edge-branch', repo.branch);
      branch.title = repo.branch;
      const status = el('span', 'git-edge-status', repo.status);
      label.append(name, branch, status);
      item.append(dot, label);
      item.setAttribute('aria-label', `${repo.name}${repo.branch ? `, ${repo.branch}` : ''}: ${repo.status}. Open.`);
      // Same name in two worktrees: the path tells them apart.
      item.title = repo.path;
      item.addEventListener('click', (e) => {
        if (press?.fired) return;
        e.preventDefault();
        o.onOpen(repo, item);
      });
      list.append(item);
    }
    edge.classList.toggle('empty', !repos.length);
    edge.classList.toggle('expanded', expanded);
  }

  function setExpanded(on) {
    expanded = on;
    edge.classList.toggle('expanded', on);
    if (!on) highlight(null);
    place();
  }

  function highlight(item) {
    if (over === item) return;
    over?.classList.remove('over');
    over = item;
    over?.classList.add('over');
  }

  /** The label actually under the pointer, or null (a gap or outside). */
  function labelAt(x, y) {
    const node = document.elementFromPoint(x, y)?.closest?.('.git-edge-item');
    if (!node || !edge.contains(node)) return null;
    const r = node.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? node : null;
  }

  edge.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!e.target.closest('.git-edge-item')) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, fired: false, timer: 0 };
    press.timer = setTimeout(() => {
      press.fired = true;
      navigator.vibrate?.(8);
      setExpanded(true);
      highlight(labelAt(press.x, press.y));
    }, HOLD_MS);
  });
  edge.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    press.x = e.clientX;
    press.y = e.clientY;
    if (!press.fired) {
      if (Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > 10) clearTimeout(press.timer);
      return;
    }
    highlight(labelAt(e.clientX, e.clientY));
  });
  function finish(e, cancelled) {
    if (!press || e.pointerId !== press.id) return;
    clearTimeout(press.timer);
    const fired = press.fired;
    const target = fired && !cancelled ? labelAt(e.clientX, e.clientY) : null;
    if (fired) {
      setExpanded(false);
      const repo = target && repos.find((r) => r.id === target.dataset.id);
      if (repo) o.onOpen(repo, target);
    }
    // The click that follows a hold is swallowed by `press.fired`; clear it after it.
    setTimeout(() => (press = null), 0);
  }
  edge.addEventListener('pointerup', (e) => finish(e, false));
  edge.addEventListener('pointercancel', (e) => finish(e, true));
  edge.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => e.key === 'Escape' && expanded && setExpanded(false), true);
  addEventListener('resize', place);
  new ResizeObserver(place).observe(o.chat);

  place();
  return {
    set(next) {
      repos = Array.isArray(next) ? next : [];
      render();
    },
    place,
  };
}
