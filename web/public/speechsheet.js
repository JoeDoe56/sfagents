/**
 * Settings → STT & TTS: the two speech models on the computer (Qwen3-ASR for
 * dictation, Qwen3-TTS for reading replies aloud) and their settings: the
 * glossary Qwen3-ASR should know, the reference voice Qwen3-TTS copies, and
 * where each model runs (chosen at each start:
 * dictation.ts). The check button saves the settings; the voice clip and the
 * model download happen at once, like adding a provider.
 */

import { getJson, postJson } from './api.js';
import { openSheet } from './modalsheet.js';
import { showMenu } from './menu.js';
import { confirmDialog, showError, toast } from './dialogs.js';
import { dictationEvent, dictationStatus, onDictation, toWav } from './dictation.js';
import { ensureVoice, speak, stopSpeaking } from './speech.js';
import { createRow, createSection } from './vendor/sfgl/src/ui/index.js';

const KEYS = ['dictation.glossary', 'speech.referenceText'];
/** Qwen3-TTS's rate; it uses the clip's first 15 seconds (cut at a pause: dictation.ts). */
const CLIP_RATE = 24000;
const CLIP_SECONDS = 60;
const SAMPLE = 'Hello! This is how I sound when I read your replies aloud.';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;

/** Where a model runs: "GPU (NVIDIA GeForce GTX 1660 SUPER)", "CPU (6 threads)". */
function where(s, on) {
  const p = s?.placement;
  if (!p || !on) return s?.device ?? s?.backend ?? 'this computer';
  if (on === 'cpu') return `CPU (${p.threads} thread${p.threads === 1 ? '' : 's'})`;
  return s.device && s.device !== 'CPU' ? `GPU (${s.device})` : 'GPU';
}

/** One line on what a model is doing. */
function asrLine(s) {
  if (!s) return '';
  if (s.state === 'installing') return s.progress ? `Downloading… ${Math.round((100 * s.progress.done) / Math.max(1, s.progress.total))}%` : 'Setting up…';
  if (s.state === 'running') return `Loaded on ${where(s, s.placement?.asr)}`;
  if (s.state === 'starting') return 'Loading…';
  if (s.state === 'ready') return 'Downloaded, not loaded';
  if (s.state === 'error') return `Not working: ${s.error ?? 'unknown error'}`;
  return `Not downloaded yet (${gb(s.downloadSize)})`;
}

function voiceLine(s) {
  const v = s?.voice;
  if (!v) return '';
  if (v.state === 'installing') return v.progress ? `Downloading… ${Math.round((100 * v.progress.done) / Math.max(1, v.progress.total))}%` : 'Downloading…';
  if (v.state === 'speaking') return 'Speaking…';
  if (v.state === 'loaded') return `Loaded on ${where(s, s.placement?.tts)}`;
  if (v.state === 'ready') return s.state === 'starting' ? 'Loading…' : 'Downloaded, not loaded';
  if (v.state === 'error') return `Not working: ${v.error ?? 'unknown error'}`;
  return `Not downloaded yet (${gb(v.downloadSize)})`;
}

/** "Speech to text: CPU (6 threads) · Text to speech: GPU (…)" */
function placeLine(s) {
  const p = s?.placement;
  if (!p || s.state !== 'running') return s?.state === 'starting' ? 'Loading…' : 'Not loaded';
  return [`Speech to text: ${where(s, p.asr)}`, ...(p.tts ? [`Text to speech: ${where(s, p.tts)}`] : [])].join(' · ');
}

/**
 * @param {{settings: {key: string, value: any, min?: number, max?: number, step?: number, hint: string}[], onSaved?: (server: object) => void}} o
 */
