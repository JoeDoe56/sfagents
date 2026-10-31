/**
 * The dock above the composer: a glass pill for each Git repository with
 * uncommitted changes (stacked, newest change at the bottom, closest to
 * the bar), and beside them a glass circle, as tall as a pill, that
 * scrolls the conversation back to the end once its last messages are out
 * of view.
 *
 * Layout: the dock spans the composer bar's width, its bottom edge a fixed
 * gap above the bar. The pills are a column on the leading side; the
 * circle sits at the trailing side, level with the bottom pill (or alone).
 * The topic rail along the right edge is lifted above the dock so they
 * never overlap, and the conversation's bottom padding grows by the pills'
 * height so the last message can still scroll clear of them.
 *
 * Both are sfgl glass on the bar sheet's layer (which refracts the chat).
 */

import { applySymbol } from './vendor/sfgl/src/symbols.js';
import { springAnimate } from './springs.js';
import { lensFor } from './vendor/sfgl/src/ui/index.js';

/** A Git branch (the bundled symbols have none). */
const BRANCH_GLYPH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 6.75c0 3-7 2.5-7 4"/></g></svg>';

export const DOCK_ROW = 30; // pill height = circle diameter
const GAP_ABOVE_BAR = 10;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{layer: () => ({el: HTMLElement, host: any} | null), bar: HTMLElement, chat: HTMLElement, thread: HTMLElement,
 *   onOpenDiff: (repo: object, pill: HTMLElement) => void, onLayout: (o: {height: number, pills: number}) => void}} o
 */
