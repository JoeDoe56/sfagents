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
 * The content-age probe's reads, off the main thread (ContentAgeProbe.js).
 *
 * Copying a strip out of a decoded frame held the main thread: on DualRTX's
 * AMD iGPU, a frame the probe read waited 12.2 ms more between its decode and
 * its draw than one it did not (03/10/2026, docs/design/ultra-lan-poc.md
 * §6.1). Here that wait is this worker's: the main thread clones the frame
 * and hands it over.
 *
 * In:  {id, frame: VideoFrame (transferred), rect}
 * Out: {id, format, layout, buf (transferred)} or {id, error}
 */
self.onmessage = async (e) => {
    const { id, frame, rect } = e.data;
    try {
        const buf = new Uint8Array(frame.allocationSize({ rect }));
        const format = frame.format;
        const layout = await frame.copyTo(buf, { rect });
        self.postMessage({ id, format, layout, buf }, [buf.buffer]);
    } catch (err) {
        self.postMessage({ id, error: String((err && err.message) || err) });
    } finally {
        frame.close();
    }
};
