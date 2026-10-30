/**
 * Springs for the conversation's motion, iMessage style: Web Animations
 * easings sampled from a damped spring, and the bubbles that trail the
 * scroll and settle back, the further from the finger the more.
 */

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const linearOk = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)');

const cache = new Map();

/**
 * A spring as an easing for element.animate(): `{easing, duration}`.
 * `bounce` 0 settles without overshoot; 0.3 overshoots like a Messages bubble.
 * @param {{response?: number, bounce?: number}} [o]  response: seconds to (mostly) settle
 */
export function spring({ response = 0.42, bounce = 0.22 } = {}) {
  const key = `${response}|${bounce}`;
  if (cache.has(key)) return cache.get(key);
  // SwiftUI's parameterization: stiffness from the response, damping from the bounce.
  const stiffness = (2 * Math.PI / response) ** 2;
  const damping = (1 - bounce) * 4 * Math.PI / response;
  let x = 0;
  let v = 0;
  const dt = 1 / 240;
  const samples = [0];
  let t = 0;
  for (let i = 0; i < 240 * 3; i++) {
    const a = stiffness * (1 - x) - damping * v;
    v += a * dt;
    x += v * dt;
    t += dt;
    if (i % 4 === 3) samples.push(x);
    if (t > 0.2 && Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.01) break;
  }
  samples[samples.length - 1] = 1;
  const duration = Math.round(t * 1000);
  const result = linearOk
    ? { easing: `linear(${samples.map((s) => +s.toFixed(4)).join(', ')})`, duration }
    : { easing: bounce > 0.05 ? 'cubic-bezier(0.34, 1.4, 0.64, 1)' : 'cubic-bezier(0.25, 1, 0.5, 1)', duration };
  cache.set(key, result);
  return result;
}

/** element.animate with a spring; instant (no motion) when the reader asked for less. */
export function springAnimate(node, keyframes, o = {}) {
  const s = spring(o);
  return node.animate(keyframes, { duration: reduced() ? 1 : s.duration, easing: s.easing, fill: o.fill ?? 'none', delay: reduced() ? 0 : o.delay ?? 0 });
}

/**
 * Bubbles that trail the scroll: each row in view is pushed against the
 * scroll by an amount that grows with its distance from the finger (or the
 * middle of the view), then springs back. Only `.msg` rows move.
 * @param {HTMLElement} scroller
 * @param {HTMLElement} list
 */
export function springyScroll(scroller, list) {
  if (reduced()) return () => {};
  const STIFFNESS = 420;
  const DAMPING = 32;
  const MAX = 28;
  const state = new Map(); // row → {x, v}
  let lastTop = scroller.scrollTop;
  let anchorY = null;
  let raf = 0;
  let last = 0;

  const visibleRows = () => {
    const r = scroller.getBoundingClientRect();
    const rows = [];
    for (const row of list.children) {
      if (!row.classList.contains('msg')) continue;
      const top = row.offsetTop - scroller.scrollTop + r.top;
      if (top > r.bottom + 60) break;
      if (top + row.offsetHeight < r.top - 60) continue;
      rows.push([row, top + row.offsetHeight / 2]);
    }
    return rows;
  };

  function onScroll() {
    const top = scroller.scrollTop;
    const dy = top - lastTop;
    lastTop = top;
    // Big jumps are programmatic (a jump to a message, a new message): no trail.
    if (!dy || Math.abs(dy) > 160 || list.classList.contains('no-spring')) return;
    const r = scroller.getBoundingClientRect();
    const anchor = anchorY ?? r.top + r.height / 2;
    for (const [row, y] of visibleRows()) {
      const k = Math.min(1, Math.abs(y - anchor) / Math.max(1, r.height));
      let s = state.get(row);
      if (!s) state.set(row, (s = { x: 0, v: 0 }));
      // Content moves up by dy; the trailing row lags behind (moves down relative to its place).
      s.x = Math.max(-MAX, Math.min(MAX, s.x + dy * k * 0.32));
    }
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    let moving = false;
    for (const [row, s] of state) {
      const a = -STIFFNESS * s.x - DAMPING * s.v;
      s.v += a * dt;
      s.x += s.v * dt;
      if (Math.abs(s.x) < 0.05 && Math.abs(s.v) < 0.5 || !row.isConnected) {
        row.style.translate = '';
        state.delete(row);
        continue;
      }
      moving = true;
      row.style.translate = `0 ${s.x.toFixed(2)}px`;
    }
    raf = moving ? requestAnimationFrame(tick) : 0;
  }

  // The finger, while it is down (a touch scroll cancels its pointer, so touches are followed instead).
  const onTouch = (e) => (anchorY = e.touches[0]?.clientY ?? null);
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('touchstart', onTouch, { passive: true });
  scroller.addEventListener('touchmove', onTouch, { passive: true });
  scroller.addEventListener('touchend', onTouch, { passive: true });
  scroller.addEventListener('touchcancel', onTouch, { passive: true });
  return () => {
    scroller.removeEventListener('scroll', onScroll);
    cancelAnimationFrame(raf);
    for (const row of state.keys()) row.style.translate = '';
    state.clear();
  };
}
