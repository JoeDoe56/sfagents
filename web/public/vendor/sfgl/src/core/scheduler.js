/**
 * Frame scheduler. It runs one-shot jobs, persistent tasks ordered by phase,
 * and the work flags that renderers read each frame.
 */

/**
 * Phases a persistent task can run in. Within one frame, tasks run in this
 * order. Tasks in the same phase run in registration order.
 */
const PHASES = ["input", "measure", "animate", "write", "render"];
const DEFAULT_PHASE = "animate";

/**
 * @typedef {object} FrameState
 * @property {number} time Frame timestamp from requestAnimationFrame.
 * @property {number} timestamp Same as `time`.
 * @property {number} delta Milliseconds since the previous frame.
 * @property {Record<string, boolean>} flags Work flags consumed for this frame.
 * @property {number} qualityBias Quality factor between 0.55 and 1.
 * @property {boolean} hidden Whether the document was hidden.
 * @property {number} frameCount Frames run since creation.
 * @property {number} longFrames Frames whose delta exceeded 34 ms.
 * @property {string} [key] Key of the job or task being run.
 */

/**
 * Host globals used by the scheduler. Each entry defaults to the matching
 * global when it is not supplied.
 *
 * @typedef {object} SchedulerEnv
 * @property {Document} [document] Source of `document.hidden`.
 * @property {Window} [window] Accepted for symmetry with the other modules; the scheduler does not read it.
 * @property {(callback: (time: number) => void) => number} [requestAnimationFrame]
 * @property {(id: number) => void} [cancelAnimationFrame]
 */

/**
 * @typedef {object} RegisterOptions
 * @property {boolean} [persistent=true] When false, the task is removed after a run
 *   that throws or does not return `true`.
 * @property {"input" | "measure" | "animate" | "write" | "render"} [phase="animate"]
 */

/**
 * Creates a frame scheduler with its own queues and state.
 *
 * @param {SchedulerEnv} [env={}]
 * @returns {{
 *   request: (key: string, fn: (frame: FrameState) => void) => void,
 *   cancel: (key: string) => void,
 *   mark: (flags?: string | Record<string, boolean>) => void,
 *   requestWork: (flags?: string | Record<string, boolean>) => void,
 *   register: (key: string, fn: (frame: FrameState) => boolean | void, options?: RegisterOptions) => void,
 *   unregister: (key: string) => void,
 *   hasPending: () => boolean,
 *   destroy: () => void,
 *   isRunning: () => boolean,
 *   stats: () => {frameCount: number, longFrames: number, fps: number, qualityBias: number, pending: boolean, tasks: number}
 * }}
 */
