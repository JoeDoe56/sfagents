/**
 * Glass light direction from device orientation, with the pointer as the
 * alternative on devices that do not tilt.
 */

/**
 * Host settings and hooks. Numeric settings and `storageKey` may be functions
 * that are read on every use, so the host can change them at runtime.
 *
 * @typedef {object} LightingOptions
 * @property {number | (() => number)} [fps=60] Frame rate cap, clamped to 30 through 120.
 * @property {number | (() => number)} [multiplier=1] Scales device light strength, clamped to 0 through 2.
 * @property {{getItem: (key: string) => string | null, setItem: (key: string, value: string) => void} | null} [storage]
 *   Where the orientation permission result is remembered.
 * @property {string | (() => string)} [storageKey="liquid-glass:orientation-permission"]
 * @property {() => void} [onChange] Called on each frame where the light is rendered.
 */

/**
 * Host globals. Each entry defaults to the matching global when it is not supplied.
 *
 * @typedef {object} LightingEnv
 * @property {Window} [window]
 * @property {Document} [document]
 * @property {(callback: (time: number) => void) => number} [requestAnimationFrame]
 * @property {(id: number) => void} [cancelAnimationFrame]
 * @property {Performance} [performance]
 */

/**
 * @typedef {object} LightState
 * @property {number} x
 * @property {number} y
 * @property {number} intensity
 * @property {"default" | "pointer" | "orientation"} source
 */

/**
 * Creates a glass lighting controller and attaches its pointer and
 * orientation listeners to the environment.
 *
 * @param {LightingOptions} [options={}]
 * @param {LightingEnv} [env={}]
 * @returns {{
 *   state: () => LightState,
 *   status: () => "Active" | "Denied" | "Waiting for motion",
 *   requestOrientationPermission: (retry?: boolean) => Promise<"granted" | "denied" | "unknown">,
 *   destroy: () => void,
 *   testing: object
 * }}
 */
