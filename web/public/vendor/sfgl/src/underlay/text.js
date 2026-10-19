/**
 * Text underlay for a lens. It draws the text under a glass lens onto a canvas
 * and clips the DOM text where the lens sits, so the glass shows refracted
 * text instead of the live row.
 */

/**
 * @typedef {object} TextUnderlayConfig
 * @property {() => Element | null} [container] Returns the list element to sample.
 * @property {string} [textSelector] Selects the text-bearing elements inside the container.
 * @property {string} [sampleRowSelector] Selects a row whose height sets the sampling band.
 * @property {string} [fadeHostSelector] Selects the element that carries the horizontal fade.
 * @property {string} [fadeVariable="--underlay-text-fade"] CSS variable holding the fade width.
 * @property {number} [fadeDefaultPx=18] Fade width used when the variable is empty.
 * @property {(host: Element) => boolean} [leftFade] Whether the host fades on the left.
 */

/**
 * @typedef {object} Lens
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 */

/**
 * Host globals. Each entry defaults to the matching global when it is not supplied.
 *
 * @typedef {object} TextUnderlayEnv
 * @property {Window} [window] Source of `getComputedStyle` and `devicePixelRatio`.
 * @property {Document} [document] Source of `createElement`, `createTreeWalker` and `createRange`.
 */

// NodeFilter.SHOW_TEXT. The numeric value avoids a dependency on the NodeFilter global.
const SHOW_TEXT = 4;

/**
 * Creates a text underlay controller.
 *
 * @param {TextUnderlayConfig} [config={}]
 * @param {TextUnderlayEnv} [env={}]
 * @returns {{
 *   prepare: (lens: Lens, radius: number, deferCutouts?: boolean) => {canvas: HTMLCanvasElement | null, bounds: object, revision: number} | null,
 *   commit: () => void,
 *   clear: () => void,
 *   destroy: () => void,
 *   invalidate: () => void,
 *   beginFrame: () => void,
 *   endFrame: () => void,
 *   testing: {cutout: Function, textSignature: Function}
 * }}
 */
