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
 * VideoElementRenderer — routes decoded VideoFrames to a <video> element via a
 * writable track generator, instead of drawing them to a canvas.
 *
 * Why: the WebGPU/Canvas paths sample frames through importExternalTexture /
 * drawImage, which only output SDR-referred color spaces (srgb/display-p3) and
 * tone-map away the HDR (PQ → SDR) — HDR content looks washed out. A <video>
 * element, by contrast, presents decoded VideoFrames with their native color
 * space (BT.2020 + PQ), so the browser does the HDR compositing correctly
 * (proven on Windows Chrome). This reuses the existing WebCodecs decode
 * pipeline (DataChannel transport) and only swaps the render sink.
 *
 * The decoded frame already carries the right VideoColorSpace (set by the
 * decoder config: bt2020 / pq), so no per-frame color handling is needed here —
 * we just write the frame to the generator, which presents it on the <video>.
 *
 * Needs the writable frame sink under either of its names — Chromium's
 * MediaStreamTrackGenerator or WebKit's standardized VideoTrackGenerator (see
 * videoSinkCtor). createVideoRenderer falls back to the WebGPU/Canvas2D path
 * when neither exists.
 *
 * Trade-off: no WebGPU enhancers (FSR1/SGSR) on this path — the frames bypass
 * the shader pipeline. HDR fidelity is the priority here.
 */
import { VideoRenderer } from './VideoRenderer.js';
import { videoSinkCtor } from './videoSink.js';

/**
 * How long a draw waits for the generator to take a frame. The writer's
 * `ready` is the compositor's pace; one that never comes (an overloaded TV
 * pipeline, 02/10/2026: a Mi TV at 1080p60 froze on the way out) used to hold
 * the one draw in flight forever, and with it the whole render path. Past
 * this, the frame is dropped and the next one tries again.
 */
export const READY_WAIT_MS = 250;

export class VideoElementRenderer extends VideoRenderer {
    constructor() {
        super();
        /** @type {number} Frames written to the generator — caps warm-up logging. */
        this._wrote = 0;
    }

    static async create(canvas, opts) {
        const Sink = videoSinkCtor();
        if (!Sink) throw new Error('no VideoFrame sink (MediaStreamTrack/VideoTrackGenerator)');
        const videoEl = opts && opts.videoEl;
        if (!videoEl) throw new Error('VideoElementRenderer requires opts.videoEl');

        const r = new VideoElementRenderer();
        r.videoEl = videoEl;
        r._disposed = false;
        r._wrote = 0;

        // Both sinks are writable streams of VideoFrames, but they expose the
        // track differently: MediaStreamTrackGenerator IS the track (and takes a
        // kind), VideoTrackGenerator carries one on .track. The kind argument is
        // the former's; WebIDL drops the extra one for the latter, so a single
        // call serves both, and .track || itself gives the track to present.
        r._generator = new Sink({ kind: 'video' });
        if (!r._generator.writable) throw new Error('generator.writable is undefined');
        r._writer = r._generator.writable.getWriter();
        const track = r._generator.track || r._generator;
        r._track = track;
        r._stream = new MediaStream([track]);
        videoEl.srcObject = r._stream;
        // Make the <video> visible BEFORE play() — a display:none element can keep
        // play() pending. Caller's _applyRendererSink also sets this, but do it here
        // too to avoid any ordering gap.
        videoEl.style.display = 'block';
        // Minimize playout delay for real-time streaming when supported.
        if ('playoutDelayHint' in videoEl) videoEl.playoutDelayHint = 0;
        // play() MUST NOT be awaited: it stays pending until the first frame is
        // written, but frames are only written after create() returns (the render
        // loop needs this._renderer). Awaiting it here deadlocks. Fire-and-forget;
        // re-armed on the first successful write.
        r._playRequested = false;
        r._tryPlay();
        console.log('[VideoElementRenderer] created; track.readyState=' + track.readyState);
        return r;
    }

    get kind() {
        return 'video-element';
    }

    // Fire-and-forget play(): never awaited (would deadlock against the first
    // frame write). Logs the outcome once for diagnostics.
    _tryPlay() {
        if (!this.videoEl) return;
        this.videoEl
            .play()
            .then(() => {
                if (!this._playRequested) {
                    this._playRequested = true;
                    console.log('[VideoElementRenderer] videoEl.play() OK');
                }
            })
            .catch((e) => console.warn('[VideoElementRenderer] play() rejected: ' + e.message));
    }

    /** <video> presents the decoded HDR frames natively. */
    get hdrActive() {
        return true;
    }

    setOutputSize() {
        // The <video> element scales itself via CSS; nothing to do here.
    }

    /**
     * One frame at a time: draw() may await the writer's backpressure before
     * write(), so two overlapping draws could reach write() in the reverse
     * order and hand the <video> an older frame last. Nothing to gain either —
     * the stream writer already paces itself on the compositor.
     */
    get serialDrawsOnly() {
        return true;
    }

    async draw(frame) {
        if (this._disposed || !this._writer) {
            try {
                frame.close();
            } catch (e) {}
            return;
        }
        try {
            // Honor backpressure so we never queue ahead of the compositor —
            // for a while: see READY_WAIT_MS.
            if (this._writer.desiredSize !== null && this._writer.desiredSize <= 0) {
                let timer = null;
                const ready = await Promise.race([
                    this._writer.ready.then(() => true),
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve(false), READY_WAIT_MS);
                    }),
                ]);
                clearTimeout(timer);
                if (!ready || this._disposed || !this._writer) {
                    if (!ready && !this._readyTimedOut) {
                        this._readyTimedOut = true;
                        console.warn(
                            '[VideoElementRenderer] sink not ready after ' +
                                READY_WAIT_MS +
                                ' ms: frame dropped',
                        );
                    }
                    frame.close();
                    return;
                }
            }
            // The generator's writable takes ownership of the frame and closes it.
            await this._writer.write(frame);
            if (this._wrote < 3) {
                this._wrote++;
                // Re-arm play() now that a frame is available (some browsers keep
                // play() pending until the MediaStream produces its first frame).
                if (this.videoEl && this.videoEl.paused) this._tryPlay();
                console.log(
                    '[VideoElementRenderer] wrote frame #' +
                        this._wrote +
                        ' ' +
                        (this.videoEl
                            ? this.videoEl.videoWidth + 'x' + this.videoEl.videoHeight
                            : '?') +
                        ' track=' +
                        (this._track ? this._track.readyState : '?'),
                );
            }
        } catch (e) {
            console.warn('[VideoElementRenderer] write failed: ' + e.message);
            try {
                frame.close();
            } catch (e2) {}
        }
    }

    /**
     * Let go of everything at once: the <video> stops presenting, the writer
     * drops what it still holds (abort, not close — close waits for writes a
     * stalled sink may never take), and the track ends, which frees the frames
     * and the hardware decoder buffers behind them.
     */
    dispose() {
        this._disposed = true;
        try {
            if (this.videoEl) {
                this.videoEl.pause();
                this.videoEl.srcObject = null;
            }
        } catch (e) {}
        try {
            if (this._writer) this._writer.abort().catch(() => {});
        } catch (e) {}
        try {
            if (this._track && typeof this._track.stop === 'function') this._track.stop();
        } catch (e) {}
        this._writer = null;
        this._generator = null;
        this._track = null;
        this._stream = null;
        this.videoEl = null;
    }
}