export function openSpeechSheet(o) {
  const spec = Object.fromEntries(o.settings.filter((s) => KEYS.includes(s.key)).map((s) => [s.key, s]));
  const saved = Object.fromEntries(KEYS.map((k) => [k, spec[k]?.value]));
  const draft = { ...saved };
  let status = dictationStatus();
  let asrRow, voiceRow, clipRow, sampleRow, placeRow, textRow, againRow;
  let stop = () => {};

  const ctx = openSheet({
    title: 'STT & TTS',
    detents: ['large'],
    className: 'st-sheet',
    z: 1200,
    build(sheet) {
      // Speech to text.
      asrRow = createRow({ icon: 'mic.fill', iconTint: '#0a84ff', title: 'Qwen3-ASR 1.7B', subtitle: asrLine(status), wrap: true });
      const glossary = createRow({
        title: 'Glossary',
        wrap: true,
        input: { value: String(draft['dictation.glossary'] ?? ''), placeholder: 'SF Agents, Tailscale, …', onInput: (v) => set('dictation.glossary', v) },
      });
      // Text to speech.
      voiceRow = createRow({ icon: 'waveform', iconTint: '#ff9f0a', title: 'Qwen3-TTS 1.7B', subtitle: voiceLine(status), wrap: true, onTap: () => voiceMenu() });
      clipRow = createRow({ title: 'Reference Voice', subtitle: '', wrap: true, accessory: 'ellipsis', onTap: () => clipMenu() });
      // What is said in the clip: filled in by Qwen3-ASR, correctable.
      textRow = createRow({
        title: 'Transcript',
        wrap: true,
        input: { value: String(draft['speech.referenceText'] ?? ''), placeholder: 'Filled in from the clip', onInput: (v) => set('speech.referenceText', v) },
      });
      againRow = createRow({ title: 'Transcribe Again', tintTitle: true, onTap: () => transcribeAgain() });
      sampleRow = createRow({ title: 'Play a Sample', tintTitle: true, onTap: () => playSample() });
      // Where they run.
      placeRow = createRow({ icon: 'gauge', iconTint: '#8e8e93', title: 'Placement', subtitle: placeLine(status), wrap: true });
      sheet.body.append(
        createSection({ title: 'Speech to Text', rows: [asrRow, glossary], note: spec['dictation.glossary']?.hint }).el,
        createSection({ title: 'Text to Speech', rows: [voiceRow, clipRow, textRow, againRow, sampleRow], note: 'The reference voice is a clean recording of one speaker, at least 10 seconds long; Qwen3-TTS copies its voice from its first 15 seconds and their transcript. Qwen3-ASR writes the transcript when the clip is set; correct it where it misheard. Without a clip, replies are not read aloud.' }).el,
        createSection({ title: 'Where They Run', rows: [placeRow], note: 'Both models load when SF Agents starts and stay loaded. Each start puts them where they fit with room to spare: both on the graphics card; else Qwen3-TTS on the graphics card and Qwen3-ASR on the processor, where it is still faster than real time; else both on the processor.' }).el,
      );
    },
    onConfirm: async () => {
      const values = {};
      for (const k of KEYS) if (String(draft[k]) !== String(saved[k])) values[k] = draft[k];
      if (!Object.keys(values).length) return true;
      try {
        o.onSaved?.(await postJson('/api/settings', { values }));
        return true;
      } catch (error) {
        showError(error.message, "Couldn't save the settings");
        return false;
      }
    },
    onClose: () => {
      stop();
      stopSpeaking();
    },
  });

  function set(key, value) {
    draft[key] = value;
    ctx.setDirty(KEYS.some((k) => String(draft[k]) !== String(saved[k])));
  }

  function render() {
    asrRow?.setSubtitle(asrLine(status));
    placeRow?.setSubtitle(placeLine(status));
    voiceRow?.update({ subtitle: voiceLine(status), accessory: status?.voice && (status.voice.state === 'missing' || status.voice.state === 'error') ? 'chevron' : 'none' });
    clipRow?.setSubtitle(status?.voice?.reference ? 'Set: Qwen3-TTS copies this voice' : 'None: set one to have replies read aloud');
    sampleRow?.setDisabled(!status?.voice || status.voice.state === 'installing' || status.voice.state === 'speaking');
    againRow?.update({ title: status?.voice?.transcribing ? 'Transcribing…' : 'Transcribe Again' });
    againRow?.setDisabled(!status?.voice?.reference || !!status.voice.transcribing);
    // A new transcript (a new clip, or transcribed again) shows in the field, unless the user is editing it.
    const heard = status?.voice?.transcript;
    const key = 'speech.referenceText';
    if (heard && heard !== saved[key] && String(draft[key] ?? '') === String(saved[key] ?? '')) {
      saved[key] = draft[key] = heard;
      if (textRow?.input) textRow.input.value = heard;
    }
    ctx.refresh?.();
  }

  async function voiceMenu() {
    const v = status?.voice;
    if (v && (v.state === 'missing' || v.state === 'error')) await ensureVoice();
  }

  function clipMenu() {
    const has = status?.voice?.reference;
    showMenu({
      anchor: clipRow.el,
      align: 'end',
      groups: [
        [{ label: has ? 'Replace Clip…' : 'Choose a Clip…', symbol: 'folder', action: () => chooseClip() }],
        has ? [{ label: 'Play Clip', symbol: 'play.fill', action: () => playClip() }] : [],
        has ? [{ label: 'Remove Clip', symbol: 'trash', role: 'destructive', action: () => removeClip() }] : [],
      ],
    });
  }

  function chooseClip() {
    const input = el('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus,.webm';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        // Whatever the format, Qwen3-TTS gets a mono WAV at its own rate.
        const wav = await toWav(file, { rate: CLIP_RATE, maxSeconds: CLIP_SECONDS });
        const res = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        update(data);
        toast('Reference voice set', { symbol: 'checkmark', timeout: 2200 });
      } catch (error) {
        showError(error.name === 'EncodingError' ? 'The browser could not read that file as audio.' : error.message, "Couldn't set the voice clip");
      }
    });
    input.click();
  }

  async function playClip() {
    stopSpeaking();
    const audio = new Audio(`/api/voice?t=${Date.now()}`);
    audio.play().catch((error) => showError(error.message, "Couldn't play the clip"));
  }

  async function removeClip() {
    if (!(await confirmDialog('Remove the reference voice?', 'Replies are not read aloud without one.', 'Remove', true))) return;
    try {
      const res = await fetch('/api/voice', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      update(data);
    } catch (error) {
      showError(error.message, "Couldn't remove the clip");
    }
  }

  async function transcribeAgain() {
    try {
      const s = await postJson('/api/dictation', { action: 'transcribe-voice' });
      // The server saved it as the setting: it is the field's text now, edited or not.
      const key = 'speech.referenceText';
      const heard = s.voice?.transcript ?? '';
      saved[key] = draft[key] = heard;
      if (textRow?.input) textRow.input.value = heard;
      ctx.setDirty(KEYS.some((k) => String(draft[k]) !== String(saved[k])));
      update(s);
    } catch (error) {
      showError(error.message, "Couldn't transcribe the clip");
    }
  }

  async function playSample() {
    try {
      await speak(SAMPLE);
    } catch (error) {
      showError(error.message, "Couldn't speak");
    }
  }

  function update(s) {
    status = s;
    dictationEvent(s);
    render();
  }

  render();
  stop = onDictation((s) => {
    status = s;
    render();
  });
  if (!status) getJson('/api/dictation').then(update, () => {});
  return ctx;
}
