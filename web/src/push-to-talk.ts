/**
 * Push-to-talk: hold the hotkey (Settings → Push to Talk, F13 by default)
 * anywhere on this computer to dictate, let go to have what you said typed
 * into the window that has the focus. The speech to text is dictation's
 * (Qwen3-ASR through audio.cpp, kept loaded: dictation.ts); the rest is here:
 *
 *   - the hotkey and the typing, in a process of their own (KeyboardProcess).
 *     On Windows, SfAgents.Input.exe (web/native/windows-input), which the
 *     administrator approval at startup runs elevated (privileges.ts) so
 *     that apps running as administrator get the text too; it types with
 *     SendInput, as Unicode characters. On macOS and Linux, keyboard-worker.ts
 *     (libuiohook; the text pasted on macOS, typed with xdotool, wtype or
 *     ydotool on Linux). macOS asks once for Accessibility access (for the
 *     terminal SF Agents runs in). On Linux the hook needs X11: under Wayland
 *     it sees XWayland apps only.
 *   - the microphone, 16 kHz mono (PvRecorder), and the chimes at the start
 *     and the end of each recording (PvSpeaker, web/sounds).
 *
 * The native modules are optional dependencies: without one, push-to-talk
 * says why in the log and the rest of SF Agents is unaffected.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { getErrorMessage, parseHotkey, type Hotkey } from '@sfagents/core';
import { sensorEnvironment } from './sensor-process.js';

export const WINDOWS_INPUT_EXE = fileURLToPath(new URL(`../native/bin/win-${process.arch}/SfAgents.Input.exe`, import.meta.url));
export const SOUNDS_DIR = fileURLToPath(new URL('../sounds/', import.meta.url));

const SAMPLE_RATE = 16_000;
/** Shorter than this, a press was not speech. */
const MIN_SECONDS = 0.3;
/** The longest recording kept (Qwen3-ASR handles a few minutes well). */
const MAX_SECONDS = 5 * 60;

export interface PushToTalkStatus {
  state: 'off' | 'unavailable' | 'idle' | 'recording' | 'transcribing';
  hotkey: string;
  /** Why it is unavailable, or the last failure. */
  error?: string;
  /** Windows: whether the keyboard program runs with administrator rights. */
  elevated?: boolean;
}

/** The hotkey and the typing. */
export interface Keyboard {
  setHotkey(hotkey: Hotkey | null): void;
  type(text: string): Promise<void>;
  close(): void;
  readonly elevated?: boolean;
}

export interface KeyboardEvents {
  down: () => void;
  up: () => void;
  /** The keyboard stopped working (and why). */
  failed: (error: Error) => void;
  log: (line: string) => void;
}

export interface Microphone {
  start(): void;
  /** Stops and returns what was recorded: 16 kHz mono PCM. */
  stop(): Promise<Int16Array>;
  close(): void;
}

export interface Chimes {
  play(which: 'start' | 'stop'): void;
  close(): void;
}

export interface PushToTalkOptions {
  transcribe: (wav: Buffer) => Promise<string>;
  keyboard?: (events: KeyboardEvents) => Keyboard;
  microphone?: () => Microphone;
  chimes?: () => Chimes;
  log?: (line: string) => void;
  onChange?: (status: PushToTalkStatus) => void;
  /** Windows: the elevated keyboard program's pipe, from the approval at startup. */
  elevated?: { pipe: string; approved: Promise<boolean> };
}

