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
 * scaleRegime — where a decoded frame lands on the canvas, and whether that is
 * a 1:1 copy. Pure, shared by the two shader renderers (WebGPU, WebGL2) so
 * both decide the same thing from the same numbers, and tested without a GPU.
 *
 * The canvas backing is the frame-aspect rectangle that fits the output box
 * (the display size in device pixels), or the frame's own size while no box is
 * known; its longer side is capped at MAX_CANVAS_DIM, which bounds the GPU cost
 * when pinch-zoom inflates the box.
 *
 * At exactly the frame size on both axes an enhancer has nothing to
 * reconstruct: the shader renderers then copy the frame to the canvas instead
 * of running the pass (docs/design/upscaler-mwsr.md §5), and the pass resumes
 * on the next frame whose size differs. Exact means exact: a 0.98 scale is a
 * resample and gets the pass.
 */

/** Longest side a canvas backing may have (the texture limit, with margin). */
export const MAX_CANVAS_DIM = 4096;

/**
 * Canvas backing for a frame of inW×inH shown in a box of outW×outH. A box
 * that is missing or degenerate (≤ 0 on a side) gives the frame's own size.
 * @param {number} inW
 * @param {number} inH
 * @param {number} outW
 * @param {number} outH
 * @returns {{cw: number, ch: number}}
 */
export function fitOutputSize(inW, inH, outW, outH) {
    let cw = inW,
        ch = inH;
    if (outW > 0 && outH > 0) {
        const frameAspect = inW / inH;
        const boxAspect = outW / outH;
        cw = frameAspect >= boxAspect ? outW : Math.round(outH * frameAspect);
        ch = Math.round(cw / frameAspect);
        if (cw > MAX_CANVAS_DIM || ch > MAX_CANVAS_DIM) {
            const k = MAX_CANVAS_DIM / Math.max(cw, ch);
            cw = Math.round(cw * k);
            ch = Math.round(ch * k);
        }
    }
    return { cw, ch };
}

/**
 * True when the frame is presented at exactly its own size on both axes — the
 * one case where the enhancer pass is skipped.
 * @param {number} inW
 * @param {number} inH
 * @param {number} cw
 * @param {number} ch
 */
export function isIdentityScale(inW, inH, cw, ch) {
    return inW === cw && inH === ch;
}
