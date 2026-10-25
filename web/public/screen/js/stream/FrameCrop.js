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
 * A decoded frame cut to the size the native host announces.
 *
 * An encoder that codes by blocks may pad the frame past the picture — the 780M
 * codes AV1 by 64×16, so 1080p goes out as a 1920x1088 frame — and say the
 * picture in AV1's render size. Chrome reads none of it: software and hardware
 * decoders alike hand back the whole frame (visibleRect, displayHeight: 1088),
 * and the stream would show the padding, the pointer off by as much.
 *
 * So the view cuts it, at the decoder's output, before any renderer sees the
 * frame: a new VideoFrame over the same picture with a smaller visibleRect, no
 * copy. Only where /start said it would (crops_to_frame, canCropFrames) — the
 * host otherwise keeps the picture on its grid — and only for AV1: an HEVC or
 * H.264 frame says its picture in a field the browser reads.
 */

/** The most a frame is padded past its picture: a 128-pixel superblock. A
 *  frame larger than that is another size, a change the host has not told
 *  yet, and is shown as it is. */
export const MAX_PAD = 128;

/**
 * The part of a frame to show, or null to show it whole.
 *
 * @param {{x: number, y: number, width: number, height: number}} visible
 *   the decoded frame's visibleRect
 * @param {{width: number, height: number} | null | undefined} announced
 *   the size the host says it streams (/start's stream_width × stream_height,
 *   then each `displayformat`)
 * @returns {{x: number, y: number, width: number, height: number} | null}
 */
export function cropRect(visible, announced) {
    if (!visible || !announced) return null;
    const w = announced.width;
    const h = announced.height;
    if (!(w > 0) || !(h > 0)) return null;
    if (visible.width === w && visible.height === h) return null;
    // Smaller, or larger by more than a block: not this picture padded.
    if (visible.width < w || visible.height < h) return null;
    if (visible.width - w >= MAX_PAD || visible.height - h >= MAX_PAD) return null;
    return { x: visible.x, y: visible.y, width: w, height: h };
}

/** @type {boolean | null} */
let canCrop = null;

/**
 * Whether this browser makes a VideoFrame over another with a smaller
 * visibleRect — what /start says as crops_to_frame. Tried once, on a 4×4
 * frame of its own.
 * @returns {boolean}
 */
export function canCropFrames() {
    if (canCrop !== null) return canCrop;
    canCrop = false;
    if (typeof VideoFrame !== 'function') return canCrop;
    /** @type {VideoFrame | null} */
    let source = null;
    /** @type {VideoFrame | null} */
    let cut = null;
    try {
        source = new VideoFrame(new Uint8Array(24), {
            format: 'I420',
            codedWidth: 4,
            codedHeight: 4,
            timestamp: 0,
        });
        cut = new VideoFrame(source, {
            visibleRect: { x: 0, y: 0, width: 2, height: 2 },
            displayWidth: 2,
            displayHeight: 2,
        });
        canCrop = !!cut.visibleRect && cut.visibleRect.height === 2 && cut.displayHeight === 2;
    } catch (e) {
        canCrop = false;
    }
    try {
        if (cut) cut.close();
        if (source) source.close();
    } catch (e) {}
    return canCrop;
}

/**
 * @p frame cut to @p announced, or @p frame itself where there is nothing to
 * cut or the browser refuses. The frame handed in is closed when a cut one is
 * handed back: the caller owns whichever comes out, as it owned the frame.
 *
 * @param {VideoFrame} frame
 * @param {{width: number, height: number} | null | undefined} announced
 * @returns {VideoFrame}
 */
export function cropToAnnounced(frame, announced) {
    const rect = cropRect(frame.visibleRect, announced);
    if (!rect) return frame;
    try {
        const cut = new VideoFrame(frame, {
            visibleRect: rect,
            displayWidth: rect.width,
            displayHeight: rect.height,
        });
        frame.close();
        return cut;
    } catch (e) {
        return frame;
    }
}