export class PushToTalk {
  private status_: PushToTalkStatus = { state: 'off', hotkey: 'Off' };
  private hotkey: Hotkey | null = null;
  private keyboard: Keyboard | null = null;
  private microphone: Microphone | null = null;
  private chimes: Chimes | null = null;
  private recording = false;
  private session: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: PushToTalkOptions) {}

  status(): PushToTalkStatus {
    return this.status_;
  }

  private set(patch: Partial<PushToTalkStatus>): void {
    this.status_ = { ...this.status_, ...patch };
    if (!('error' in patch) && patch.state && patch.state !== 'unavailable') delete this.status_.error;
    this.options.onChange?.(this.status_);
  }

  private log(line: string): void {
    this.options.log?.(`push-to-talk: ${line}`);
  }

  /** Applies a hotkey setting ("F13", "Ctrl+Shift+Space", "Off"). Starts the keyboard the first time. */
  setHotkey(value: string): void {
    if (this.closed) return;
    let hotkey: Hotkey | null;
    try {
      hotkey = parseHotkey(value);
    } catch (error) {
      this.log(`the hotkey "${value}" is not valid (${getErrorMessage(error)}); push-to-talk is off.`);
      hotkey = null;
    }
    this.hotkey = hotkey;
    const name = hotkey ? [...hotkey.modifiers, hotkey.key].join('+') : 'Off';
    // The keyboard program starts even with the hotkey off: on Windows the
    // elevated one, started by the approval at startup, waits for it only so long.
    if (!this.keyboard) {
      try {
        this.keyboard = (this.options.keyboard ?? ((events) => defaultKeyboard(events, this.options.elevated)))({
          down: () => this.pressed(),
          up: () => this.released(),
          failed: (error) => {
            this.keyboard = null;
            this.set({ state: 'unavailable', error: error.message });
            this.log(error.message);
          },
          log: (line) => this.log(line),
        });
      } catch (error) {
        this.set({ state: hotkey ? 'unavailable' : 'off', hotkey: name, error: getErrorMessage(error) });
        this.log(`${getErrorMessage(error)}`);
        return;
      }
    }
    this.keyboard.setHotkey(hotkey);
    if (name !== this.status_.hotkey || this.status_.state === 'off' || this.status_.state === 'unavailable')
      this.log(hotkey ? `hold ${name} to dictate${this.keyboard.elevated ? ' (into apps running as administrator too)' : ''}.` : 'off.');
    this.set({ state: !hotkey ? 'off' : this.recording ? 'recording' : 'idle', hotkey: name, elevated: this.keyboard.elevated });
  }

  private pressed(): void {
    if (this.recording || this.closed || !this.hotkey) return;
    try {
      this.microphone ??= (this.options.microphone ?? defaultMicrophone)();
      this.microphone.start();
    } catch (error) {
      this.microphone?.close();
      this.microphone = null;
      this.set({ state: 'idle', error: `The microphone could not be opened: ${getErrorMessage(error)}` });
      this.log(this.status_.error!);
      return;
    }
    this.recording = true;
    // The chime once the microphone is recording, so it means "speak now".
    this.chime('start');
    this.set({ state: 'recording' });
  }

  private released(): void {
    if (!this.recording) return;
    this.recording = false;
    const mic = this.microphone!;
    const stopped = mic.stop().finally(() => this.chime('stop'));
    stopped.catch(() => {});
    // The recordings are transcribed and typed one at a time, in order.
    this.session = this.session.then(async () => {
      let pcm: Int16Array;
      try {
        pcm = await stopped;
      } catch (error) {
        if (this.microphone === mic) {
          mic.close();
          this.microphone = null;
        }
        this.set({ state: this.recording ? 'recording' : 'idle', error: `Recording failed: ${getErrorMessage(error)}` });
        return;
      }
      // Given silence (and the start chime, which the microphone hears), the
      // model makes something up: what has no speech in it is not sent.
      if (pcm.length < SAMPLE_RATE * MIN_SECONDS || !hasSpeech(pcm, SAMPLE_RATE)) {
        if (pcm.length >= SAMPLE_RATE * MIN_SECONDS) this.log('nothing was said.');
        this.set({ state: 'idle' });
        return;
      }
      this.set({ state: 'transcribing' });
      try {
        const text = (await this.options.transcribe(pcmToWav(pcm.subarray(0, SAMPLE_RATE * MAX_SECONDS), SAMPLE_RATE))).trim();
        if (text && !isFiller(text) && this.keyboard) await this.keyboard.type(text);
        this.set({ state: this.recording ? 'recording' : 'idle' });
      } catch (error) {
        this.set({ state: this.recording ? 'recording' : 'idle', error: getErrorMessage(error) });
        this.log(getErrorMessage(error));
      }
    });
  }

  private chime(which: 'start' | 'stop'): void {
    try {
      this.chimes ??= (this.options.chimes ?? defaultChimes)();
      this.chimes.play(which);
    } catch (error) {
      this.chimes = null;
      this.log(`the chime could not be played: ${getErrorMessage(error)}`);
    }
  }

  close(): void {
    this.closed = true;
    this.recording = false;
    this.keyboard?.close();
    this.keyboard = null;
    this.microphone?.close();
    this.microphone = null;
    this.chimes?.close();
    this.chimes = null;
  }
}

// -------------------------------------------------------------------- audio

/** An answer that is only a hesitation or punctuation ("嗯。", "Um.") is not worth typing. */
export function isFiller(text: string): boolean {
  const bare = text.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
  return !bare || /^(?:嗯|呃|啊|哦|um+|uh+|hm+|mm+|ah+|er+)+$/u.test(bare);
}

/** The start chime as the microphone may hear it (its lead-in and its length), with some echo. */
const CHIME_SECONDS = 0.7;

