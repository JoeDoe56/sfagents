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

function safeInset(side) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;bottom:0;height:env(safe-area-inset-${side},0px);visibility:hidden;pointer-events:none`;
  document.body.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h;
}
const safeBottom = () => safeInset('bottom');
const safeTop = () => safeInset('top');

export function createSheet({ bar, row, grabber, scroller, onLayout, onDetent }) {
  let t = 0;
  let detent = 0;
  let anim = null;
  let safe = safeBottom();
  let safeT = safeTop();
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
    // Below the status bar when installed as an app (black-translucent status bar).
    const top = (phone ? 10 : 16) + safeT;
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
    const inset = lerp(10, 12, smooth(0, 1, t));
    row.style.left = row.style.right = `${inset}px`;
    scroller.style.setProperty('--row-inset', `${inset}px`);
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
  //
  // The whole sheet is draggable, not only the grabber. A press anywhere on
  // it becomes a sheet drag once it moves vertically past a small threshold;
  // short presses stay taps and clicks. Content that scrolls keeps its own
  // gestures: a scrolling text field, and the full sheet's list except when
  // it is at the top and the finger pulls down (then the sheet follows, as
  // in Maps). Mouse and pen use pointer events; touch inside the scrolling
  // list uses touch events so the pull-down can cancel native scrolling.
  const THRESHOLD = 7;
  let drag = null; // active drag: { y0, top0, samples }
  let press = null; // pointer press that may become a drag
  let suppressClick = false;

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

  function beginDrag(y) {
    if (anim) {
      cancelAnimationFrame(anim.raf);
      anim = null;
    }
    const g = geometry(row.offsetHeight);
    drag = { y0: y, top0: topAt(g, clamp(t, 0, 2)), samples: [{ y, at: performance.now() }] };
    bar.classList.add('dragging');
    suppressClick = true;
    // Keep a half-finished text selection from following the finger.
    window.getSelection?.()?.removeAllRanges?.();
  }

  function moveDrag(y) {
    if (!drag) return;
    const g = geometry(row.offsetHeight);
    t = tForTop(g, drag.top0 + (y - drag.y0));
    drag.samples.push({ y, at: performance.now() });
    if (drag.samples.length > 6) drag.samples.shift();
    apply();
  }

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    bar.classList.remove('dragging');
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
    setTimeout(() => (suppressClick = false), 0);
  }

  const toggle = () => animateTo(detent === 0 ? 1 : detent === 2 ? 1 : 0);
  const inScroller = (target) => scroller.contains(target) && bar.dataset.state === 'full';
  const scrollingInput = (target) => target.closest?.('textarea') && target.scrollHeight > target.clientHeight + 1;

  /** Whether a vertical move of dy from this target should move the sheet. */
  function wantsSheet(target, dy) {
    if (scrollingInput(target)) return false;
    if (inScroller(target)) return dy > 0 && scroller.scrollTop <= 0;
    return true;
  }

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    // Touches in the full sheet's scrolling list are handled with touch events below.
    if (e.pointerType === 'touch' && inScroller(e.target)) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, target: e.target, onGrabber: grabber.contains(e.target) };
  });
  bar.addEventListener('pointermove', (e) => {
    if (drag && press && e.pointerId === press.id) {
      moveDrag(e.clientY);
      e.preventDefault();
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (Math.abs(dy) < THRESHOLD || Math.abs(dy) < Math.abs(dx)) return;
    if (!wantsSheet(press.target, dy)) {
      press = null;
      return;
    }
    beginDrag(press.y);
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    moveDrag(e.clientY);
    e.preventDefault();
  });
  const pointerEnd = (e) => {
    if (!press || e.pointerId !== press.id) return;
    const wasTap = !drag && e.type === 'pointerup' && press.onGrabber;
    press = null;
    if (drag) endDrag();
    else if (wasTap) toggle();
  };
  bar.addEventListener('pointerup', pointerEnd);
  bar.addEventListener('pointercancel', pointerEnd);
  // A press that turned into a drag must not also click the button or tile under it.
  bar.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }
    },
    true,
  );

  let touch = null; // touch press in the scrolling list: { id, x, y, decided }
  scroller.addEventListener(
    'touchstart',
    (e) => {
      if (!inScroller(e.target) || e.touches.length !== 1) return;
      const p = e.touches[0];
      touch = { id: p.identifier, x: p.clientX, y: p.clientY, decided: false, dragging: false };
    },
    { passive: true },
  );
  scroller.addEventListener(
    'touchmove',
    (e) => {
      if (!touch) return;
      const p = [...e.changedTouches].find((x) => x.identifier === touch.id);
      if (!p) return;
      if (!touch.decided) {
        const dx = p.clientX - touch.x;
        const dy = p.clientY - touch.y;
        // Decide on the first move so the browser has not started scrolling yet.
        touch.decided = true;
        if (dy > 0 && Math.abs(dy) >= Math.abs(dx) && scroller.scrollTop <= 0) {
          touch.dragging = true;
          beginDrag(touch.y);
        } else {
          touch = null;
          return;
        }
      }
      if (touch.dragging) {
        e.preventDefault();
        moveDrag(p.clientY);
      }
    },
    { passive: false },
  );
  const touchEnd = () => {
    if (touch?.dragging) endDrag();
    touch = null;
  };
  scroller.addEventListener('touchend', touchEnd);
  scroller.addEventListener('touchcancel', touchEnd);

  grabber.addEventListener('click', (e) => {
    // Pointer taps are handled in pointerEnd; this covers keyboard activation.
    if (e.detail === 0) toggle();
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

  addEventListener('resize', () => {
    safe = safeBottom();
    safeT = safeTop();
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
