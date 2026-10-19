/**
 * The bottom bar as an Apple Maps-style sheet with three detents:
 *   0  collapsed: a floating pill holding the message field
 *   1  medium: a taller glass sheet, the field still on top
 *   2  full: an opaque sheet showing everything below the field
 * Position is a continuous value t in [0, 2]; dragging the grabber moves
 * it directly and release snaps to the nearest detent (with flick
 * velocity). Geometry is interpolated between detents.
 */

const DETENTS = ['collapsed', 'medium', 'full'];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, v) => {
  const k = clamp((v - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

function safeBottom() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}

export function createSheet({ bar, row, grabber, scroller, onLayout, onDetent }) {
  let t = 0;
  let detent = 0;
  let anim = null;
  let safe = safeBottom();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function geometry(rowH) {
    // The stage follows the visual viewport (it shrinks above an on-screen keyboard).
    const W = bar.parentElement.clientWidth || innerWidth;
    const H = bar.parentElement.clientHeight || innerHeight;
    const phone = W < 640;
    const collapsedW = Math.min(W - (phone ? 40 : 48), 640);
    const collapsedH = rowH + 20;
    const C = { width: collapsedW, left: (W - collapsedW) / 2, bottom: (phone ? 18 : 24) + safe, height: collapsedH, radius: 32 };
    const mediumW = Math.min(W - 16, 720);
    const mediumH = clamp(Math.round(H * 0.46), Math.min(collapsedH + 260, H - 40), Math.max(collapsedH + 260, 560));
    const M = { width: mediumW, left: (W - mediumW) / 2, bottom: 8 + safe * 0.5, height: Math.min(mediumH, H - 24), radius: 40 };
    const fullW = phone ? W : Math.min(W - 32, 720);
    const top = phone ? 10 : 16;
    // The full sheet runs past the bottom edge so only its top corners show.
    const F = { width: fullW, left: (W - fullW) / 2, bottom: -40, height: H - top + 40, radius: phone ? 38 : 34 };
    return { C, M, F, H };
  }

  function at(g, v) {
    const [a, b, k] = v <= 1 ? [g.C, g.M, v] : [g.M, g.F, v - 1];
    const e = k;
    return {
      width: lerp(a.width, b.width, e),
      left: lerp(a.left, b.left, e),
      bottom: lerp(a.bottom, b.bottom, e),
      height: lerp(a.height, b.height, e),
      radius: lerp(a.radius, b.radius, e),
    };
  }

  function topAt(g, v) {
    const p = at(g, v);
    return g.H - p.bottom - p.height;
  }

  function apply() {
    const rowH = row.offsetHeight;
    const g = geometry(rowH);
    const p = at(g, clamp(t, 0, 2));
    const pad = lerp(10, 22, smooth(0, 1, t));
    const opaque = smooth(1.15, 1.6, t);
    bar.style.left = `${p.left}px`;
    bar.style.width = `${p.width}px`;
    bar.style.bottom = `${p.bottom}px`;
    bar.style.height = `${p.height}px`;
    bar.style.borderRadius = `${p.radius}px`;
    bar.style.setProperty('--opaque', opaque.toFixed(3));
    row.style.top = `${pad}px`;
    row.style.left = row.style.right = `${lerp(10, 12, smooth(0, 1, t))}px`;
    scroller.style.top = `${pad + rowH + 10}px`;
    scroller.style.opacity = smooth(0.08, 0.6, t).toFixed(3);
    scroller.style.visibility = t < 0.02 ? 'hidden' : 'visible';
    const state = t >= 1.98 ? 'full' : t >= 0.5 ? 'medium' : 'collapsed';
    if (bar.dataset.state !== state) bar.dataset.state = state;
    grabber.setAttribute('aria-expanded', String(t > 0.5));
    grabber.setAttribute('aria-label', t > 1.5 ? 'Collapse' : 'Show artifacts');
    onLayout?.({
      t,
      opaque,
      rect: { left: p.left, top: g.H - p.bottom - p.height, width: p.width, height: p.height, radius: p.radius },
      collapsedClearance: g.C.height + g.C.bottom,
    });
  }

  function animateTo(target, velocity = 0) {
    if (anim) cancelAnimationFrame(anim.raf);
    const from = t;
    const to = clamp(target, 0, 2);
    detent = Math.round(to);
    onDetent?.(DETENTS[detent]);
    if (reduced.matches || Math.abs(to - from) < 0.001) {
      t = to;
      apply();
      return;
    }
    const duration = clamp(240 + Math.abs(to - from) * 180 - Math.abs(velocity) * 60, 220, 460);
    const start = performance.now();
    // Ease out with a slight overshoot, like a damped spring.
    const ease = (k) => {
      const c1 = 1.2;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
    };
    const step = (now) => {
      const k = clamp((now - start) / duration, 0, 1);
      t = from + (to - from) * ease(k);
      apply();
      if (k < 1) anim.raf = requestAnimationFrame(step);
      else {
        t = to;
        apply();
        anim = null;
      }
    };
    anim = { raf: requestAnimationFrame(step) };
  }

  // ------------------------------------------------------------ dragging
  let drag = null;
  function tForTop(g, top) {
    // topAt decreases as t grows; bisect.
    let lo = 0;
    let hi = 2;
    if (top >= topAt(g, 0)) return 0 - Math.min(0.06, (top - topAt(g, 0)) / 2000);
    if (top <= topAt(g, 2)) return 2;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (topAt(g, mid) > top) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function startDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (anim) {
      cancelAnimationFrame(anim.raf);
      anim = null;
    }
    const g = geometry(row.offsetHeight);
    drag = { id: e.pointerId, y0: e.clientY, top0: topAt(g, clamp(t, 0, 2)), moved: false, samples: [{ y: e.clientY, at: performance.now() }] };
    bar.classList.add('dragging');
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const g = geometry(row.offsetHeight);
    t = tForTop(g, drag.top0 + dy);
    drag.samples.push({ y: e.clientY, at: performance.now() });
    if (drag.samples.length > 6) drag.samples.shift();
    apply();
    e.preventDefault();
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    bar.classList.remove('dragging');
    if (!d.moved) {
      // A tap toggles: collapsed ↔ medium; the full sheet steps back to medium.
      animateTo(detent === 0 ? 1 : detent === 2 ? 1 : 0);
      return;
    }
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const v = last.at > first.at ? (last.y - first.y) / (last.at - first.at) : 0; // px/ms, + is down
    const g = geometry(row.offsetHeight);
    const projected = topAt(g, clamp(t, 0, 2)) + v * 220;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < 3; i++) {
      const dist = Math.abs(topAt(g, i) - projected);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    animateTo(best, v);
  }

  grabber.addEventListener('pointerdown', startDrag);
  grabber.addEventListener('pointermove', moveDrag);
  grabber.addEventListener('pointerup', endDrag);
  grabber.addEventListener('pointercancel', endDrag);
  // Dragging also works from the sheet's own glass (not its controls or content).
  bar.addEventListener('pointerdown', (e) => {
    if (e.target === bar || e.target.classList.contains('bar-fill') || e.target === row) startDrag(e);
  });
  bar.addEventListener('pointermove', moveDrag);
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  grabber.addEventListener('click', (e) => {
    // Pointer taps are handled in endDrag; this covers keyboard activation.
    if (e.detail === 0) animateTo(detent === 0 ? 1 : detent === 2 ? 1 : 0);
  });
  grabber.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      animateTo(Math.min(2, detent + 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      animateTo(Math.max(0, detent - 1));
    }
  });
  // Pulling down on the full sheet's content at its top collapses it, as in Maps.
  let pull = null;
  scroller.addEventListener('pointerdown', (e) => {
    if (detent === 2 && scroller.scrollTop <= 0 && e.pointerType !== 'mouse') pull = { id: e.pointerId, y: e.clientY };
  });
  scroller.addEventListener('pointermove', (e) => {
    if (!pull || e.pointerId !== pull.id) return;
    if (e.clientY - pull.y > 12 && scroller.scrollTop <= 0) {
      pull = null;
      startDrag(e);
    }
  });
  scroller.addEventListener('pointerup', () => (pull = null));

  addEventListener('resize', () => {
    safe = safeBottom();
    apply();
  });
  new ResizeObserver(() => apply()).observe(row);
  apply();

  return {
    get detent() {
      return DETENTS[detent];
    },
    set: (name) => animateTo(DETENTS.indexOf(name)),
    relayout: apply,
  };
}
