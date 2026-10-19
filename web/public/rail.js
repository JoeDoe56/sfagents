/**
 * Semantic scroll rail: one small dot per conversation section along the
 * right edge, oldest at the top and the newest at the bottom.
 *
 * Press and hold on the dots and they expand into the section titles. While
 * the finger (or mouse button) stays down, moving it only highlights a
 * title; nothing scrolls yet. Holding near the top or bottom edge scrolls
 * the list of titles so long histories stay reachable. Releasing jumps the
 * conversation to the highlighted section. Like the letter index in iOS
 * lists, but for topics. Keyboard: focus the rail, Enter or an arrow key
 * opens it, arrows move, Enter jumps, Escape closes.
 */

const ROW_HEIGHT = 34;
const DOT_SLOT = 12;
const EDGE = 56;
const MAX_SPEED = 16; // px per frame at the very edge

export function createRail({ root, dots, list, onJump, onOpenChange }) {
  let sections = [];
  let open = false;
  let pointer = null; // { id, y }
  let highlight = -1;
  let active = null; // section id currently in view
  let raf = 0;
  const vibrate = (ms) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      // not supported
    }
  };

  // ------------------------------------------------------------ rendering

  function renderDots() {
    dots.replaceChildren();
    const height = root.clientHeight || 0;
    const fit = Math.max(1, Math.floor(height / DOT_SLOT));
    const shown = sections.length > fit ? sections.slice(sections.length - fit) : sections;
    root.classList.toggle('overflowing', sections.length > fit);
    for (const s of shown) {
      const d = document.createElement('span');
      d.className = `rail-dot${s.depth > 0 ? ' sub' : ''}${s.id === active ? ' active' : ''}`;
      d.dataset.id = s.id;
      dots.append(d);
    }
  }

  function renderList() {
    const inner = document.createElement('div');
    inner.className = 'rail-inner';
    sections.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = `rail-row depth-${Math.min(s.depth, 3)}${i === highlight ? ' highlighted' : ''}${s.id === active ? ' active' : ''}`;
      row.id = `rail-${s.id}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === highlight));
      row.dataset.index = String(i);
      const label = document.createElement('span');
      label.textContent = s.title;
      row.append(label);
      inner.append(row);
    });
    list.replaceChildren(inner);
  }

  function setHighlight(i) {
    if (i === highlight || i < 0 || i >= sections.length) return;
    const rows = list.querySelectorAll('.rail-row');
    rows[highlight]?.classList.remove('highlighted');
    rows[highlight]?.setAttribute('aria-selected', 'false');
    highlight = i;
    rows[i]?.classList.add('highlighted');
    rows[i]?.setAttribute('aria-selected', 'true');
    root.setAttribute('aria-activedescendant', `rail-${sections[i].id}`);
    vibrate(4);
  }

  function rowAt(y) {
    const rows = list.querySelectorAll('.rail-row');
    let best = -1;
    let bestDist = Infinity;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  function expand(initial) {
    if (open || sections.length === 0) return;
    open = true;
    root.classList.add('open');
    renderList();
    // Newest section at the bottom: start scrolled to the end.
    list.scrollTop = list.scrollHeight;
    highlight = -1;
    if (initial !== undefined) {
      setHighlight(initial);
      list.querySelectorAll('.rail-row')[initial]?.scrollIntoView({ block: 'nearest' });
    }
    onOpenChange?.(true);
  }

  function collapse(jump) {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    raf = 0;
    root.classList.remove('open');
    root.removeAttribute('aria-activedescendant');
    const target = jump && highlight >= 0 ? sections[highlight] : null;
    highlight = -1;
    onOpenChange?.(false);
    if (target) onJump(target);
  }

  // Edge auto-scroll while the pointer is held near the top or bottom.
  function tick() {
    raf = 0;
    if (!open || !pointer) return;
    const r = list.getBoundingClientRect();
    let speed = 0;
    if (pointer.y < r.top + EDGE) speed = -MAX_SPEED * Math.min(1, (r.top + EDGE - pointer.y) / EDGE);
    else if (pointer.y > r.bottom - EDGE) speed = MAX_SPEED * Math.min(1, (pointer.y - (r.bottom - EDGE)) / EDGE);
    if (speed) {
      const before = list.scrollTop;
      list.scrollTop += speed;
      if (list.scrollTop !== before) setHighlight(rowAt(pointer.y));
    }
    raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ pointer

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sections.length === 0) return;
    e.preventDefault();
    pointer = { id: e.pointerId, y: e.clientY };
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    expand();
    setHighlight(rowAt(e.clientY));
    if (!raf) raf = requestAnimationFrame(tick);
  });
  root.addEventListener('pointermove', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    pointer.y = e.clientY;
    setHighlight(rowAt(e.clientY));
    e.preventDefault();
  });
  const release = (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    pointer = null;
    collapse(e.type === 'pointerup');
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('lostpointercapture', (e) => {
    if (pointer && e.pointerId === pointer.id) {
      pointer = null;
      collapse(false);
    }
  });
  // While open with a mouse, the wheel scrolls the titles.
  root.addEventListener(
    'wheel',
    (e) => {
      if (!open) return;
      e.preventDefault();
      list.scrollTop += e.deltaY;
      if (pointer) setHighlight(rowAt(pointer.y));
    },
    { passive: false },
  );

  // ------------------------------------------------------------ keyboard

  root.addEventListener('keydown', (e) => {
    if (!sections.length) return;
    const current = Math.max(0, sections.findIndex((s) => s.id === active));
    if (!open && ['Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      expand(active ? current : sections.length - 1);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(Math.max(0, Math.min(sections.length - 1, highlight + (e.key === 'ArrowUp' ? -1 : 1))));
      list.querySelectorAll('.rail-row')[highlight]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHighlight(e.key === 'Home' ? 0 : sections.length - 1);
      list.querySelectorAll('.rail-row')[highlight]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      collapse(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      collapse(false);
    }
  });
  root.addEventListener('blur', () => {
    if (!pointer) collapse(false);
  });

  new ResizeObserver(() => {
    if (!open) renderDots();
  }).observe(root);

  return {
    /** Replaces the section index (oldest first). */
    setSections(next) {
      sections = next || [];
      root.hidden = sections.length === 0;
      if (!open) renderDots();
    },
    /** Marks the section currently in view. */
    setActive(id) {
      if (id === active) return;
      active = id;
      for (const d of dots.children) d.classList.toggle('active', d.dataset.id === id);
    },
    get open() {
      return open;
    },
    get sections() {
      return sections;
    },
  };
}
