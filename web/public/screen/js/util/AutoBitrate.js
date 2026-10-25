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
 * Recommended-bitrate estimate, shared by the Settings UI (auto-bitrate
 * slider) and the congestion-degradation ladder (bitrate aligned to a
 * reduced resolution).
 */

/** Parse a "W:H" aspect string into a numeric ratio. "auto" / unknown → 16:9
 *  (baseline for the bitrate estimate; the real width is derived from the
 *  host's screen format on the backend at launch). */
export function aspectToNumber(aspect) {
    const m = /^(\d+):(\d+)$/.exec(aspect || '');
    if (m && +m[2] > 0) return +m[1] / +m[2];
    return 16 / 9;
}

/**
 * Recommended bitrate (Mbps) derived from the 1080p@60 SDR reference (20 Mbps):
 *   × pixel-count ratio vs 1080p (e.g. 1440p → 1.78)
 *   × framerate ratio vs 60 fps (e.g. 120 fps → 2.00)
 *   × 1.5 when HDR and/or YUV 4:4:4 is enabled (not cumulative — single 1.5×)
 *   × 0.5 on a phone or a tablet (`touch`)
 * Clamped to [1, 150] Mbps.
 * "Same as Host" (height 0) uses the 1080p reference.
 *
 * Half on a phone or a tablet: the picture is shown on a hand-sized screen
 * where the same frame carries far more pixels than the eye resolves, the
 * decoder is the weakest link there, and the link is usually mobile data
 * rather than the LAN a desktop streams over. A desktop keeps the full rule.
 */
export function computeAutoBitrate(height, fps, aspect, chroma444, hdr, touch) {
    const REF_BITRATE = 20; // Mbps at 1920×1080 / 60fps / SDR
    const h = height > 0 ? height : 1080;
    // Pixel count = (h × aspectRatio) × h, normalised to the 1920×1080 ref.
    // Ultrawide (21:9, 32:9) therefore scales the bitrate up accordingly.
    const aspRatio = aspectToNumber(aspect);
    const pixelRatio = (h * h * aspRatio) / (1080 * 1080 * (16 / 9));
    const fpsRatio = (fps > 0 ? fps : 60) / 60;
    // HDR (10-bit) and 4:4:4 (4× chroma samples) each justify ~1.5× bitrate;
    // not cumulative — a single 1.5× when either is enabled.
    const richRatio = chroma444 || hdr ? 1.5 : 1.0;
    const screenRatio = touch ? 0.5 : 1.0;
    const mbps = Math.round(REF_BITRATE * pixelRatio * fpsRatio * richRatio * screenRatio);
    return Math.max(1, Math.min(150, mbps));
}