/**
 * Whether a recording has speech in it: at least a quarter of a second, after
 * the start chime, clearly louder (10 dB) than the recording's own quiet
 * parts and than a floor that room noise stays under.
 */
export function hasSpeech(pcm: Int16Array, rate: number): boolean {
  const frame = Math.round(rate * 0.03);
  const levels: number[] = [];
  for (let at = 0; at + frame <= pcm.length; at += frame) {
    let sum = 0;
    for (let i = at; i < at + frame; i++) sum += pcm[i]! * pcm[i]!;
    levels.push(Math.sqrt(sum / frame));
  }
  const after = levels.slice(Math.ceil(CHIME_SECONDS / 0.03));
  if (!after.length) return false;
  const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.1)]!;
  const threshold = Math.max(floor * Math.sqrt(10), 150);
  return after.filter((l) => l > threshold).length * 0.03 >= 0.25;
}

/** 16-bit mono PCM as a WAV file. */
export function pcmToWav(pcm: Int16Array, rate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** The samples and rate of a 16-bit mono PCM WAV file. */
export function readWav(wav: Buffer): { rate: number; samples: Int16Array } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let rate = 0;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (wav.readUInt16LE(body) !== 1 || wav.readUInt16LE(body + 2) !== 1 || wav.readUInt16LE(body + 14) !== 16) throw new Error('not 16-bit mono PCM');
      rate = wav.readUInt32LE(body + 4);
    } else if (id === 'data') {
      if (!rate) throw new Error('no format before the data');
      const bytes = wav.subarray(body, Math.min(wav.length, body + size));
      const samples = new Int16Array(Math.floor(bytes.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
      return { rate, samples };
    }
    at = body + size + (size % 2);
  }
  throw new Error('no audio data');
}

const require = createRequire(import.meta.url);

function optional<T>(load: () => unknown, name: string, what: string): T {
  try {
    return load() as T;
  } catch (error) {
    throw new Error(`${what} is not installed (${name}: ${getErrorMessage(error).split('\n')[0]}). Reinstall SF Agents with its optional dependencies.`);
  }
}

interface PvRecorderClass {
  new (frameLength: number, deviceIndex?: number): { start(): void; stop(): void; read(): Promise<Int16Array>; release(): void; readonly sampleRate: number };
}

/** The default microphone, through PvRecorder (16 kHz mono, as Qwen3-ASR wants it). */
export function defaultMicrophone(): Microphone {
  const { PvRecorder } = optional<{ PvRecorder: PvRecorderClass }>(() => require(require.resolve('@picovoice/pvrecorder-node')), '@picovoice/pvrecorder-node', 'The microphone library');
  const rec = new PvRecorder(512, -1);
  // Each recording is a session; a new one starts once the last has stopped reading.
  let chain: Promise<void> = Promise.resolve();
  let current: { frames: Int16Array[]; on: boolean; error?: unknown } | null = null;
  return {
    start() {
      const s: { frames: Int16Array[]; on: boolean; error?: unknown } = { frames: [], on: true };
      current = s;
      chain = chain.then(async () => {
        if (!s.on) return;
        try {
          rec.start();
          while (s.on) {
            const frame = await rec.read();
            if (s.frames.length * 512 < SAMPLE_RATE * MAX_SECONDS) s.frames.push(frame);
          }
        } catch (error) {
          s.error = error;
        } finally {
          try {
            rec.stop();
          } catch {
            // not recording
          }
        }
      });
    },
    async stop() {
      const s = current;
      current = null;
      if (!s) return new Int16Array(0);
      s.on = false;
      // The read in flight finishes with the next frame (32 ms).
      await chain;
      if (s.error) throw s.error;
      const out = new Int16Array(s.frames.reduce((n, f) => n + f.length, 0));
      let at = 0;
      for (const f of s.frames) {
        out.set(f, at);
        at += f.length;
      }
      return out;
    },
    close() {
      if (current) current.on = false;
      void chain.then(() => {
        try {
          rec.release();
        } catch {
          // already released
        }
      });
    },
  };
}

interface PvSpeakerClass {
  new (sampleRate: number, bitsPerSample: number, options?: { bufferSizeSecs?: number; deviceIndex?: number }): { start(): void; stop(): void; write(pcm: ArrayBuffer): number; release(): void };
}

const LEAD_IN_SECONDS = 0.15;

/** How long the speaker stays open after a chime (opening it for each one can clip the chime's start). */
const SPEAKER_IDLE_MS = 30_000;

