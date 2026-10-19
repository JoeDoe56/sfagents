/**
 * WebGL context creation and capability detection.
 * WebGL2 is preferred; WebGL1 is supported with or without
 * EXT_shader_texture_lod and OES_standard_derivatives.
 * @module
 */

const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'default',
});

/**
 * @typedef {object} GLCaps
 * @property {boolean} webgl2
 * @property {'lod'|'ext'|'bias'} lodMode  how explicit mip levels are sampled
 * @property {boolean} derivatives
 * @property {boolean} highp
 * @property {number} maxTextureSize
 * @property {any} timer               timer-query extension or null
 * @property {any} parallelCompile     KHR_parallel_shader_compile or null
 * @property {any} loseContext         WEBGL_lose_context or null
 * @property {string} renderer
 * @property {boolean} software        software rasteriser (SwiftShader, llvmpipe…)
 */

/**
 * Create a WebGL context on a canvas.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {{webgl2?: boolean}} [options]
 * @returns {{gl: WebGLRenderingContext|WebGL2RenderingContext, caps: GLCaps}|null}
 */
export function createContext(canvas, options = {}) {
  /** @type {WebGLRenderingContext|WebGL2RenderingContext|null} */
  let gl = null;
  if (options.webgl2 !== false) {
    try { gl = /** @type {WebGL2RenderingContext|null} */ (canvas.getContext('webgl2', CONTEXT_ATTRIBUTES)); } catch (e) { gl = null; }
  }
  if (!gl) {
    try { gl = canvas.getContext('webgl', CONTEXT_ATTRIBUTES) || /** @type {any} */ (canvas).getContext('experimental-webgl', CONTEXT_ATTRIBUTES); } catch (e) { gl = null; }
  }
  if (!gl) return null;
  return {gl, caps: readCaps(gl)};
}

/**
 * Read capabilities from an existing context.
 * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
 * @returns {GLCaps}
 */
export function readCaps(gl) {
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const lodExt = webgl2 ? null : gl.getExtension('EXT_shader_texture_lod');
  const derivatives = webgl2 || !!gl.getExtension('OES_standard_derivatives');
  let highp = true;
  try {
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    highp = !!(precision && precision.precision > 0);
  } catch (e) { /* assume highp */ }
  let renderer = '';
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
  } catch (e) { renderer = ''; }
  return {
    webgl2,
    lodMode: webgl2 ? 'lod' : (lodExt ? 'ext' : 'bias'),
    derivatives,
    highp,
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
    timer: gl.getExtension(webgl2 ? 'EXT_disjoint_timer_query_webgl2' : 'EXT_disjoint_timer_query'),
    parallelCompile: gl.getExtension('KHR_parallel_shader_compile'),
    loseContext: gl.getExtension('WEBGL_lose_context'),
    renderer,
    software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer),
  };
}

/**
 * Probe what this browser can do without keeping a context alive.
 * @param {Document} [doc]
 * @returns {GLCaps|null}
 */
export function probe(doc = globalThis.document) {
  if (!doc) return null;
  const canvas = doc.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const created = createContext(canvas);
  if (!created) return null;
  const caps = created.caps;
  try { if (caps.loseContext) caps.loseContext.loseContext(); } catch (e) { /* ignore */ }
  return caps;
}

/**
 * Compile and link a program. Throws with the driver log on failure.
 * @param {WebGLRenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 * @param {Record<string, number>} [attributes] attribute name → location
 */
export function createProgram(gl, vertexSource, fragmentSource, attributes = {a_position: 0}) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  Object.entries(attributes).forEach(([name, location]) => gl.bindAttribLocation(program, location, name));
  gl.linkProgram(program);
  return {program, vs, fs};
}

/**
 * Finish a program created with createProgram; returns null while a parallel
 * compile is still running, throws on failure.
 * @param {WebGLRenderingContext} gl
 * @param {{program: WebGLProgram, vs: WebGLShader, fs: WebGLShader}} pending
 * @param {any} [parallel] KHR_parallel_shader_compile
 */
export function finishProgram(gl, pending, parallel) {
  if (parallel && !gl.getProgramParameter(pending.program, parallel.COMPLETION_STATUS_KHR)) return null;
  if (!gl.getProgramParameter(pending.program, gl.LINK_STATUS)) {
    const detail = gl.getShaderInfoLog(pending.fs) || gl.getShaderInfoLog(pending.vs) || gl.getProgramInfoLog(pending.program) || 'unknown error';
    throw new Error('sfgl: shader failed: ' + detail);
  }
  gl.deleteShader(pending.vs);
  gl.deleteShader(pending.fs);
  const uniforms = new Map();
  const count = gl.getProgramParameter(pending.program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(pending.program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    uniforms.set(name, {location: gl.getUniformLocation(pending.program, info.name), type: info.type, size: info.size});
  }
  return {program: pending.program, uniforms, cache: new Map()};
}

/**
 * Upload a uniform value, skipping the call when the value is unchanged.
 * Numbers, booleans, arrays and typed arrays are accepted; the GL type of the
 * active uniform decides the call.
 * @param {WebGLRenderingContext} gl
 * @param {{uniforms: Map<string, {location: WebGLUniformLocation, type: number, size: number}>, cache: Map<string, any>}} info
 * @param {string} name
 * @param {any} value
 */
export function setUniform(gl, info, name, value) {
  const uniform = info.uniforms.get(name);
  if (!uniform || value === undefined || value === null) return;
  const {location, type, size} = uniform;
  const cache = info.cache;
  const previous = cache.get(name);
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (previous === value) return;
    cache.set(name, value);
    const n = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    if (type === gl.FLOAT) gl.uniform1f(location, n);
    else gl.uniform1i(location, n);
    return;
  }
  const array = value instanceof Float32Array || value instanceof Int32Array ? value : Float32Array.from(value);
  if (previous && previous.length === array.length) {
    let same = true;
    for (let i = 0; i < array.length; i++) if (previous[i] !== array[i]) { same = false; break; }
    if (same) return;
  }
  cache.set(name, Float32Array.from(array));
  switch (type) {
    case gl.FLOAT: gl.uniform1fv(location, array); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(location, array); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(location, array); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(location, array); break;
    case gl.FLOAT_MAT4: gl.uniformMatrix4fv(location, false, array); break;
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(location, false, array); break;
    case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: gl.uniform1iv(location, Int32Array.from(array)); break;
    default: if (size > 1) gl.uniform1fv(location, array); break;
  }
}

/**
 * Smallest power of two ≥ value, capped.
 * @param {number} value @param {number} cap
 */
export function nextPowerOfTwo(value, cap) {
  return Math.min(cap, Math.pow(2, Math.ceil(Math.log2(Math.max(2, value)))));
}
