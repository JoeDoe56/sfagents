/**
 * Line and area charts for the monitor's windows, drawn on a canvas:
 * smooth monotone curves, a soft gradient under each line, faint
 * horizontal guides, and the window's scale in the corners (as Task
 * Manager's performance graphs show it), in Apple's system colours.
 */

export const COLORS = {
  blue: '#0a84ff',
  purple: '#bf5af2',
  green: '#30d158',
  orange: '#ff9f0a',
  teal: '#64d2ff',
  pink: '#ff375f',
  yellow: '#ffd60a',
  indigo: '#5e5ce6',
  gray: '#8e8e93',
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Points of a monotone cubic (Fritsch–Carlson) through (xs, ys): no overshoot above 100 % or below 0. */
function monotonePath(ctx, pts) {
  const n = pts.length;
  if (n < 2) return;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    ctx.bezierCurveTo(pts[i][0] + h, pts[i][1] + h * t[i], pts[i + 1][0] - h, pts[i + 1][1] - h * t[i + 1], pts[i + 1][0], pts[i + 1][1]);
  }
}

/**
 * @param {HTMLElement} host  the chart fills it
 * @param {{series: {color: string, fill?: boolean, width?: number}[], max?: number | 'auto', points?: number,
 *          compact?: boolean, format?: (v: number) => string, span?: string}} options
 */
export function createChart(host, options) {
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-canvas';
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  let data = options.series.map(() => []);
  let width = 0;
  let height = 0;

  function resize() {
    const r = host.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const k of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
    return 10 * p;
  }

  function draw() {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const points = options.points ?? 60;
    const all = data.flat().filter(Number.isFinite);
    const max = options.max === 'auto' || options.max === undefined ? niceMax(Math.max(0, ...all) * 1.1) : options.max;
    const pad = options.compact ? { l: 0, r: 0, t: 14, b: 1 } : { l: 8, r: 8, t: 20, b: 18 };
    const w = width - pad.l - pad.r;
    const h = height - pad.t - pad.b;
    // Guides.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(235,235,245,0.09)';
    const rows = options.compact ? 2 : 4;
    for (let i = 0; i <= rows; i++) {
      const y = Math.round(pad.t + (h * i) / rows) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + w, y);
      ctx.stroke();
    }
    // Series: the newest sample at the right edge.
    options.series.forEach((s, si) => {
      const values = data[si].slice(-points);
      const start = points - values.length;
      const segments = [];
      let current = [];
      values.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          if (current.length) segments.push(current);
          current = [];
          return;
        }
        const x = pad.l + (w * (start + i)) / Math.max(1, points - 1);
        const y = pad.t + h - (h * Math.min(max, Math.max(0, v))) / max;
        current.push([x, y]);
      });
      if (current.length) segments.push(current);
      const [r, g, b] = hexToRgb(s.color);
      for (const pts of segments) {
        if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
        if (s.fill !== false) {
          const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
          grad.addColorStop(0, `rgba(${r},${g},${b},0.38)`);
          grad.addColorStop(1, `rgba(${r},${g},${b},0.02)`);
          ctx.beginPath();
          monotonePath(ctx, pts);
          ctx.lineTo(pts[pts.length - 1][0], pad.t + h);
          ctx.lineTo(pts[0][0], pad.t + h);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }
        ctx.beginPath();
        monotonePath(ctx, pts);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width ?? (options.compact ? 1.25 : 1.75);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    });
    if (!options.compact) {
      ctx.font = '500 11px "Host Grotesk", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(235,235,245,0.45)';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'right';
      ctx.fillText(options.format ? options.format(max) : String(max), width - 8, 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(options.span ?? `${points} seconds`, 8, height - 3);
      ctx.textAlign = 'right';
      ctx.fillText('0', width - 8, height - 3);
    }
  }

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  return {
    /** One array of values per series, oldest first. */
    update(next) {
      data = next.map((v) => v ?? []);
      draw();
    },
    destroy() {
      observer.disconnect();
      canvas.remove();
    },
  };
}
