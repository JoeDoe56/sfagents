/**
 * Text to speech: the computer reads text aloud with VibeVoice, in the
 * reference voice set in Settings → STT & TTS (web/src/dictation.ts). It
 * plays as it is made: the server sends 16-bit PCM as VibeVoice makes it, and
 * each piece is scheduled with Web Audio right after the one before, without
 * gaps. A little is buffered first; where VibeVoice is slower than real time
 * (on a CPU), enough that the rest plays without stopping. Stopping aborts the
 * request, which stops the generation on the server. The first use asks
 * before downloading the model.
 */

import { getJson, postJson } from './api.js';
import { confirmDialog, toast } from './dialogs.js';
import { dictationEvent, dictationStatus, onDictation } from './dictation.js';

let playing = null; // {stop}

/** Stops what is being read aloud. */
export function stopSpeaking() {
  playing?.stop();
}

/** Whether something is being read aloud (or generated to be). */
export function speaking() {
  return !!playing;
}

/** Downloads VibeVoice after asking; resolves false when it is not wanted or fails. */
export async function ensureVoice() {
  let s = dictationStatus() ?? (await getJson('/api/dictation'));
  dictationEvent(s);
  if (s.voice.state !== 'missing' && s.voice.state !== 'error' && s.voice.state !== 'installing') return true;
  if (s.voice.state !== 'installing') {
    const gb = (s.voice.downloadSize / 1e9).toFixed(1);
    if (!(await confirmDialog('Download the voice model?', `VibeVoice reads replies aloud on this computer. It downloads once (${gb} GB).`, 'Download'))) return false;
    s = await postJson('/api/dictation', { action: 'install-voice' });
    dictationEvent(s);
  }
  const done = await new Promise((resolve) => {
    const check = (st) => st.voice.state !== 'installing' && (stop(), resolve(st));
    const stop = onDictation(check);
    check(s);
  });
  if (done.voice.state === 'error' || done.voice.state === 'missing') {
    toast(`The voice model could not be downloaded: ${done.voice.error ?? 'unknown error'}`, { symbol: 'exclamationmark.triangle', timeout: 5000 });
    return false;
  }
  return true;
}

/** VibeVoice's rate (web/src/dictation.ts SPEECH_RATE). */
const RATE = 24000;
/** Buffered before playing starts, in seconds, when the audio comes faster than real time; at most MAX_LEAD otherwise. */
const LEAD = 0.3;
const MAX_LEAD = 60;

let context = null;

/** One AudioContext, resumed while the tap that asked for speech still counts as a user gesture. */
function audioContext() {
  context ??= new (window.AudioContext || window.webkitAudioContext)();
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

/**
 * Reads text aloud as it is made. Resolves when it has finished playing (or
 * was stopped); rejects when it could not be generated.
 * @param {string} text
 */
export async function speak(text) {
  stopSpeaking();
  const ctx = audioContext();
  const abort = new AbortController();
  const sources = new Set();
  let finish = () => {};
  const finished = new Promise((resolve) => (finish = resolve));
  const me = {
    stop() {
      abort.abort();
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          // not started
        }
      }
      sources.clear();
      if (playing === me) playing = null;
      finish();
    },
  };
  playing = me;
  if (!(await ensureVoice()) || abort.signal.aborted) return me.stop();
  let res;
  try {
    res = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, stream: true }), signal: abort.signal });
  } catch (error) {
    if (abort.signal.aborted) return;
    me.stop();
    throw error;
  }
  if (!res.ok) {
    me.stop();
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }

  let next = 0; // when the next piece starts, in the context's time; 0 while buffering
  let waiting = []; // pieces buffered before playing (again)
  let buffered = 0;
  let last = null;
  const play = (buffer) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(next);
    next += buffer.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
    last = src;
  };
  const flush = () => {
    next = ctx.currentTime + 0.05;
    for (const b of waiting) play(b);
    waiting = [];
    buffered = 0;
  };
  // How fast the audio comes (seconds of it a second, after the first piece),
  // and about how much there will be (speech is about 15 characters a second;
  // this errs long).
  const expected = text.length / 15;
  let firstAt = 0;
  let since = 0;
  let pieces = 0;
  let scheduled = 0;
  /** What to buffer before playing: on a slow computer, enough that the rest plays without stopping. */
  const lead = () => {
    const rate = since / Math.max(0.001, (performance.now() - firstAt) / 1000);
    if (rate >= 1.1) return LEAD;
    const rest = Math.max(0, expected - scheduled);
    return Math.min(MAX_LEAD, Math.max(LEAD, rest * (1 - rate) * 1.1));
  };
  const piece = (samples) => {
    const buffer = ctx.createBuffer(1, samples.length, RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
    if (pieces++ === 0) firstAt = performance.now();
    else since += buffer.duration;
    // Ran dry: buffer again before going on.
    if (next && next < ctx.currentTime + 0.01) next = 0;
    if (next) {
      scheduled += buffer.duration;
      return play(buffer);
    }
    waiting.push(buffer);
    buffered += buffer.duration;
    if (pieces >= 3 && buffered >= lead()) {
      scheduled += buffered;
      flush();
    }
  };

  let carry = null; // an odd byte left from the last chunk
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes = value;
      if (carry) {
        bytes = new Uint8Array(value.length + 1);
        bytes[0] = carry[0];
        bytes.set(value, 1);
        carry = null;
      }
      const even = bytes.length - (bytes.length % 2);
      if (even < bytes.length) carry = bytes.slice(even);
      if (even) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, even);
        const samples = new Int16Array(even / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
        piece(samples);
      }
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    me.stop();
    throw error;
  }
  if (waiting.length) flush();
  if (!last) return me.stop();
  // Done when the last piece has played (it may have already).
  setTimeout(() => playing === me && me.stop(), Math.max(0, next - ctx.currentTime) * 1000 + 100);
  await finished;
}
