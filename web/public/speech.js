/**
 * Text to speech: the computer reads text aloud with VibeVoice, in the
 * reference voice set in Settings → STT & TTS (web/src/dictation.ts). The
 * whole reply is generated, then played. The first use asks before
 * downloading the model.
 */

import { getJson, postJson } from './api.js';
import { confirmDialog, toast } from './dialogs.js';
import { dictationEvent, dictationStatus, onDictation } from './dictation.js';

let playing = null; // {audio, url, done}

/** Stops what is being read aloud. */
export function stopSpeaking() {
  if (!playing) return;
  playing.audio.pause();
  playing.done();
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

/**
 * Reads text aloud. Resolves when it has finished playing (or was stopped);
 * rejects when it could not be generated.
 * @param {string} text
 */
export async function speak(text) {
  stopSpeaking();
  if (!(await ensureVoice())) return;
  const res = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  await new Promise((resolve) => {
    const done = () => {
      if (playing?.audio === audio) playing = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    playing = { audio, done };
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });
    audio.play().catch(done);
  });
}