/** The chimes, through PvSpeaker. */
export function defaultChimes(): Chimes {
  const { PvSpeaker } = optional<{ PvSpeaker: PvSpeakerClass }>(() => require(require.resolve('@picovoice/pvspeaker-node')), '@picovoice/pvspeaker-node', 'The sound library');
  const sounds = {
    start: readWav(fs.readFileSync(`${SOUNDS_DIR}ptt-start.wav`)),
    stop: readWav(fs.readFileSync(`${SOUNDS_DIR}ptt-stop.wav`)),
  };
  const rate = sounds.start.rate;
  let speaker: InstanceType<PvSpeakerClass> | null = null;
  let idle: NodeJS.Timeout | null = null;
  const shut = () => {
    if (idle) clearTimeout(idle);
    idle = null;
    try {
      speaker?.stop();
      speaker?.release();
    } catch {
      // already gone
    }
    speaker = null;
  };
  return {
    play(which) {
      // A lead-in of silence: an output that is starting, or waking from its
      // power saving (Bluetooth, USB), loses its first moments, and they should
      // not be the chime's.
      const samples = new Int16Array(Math.round(rate * LEAD_IN_SECONDS) + sounds[which].samples.length);
      samples.set(sounds[which].samples, samples.length - sounds[which].samples.length);
      if (!speaker) {
        speaker = new PvSpeaker(rate, 16, { bufferSizeSecs: 2, deviceIndex: -1 });
        speaker.start();
      }
      try {
        speaker.write(samples.buffer);
      } catch {
        // The output device changed or went away: open the current one.
        shut();
        speaker = new PvSpeaker(rate, 16, { bufferSizeSecs: 2, deviceIndex: -1 });
        speaker.start();
        speaker.write(samples.buffer);
      }
      if (idle) clearTimeout(idle);
      idle = setTimeout(shut, SPEAKER_IDLE_MS);
      idle.unref?.();
    },
    close: shut,
  };
}

// -------------------------------------------------------------------- keyboards

/** Windows' virtual keys for the hotkey names (core/src/settings/hotkey.ts). */
export function windowsVirtualKey(key: string): number {
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0);
  const f = /^F(\d+)$/.exec(key);
  if (f) return 0x6f + Number(f[1]);
  const n = /^Numpad(\d)$/.exec(key);
  if (n) return 0x60 + Number(n[1]);
  const vk: Record<string, number> = {
    Space: 0x20, Enter: 0x0d, Tab: 0x09, Backspace: 0x08, Escape: 0x1b, Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, PrintScreen: 0x2c,
    NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
    Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
    CtrlRight: 0xa3, AltRight: 0xa5, ShiftRight: 0xa1, MetaRight: 0x5c,
  };
  const code = vk[key];
  if (code === undefined) throw new Error(`no Windows key for ${key}`);
  return code;
}

export function modifierMask(hotkey: Hotkey): number {
  const bits = { Ctrl: 1, Alt: 2, Shift: 4, Meta: 8 } as const;
  return hotkey.modifiers.reduce((m, k) => m | bits[k], 0);
}

function defaultKeyboard(events: KeyboardEvents, elevated?: PushToTalkOptions['elevated']): Keyboard {
  if (process.platform === 'win32' && fs.existsSync(WINDOWS_INPUT_EXE)) return new KeyboardProcess(events, { exe: WINDOWS_INPUT_EXE, elevated, hotkeyLine: windowsHotkeyLine });
  if (process.platform === 'linux' && !process.env['DISPLAY']) throw new Error('Push-to-talk needs an X11 (or XWayland) desktop session; none was found (DISPLAY is not set).');
  try {
    require.resolve('uiohook-napi');
  } catch (error) {
    throw new Error(`The keyboard hook library is not installed (uiohook-napi: ${getErrorMessage(error).split('\n')[0]}). Reinstall SF Agents with its optional dependencies.`);
  }
  return new KeyboardProcess(events, { exe: process.execPath, args: [KEYBOARD_WORKER], hotkeyLine: namedHotkeyLine });
}

export const KEYBOARD_WORKER = fileURLToPath(new URL('./keyboard-worker.js', import.meta.url));

/** SfAgents.Input.exe's hotkey line: Windows' virtual key. */
export function windowsHotkeyLine(h: Hotkey | null): string {
  return h ? `hotkey ${windowsVirtualKey(h.key)} ${modifierMask(h)}` : 'hotkey 0 0';
}

/** keyboard-worker.js's hotkey line: the key's name. */
export function namedHotkeyLine(h: Hotkey | null): string {
  return h ? `hotkey ${h.key} ${modifierMask(h)}` : 'hotkey Off 0';
}

/**
 * The keyboard program, in a process of its own: SfAgents.Input.exe on
 * Windows (elevated through its broker when the approval at startup was
 * given, else at the user's level), keyboard-worker.js elsewhere. Their
 * protocol is in keyboard-worker.ts. One that stops is started again.
 */