export function createScheduler(env = {}) {
  const doc = env.document || globalThis.document;
  const raf = env.requestAnimationFrame || globalThis.requestAnimationFrame;
  const caf = env.cancelAnimationFrame || globalThis.cancelAnimationFrame;
  const oneShotJobs = new Map();
  const tasks = new Map();
  const work = {
    refreshSources: false,
    metrics: false,
    render: false,
    textContrast: false,
    keepAlive: false
  };
  let frame = 0;
  let running = false;
  let lastTime = 0;
  let longFrames = 0;
  let frameCount = 0;
  let qualityBias = 1;
  const frameSamples = [];

  // A frame that runs while the page is hidden does not schedule the next
  // one; pick the pending work up again when the page is shown.
  const onVisibility = () => { if (!doc.hidden && hasWork()) schedule(); };
  if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisibility);

  function phaseRank(task) {
    return PHASES.indexOf(task.phase);
  }

  function request(key, fn) {
    if (typeof fn !== "function") return;
    oneShotJobs.set(String(key || "default"), fn);
    schedule();
  }

  function cancel(key) {
    oneShotJobs.delete(String(key || "default"));
    tasks.delete(String(key || "default"));
    if (!oneShotJobs.size && !tasks.size && !hasWork() && frame) {
      caf(frame);
      frame = 0;
      lastTime = 0;
    }
  }

  function hasWork() {
    return work.refreshSources || work.metrics || work.render || work.textContrast || work.keepAlive || oneShotJobs.size || tasks.size;
  }

  function schedule() {
    if (frame || running) return;
    frame = raf(runFrame);
  }

  function mark(flags) {
    if (typeof flags === "string") work[flags] = true;
    else if (flags && typeof flags === "object") {
      Object.keys(flags).forEach((key) => { if (flags[key]) work[key] = true; });
    } else {
      work.render = true;
    }
    schedule();
  }

  function register(key, fn, options) {
    if (typeof fn !== "function") return;
    const phase = PHASES.includes(options && options.phase) ? options.phase : DEFAULT_PHASE;
    tasks.set(String(key || "default"), {fn, phase, options: Object.assign({persistent: true}, options || {})});
    schedule();
  }

  function unregister(key) {
    tasks.delete(String(key || "default"));
  }

  function consumeWork() {
    const snapshot = Object.assign({}, work);
    work.refreshSources = false;
    work.metrics = false;
    work.render = false;
    work.textContrast = false;
    work.keepAlive = false;
    return snapshot;
  }

  function runFrame(ts) {
    frame = 0;
    running = true;
    const delta = lastTime ? Math.max(0, ts - lastTime) : 16.7;
    lastTime = ts;
    frameCount += 1;
    frameSamples.push(ts);
    while (frameSamples.length && ts - frameSamples[0] > 1000) frameSamples.shift();
    if (delta > 34) longFrames += 1;
    if (delta > 24) qualityBias = Math.max(0.55, qualityBias * 0.92);
    else if (delta < 18) qualityBias = Math.min(1, qualityBias + 0.015);
    const flags = consumeWork();
    const frameState = {
      time: ts,
      timestamp: ts,
      delta,
      flags,
      qualityBias,
      hidden: !!doc.hidden,
      frameCount,
      longFrames
    };
    const run = Array.from(oneShotJobs.entries());
    oneShotJobs.clear();
    for (const entry of run) {
      try { entry[1](Object.assign({key: entry[0]}, frameState)); } catch (e) {}
    }
    // Geometry jobs run before rendering. Their work belongs to this paint,
    // not a second RAF where glass would trail the DOM by one frame.
    const sameFrameWork = consumeWork();
    Object.keys(sameFrameWork).forEach(key => { if (sameFrameWork[key]) flags[key] = true; });
    // Array.prototype.sort is stable, so equal phases keep insertion order.
    const taskRun = Array.from(tasks.entries()).sort((a, b) => phaseRank(a[1]) - phaseRank(b[1]));
    for (const entry of taskRun) {
      const task = entry[1];
      try {
        const keep = task.fn(Object.assign({key: entry[0]}, frameState));
        if (task.options && task.options.persistent === false && keep !== true) tasks.delete(entry[0]);
      } catch (e) {
        if (task.options && task.options.persistent === false) tasks.delete(entry[0]);
      }
    }
    running = false;
    if (!doc.hidden && (work.keepAlive || work.render || work.metrics || work.refreshSources || work.textContrast || oneShotJobs.size)) {
      schedule();
    } else {
      // Going idle: the next frame after idle must start from the default delta, not a stale timestamp.
      lastTime = 0;
    }
  }

  return {
    request,
    cancel,
    mark,
    requestWork: mark,
    register,
    unregister,
    hasPending: function() { return !!frame; },
    /** Cancel the pending frame, drop all jobs and tasks, and stop listening. */
    destroy: function() {
      if (frame) caf(frame);
      frame = 0;
      oneShotJobs.clear();
      tasks.clear();
      if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisibility);
    },
    isRunning: function() { return running; },
    stats: function() {
      const fps = frameSamples.length > 1 ? (frameSamples.length - 1) * 1000 / Math.max(1, frameSamples[frameSamples.length - 1] - frameSamples[0]) : 0;
      return {frameCount, longFrames, fps, qualityBias, pending: !!frame, tasks: tasks.size};
    }
  };
}
