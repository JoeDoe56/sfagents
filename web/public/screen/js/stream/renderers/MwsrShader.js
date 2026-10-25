/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * MwsrShader — the texts of `mwsr`, MoonlightWeb's own upscaler
 * (docs/design/upscaler-mwsr.md, §3 and §4): one WGSL source per mode,
 * specialised by `override` constants, the input feed substituted in its
 * preamble; and the GLSL ES 3.00 twin of each (mwsrGlsl, plan §3.6), written
 * from the same tables of constants so that the two texts cannot drift
 * apart, which the laboratory's conformity flow holds to 2/255 (C11).
 *
 * Two modes (plan §4.3), chosen per frame by mwsrRegime():
 *
 * `up` — the kernel, per output pixel (plan §3.2):
 *   1. one bilinear sample C at the pixel's position in the input, its luma;
 *   2. the vote: the screen derivatives of that luma, scaled to luma per input
 *      texel, decide per 2×2 quad whether the pixel sits on an edge; a flat
 *      quad returns C — one sample, a dozen operations;
 *   3. on an edge, four more bilinear samples, laid along and across the edge
 *      the derivatives measure: the along pair smooths the staircase, the
 *      across pair sharpens the ramp;
 *   4. a coherence term (a step or a ridge across, against all the variation
 *      around) doses both, so that grain, texture and compression blocks are
 *      left alone; the whole fades to C near 1:1;
 *   5. the result is bounded by the min and max of the five samples, then by
 *      the four input texels around the pixel.
 *   With CHROMA444 (4:4:4 streams, plan §4.2) the vote, the coherence and the
 *   weights are taken per channel, so that a border between two colours of one
 *   luma is seen and sharpened too.
 *
 * `down` — the surface filter: a k×k grid of bilinear samples spread over the
 *   output pixel's footprint in the input (k by the scale, the grid's span
 *   R_DOWN with it), averaged in linear light: the decisive term, +2.5 to
 *   +12 dB against the host's Lanczos in the lab (P3). The light is best made
 *   by the hardware: read through an `-srgb` view and drawn into one, the
 *   sampler decodes before it filters and the target encodes on write
 *   (LINEAR_LIGHT 0: free, exact). Then one bilinear sample is the whole
 *   filter between ×0.5 and 1:1 (k = 1: the exact box at ×0.5; at ×0.75, +4 dB
 *   and half the FLIP of the gamma-space bilinear, at its cost, J15), and the
 *   3×3 and 4×4 grids serve below ×0.5 with five times less aliasing energy
 *   than in software light (J15). Without the views (an rgba16float feed)
 *   LINEAR_LIGHT 1 decodes each sample by a square (2: exact sRGB, three times
 *   the cost on the 780M) and the 2×2 grid serves between ×0.5 and 1:1 (J12).
 *   No vote, no sharpening: a reduction sharpens by itself.
 *
 * HDR (plan §4.1): the renderer's `linear` feed is sRGB-encoded past 1.0
 * (1.0 = reference white); both modes are per channel, bounded by their own
 * samples and clamp nothing to 1.0, so they run on it unchanged.
 *
 * Written from scratch (plan §10.2). Ideas taken, and credited: bilinear taps
 * instead of gathers (Atyuwen's mobile EASU, Jimenez, MJP); the early out on
 * an edge vote (SGSR1, NEDI); the local min/max bound against ringing (EASU,
 * SGSR1); sharpening held by the local range (CAS, RCAS). The vote by screen
 * derivatives and the taps laid along the measured edge are this project's.
 * No line, polynomial or constant of FSR1, SGSR1, NIS or the gist is
 * reproduced; the constants come from the laboratory
 * (scripts/bench/scaler-lab/journal.md), the test file checks the forbidden
 * ones never creep in.
 */

/**
 * The pipeline-overridable constants, with their type and the default the
 * WGSL text declares. A renderer sets them at pipeline creation
 * (`fragment.constants`), the laboratory per cell (`mwsr:dering=0;...`).
 * Every text declares them all; each mode reads its own.
 */
export const MWSR_OVERRIDE_SPEC = Object.freeze({
    /** 1: paint the vote (white = edge quad, black = flat) instead of the picture. */
    SHOW: ['u32', 0],
    /** Weight of each tap along the edge, at full coherence and strength. */
    W_ALONG: ['f32', 0.15],
    /** Weight of each tap across the edge, negated and × sharpness. */
    W_ACROSS: ['f32', 0.3],
    /** Distance of the along taps, input texels. */
    R_ALONG: ['f32', 0.5],
    /** Distance of the across taps, input texels. */
    R_ACROSS: ['f32', 1.0],
    /** The scale (output / input) from which the kernel is at full strength; 0 at 1:1. */
    S_FULL: ['f32', 1.5],
    /** The most negative weight of an across tap: the blend's divisor stays >= 1 + 2 W_MIN. */
    W_MIN: ['f32', -0.3],
    /** 1: bound the result by the four input texels around the pixel (four loads, edge path only). */
    DERING: ['u32', 1],
    /** 1: the vote, the coherence and the weights per channel (4:4:4 streams); 0: from the luma, shared by the channels. */
    CHROMA444: ['u32', 0],
    /** Reduction: the span of the tap grid, as a fraction of the pixel's footprint in the input (mwsrRegime() sets it by the grid). */
    R_DOWN: ['f32', 1.0],
    /** Reduction: 0 average the encoded values; 1 in gamma-2 light (square, square root); 2 in sRGB linear light (≤ 0.35 dB better, 15 pow per pixel). */
    LINEAR_LIGHT: ['u32', 1],
});

/** The defaults alone, name → value. */
export const MWSR_OVERRIDES = Object.freeze(
    Object.fromEntries(Object.entries(MWSR_OVERRIDE_SPEC).map(([k, [, v]]) => [k, v])),
);

/** Constants shared by the WGSL text and, later, its GLSL twin. */
export const MWSR_CONSTANTS = Object.freeze({
    /** Luma weights: Rec. 709 rounded to powers of two, two multiply-adds. */
    LUMA: [0.25, 0.625, 0.125],
    /** Guards the divisions by a variation of luma. */
    EPS: 1e-5,
});

/** The per-draw values of the uniform block: the vote threshold (luma per
 *  input texel) and the sharpness (× W_ACROSS). */
export const MWSR_UNIFORMS = Object.freeze({ tau: 0.05, sharp: 1.0 });

/** Number of f32 in the uniform block: texel.xy, scale.xy, tau, sharp, pad.xy. */
export const MWSR_UNIFORM_FLOATS = 8;

/**
 * The reduction's tap grids when the light is software's (LINEAR_LIGHT 1 or
 * 2), by the smallest scale (output / input) they serve: [minimum scale, taps,
 * R_DOWN]. A 2×2 grid of bilinear samples spread over the footprint is the
 * exact box average at ×0.5 (plan §4.3); below ×0.5 the 3×3 grid, spread a
 * quarter wider than the footprint, took +2.7 dB on text and 40 % off the
 * moiré of the zone plate in the lab (P3, journal J12); the 4×4 grid below
 * ×0.25 is the plan's, unmeasured.
 */
export const MWSR_DOWN_TAPS = Object.freeze([
    [0.5, 4, 1.0],
    [0.25, 9, 1.25],
    [0, 16, 1.25],
]);

/**
 * The grids through sRGB views (the sampler decodes, the target encodes,
 * LINEAR_LIGHT 0): one bilinear sample is the filter down to ×0.5, where it is
 * the exact box average, at the cost of the renderer's plain copy (J15: at
 * ×0.75, 30.2 dB against the host's Lanczos-2 on text and half the FLIP of
 * the gamma-space bilinear, where the 2×2 grids reach 27 to 29 dB); below
 * ×0.5 the same 3×3 and 4×4 grids as above.
 */
export const MWSR_DOWN_TAPS_SRGB = Object.freeze([
    [0.5, 1, 1.0],
    [0.25, 9, 1.25],
    [0, 16, 1.25],
]);

/**
 * Which text a frame of inW×inH drawn at outW×outH takes: 'copy' at exactly
 * 1:1 (the renderer copies, plan §5), 'down' with its grid, its span and its
 * light below 1 on either axis, 'up' otherwise. `srgb`: the renderer reads the
 * input through an `-srgb` view and draws into one (SDR: `viewFormats` on the
 * pass-0 texture and on the canvas), so the hardware makes the linear light
 * (linearLight 0, the LINEAR_LIGHT override) and one sample is the filter
 * down to ×0.5; otherwise the light is software's (linearLight 1) and the 2×2
 * grid serves there.
 * @param {number} inW
 * @param {number} inH
 * @param {number} outW
 * @param {number} outH
 * @param {{srgb?: boolean}} [opts]
 * @returns {{mode: 'copy'|'up'|'down', taps: number, rDown: number, linearLight: number}}
 */
export function mwsrRegime(inW, inH, outW, outH, { srgb = false } = {}) {
    if (inW === outW && inH === outH) return { mode: 'copy', taps: 0, rDown: 0, linearLight: 0 };
    const s = Math.min(outW / inW, outH / inH);
    if (s >= 1) return { mode: 'up', taps: 5, rDown: 0, linearLight: 0 };
    const table = srgb ? MWSR_DOWN_TAPS_SRGB : MWSR_DOWN_TAPS;
    const linearLight = srgb ? 0 : 1;
    for (const [min, taps, rDown] of table)
        if (s >= min) return { mode: 'down', taps, rDown, linearLight };
    const [, taps, rDown] = table[table.length - 1];
    return { mode: 'down', taps, rDown, linearLight };
}

/**
 * Every regime mwsrRegime() can answer a renderer with — the `up` kernel and
 * each grid of the reduction's table, through sRGB views or not — so that the
 * renderer builds all of its pipelines at creation and compiles nothing while
 * the stream runs (plan §4.3: the pinch zoom and the quality ladder change the
 * scale from one frame to the next).
 * @param {{srgb?: boolean}} [opts]
 * @returns {Array<{mode: 'up'|'down', taps: number, rDown: number, linearLight: number}>}
 */
export function mwsrRegimes({ srgb = false } = {}) {
    const table = srgb ? MWSR_DOWN_TAPS_SRGB : MWSR_DOWN_TAPS;
    const linearLight = srgb ? 0 : 1;
    return [
        { mode: 'up', taps: 5, rDown: 0, linearLight: 0 },
        ...table.map(([, taps, rDown]) => ({ mode: 'down', taps, rDown, linearLight })),
    ];
}

/**
 * The name a renderer keeps a regime's pipeline or program under: 'up', or
 * 'down' and the grid's taps (the span and the light follow from the taps
 * and the renderer's views).
 * @param {{mode: 'up'|'down', taps?: number}} reg
 * @returns {string}
 */
export function mwsrRegimeKey(reg) {
    return reg.mode === 'up' ? 'up' : 'down' + reg.taps;
}

/**
 * The uniform block for an input of inW×inH drawn at outW×outH.
 * @param {number} inW
 * @param {number} inH
 * @param {number} outW
 * @param {number} outH
 * @param {{tau?: number, sharp?: number}} [u]
 * @returns {Float32Array}
 */
export function mwsrUniforms(inW, inH, outW, outH, u = {}) {
    const tau = u.tau ?? MWSR_UNIFORMS.tau;
    const sharp = u.sharp ?? MWSR_UNIFORMS.sharp;
    return new Float32Array([1 / inW, 1 / inH, outW / inW, outH / inH, tau, sharp, 0, 0]);
}

function wgslNumber(type, v) {
    if (type === 'u32') return `${v >>> 0}u`;
    const s = String(v);
    return /[.e]/.test(s) ? s : s + '.0';
}

const FEEDS = {
    tex: {
        decl: '@group(0) @binding(1) var tex : texture_2d<f32>;',
        sample: `fn S(uv : vec2f) -> vec3f {
    return textureSampleLevel(tex, samp, uv, 0.0).rgb;
}
fn L(c : vec2i) -> vec3f {
    return textureLoad(tex, c, 0).rgb;
}`,
    },
    ext: {
        decl: '@group(0) @binding(1) var tex : texture_external;',
        sample: `fn S(uv : vec2f) -> vec3f {
    return textureSampleBaseClampToEdge(tex, samp, uv).rgb;
}
fn L(c : vec2i) -> vec3f {
    return textureLoad(tex, c).rgb;
}`,
    },
};

// The part every text shares: the vertex stage, the uniform block, the
// bindings, the feed, the overrides and the luma.
function preamble(feed, half) {
    const f = FEEDS[feed];
    if (!f) throw new Error('mwsr: feed ' + feed + '?');
    const prelude = half ? 'enable f16;\n\n' : '';
    const aliases = half
        ? 'alias hf = f16;\nalias h3 = vec3<f16>;\nconst EPS_H : hf = 0.001h;'
        : 'alias hf = f32;\nalias h3 = vec3<f32>;\nconst EPS_H : hf = 0.00001;';
    const overrides = Object.entries(MWSR_OVERRIDE_SPEC)
        .map(([k, [t, v]]) => `override ${k} : ${t} = ${wgslNumber(t, v)};`)
        .join('\n');
    const [lr, lg, lb] = MWSR_CONSTANTS.LUMA;
    return `${prelude}struct VSOut {
    @builtin(position) pos : vec4f,
    @location(0) uv : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vid : u32) -> VSOut {
    var out : VSOut;
    let uv = vec2f(f32((vid << 1u) & 2u), f32(vid & 2u));
    out.uv = uv;
    out.pos = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    return out;
}

struct U {
    texel : vec2f,
    scale : vec2f,
    tau : f32,
    sharp : f32,
    pad : vec2f,
};

@group(0) @binding(0) var samp : sampler;
${f.decl}
@group(0) @binding(2) var<uniform> u : U;

${f.sample}

${aliases}

${overrides}

const LUMA : vec3f = vec3f(${wgslNumber('f32', lr)}, ${wgslNumber('f32', lg)}, ${wgslNumber('f32', lb)});

fn luma(c : vec3f) -> f32 {
    return dot(c, LUMA);
}

fn lumah(c : h3) -> hf {
    return dot(c, h3(LUMA));
}
`;
}

// The `up` fragment stage: the kernel of plan §3.2.
const UP_FS = `
// Five samples blended in the frame of an edge: the centre, a pair along it
// (weight wT each, smoothing) and a pair across it (weight wX each, negative:
// sharpening), per channel, the result bounded by the five.
fn blend(C : h3, T1 : h3, T2 : h3, X1 : h3, X2 : h3, wT : h3, wX : h3) -> h3 {
    let R = (C + wT * (T1 + T2) + wX * (X1 + X2)) / (1.0 + 2.0 * (wT + wX));
    let lo = min(min(C, T1), min(T2, min(X1, X2)));
    let hi = max(max(C, T1), max(T2, max(X1, X2)));
    return clamp(R, lo, hi);
}

// A step (|X2 - X1|) or a ridge (|X1 + X2 - 2C|) across the edge, against
// all the variation around: 1 on a clean edge or line, near 0 on texture,
// grain and compression blocks.
fn coherence(c : hf, t1 : hf, t2 : hf, x1 : hf, x2 : hf) -> hf {
    let step = abs(x2 - x1);
    let ridge = abs(x1 + x2 - 2.0 * c);
    let variation = abs(x2 - c) + abs(c - x1) + abs(t2 - c) + abs(c - t1) + EPS_H;
    return max(step, ridge) / variation;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
    let uv = in.uv;
    let C = S(uv);
    let lC = luma(C);
    // The vote: the screen derivatives of the bilinear sample, scaled to a
    // change per input texel; coarse, so the whole quad takes the same branch.
    // From the luma, or (CHROMA444) from the channel with the steepest ramp,
    // so that a border between two colours of one luma is an edge too.
    let dx = dpdxCoarse(C) * u.scale.x;
    let dy = dpdyCoarse(C) * u.scale.y;
    let m = abs(dx) + abs(dy);
    let rg = m.g > m.r;
    let b = m.b > max(m.r, m.g);
    let c444 = CHROMA444 == 1u;
    let gx = select(dot(dx, LUMA), select(select(dx.r, dx.g, rg), dx.b, b), c444);
    let gy = select(dot(dy, LUMA), select(select(dy.r, dy.g, rg), dy.b, b), c444);
    let flat = select(abs(gx) + abs(gy), max(m.r, max(m.g, m.b)), c444) < u.tau;
    if (SHOW == 1u) {
        return vec4f(vec3f(select(1.0, 0.0, flat)), 1.0);
    }
    if (flat) {
        return vec4f(C, 1.0);
    }
    // Strength: none at 1:1 (the renderer copies the frame there), full from
    // S_FULL on.
    let smin = min(u.scale.x, u.scale.y);
    let strength = clamp((smin - 1.0) / (S_FULL - 1.0), 0.0, 1.0);
    // The taps along and across the edge the derivatives measure.
    let n = vec2f(gx, gy) * inverseSqrt(max(gx * gx + gy * gy, 1e-12));
    let dt = vec2f(-n.y, n.x) * u.texel * R_ALONG;
    let dn = n * u.texel * R_ACROSS;
    // From here the arithmetic is hf (f32, or f16 when the module says so).
    let Ch = h3(C);
    let T1 = h3(S(uv - dt));
    let T2 = h3(S(uv + dt));
    let X1 = h3(S(uv - dn));
    let X2 = h3(S(uv + dn));
    let lCh = hf(lC);
    let lT1 = lumah(T1);
    let lT2 = lumah(T2);
    let lX1 = lumah(X1);
    let lX2 = lumah(X2);
    var a : h3;
    if (CHROMA444 == 1u) {
        a = h3(coherence(Ch.r, T1.r, T2.r, X1.r, X2.r),
               coherence(Ch.g, T1.g, T2.g, X1.g, X2.g),
               coherence(Ch.b, T1.b, T2.b, X1.b, X2.b)) * hf(strength);
    } else {
        a = h3(coherence(lCh, lT1, lT2, lX1, lX2) * hf(strength));
    }
    let wT = hf(W_ALONG) * a;
    let wX = max(-hf(W_ACROSS) * hf(u.sharp) * a, h3(hf(W_MIN)));
    var R = vec3f(blend(Ch, T1, T2, X1, X2, wT, wX));
    if (DERING == 1u) {
        // The exact bound: the four input texels around the pixel, the
        // footprint of its bilinear sample.
        let dims = vec2i(textureDimensions(tex));
        let pt = uv * vec2f(dims) - 0.5;
        let i0 = clamp(vec2i(floor(pt)), vec2i(0), dims - vec2i(1));
        let i1 = min(i0 + vec2i(1), dims - vec2i(1));
        let q00 = L(i0);
        let q10 = L(vec2i(i1.x, i0.y));
        let q01 = L(vec2i(i0.x, i1.y));
        let q11 = L(i1);
        R = clamp(R, min(min(q00, q10), min(q01, q11)), max(max(q00, q10), max(q01, q11)));
    }
    return vec4f(R, 1.0);
}
`;

// The k×k grid of the reduction, as offsets in the pixel's footprint (the
// span): the centres of k×k equal cells, row by row. Both twins unroll it.
function downOffsets(taps) {
    const k = Math.round(Math.sqrt(taps));
    if (![1, 2, 3, 4].includes(k) || k * k !== taps)
        throw new Error('mwsr: down taps ' + taps + '?');
    const offs = [];
    for (let i = 0; i < k; i++) offs.push((i + 0.5) / k - 0.5);
    const grid = [];
    for (const oy of offs) for (const ox of offs) grid.push([ox, oy]);
    return grid;
}

// The `down` fragment stage: a k×k grid of bilinear samples over the pixel's
// footprint, averaged (plan §4.3), unrolled here so that the text holds no loop.
function downFs(taps) {
    const k = Math.round(Math.sqrt(taps));
    const lines = downOffsets(taps).map(
        ([ox, oy]) =>
            `    acc += dec(S(uv + vec2f(${wgslNumber('f32', ox)}, ${wgslNumber('f32', oy)}) * span));`,
    );
    return `
// The sRGB transfer, both ways, for LINEAR_LIGHT 2; past 1.0 (HDR) the same
// formula continues, as the renderer's HDR pass 0 encodes it.
fn srgbToLin(c : vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((max(c, vec3f(0.0)) + 0.055) / 1.055, vec3f(2.4));
    return select(hi, lo, c <= vec3f(0.04045));
}

fn linToSrgb(c : vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

fn dec(c : vec3f) -> vec3f {
    if (LINEAR_LIGHT == 1u) {
        return c * c;
    }
    if (LINEAR_LIGHT == 2u) {
        return srgbToLin(c);
    }
    return c;
}

fn enc(c : vec3f) -> vec3f {
    if (LINEAR_LIGHT == 1u) {
        return sqrt(max(c, vec3f(0.0)));
    }
    if (LINEAR_LIGHT == 2u) {
        return linToSrgb(c);
    }
    return c;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
    let uv = in.uv;
    // The pixel's footprint in the input, 1 / scale texels per axis, spanned
    // by the grid (R_DOWN 1); ${k}×${k} samples at its ${k}×${k} centres.
    let span = u.texel / u.scale * R_DOWN;
    var acc = vec3f(0.0);
${lines.join('\n')}
    return vec4f(enc(acc * ${wgslNumber('f32', 1 / taps)}), 1.0);
}
`;
}

/**
 * The WGSL text of one mode: a full-screen triangle (`vs`) and the fragment
 * stage (`fs`); bindings 0 sampler (linear, clamp to edge), 1 the feed, 2 the
 * uniform block of mwsrUniforms(). Explicit LOD and clamp-to-edge sampling
 * only, so the samples may sit in the non-uniform branch; the derivatives are
 * taken before it, in uniform control flow, as WGSL requires.
 * @param {{feed?: 'tex'|'ext', half?: boolean, mode?: 'up'|'down', taps?: number}} [opts]
 *   'tex' reads a texture_2d<f32>: the product's path, after its pass 0 (the
 *   external texture's two planes per sample made 'ext' lose to pass 0 +
 *   kernel on the RTX, the 780M and the M1 alike, P2.3; 'ext' stays for the
 *   lab). `half` runs the up mode's edge path in f16 (`enable f16`: the device
 *   must have 'shader-f16'; worth 9-10 % on the 780M, nothing on NVIDIA); the
 *   vote, the frame, the bound and the down mode stay in f32. `mode` 'down'
 *   is the reduction with `taps` samples (1, 4, 9 or 16; see mwsrRegime()).
 * @returns {string}
 */
export function mwsrWgsl({ feed = 'tex', half = false, mode = 'up', taps = 4, fine = false } = {}) {
    if (mode === 'up')
        return (
            preamble(feed, half) + (fine ? UP_FS.replace(/dpd([xy])Coarse/g, 'dpd$1Fine') : UP_FS)
        );
    if (mode === 'down') return preamble(feed, false) + downFs(taps);
    throw new Error('mwsr: mode ' + mode + '?');
}

// The `up` fragment stage in GLSL: the kernel of the WGSL text above, line for
// line. The colours and weights of the edge path are mediump — f16 where the
// GPU has it, the twin of the `half` module — the coordinates, the
// derivatives, the bound and the result highp.
const UP_GLSL = `
mediump vec3 blend(mediump vec3 C, mediump vec3 T1, mediump vec3 T2, mediump vec3 X1, mediump vec3 X2,
                   mediump vec3 wT, mediump vec3 wX) {
    mediump vec3 R = (C + wT * (T1 + T2) + wX * (X1 + X2)) / (1.0 + 2.0 * (wT + wX));
    mediump vec3 lo = min(min(C, T1), min(T2, min(X1, X2)));
    mediump vec3 hi = max(max(C, T1), max(T2, max(X1, X2)));
    return clamp(R, lo, hi);
}

mediump float coherence(mediump float c, mediump float t1, mediump float t2, mediump float x1,
                        mediump float x2) {
    mediump float jump = abs(x2 - x1);
    mediump float ridge = abs(x1 + x2 - 2.0 * c);
    mediump float variation = abs(x2 - c) + abs(c - x1) + abs(t2 - c) + abs(c - t1) + EPS_H;
    return max(jump, ridge) / variation;
}

void main() {
    vec2 uv = vUv;
    vec3 C = S(uv);
    float lC = luma(C);
    // GL's window y runs up, WebGPU's framebuffer y runs down: dFdy is the
    // WGSL text's dpdy negated, or the edge normal comes out mirrored and the
    // along and across taps swap on every diagonal (the first conformity run).
    vec3 dx = dFdx(C) * uTexelScale.z;
    vec3 dy = -dFdy(C) * uTexelScale.w;
    vec3 m = abs(dx) + abs(dy);
    bool rg = m.g > m.r;
    bool b = m.b > max(m.r, m.g);
    bool c444 = CHROMA444 == 1u;
    float gx = c444 ? (b ? dx.b : (rg ? dx.g : dx.r)) : dot(dx, LUMA);
    float gy = c444 ? (b ? dy.b : (rg ? dy.g : dy.r)) : dot(dy, LUMA);
    bool isFlat = (c444 ? max(m.r, max(m.g, m.b)) : abs(gx) + abs(gy)) < uTauSharp.x;
    if (SHOW == 1u) {
        oColor = vec4(vec3(isFlat ? 0.0 : 1.0), 1.0);
        return;
    }
    if (isFlat) {
        oColor = vec4(C, 1.0);
        return;
    }
    float smin = min(uTexelScale.z, uTexelScale.w);
    float strength = clamp((smin - 1.0) / (S_FULL - 1.0), 0.0, 1.0);
    vec2 n = vec2(gx, gy) * inversesqrt(max(gx * gx + gy * gy, 1e-12));
    vec2 dt = vec2(-n.y, n.x) * uTexelScale.xy * R_ALONG;
    vec2 dn = n * uTexelScale.xy * R_ACROSS;
    mediump vec3 Ch = C;
    mediump vec3 T1 = S(uv - dt);
    mediump vec3 T2 = S(uv + dt);
    mediump vec3 X1 = S(uv - dn);
    mediump vec3 X2 = S(uv + dn);
    mediump float lCh = lC;
    mediump float lT1 = lumah(T1);
    mediump float lT2 = lumah(T2);
    mediump float lX1 = lumah(X1);
    mediump float lX2 = lumah(X2);
    mediump vec3 a;
    if (CHROMA444 == 1u) {
        a = vec3(coherence(Ch.r, T1.r, T2.r, X1.r, X2.r),
                 coherence(Ch.g, T1.g, T2.g, X1.g, X2.g),
                 coherence(Ch.b, T1.b, T2.b, X1.b, X2.b)) * strength;
    } else {
        a = vec3(coherence(lCh, lT1, lT2, lX1, lX2) * strength);
    }
    mediump vec3 wT = W_ALONG * a;
    mediump vec3 wX = max(-W_ACROSS * uTauSharp.y * a, vec3(W_MIN));
    vec3 R = blend(Ch, T1, T2, X1, X2, wT, wX);
    if (DERING == 1u) {
        ivec2 dims = textureSize(uTex, 0);
        vec2 pt = uv * vec2(dims) - 0.5;
        ivec2 i0 = clamp(ivec2(floor(pt)), ivec2(0), dims - 1);
        ivec2 i1 = min(i0 + 1, dims - 1);
        vec3 q00 = L(i0);
        vec3 q10 = L(ivec2(i1.x, i0.y));
        vec3 q01 = L(ivec2(i0.x, i1.y));
        vec3 q11 = L(i1);
        R = clamp(R, min(min(q00, q10), min(q01, q11)), max(max(q00, q10), max(q01, q11)));
    }
    oColor = vec4(R, 1.0);
}
`;

// The `down` fragment stage in GLSL: the same grid, from the same offsets.
function downGlsl(taps) {
    const lines = downOffsets(taps).map(
        ([ox, oy]) =>
            `    acc += dec(S(uv + vec2(${wgslNumber('f32', ox)}, ${wgslNumber('f32', oy)}) * span));`,
    );
    return `
vec3 srgbToLin(vec3 c) {
    vec3 lo = c / 12.92;
    vec3 hi = pow((max(c, vec3(0.0)) + 0.055) / 1.055, vec3(2.4));
    return mix(hi, lo, lessThanEqual(c, vec3(0.04045)));
}

vec3 linToSrgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, lessThanEqual(c, vec3(0.0031308)));
}

vec3 dec(vec3 c) {
    if (LINEAR_LIGHT == 1u) {
        return c * c;
    }
    if (LINEAR_LIGHT == 2u) {
        return srgbToLin(c);
    }
    return c;
}

vec3 enc(vec3 c) {
    if (LINEAR_LIGHT == 1u) {
        return sqrt(max(c, vec3(0.0)));
    }
    if (LINEAR_LIGHT == 2u) {
        return linToSrgb(c);
    }
    return c;
}

void main() {
    vec2 uv = vUv;
    vec2 span = uTexelScale.xy / uTexelScale.zw * R_DOWN;
    vec3 acc = vec3(0.0);
${lines.join('\n')}
    oColor = vec4(enc(acc * ${wgslNumber('f32', 1 / taps)}), 1.0);
}
`;
}

// The part every GLSL text shares: the uniforms (the block of mwsrUniforms()
// in two vec4), the varying and the output of WebGlRenderer's full-screen
// triangle, the feed, the overrides as constants and the luma.
function glslPreamble(overrides) {
    for (const k of Object.keys(overrides))
        if (!(k in MWSR_OVERRIDE_SPEC)) throw new Error('mwsr: override ' + k + '?');
    const consts = Object.entries(MWSR_OVERRIDE_SPEC)
        .map(
            ([k, [t, v]]) =>
                `const ${t === 'u32' ? 'uint' : 'float'} ${k} = ${wgslNumber(t, overrides[k] ?? v)};`,
        )
        .join('\n');
    const [lr, lg, lb] = MWSR_CONSTANTS.LUMA;
    return `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform vec4 uTexelScale; // texel.xy, scale.xy: the first four of mwsrUniforms()
uniform vec4 uTauSharp; // tau, sharp, 0, 0: the last four
in vec2 vUv;
out vec4 oColor;

vec3 S(vec2 uv) {
    return textureLod(uTex, uv, 0.0).rgb;
}
vec3 L(ivec2 c) {
    return texelFetch(uTex, c, 0).rgb;
}

const mediump float EPS_H = 0.001;

${consts}

const vec3 LUMA = vec3(${wgslNumber('f32', lr)}, ${wgslNumber('f32', lg)}, ${wgslNumber('f32', lb)});

float luma(vec3 c) {
    return dot(c, LUMA);
}

mediump float lumah(mediump vec3 c) {
    return dot(c, LUMA);
}
`;
}

/**
 * The GLSL ES 3.00 twin of one mode (plan §3.6): the same kernel and the same
 * constants as mwsrWgsl(), from the same tables, for WebGlRenderer's
 * full-screen triangle (`vUv` in, `oColor` out). WebGL2 has no pipeline
 * constants, so the overrides are baked into the text (`overrides`, by name;
 * the rest at their defaults); two vec4 uniforms carry the block of
 * mwsrUniforms(). The edge path's colours and weights are mediump: f16 on the
 * GPUs that have it, the twin of the `half` module, and highp on the others.
 * No sRGB views on a WebGL2 drawing buffer: the reduction takes the software
 * light (MWSR_DOWN_TAPS, LINEAR_LIGHT 1).
 * @param {{mode?: 'up'|'down', taps?: number, overrides?: Object<string, number>}} [opts]
 * @returns {string}
 */
export function mwsrGlsl({ mode = 'up', taps = 4, overrides = {} } = {}) {
    if (mode === 'up') return glslPreamble(overrides) + UP_GLSL;
    if (mode === 'down') return glslPreamble(overrides) + downGlsl(taps);
    throw new Error('mwsr: mode ' + mode + '?');
}
