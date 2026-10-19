/**
 * Press/touch contact tracking for the glow under a finger or pressed mouse.
 * Listens in the capture phase so controls that stop propagation while they
 * own a gesture cannot hide a press or release, and follows the touch stream
 * when native scrolling cancels the pointer stream.
 * @module
 */

/**
 * @param {{window?: Window}} [env]
 */
export function createContactTracker(env = {}) {
  const win = env.window || globalThis.window;
  const state = {x: -100000, y: -100000, down: false, pointerDown: false, touchId: null};
  const listeners = new Set();
  let attached = false;

  const notify = () => {
    state.down = state.pointerDown || state.touchId !== null;
    listeners.forEach((fn) => { try { fn(state); } catch (e) { /* listener errors stay local */ } });
  };
  const update = (event) => {
    if (state.touchId === null) {
      if (Number.isFinite(event.clientX)) state.x = event.clientX;
      if (Number.isFinite(event.clientY)) state.y = event.clientY;
    }
    if (event.type === 'pointerdown') state.pointerDown = true;
    if (event.type === 'pointerup' || event.type === 'pointercancel' || event.type === 'blur') state.pointerDown = false;
    if (event.type === 'blur') state.touchId = null;
    if (event.type === 'pointermove' && !state.down) return;
    notify();
  };
  const updateTouch = (event) => {
    const touches = event.touches || [];
    let touch = null;
    for (let i = 0; i < touches.length; i++) if (touches[i].identifier === state.touchId) touch = touches[i];
    if (!touch && touches.length) touch = touches[0];
    if (touch) {
      state.touchId = touch.identifier;
      state.x = touch.clientX;
      state.y = touch.clientY;
    } else {
      state.touchId = null;
      state.pointerDown = false;
    }
    notify();
  };

  function attach() {
    if (attached || !win || !win.addEventListener) return;
    attached = true;
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'blur'].forEach((name) =>
      win.addEventListener(name, update, {passive: true, capture: true}));
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((name) =>
      win.addEventListener(name, updateTouch, {passive: true, capture: true}));
  }
  function detach() {
    if (!attached) return;
    attached = false;
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'blur'].forEach((name) =>
      win.removeEventListener(name, update, {capture: true}));
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((name) =>
      win.removeEventListener(name, updateTouch, {capture: true}));
  }

  return {
    state,
    /** @param {(state: typeof state) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      attach();
      return () => { listeners.delete(fn); if (!listeners.size) detach(); };
    },
  };
}

/**
 * Per-lens press smoothing: eases 0..1 towards whether the contact is down
 * inside the lens rect, frame-rate independently.
 * @param {{press:number,time:number,x:number,y:number}|undefined} previous
 * @param {{x:number,y:number,down:boolean}} contact
 * @param {{left:number,top:number,width:number,height:number}|null} rect
 * @param {number} now
 * @param {boolean} reducedMotion
 */
export function stepContact(previous, contact, rect, now, reducedMotion) {
  const state = previous || {press: 0, time: now, x: 0.5, y: 0.5};
  const inside = !!rect && contact.x >= rect.left && contact.x <= rect.left + rect.width && contact.y >= rect.top && contact.y <= rect.top + rect.height;
  const target = inside && contact.down ? 1 : 0;
  if (inside) {
    state.x = (contact.x - rect.left) / Math.max(1, rect.width);
    state.y = 1 - (contact.y - rect.top) / Math.max(1, rect.height);
  }
  const elapsed = Math.max(1, Math.min(64, now - state.time));
  state.press += (target - state.press) * (reducedMotion ? 1 : 1 - Math.exp(-elapsed / 55));
  state.time = now;
  const settled = Math.abs(target - state.press) < 0.005;
  if (settled) state.press = target;
  return {state, settled};
}