export function createChatDock(o) {
  const dock = el('div', 'chat-dock');
  dock.setAttribute('aria-label', 'Changes and scrolling');
  const pills = el('div', 'dock-pills');
  const down = el('button', 'dock-down dock-glass');
  down.type = 'button';
  down.dataset.glass = 'control';
  down.setAttribute('aria-label', 'Scroll to the latest message');
  const arrow = el('i');
  applySymbol(arrow, 'arrow.down', { size: 13 });
  down.append(arrow);
  // sfgl's lens owns the button's own opacity, so the show and hide animate a wrapper.
  const downWrap = el('div', 'dock-down-wrap');
  downWrap.append(down);
  dock.append(pills, downWrap);

  let repos = [];
  const pillFor = new Map(); // repo id → pill
  let clearance = 100;
  let covered = false;
  let downShown = false;
  let attached = null;

  function host() {
    const layer = o.layer();
    if (layer && attached !== layer.el) {
      layer.el.append(dock);
      attached = layer.el;
    }
    return layer?.host ?? null;
  }

  /** Glass follows the elements while they move (an entrance, the bar moving). */
  let followUntil = 0;
  let followRaf = 0;
  function followGlass(ms = 450) {
    followUntil = Math.max(followUntil, performance.now() + ms);
    if (followRaf) return;
    const tick = () => {
      host()?.invalidate();
      if (performance.now() < followUntil) followRaf = requestAnimationFrame(tick);
      else followRaf = 0;
    };
    followRaf = requestAnimationFrame(tick);
  }

  function adopt() {
    host()?.adopt(dock);
    followGlass();
  }

  // ---------------------------------------------------------------- layout

  function place() {
    const r = o.bar.getBoundingClientRect();
    if (r.width) {
      dock.style.left = `${Math.round(r.left)}px`;
      dock.style.width = `${Math.round(r.width)}px`;
    }
    dock.style.bottom = `${Math.round(clearance + GAP_ABOVE_BAR)}px`;
    dock.classList.toggle('covered', covered);
    dock.classList.toggle('has-pills', repos.length > 0);
    report();
  }

  let lastReport = '';
  function report() {
    const count = covered ? 0 : repos.length;
    const pillsHeight = count ? count * DOCK_ROW + (count - 1) * 8 : 0;
    // The circle needs room above the bar too, but only lifts the rail (it shows over scrolled-up content).
    const height = covered ? 0 : Math.max(pillsHeight, downShown ? DOCK_ROW : 0);
    const key = `${height}|${pillsHeight}`;
    if (key === lastReport) return;
    lastReport = key;
    o.onLayout({ height: height ? height + GAP_ABOVE_BAR : 0, pills: pillsHeight ? pillsHeight + GAP_ABOVE_BAR : 0 });
  }

  // ---------------------------------------------------------------- pills

  function pillText(pill, repo) {
    pill.querySelector('.pill-name').textContent = repo.name;
    const branch = pill.querySelector('.pill-branch');
    branch.textContent = repo.branch && repo.branch !== 'HEAD' ? repo.branch : '';
    branch.hidden = !branch.textContent;
    pill.querySelector('.pill-files').textContent = `${repo.files} file${repo.files === 1 ? '' : 's'}`;
    pill.querySelector('.pill-add').textContent = `+${repo.added}`;
    pill.querySelector('.pill-del').textContent = `−${repo.removed}`;
    pill.setAttribute('aria-label', `${repo.name}: ${repo.files} changed file${repo.files === 1 ? '' : 's'}, ${repo.added} lines added, ${repo.removed} removed. Show the diff.`);
  }

  function makePill(repo) {
    const pill = el('button', 'diff-pill dock-glass');
    pill.type = 'button';
    pill.dataset.glass = 'control';
    const icon = el('i', 'pill-icon');
    icon.innerHTML = BRANCH_GLYPH;
    const name = el('span', 'pill-name');
    const branch = el('span', 'pill-branch');
    const files = el('span', 'pill-files');
    const add = el('span', 'pill-add');
    const del = el('span', 'pill-del');
    pill.append(icon, name, branch, files, add, del);
    pill.addEventListener('click', () => {
      const current = repos.find((r) => r.id === pill.dataset.id);
      if (current) o.onOpenDiff(current, pill);
    });
    pill.dataset.id = repo.id;
    pillText(pill, repo);
    return pill;
  }

  function setRepos(next) {
    host();
    const list = Array.isArray(next) ? next : [];
    const ids = new Set(list.map((r) => r.id));
    // Leaving pills fold away, then their glass goes.
    for (const [id, pill] of pillFor) {
      if (ids.has(id)) continue;
      pillFor.delete(id);
      const done = () => {
        o.layer()?.host?.release(pill);
        pill.remove();
        followGlass(120);
      };
      if (reduced()) done();
      else {
        pill.style.pointerEvents = 'none';
        springAnimate(pill, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.85)' }], { response: 0.3, bounce: 0, fill: 'forwards' }).finished.then(done, done);
      }
    }
    // The column reads top to bottom in the order the server gives (stable by path).
    for (const repo of list) {
      let pill = pillFor.get(repo.id);
      if (!pill) {
        pill = makePill(repo);
        pillFor.set(repo.id, pill);
        pills.append(pill);
        if (!reduced()) springAnimate(pill, [{ opacity: 0, transform: 'translateY(10px) scale(0.85)' }, { opacity: 1, transform: 'none' }], { response: 0.42, bounce: 0.24 });
      } else pillText(pill, repo);
      pills.append(pill); // keeps the server's order
    }
    repos = list;
    place();
    adopt();
  }

  // ---------------------------------------------------------------- scroll to the end

  /** The last message is below what is visible above the dock and the bar. */
  function lastOutOfView() {
    const last = o.thread.lastElementChild;
    if (!last) return false;
    const visibleBottom = o.chat.getBoundingClientRect().bottom - clearance;
    return last.getBoundingClientRect().top > visibleBottom - 8 && o.chat.scrollHeight - o.chat.scrollTop - o.chat.clientHeight > 40;
  }

  let downAnim = 0;
  let downProgress = 0;
  function setDownShown(show) {
    if (show === downShown) return;
    downShown = show;
    down.tabIndex = show ? 0 : -1;
    down.setAttribute('aria-hidden', String(!show));
    downWrap.classList.toggle('shown', show);
    report();
    // Rises with a slight overshoot and fades; the glass forms and dissolves with it.
    cancelAnimationFrame(downAnim);
    const from = downProgress;
    const to = show ? 1 : 0;
    const duration = reduced() ? 0 : show ? 340 : 200;
    const start = performance.now();
    const back = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
    const frame = (now) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      downProgress = from + (to - from) * t;
      const p = downProgress;
      const lift = show ? back(t) * (to - from) + from : p;
      downWrap.style.opacity = String(p);
      downWrap.style.transform = `translateY(${((1 - lift) * 10).toFixed(2)}px) scale(${(0.6 + 0.4 * lift).toFixed(3)})`;
      downWrap.style.visibility = p > 0 ? 'visible' : 'hidden';
      lensFor(down)?.lens.setReveal(p >= 1 ? null : p);
      host()?.invalidate();
      if (t < 1) downAnim = requestAnimationFrame(frame);
      else downAnim = 0;
    };
    downAnim = requestAnimationFrame(frame);
  }

  let scrolling = 0; // raf of the scroll animation
  /** Scrolls to the end with an ease-in-out curve: accelerates, then settles. */
  function scrollToEnd() {
    cancelAnimationFrame(scrolling);
    const from = o.chat.scrollTop;
    const target = () => o.chat.scrollHeight - o.chat.clientHeight;
    const distance = target() - from;
    if (distance <= 1 || reduced()) {
      o.chat.scrollTop = target();
      return;
    }
    const duration = Math.min(900, Math.max(320, 260 + Math.sqrt(distance) * 9));
    const start = performance.now();
    // Smootherstep: zero velocity and acceleration at both ends.
    const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // The end can move while scrolling (an image loading): aim at where it is now.
      o.chat.scrollTop = from + (target() - from) * ease(t);
      if (t < 1) scrolling = requestAnimationFrame(step);
      else {
        scrolling = 0;
        o.chat.scrollTop = target();
      }
    };
    scrolling = requestAnimationFrame(step);
  }
  // A finger or wheel takes over from the animation.
  for (const type of ['wheel', 'touchstart', 'pointerdown']) {
    o.chat.addEventListener(type, () => {
      if (scrolling) {
        cancelAnimationFrame(scrolling);
        scrolling = 0;
      }
    }, { passive: true });
  }
  down.addEventListener('click', scrollToEnd);
  down.tabIndex = -1;
  down.setAttribute('aria-hidden', 'true');

  let checkQueued = false;
  function check() {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(() => {
      checkQueued = false;
      setDownShown(!covered && lastOutOfView());
    });
  }
  o.chat.addEventListener('scroll', check, { passive: true });
  new ResizeObserver(check).observe(o.thread);
  addEventListener('resize', () => {
    place();
    check();
  });

  return {
    el: dock,
    setRepos,
    /** The bar moved (the sheet's onMove): follow it, and hide while the sheet is up. */
    setBar({ clearance: next, covered: isCovered }) {
      clearance = next;
      covered = isCovered;
      place();
      check();
      followGlass(80);
    },
    refresh: check,
    get repos() {
      return repos;
    },
  };
}