export function createLighting(options = {}, env = {}) {
  const win = env.window || globalThis.window;
  const doc = env.document || globalThis.document;
  const raf = env.requestAnimationFrame || globalThis.requestAnimationFrame;
  const cancelFrame = env.cancelAnimationFrame || globalThis.cancelAnimationFrame;
  const perf = env.performance || globalThis.performance;
  /** @type {LightState} */
  const neutral = {x: -0.16, y: -0.22, intensity: 0.22, source: "default"};
  // Pointer and device tilt drive the same light at the same strength, so a
  // computer's mouse reaches every rim the way tilting a phone does.
  const activeIntensity = 0.95;
  const pointerGain = 0.9;
  const light = Object.assign({}, neutral);
  let target = Object.assign({}, neutral);
  let frame = 0;
  let lastFrameAt = 0;
  let orientationAttached = false;
  let orientationActive = false;
  let permissionRequested = false;
  let orientationOrigin = null;
  /** @type {(() => void) | null} */
  let armedRequest = null;

  function clamp(value, low, high) { return Math.max(low, Math.min(high, Number(value) || 0)); }
  function setting(name, fallback) {
    try {
      const value = typeof options[name] === "function" ? options[name]() : options[name];
      return value === undefined || value === null ? fallback : value;
    } catch (e) { return fallback; }
  }
  function permissionKey() { return String(setting("storageKey", "liquid-glass:orientation-permission")); }
  function storedPermission() {
    try {
      const storage = options.storage;
      const value = String(storage && storage.getItem(permissionKey()) || "");
      return value === "granted" || value === "denied" ? value : "unknown";
    } catch (e) { return "unknown"; }
  }
  function savePermission(value) {
    try { if (options.storage) options.storage.setItem(permissionKey(), value); } catch (e) {}
  }
  function currentFps() {
    const raw = Number(setting("fps", 60));
    return Math.max(30, Math.min(120, Number.isFinite(raw) ? raw : 60));
  }
  function motionEffectMultiplier() {
    const raw = Number(setting("multiplier", 1));
    return Number.isFinite(raw) ? clamp(raw, 0, 2) : 1;
  }
  function markGlassFrame() {
    try { if (typeof options.onChange === "function") options.onChange(); } catch (e) {}
  }
  function schedule() {
    if (frame || doc.hidden) return;
    frame = raf(step);
  }
  function setTarget(x, y, intensity, source) {
    target = {
      x: clamp(x, -1, 1),
      y: clamp(y, -1, 1),
      intensity: clamp(intensity, 0, 1),
      source: source === "orientation" || source === "pointer" ? source : "default"
    };
    schedule();
  }
  function compressLightVector(x, y) {
    const radius = Math.hypot(x, y);
    const limit = 0.8;
    if (!Number.isFinite(radius) || radius <= limit) return {x, y};
    // Preserve the diagonal direction while easing the vector into the
    // allowed circle. Independent x/y clamping turns diagonal motion into a
    // cardinal snap when the phone is rotated far enough.
    const headroom = 1 - limit;
    const compressed = limit + headroom * (1 - Math.exp(-(radius - limit) / headroom));
    const factor = compressed / radius;
    return {x: x * factor, y: y * factor};
  }
  function step(timestamp) {
    frame = 0;
    const now = Number(timestamp || perf.now() || Date.now());
    const interval = 1000 / currentFps();
    if (lastFrameAt && now - lastFrameAt < interval - 1) { schedule(); return false; }
    const elapsed = lastFrameAt ? Math.max(1, now - lastFrameAt) : interval;
    lastFrameAt = now;
    const smoothing = 1 - Math.exp(-elapsed / 45);
    light.x += (target.x - light.x) * smoothing;
    light.y += (target.y - light.y) * smoothing;
    light.intensity += (target.intensity - light.intensity) * smoothing;
    light.source = target.source;
    const moving = Math.abs(target.x - light.x) > 0.002 || Math.abs(target.y - light.y) > 0.002 || Math.abs(target.intensity - light.intensity) > 0.002;
    markGlassFrame();
    if (moving) schedule();
    else lastFrameAt = 0; // A new movement must not include time spent idle.
    return moving;
  }
  function resetPointerLight() {
    if (!orientationActive) setTarget(neutral.x, neutral.y, neutral.intensity, "default");
  }
  // The pointer stands in for device tilt: the centre of the window is the
  // resting direction and the edges sweep the light around the full circle.
  // The light holds where the pointer stops and eases back to neutral only
  // when the pointer leaves the window.
  function pointerMove(event) {
    if (orientationActive || !event) return;
    const width = Math.max(1, win.innerWidth || 1);
    const height = Math.max(1, win.innerHeight || 1);
    const clientX = Number.isFinite(Number(event.clientX)) ? Number(event.clientX) : width / 2;
    const clientY = Number.isFinite(Number(event.clientY)) ? Number(event.clientY) : height / 2;
    const dx = clamp((clientX / width - 0.5) * 2, -1, 1) * pointerGain;
    const dy = clamp((clientY / height - 0.5) * 2, -1, 1) * pointerGain;
    const projected = compressLightVector(neutral.x + dx, neutral.y + dy);
    setTarget(projected.x, projected.y, activeIntensity, "pointer");
  }
  function pointerLeftWindow(event) {
    if (event && event.relatedTarget) return;
    resetPointerLight();
  }
  // W3C device orientation uses Rz(alpha) * Rx(beta) * Ry(gamma).
  // Reconstruct the physical basis before comparing poses: individual Euler
  // angles can exchange values at vertical without any real phone movement.
  function orientationMatrix(alpha, beta, gamma) {
    const a = alpha * Math.PI / 180, b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    return [ca * cg - sa * sb * sg, -cb * sa, cg * sa * sb + ca * sg,
      cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb,
      -cb * sg, sb, cb * cg];
  }
  function orientationChange(event) {
    if (!event || event.beta == null || event.gamma == null) return;
    const beta = Number(event && event.beta);
    const gamma = Number(event && event.gamma);
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return;
    const alpha = Number(event.alpha);
    const matrix = orientationMatrix(Number.isFinite(alpha) ? alpha : 0, beta, gamma);
    if (!orientationOrigin) orientationOrigin = {x: matrix[2], y: matrix[5], z: matrix[8]};
    const angle = Number(win.screen && win.screen.orientation && win.screen.orientation.angle || win.orientation || 0) * Math.PI / 180;
    const multiplier = motionEffectMultiplier();
    // Project the initial screen normal into the current phone frame. This
    // gives continuous local tilt whether the initial phone pose is flat or
    // upright, including alpha/gamma exchanges and angle wraparound.
    const sensorScale = 1.15;
    const dx = -(matrix[0] * orientationOrigin.x + matrix[3] * orientationOrigin.y + matrix[6] * orientationOrigin.z) * sensorScale * multiplier;
    const dy = (matrix[1] * orientationOrigin.x + matrix[4] * orientationOrigin.y + matrix[7] * orientationOrigin.z) * sensorScale * multiplier;
    const wasActive = orientationActive;
    orientationActive = true;
    const projected = compressLightVector(
      neutral.x + dx * Math.cos(angle) + dy * Math.sin(angle),
      neutral.y + dy * Math.cos(angle) - dx * Math.sin(angle)
    );
    // Sensor noise on a steady phone stays inside this dead-band. Skipping the
    // target write keeps the renderer idle until the pose really moves.
    if (wasActive && target.source === "orientation" &&
        Math.abs(projected.x - target.x) < 0.004 && Math.abs(projected.y - target.y) < 0.004) return;
    setTarget(projected.x, projected.y, activeIntensity, "orientation");
  }
  function attachOrientation() {
    if (orientationAttached || !win.addEventListener) return;
    orientationAttached = true;
    win.addEventListener("deviceorientation", orientationChange, {passive: true});
  }
  /**
   * @param {boolean} [retry]
   * @returns {Promise<"granted" | "denied" | "unknown">}
   */
  function requestOrientationPermission(retry) {
    const eventType = /** @type {any} */ (win).DeviceOrientationEvent;
    if (!eventType || typeof eventType.requestPermission !== "function") {
      attachOrientation();
      return Promise.resolve("granted");
    }
    const stored = storedPermission();
    if (stored === "granted") {
      attachOrientation();
      if (orientationActive) return Promise.resolve("granted");
    }
    if (retry === true && stored === "denied") {
      permissionRequested = false;
      savePermission("unknown");
    }
    if (stored === "denied" && retry !== true) return Promise.resolve("denied");
    if (permissionRequested) return Promise.resolve(stored);
    permissionRequested = true;
    let request;
    try { request = eventType.requestPermission(); }
    catch (e) { permissionRequested = false; return Promise.resolve("unknown"); }
    return Promise.resolve(request).then((result) => {
      const value = result === "granted" ? "granted" : result === "denied" ? "denied" : "unknown";
      if (value !== "unknown") savePermission(value);
      if (value === "granted") attachOrientation();
      if (value === "unknown") permissionRequested = false;
      return value;
    }).catch(() => {
      // A missing user activation is not a user denial. Retry on a valid gesture.
      permissionRequested = false;
      return "unknown";
    });
  }
  function armOrientationPermission() {
    const eventType = /** @type {any} */ (win).DeviceOrientationEvent;
    if (!eventType) return;
    if (typeof eventType.requestPermission !== "function") {
      attachOrientation();
      return;
    }
    const stored = storedPermission();
    if (stored === "denied") return;
    if (stored === "granted") {
      attachOrientation();
    }
    const requestOnce = armedRequest = () => {
      requestOrientationPermission().then(result => {
        if (result === "unknown") return;
        ["click", "touchend", "keydown"].forEach(name => doc.removeEventListener(name, requestOnce, true));
      });
    };
    ["click", "touchend", "keydown"].forEach(name => doc.addEventListener(name, requestOnce, {capture: true, passive: true}));
  }
  function init() {
    armOrientationPermission();
    if (win.addEventListener) {
      // Capture phase: controls such as the wheel stop pointermove from
      // bubbling while they own a drag, and the light must keep following.
      win.addEventListener("pointermove", pointerMove, {passive: true, capture: true});
      win.addEventListener("blur", resetPointerLight, {passive: true});
    }
    if (doc.addEventListener) doc.addEventListener("mouseout", pointerLeftWindow, {passive: true});
  }

  // Remove every listener and stop the smoothing loop.
  function destroy() {
    if (frame && cancelFrame) cancelFrame(frame);
    frame = 0;
    if (win.removeEventListener) {
      win.removeEventListener("pointermove", pointerMove, {capture: true});
      win.removeEventListener("blur", resetPointerLight);
      win.removeEventListener("deviceorientation", orientationChange);
    }
    orientationAttached = false;
    if (doc.removeEventListener) {
      doc.removeEventListener("mouseout", pointerLeftWindow);
      ["click", "touchend", "keydown"].forEach(name => doc.removeEventListener(name, armedRequest, true));
    }
  }

  init();
  return {
    destroy,
    state: () => ({x: light.x, y: light.y, intensity: light.intensity, source: light.source}),
    status: () => orientationActive ? "Active" : storedPermission() === "denied" ? "Denied" : "Waiting for motion",
    requestOrientationPermission,
    testing: {permissionKey, storedPermission, setTarget, pointerMove, pointerLeftWindow, orientationChange, step, isAnimating: () => !!frame}
  };
}
