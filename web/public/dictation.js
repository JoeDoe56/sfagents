/**
 * The mic button: records speech in the browser and has the computer
 * transcribe it (Qwen3-ASR through llama.cpp; see web/src/dictation.ts).
 *
 * Tap to start, tap again to stop; the text goes in at the cursor. The first
 * use asks before downloading the model. Recording needs a secure origin
 * (localhost, or HTTPS such as Tailscale Serve).
 */

import { getJson, postJson } from './api.js';
import { confirmDialog, toast } from './dialogs.js';

const MAX_SECONDS = 300;

let status = null;
let installToast = null;
const waiters = new Set();

/** Server "dictation" events. */
export function dictationEvent(s) {
  status = s;
  if (s.state === 'installing' && s.progress) {
    const { label, done, total } = s.progress;
    const text = `Downloading ${label}… ${total ? `${(done / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB` : ''}`;
    if (!installToast) installToast = toast(text, { progress: total ? done / total : null, symbol: 'arrow.down' });
    else installToast.set(text, total ? done / total : null);
  } else if (installToast) {
    installToast.close(s.state === 'error' ? 0 : 400);
    installToast = null;
  }
  for (const w of waiters) w(s);
}

function waitFor(pred) {
  if (status && pred(status)) return Promise.resolve(status);
  return new Promise((resolve) => {
    const w = (s) => {
      if (!pred(s)) return;
      waiters.delete(w);
      resolve(s);
    };
    waiters.add(w);
  });
}

// ------------------------------------------------------------ audio → 16 kHz WAV

async function toWav(blob) {
  const data = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    ctx.close?.();
  }
  const rate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));
  const off = new OfflineAudioContext(1, frames, rate);
  const src = off.createBufferSource();
  src.buffer = decoded; // mixed down to mono by the one-channel context
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

// ------------------------------------------------------------ the button

/**
 * @param {{mic: HTMLElement, input: HTMLTextAreaElement, changed: () => void, notice: (text: string, level?: string) => void}} o
 */
export function setupDictation({ mic, input, changed, notice }) {
  let recorder = null;
  let stream = null;
  let timer = null;
  let busy = false;

  const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  if (!canRecord()) {
    mic.classList.add('unavailable');
    mic.title = window.isSecureContext ? 'This browser cannot record audio' : 'Dictation needs HTTPS or localhost';
  }

  function setState(state) {
    mic.classList.toggle('listening', state === 'recording');
    mic.classList.toggle('transcribing', state === 'transcribing');
    mic.setAttribute('aria-label', state === 'recording' ? 'Stop dictation' : state === 'transcribing' ? 'Transcribing' : 'Dictate');
  }

  function insert(text) {
    if (!text) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    input.value = before + lead + text + trail + after;
    const pos = (before + lead + text).length;
    input.setSelectionRange(pos, pos);
    changed();
  }

  async function ensureInstalled() {
    if (!status) status = await getJson('/api/dictation');
    if (status.state !== 'missing' && status.state !== 'error') return true;
    if (status.state === 'error' && status.downloadSize === 0) return true; // installed; the start failed: try again
    const gb = (status.downloadSize / 1e9).toFixed(1);
    const ok = await confirmDialog(
      'Set up dictation?',
      `This downloads the Qwen3-ASR speech model and llama.cpp (about ${gb} GB) to the computer SF Agents runs on, once. Your speech is transcribed there, on its GPU when it has one, and is not sent anywhere else.`,
      'Download',
    );
    if (!ok) return false;
    status = await postJson('/api/dictation', { action: 'install' });
    const done = await waitFor((s) => s.state === 'ready' || s.state === 'running' || s.state === 'error');
    if (done.state === 'error') {
      notice(`Dictation could not be set up: ${done.error}`, 'error');
      return false;
    }
    toast('Dictation is ready', { symbol: 'checkmark', timeout: 2200 });
    return true;
  }

  async function start() {
    if (!canRecord()) {
      notice(window.isSecureContext ? 'This browser cannot record audio.' : 'The microphone works only on a secure address: open SF Agents on localhost, or over HTTPS (for example Tailscale Serve).', 'error');
      return;
    }
    busy = true;
    try {
      if (!(await ensureInstalled())) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      notice(error?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the browser to dictate.' : `Dictation: ${error.message}`, 'error');
      return;
    } finally {
      busy = false;
    }
    // Load the model while you speak.
    postJson('/api/dictation', { action: 'start' }).catch(() => {});
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => finish(new Blob(chunks, { type: recorder?.mimeType || chunks[0]?.type || 'audio/webm' }));
    recorder.start();
    setState('recording');
    timer = setTimeout(stop, MAX_SECONDS * 1000);
  }

  function stop() {
    clearTimeout(timer);
    if (recorder?.state === 'recording') recorder.stop();
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
  }

  async function finish(blob) {
    recorder = null;
    setState('transcribing');
    busy = true;
    try {
      const wav = await toWav(blob);
      if (wav.size < 44 + 16000 * 2 * 0.3) return; // under a third of a second: nothing said
      const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      insert(data.text);
    } catch (error) {
      notice(`Dictation failed: ${error.message}`, 'error');
    } finally {
      busy = false;
      setState('idle');
    }
  }

  mic.addEventListener('click', () => {
    if (recorder) stop();
    else if (!busy) start();
  });
}
