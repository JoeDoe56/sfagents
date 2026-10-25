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
 * The writable VideoFrame sink that drives a <video> element, under whichever
 * name this browser gives it: Chromium ships MediaStreamTrackGenerator, WebKit
 * the standardized VideoTrackGenerator. Returns the constructor, or null when
 * neither exists — and then this browser has no native-HDR presentation path.
 *
 * Its own module rather than BrowserDetect's: createRenderer is imported by the
 * decode worker too, and BrowserDetect touches document/window while loading.
 *
 * @returns {?(new (init?: { kind: 'audio' | 'video' }) => { writable: WritableStream, track?: MediaStreamTrack })}
 */
export function videoSinkCtor() {
    try {
        if (typeof MediaStreamTrackGenerator !== 'undefined') return MediaStreamTrackGenerator;
        if (typeof VideoTrackGenerator !== 'undefined') return VideoTrackGenerator;
    } catch (e) {}
    return null;
}

/**
 * Whether a stream presents through the sink because the screen is a TV's.
 *
 * The sink, fed each frame as it is decoded, is shown by the compositor on its
 * own, off the page's main thread; a canvas waits on that thread's rAF, which
 * a TV's slow cores starve under a stream. Measured 01/10/2026 on a Freebox
 * Player POP (Amlogic, Android System WebView 153), 1080p50: 49.6 frames a
 * second presented by the sink (presentedFrames), 28.4 by Canvas2D, 17.8 by
 * WebGL — the same box presenting 50 of either in a page of its own. A Mi TV
 * shows the 30 it is fed. SDR with no enhancer only: the sink has no shader
 * stage, and an HDR stream has its own routing. The canvas stays reachable for
 * a bench, by the Canvas2D presenter or `mw_force_2d`.
 * @param {{tv: boolean, hdr: boolean, algo: string, forceCanvas2d?: boolean, devCanvas2d?: boolean}} s
 * @returns {boolean}
 */
export function tvPresentsThroughSink(s) {
    return s.tv === true && !s.hdr && s.algo === 'off' && !s.forceCanvas2d && !s.devCanvas2d;
}
