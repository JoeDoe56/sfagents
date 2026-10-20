/**
 * Seeded gradient underlay: a moving gradient generated from a string (a
 * model slug, say) that a lens refracts as if it lay under the glass,
 * without being in the page. The real backdrop still shows through it.
 *
 * Everything about the gradient — palette and colour scheme, how many
 * shapes, their size, aspect, path and speed, the base layer's style and the
 * blend — comes from the seed, so the same seed always draws the same
 * animation and a different seed draws a different one.
 * @module
 */

/** 32-bit FNV-1a, then a murmur finaliser, for well-spread seeds from similar strings. */
export function hashSeed(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: a small, fast, deterministic PRNG. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMES = {
  analogous: [0, 28, -28, 52],
  triad: [0, 120, 240, 60],
  complement: [0, 180, 20, 200],
  split: [0, 150, 210, 30],
  tetrad: [0, 90, 180, 270],
  mono: [0, 8, -10, 16],
};
const STYLES = ['blobs', 'swirl', 'waves', 'aurora'];
// Additive blending washes overlapping shapes out to white; these keep the colours.
const BLENDS = ['screen', 'source-over', 'soft-light', 'overlay'];

/**
 * The gradient a seed describes (plain data: inspect it, test it, store it).
 * @param {string} seed
 */
export function gradientSpec(seed) {
  const r = rng(hashSeed(seed));
  const pick = (list) => list[Math.floor(r() * list.length) % list.length];
  const range = (a, b) => a + (b - a) * r();
  const schemeName = pick(Object.keys(SCHEMES));
  const offsets = SCHEMES[schemeName];
  const hue = r() * 360;
  const style = pick(STYLES);
  const speed = range(0.18, 0.55) * (r() < 0.5 ? -1 : 1);
  const count = 3 + Math.floor(r() * 4);
  const blobs = [];
  for (let i = 0; i < count; i++) {
    blobs.push({
      hue: (hue + offsets[i % offsets.length] + range(-14, 14) + 360) % 360,
      sat: range(62, 96),
      light: range(44, 62),
      radius: range(0.34, 0.78),
      aspect: range(0.55, 1.5),
      spin: range(-0.6, 0.6),
      fx: range(0.45, 1.6),
      fy: range(0.45, 1.6),
      px: r() * Math.PI * 2,
      py: r() * Math.PI * 2,
      ax: range(0.12, 0.42),
      ay: range(0.12, 0.42),
      alpha: range(0.55, 0.9),
    });
  }
  return {
    seed: String(seed),
    scheme: schemeName,
    style,
    blend: pick(BLENDS),
    hue,
    speed,
    base: { hue: (hue + range(-30, 30) + 360) % 360, sat: range(40, 80), light: range(14, 30), angle: r() * Math.PI * 2, bands: 2 + Math.floor(r() * 3) },
    blobs,
  };
}

const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%, ${a})`;

/**
 * Draws a spec at time `t` (seconds) into a 2D context of size w×h.
 * @param {CanvasRenderingContext2D} ctx
 */
export function drawGradient(ctx, spec, t, w, h) {
  const s = Math.max(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const phase = t * spec.speed;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  // Base layer.
  const b = spec.base;
  if (spec.style === 'swirl' && ctx.createConicGradient) {
    const g = ctx.createConicGradient(b.angle + phase, cx, cy);
    const n = spec.blobs.length;
    spec.blobs.forEach((bl, i) => g.addColorStop(i / n, hsl(bl.hue, bl.sat, bl.light * 0.8)));
    g.addColorStop(1, hsl(spec.blobs[0].hue, spec.blobs[0].sat, spec.blobs[0].light * 0.8));
    ctx.fillStyle = g;
  } else if (spec.style === 'waves' || spec.style === 'aurora') {
    const a = b.angle + phase * 0.35;
    const dx = Math.cos(a) * s * 0.6;
    const dy = Math.sin(a) * s * 0.6;
    const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    for (let i = 0; i <= b.bands; i++) {
      const bl = spec.blobs[i % spec.blobs.length];
      const wobble = 0.08 * Math.sin(phase * 1.7 + i);
      g.addColorStop(Math.max(0, Math.min(1, i / b.bands + wobble)), hsl(bl.hue, bl.sat, spec.style === 'aurora' ? b.light : bl.light * 0.75));
    }
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = hsl(b.hue, b.sat, b.light);
  }
  ctx.fillRect(0, 0, w, h);
  // Moving shapes.
  ctx.globalCompositeOperation = spec.blend;
  for (const bl of spec.blobs) {
    const x = cx + Math.sin(phase * bl.fx + bl.px) * bl.ax * w;
    const y = cy + Math.cos(phase * bl.fy + bl.py) * bl.ay * h;
    const r = bl.radius * s;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bl.spin * phase * 2 + bl.px);
    ctx.scale(bl.aspect, 1 / bl.aspect);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, hsl(bl.hue, bl.sat, bl.light, bl.alpha));
    g.addColorStop(0.55, hsl(bl.hue, bl.sat, bl.light * 0.9, bl.alpha * 0.45));
    g.addColorStop(1, hsl(bl.hue, bl.sat, bl.light, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * A lens underlay that draws the seed's gradient around the lens, animated.
 * Pass it as a lens's `underlay` option. sfgl draws only when asked to, so
 * while the gradient should move, call `glass.requestRender()` every frame
 * (or use `animate(glass)`).
 *
 * @param {{seed: string, strength?: number, margin?: number, maxPixels?: number, document?: Document, now?: () => number}} options
 */
export function createGradientUnderlay(options) {
  const doc = options.document || globalThis.document;
  const now = options.now || (() => performance.now());
  const canvas = doc.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const margin = options.margin ?? 14;
  const maxPixels = options.maxPixels ?? 160;
  let spec = gradientSpec(options.seed);
  let strength = options.strength ?? 0.8;
  let revision = 0;
  let frozenAt = null;
  let loop = 0;

  function prepare(lens) {
    if (strength <= 0.001) return null;
    const w = lens.width + margin * 2;
    const h = lens.height + margin * 2;
    const k = Math.min(1, maxPixels / Math.max(w, h));
    const cw = Math.max(2, Math.round(w * k));
    const ch = Math.max(2, Math.round(h * k));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const t = (frozenAt ?? now()) / 1000;
    drawGradient(ctx, spec, t, cw, ch);
    // The real backdrop shows through: scale the whole layer's alpha.
    if (strength < 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = `rgba(0,0,0,${strength})`;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    }
    revision++;
    return { canvas, bounds: { left: lens.left - margin, top: lens.top - margin, width: w, height: h }, revision };
  }

  return {
    prepare,
    commit() {},
    clear() {},
    get spec() {
      return spec;
    },
    get canvas() {
      return canvas;
    },
    setSeed(seed) {
      spec = gradientSpec(seed);
    },
    /** 0..1: how much of the gradient covers the backdrop. */
    setStrength(value) {
      strength = Math.max(0, Math.min(1, value));
    },
    get strength() {
      return strength;
    },
    /** Stops (or restarts) the motion; reduced motion freezes it. */
    freeze(on) {
      frozenAt = on ? now() : null;
    },
    /** Asks `glass` for a frame at most `fps` times a second until stopped. Returns a stop function. */
    animate(glass, fps = 30) {
      cancelAnimationFrame(loop);
      let last = 0;
      const tick = (time) => {
        loop = requestAnimationFrame(tick);
        if (time - last < 1000 / fps - 2) return;
        last = time;
        glass.requestRender();
      };
      loop = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(loop);
    },
  };
}