// ------------------------------------------------------------------ the diff

/** A repository's diff, file by file, colored like a code review. */
export function renderDiff(container, data) {
  container.replaceChildren();
  const files = data?.files ?? [];
  if (!files.length) {
    container.append(el('p', 'diff-empty', 'No uncommitted changes.'));
    return;
  }
  const STATUS = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'New' };
  for (const f of files) {
    const section = el('details', 'diff-file');
    section.open = files.length <= 12;
    const head = el('summary', 'diff-file-head');
    head.append(el('span', `diff-status ${f.status}`, STATUS[f.status] ?? f.status), el('span', 'diff-path', f.path));
    const counts = el('span', 'diff-counts');
    counts.append(el('span', 'pill-add', `+${f.added}`), el('span', 'pill-del', `−${f.removed}`));
    head.append(counts);
    section.append(head);
    const body = el('div', 'diff-body');
    if (f.binary) body.append(el('p', 'diff-note', 'Binary file'));
    else if (!f.patch) body.append(el('p', 'diff-note', 'No line changes shown'));
    else {
      const pre = el('pre', 'diff-lines');
      for (const line of f.patch.split('\n')) {
        // Git's own header lines are summarized by the file's row above.
        if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/.test(line)) continue;
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'note' : 'ctx';
        const row = el('span', `diff-line ${kind}`, line || ' ');
        pre.append(row);
      }
      body.append(pre);
    }
    section.append(body);
    container.append(section);
  }
  if (data.truncated) container.append(el('p', 'diff-note', 'The diff is too large to show completely.'));
}