export function createTextUnderlay(config, env = {}) {
  const doc = env.document || globalThis.document;
  const win = env.window || globalThis.window;
  config = config || {};
  const containerOf = typeof config.container === "function" ? config.container : () => null;
  const textSelector = config.textSelector || "";
  const sampleRowSelector = config.sampleRowSelector || "";
  const fadeHostSelector = config.fadeHostSelector || "";
  const fadeVariable = config.fadeVariable || "--underlay-text-fade";
  const fadeDefaultPx = Number.isFinite(config.fadeDefaultPx) ? config.fadeDefaultPx : 18;
  const leftFadeOf = typeof config.leftFade === "function" ? config.leftFade : () => false;
  const clipped = new Map();
  let canvas = null;
  let context = null;
  let touched = false;
  let cached = null;
  let revision = 0;
  let pendingCutouts = null;
  // Change tracking: when the container has not mutated, scrolled, moved or
  // run a transition since the last prepare, the text runs are reused
  // instead of re-walked and re-styled (the common case while a backdrop
  // animates under a still selection).
  let watched = null;
  let observer = null;
  let dirty = true;
  let running = 0;
  let lastKey = "";
  const onRun = () => { running++; dirty = true; };
  const onEnd = () => { running = Math.max(0, running - 1); dirty = true; };
  const transitionEvents = [["transitionrun", onRun], ["transitionend", onEnd], ["transitioncancel", onEnd], ["animationstart", onRun], ["animationend", onEnd], ["animationcancel", onEnd]];
  const markDirty = () => { dirty = true; };
  // Lenses write their own box-shadow (it follows the light); a style change
  // that differs only there cannot change the text.
  const withoutShadow = (value) => String(value || "").replace(/(?:-webkit-)?box-shadow\s*:[^;]*;?/g, "").trim();
  /** @param {any[]} records */
  function onRecords(records) {
    for (const record of records) {
      if (record && record.type === "attributes" && record.attributeName === "style" && record.target && record.target.getAttribute &&
          withoutShadow(record.oldValue) === withoutShadow(record.target.getAttribute("style"))) continue;
      dirty = true;
      return;
    }
  }

  function watch(list) {
    if (watched === list) return;
    unwatch();
    watched = list;
    dirty = true;
    if (!win || typeof /** @type {any} */ (win).MutationObserver !== "function" || !list.addEventListener) return;
    observer = new (/** @type {any} */ (win)).MutationObserver(onRecords);
    observer.observe(list, {subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true});
    // Theme classes and variables on the root element restyle the text too.
    if (doc.documentElement && doc.documentElement !== list) observer.observe(doc.documentElement, {attributes: true, attributeFilter: ["class", "style"], attributeOldValue: true});
    transitionEvents.forEach(([type, fn]) => list.addEventListener(type, fn, true));
    if (doc.fonts && doc.fonts.addEventListener) doc.fonts.addEventListener("loadingdone", markDirty);
  }

  function unwatch() {
    if (observer) { observer.disconnect(); observer = null; }
    if (watched && watched.removeEventListener) transitionEvents.forEach(([type, fn]) => watched.removeEventListener(type, fn, true));
    if (watched && doc.fonts && doc.fonts.removeEventListener) doc.fonts.removeEventListener("loadingdone", markDirty);
    watched = null;
    running = 0;
    dirty = true;
  }

  // Records already queued come from the app; collect them before writing.
  function drainRecords() {
    if (observer) onRecords(observer.takeRecords());
  }

  function restore(el, previous) {
    el.style.clipPath = previous.clip;
    el.style.webkitClipPath = previous.webkit;
    if (previous.rule !== undefined) el.style.clipRule = previous.rule;
    if (previous.webkitRule !== undefined) el.style.webkitClipRule = previous.webkitRule;
  }

  function clear() {
    pendingCutouts = null;
    drainRecords();
    clipped.forEach((previous, el) => restore(el, previous));
    clipped.clear();
    if (observer) observer.takeRecords();
    cached = null;
    lastKey = "";
  }

  function roundedPath(x, y, width, height, radius) {
    const r = Math.max(0, Math.min(Number(radius) || 0, width / 2, height / 2));
    return "M" + (x + r) + " " + y + " H" + (x + width - r) + " Q" + (x + width) + " " + y + " " + (x + width) + " " + (y + r) + " V" + (y + height - r) + " Q" + (x + width) + " " + (y + height) + " " + (x + width - r) + " " + (y + height) + " H" + (x + r) + " Q" + x + " " + (y + height) + " " + x + " " + (y + height - r) + " V" + (y + r) + " Q" + x + " " + y + " " + (x + r) + " " + y + " Z";
  }

  // Native CSS paths avoid Safari's data-SVG image decoding flicker and keep
  // each row's existing horizontal fade mask untouched.
  function cutout(rect, lens, radius) {
    if (!lens.width || !lens.height) return "none";
    const x = lens.left - rect.left;
    const y = lens.top - rect.top;
    const outerPadding = 8;
    const outer = roundedPath(0, -outerPadding, rect.width, rect.height + outerPadding * 2, 0);
    const inner = roundedPath(x, y, lens.width, lens.height, radius);
    return 'path(evenodd, "' + outer + " " + inner + '")';
  }

  function opacityOf(node) {
    try {
      const value = Number.parseFloat(win.getComputedStyle(node).opacity);
      return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    } catch (_error) {
      return 1;
    }
  }

  // Combined opacity of el and its ancestors, memoised per prepare so shared
  // ancestors are read once instead of once per text run.
  function ancestorOpacity(el, memo) {
    if (!el) return 1;
    if (memo && memo.has(el)) return memo.get(el);
    const value = opacityOf(el) * ancestorOpacity(el.parentElement, memo);
    if (memo) memo.set(el, value);
    return value;
  }

  function collectTextRuns(elements) {
    const runs = [];
    const memo = new Map();
    const range = doc.createRange();
    elements.forEach(el => {
      const walker = doc.createTreeWalker(el, SHOW_TEXT);
      // Fade data belongs to the element, so it is read once for all its runs.
      let fade = null;
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue.trim()) continue;
        const style = win.getComputedStyle(node.parentElement || el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (!fade) {
          // fadeMatch is the nearest ancestor-or-self matching fadeHostSelector, so a match means fadeHost matches it.
          const fadeMatch = el.closest && fadeHostSelector ? el.closest(fadeHostSelector) : null;
          const fadeHost = fadeMatch || el;
          const fadeStyle = win.getComputedStyle(fadeHost);
          const fadeValue = fadeStyle.getPropertyValue ? fadeStyle.getPropertyValue(fadeVariable) : "";
          fade = {rect: fadeHost.getBoundingClientRect(), px: fadeMatch ? Math.max(0, Number.parseFloat(fadeValue) || fadeDefaultPx) : 0, left: !!fadeMatch && !!leftFadeOf(fadeHost)};
        }
        runs.push({node, value: node.nodeValue, rect, style, alpha: ancestorOpacity(node.parentElement || el, memo), fadeRect: fade.rect, fadePx: fade.px, leftFade: fade.left});
      }
    });
    if (range.detach) range.detach();
    return runs;
  }

  function textSignature(runs) {
    return JSON.stringify(runs.map(run => {
      const r = run.rect, f = run.fadeRect, s = run.style;
      return [run.value, r.left, r.top, r.width, r.height, f.left, f.top, f.width, f.height, run.fadePx, run.leftFade, run.alpha, s.font, s.color, s.opacity, s.letterSpacing];
    }));
  }

  function drawText(runs, bounds) {
    if (!canvas) {
      canvas = doc.createElement("canvas");
      context = canvas.getContext("2d");
    }
    if (!context) return false;
    const scale = Math.min(2, win.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    context.setTransform(scale, 0, 0, scale, -bounds.left * scale, -bounds.top * scale);
    runs.forEach(run => {
      const style = run.style, textRect = run.rect, fadeRect = run.fadeRect;
      const size = Number.parseFloat(style.fontSize) || 16;
      context.save();
      const padding = Math.max(2, size * .2);
      context.beginPath();
      // Keep horizontal clipping aligned with the native row fade while
      // expanding only vertically for the font's glyph metrics.
      context.rect(fadeRect.left, textRect.top - padding, fadeRect.width, textRect.height + padding * 2);
      context.clip();
      context.font = style.font || (style.fontWeight + " " + style.fontSize + " " + style.fontFamily);
      context.fillStyle = style.color;
      context.globalAlpha = run.alpha;
      context.textBaseline = "alphabetic";
      if ("letterSpacing" in context) context.letterSpacing = style.letterSpacing || "0px";
      const gradient = typeof context.createLinearGradient === "function" ? context.createLinearGradient(fadeRect.left, 0, fadeRect.right, 0) : null;
      if (gradient) {
        const width = Math.max(1, fadeRect.width), left = run.leftFade ? Math.min(1, run.fadePx / width) : 0, right = Math.max(left, 1 - Math.min(1, run.fadePx / width));
        if (run.leftFade) { gradient.addColorStop(0, "transparent"); gradient.addColorStop(left, style.color); }
        else gradient.addColorStop(0, style.color);
        gradient.addColorStop(right, style.color);
        gradient.addColorStop(1, "transparent");
        context.fillStyle = gradient;
      }
      const metrics = context.measureText(run.value);
      const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || size * .8;
      const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || size * .2;
      const baseline = textRect.top + (textRect.height - ascent - descent) / 2 + ascent;
      context.fillText(run.value, textRect.left, baseline);
      context.restore();
    });
    return true;
  }

  function prepare(lens, radius, deferCutouts) {
    touched = true;
    const list = containerOf();
    if (!list) { clear(); return null; }
    const listRect = list.getBoundingClientRect();
    const margin = 32;
    const bounds = {left: Math.max(listRect.left, lens.left - margin), top: Math.max(listRect.top, lens.top - margin), right: Math.min(listRect.right, lens.left + lens.width + margin), bottom: Math.min(listRect.bottom, lens.top + lens.height + margin)};
    bounds.width = Math.max(0, bounds.right - bounds.left);
    bounds.height = Math.max(0, bounds.bottom - bounds.top);
    if (!bounds.width || !bounds.height) { clear(); return null; }
    const sampleRow = list.querySelector && sampleRowSelector ? list.querySelector(sampleRowSelector) : null;
    const sampleHeight = sampleRow ? Number(sampleRow.getBoundingClientRect().height) : 55;
    const band = Math.max(44, Number.isFinite(sampleHeight) && sampleHeight > 0 ? sampleHeight : 55) * 2;
    const bandIndex = Math.floor(Math.max(0, lens.top - listRect.top) / band);
    const stableTop = Math.max(listRect.top, listRect.top + bandIndex * band - band);
    const stableBottom = Math.min(listRect.bottom, stableTop + band * 3);
    const stableBounds = {left: listRect.left, top: stableTop, width: listRect.width, height: Math.max(0, stableBottom - stableTop)};
    watch(list);
    drainRecords();
    // Anything outside the container that changes the text's look shows up
    // in its rect, its scroll offset, its ancestors' opacity or the band.
    const key = [listRect.left, listRect.top, listRect.width, listRect.height, list.scrollTop || 0, list.scrollLeft || 0, stableBounds.top, stableBounds.height, win.devicePixelRatio || 1, ancestorOpacity(list.parentElement, null)].join(",");
    if (cached && observer && !dirty && !running && key === lastKey) {
      pendingCutouts = {elements: cached.elements, lens, radius};
      if (!deferCutouts) commit();
      return cached.result;
    }
    dirty = false;
    lastKey = key;
    const elements = (textSelector ? Array.from(list.querySelectorAll(textSelector)) : []).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > stableBounds.left && rect.left < stableBounds.left + stableBounds.width && rect.bottom > stableBounds.top && rect.top < stableBounds.top + stableBounds.height;
    });
    if (!elements.length) { clear(); return null; }
    const runs = collectTextRuns(elements);
    if (!runs.length) { clear(); return null; }
    const signature = JSON.stringify([stableBounds.left, stableBounds.top, stableBounds.width, stableBounds.height, textSignature(runs)]);
    if (!cached || cached.signature !== signature || !elements.every(el => cached.elements.includes(el))) {
      if (!drawText(runs, stableBounds)) { clear(); return null; }
      cached = {signature, elements: elements.slice(), result: {canvas, bounds: stableBounds, revision: ++revision}};
    }
    pendingCutouts = {elements, lens, radius};
    if (!deferCutouts) commit();
    return cached.result;
  }

  // Publish DOM cutouts only after the replacement pixels were submitted.
  function commit() {
    if (!pendingCutouts) return;
    const {elements, lens, radius} = pendingCutouts;
    pendingCutouts = null;
    drainRecords();
    const retained = new Set();
    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right <= lens.left || rect.left >= lens.left + lens.width || rect.bottom <= lens.top || rect.top >= lens.top + lens.height) return;
      retained.add(el);
      if (!clipped.has(el)) clipped.set(el, {clip: el.style.clipPath, webkit: el.style.webkitClipPath, rule: el.style.clipRule, webkitRule: el.style.webkitClipRule});
      const value = cutout(rect, lens, radius);
      if (el.style.clipPath !== value) el.style.clipPath = value;
      if (el.style.webkitClipPath !== value) el.style.webkitClipPath = value;
      el.style.clipRule = "evenodd";
      el.style.webkitClipRule = "evenodd";
    });
    clipped.forEach((previous, el) => { if (!retained.has(el)) { restore(el, previous); clipped.delete(el); } });
    // Our own clip-path writes are not changes to the text.
    if (observer) observer.takeRecords();
  }

  return {
    prepare,
    commit,
    clear,
    /** Stop observing the container and restore the DOM. */
    destroy: () => { clear(); unwatch(); },
    /** Re-read the text on the next prepare (for style changes the underlay cannot observe). */
    invalidate: () => { dirty = true; },
    beginFrame: () => { touched = false; },
    endFrame: () => { if (!touched) clear(); },
    testing: {cutout, textSignature}
  };
}