export class KeyboardProcess implements Keyboard {
  private child: ChildProcessWithoutNullStreams | null = null;
  private hotkey: Hotkey | null = null;
  private typing: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private elevatedVia: PushToTalkOptions['elevated'];
  private closed = false;
  private failures = 0;
  private readyOnce = false;
  elevated = false;

  constructor(
    private readonly events: KeyboardEvents,
    private readonly options: { exe: string; args?: string[]; elevated?: PushToTalkOptions['elevated']; hotkeyLine: (h: Hotkey | null) => string },
  ) {
    this.elevatedVia = options.elevated;
    void this.elevatedVia?.approved.then(
      (ok) => {
        if (!ok) this.dropElevated();
      },
      () => this.dropElevated(),
    );
    this.launch();
  }

  private dropElevated(): void {
    if (!this.elevatedVia || this.closed) return;
    this.elevatedVia = undefined;
    this.child?.kill();
  }

  private launch(): void {
    const via = this.elevatedVia;
    const args = via ? ['--broker', via.pipe] : (this.options.args ?? []);
    this.elevated = Boolean(via);
    const child = spawn(this.options.exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: keyboardEnvironment(process.env) });
    this.child = child;
    // An elevated worker that never connects (the approval is still showing,
    // or it gave up waiting): after a while, carry on at the user's level.
    const waiting = via ? setTimeout(() => {
      if (this.child === child && this.elevatedVia && !this.readyOnce) {
        this.events.log('the elevated keyboard program did not connect; running it without administrator rights.');
        child.kill();
      }
    }, 150_000) : null;
    waiting?.unref?.();
    child.once('exit', () => {
      if (waiting) clearTimeout(waiting);
    });
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    child.stdout.on('data', (d: Buffer) => {
      buffered += decoder.write(d);
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (this.child === child) this.onLine(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => this.events.log(d.toString().trim().slice(0, 2000)));
    let gone = false;
    const exit = (why: string) => {
      if (gone) return;
      gone = true;
      if (this.child !== child) return;
      this.child = null;
      for (const t of this.typing.splice(0)) t.reject(new Error('The keyboard program stopped while typing.'));
      if (this.closed) return;
      if (this.elevatedVia) {
        // The elevated worker is gone (or never came): carry on at the user's level.
        this.events.log(`the elevated keyboard program stopped (${why}); apps running as administrator will not get the text.`);
        this.elevatedVia = undefined;
        this.launch();
        return;
      }
      if (++this.failures > 3) {
        this.events.failed(new Error(`The keyboard program keeps stopping (${why}).`));
        return;
      }
      setTimeout(() => {
        if (!this.closed && !this.child) this.launch();
      }, 2000).unref?.();
    };
    child.on('error', (e) => exit(e.message));
    child.on('exit', (code) => exit(`exit code ${code ?? 'signal'}`));
    child.stdin.on('error', () => {});
  }

  private send(line: string): void {
    this.child?.stdin.write(`${line}\n`);
  }

  private onLine(line: string): void {
    if (line === 'ready') {
      this.failures = 0;
      this.readyOnce = true;
      this.send(this.options.hotkeyLine(this.hotkey));
    } else if (line === 'down') this.events.down();
    else if (line === 'up') this.events.up();
    else if (line === 'typed') this.typing.shift()?.resolve();
    else if (line.startsWith('error ')) {
      const t = this.typing.shift();
      if (t) t.reject(new Error(line.slice(6)));
      else this.events.log(line.slice(6));
    } else if (line.startsWith('warning ')) this.events.log(line.slice(8));
  }

  setHotkey(hotkey: Hotkey | null): void {
    this.hotkey = hotkey;
    this.send(this.options.hotkeyLine(hotkey));
  }

  type(text: string): Promise<void> {
    if (!this.child) return Promise.reject(new Error('The keyboard program is not running.'));
    return new Promise((resolve, reject) => {
      this.typing.push({ resolve, reject });
      this.send(`type ${Buffer.from(text, 'utf8').toString('base64')}`);
    });
  }

  close(): void {
    this.closed = true;
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
  }
}

/** What the keyboard program gets of SF Agents' environment: no provider keys; the desktop session's variables. */
export function keyboardEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const desktop = /^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|DBUS_SESSION_BUS_ADDRESS|YDOTOOL_SOCKET)$/;
  return { ...sensorEnvironment(env), ...Object.fromEntries(Object.entries(env).filter(([k, v]) => desktop.test(k) && v !== undefined)) };
}
