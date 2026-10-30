/**
 * Speech on this computer, run by audio.cpp's audiocpp_server: speech to
 * text with Qwen3-ASR 1.7B (dictation and push-to-talk), and text to speech
 * with VibeVoice 1.5B (Speak Response). Both are audio.cpp's official Q8_0
 * GGUFs (huggingface.co/audio-cpp/audio.cpp-gguf).
 *
 * Nothing is bundled. The first use downloads, into <SF Agents home>/dictation:
 *   - an audio.cpp release build for this platform, GPU first: Metal on
 *     macOS; CUDA on Windows when an NVIDIA driver is present; else Vulkan
 *     when a Vulkan loader is; else the CPU build. When a GPU build cannot
 *     start or load the model, the next one is tried, down to the CPU build.
 *   - the Qwen3-ASR model (about 2.5 GB), checked against its SHA-256.
 * The VibeVoice model (about 3.2 GB) downloads only when it is asked for
 * (Settings → STT & TTS, or the first Speak Response).
 *
 * audiocpp_server then runs on a loopback port with both models in its
 * config. Qwen3-ASR loads when the server starts. With keepLoaded (the web
 * server's choice) the server starts with SF Agents and stays up, so neither
 * the mic button nor push-to-talk waits for the model, and it is started
 * again if it stops; otherwise it starts on demand and stops after ten idle
 * minutes to give the memory back. VibeVoice loads on its first use.
 *
 * Automatic model swap (Settings → STT & TTS), for GPUs without room for
 * both: Qwen3-ASR is unloaded while VibeVoice speaks, VibeVoice is unloaded
 * when it is done, and Qwen3-ASR is loaded again at once. Dictation that
 * comes in meanwhile waits for it. Without the swap both stay loaded.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getErrorMessage, sfagentsHome } from '@sfagents/core';

const MODEL_REPO = 'https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main';
export interface ModelFile {
  /** The path in the model repository; it is saved under models/ by its base name. */
  name: string;
  size: number;
  sha256: string;
}
export const ASR_MODEL: ModelFile = { name: 'Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf', size: 2_473_010_048, sha256: 'da4fc2ac7f24dee784d1684eb1f35836cdbf559519452ae11777670734c0a4f8' };
export const TTS_MODEL: ModelFile = { name: 'VibeVoice-1.5B-GGUF/vibevoice-1.5b-q8_0.gguf', size: 3_224_706_114, sha256: 'e9ca80a31ffe7e4726fcad9798ba10ba1e514d89174fd48ea548d21022e0e6f8' };
const RELEASES = 'https://api.github.com/repos/0xShug0/audio.cpp/releases?per_page=10';
/** A release known to run both models, used when the GitHub API cannot be reached. */
const FALLBACK_TAG = 'v0.9.2-drama3-base-small';
const IDLE_MS = 10 * 60_000;
const START_TIMEOUT_MS = 300_000;
/** The ids the models have in the server's config. */
const ASR_ID = 'qwen3-asr';
const TTS_ID = 'vibevoice';
/** What the old llama.cpp setup left in the folder, removed once audio.cpp runs. */
const LLAMA_LEFTOVERS = ['runtime', 'runtime.json', 'llama-server.log', 'models/Qwen3-ASR-1.7B-Q8_0.gguf', 'models/Qwen3-ASR-1.7B-Q8_0.gguf.part', 'models/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', 'models/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf.part'];

export type Backend = 'metal' | 'cuda' | 'vulkan' | 'cpu';

export interface RuntimeChoice {
  backend: Backend;
  /** Matches the release asset (the tag is not part of the pattern). */
  asset: RegExp;
  /** Extra archive with the CUDA runtime libraries, unpacked next to the binaries. */
  extra?: RegExp;
}

interface Progress {
  label: string;
  done: number;
  total: number;
}

export interface VoiceStatus {
  /** loaded: in memory now; speaking: generating. */
  state: 'missing' | 'installing' | 'ready' | 'loaded' | 'speaking' | 'error';
  /** Bytes still to download before first use. */
  downloadSize: number;
  progress?: Progress;
  error?: string;
  /** A reference voice clip is set. */
  reference: boolean;
}

export interface DictationStatus {
  state: 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'error';
  /** Bytes still to download before first use. */
  downloadSize: number;
  progress?: Progress;
  backend?: Backend;
  device?: string;
  error?: string;
  /** Text to speech (VibeVoice). */
  voice: VoiceStatus;
}

export interface SpeechSettings {
  /** Unload Qwen3-ASR while VibeVoice speaks, and VibeVoice afterwards. */
  autoSwap: boolean;
  /** VibeVoice's classifier-free guidance scale (0.5 to 3). */
  guidanceScale: number;
  /** Words Qwen3-ASR should know, separated by commas. */
  glossary: string;
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = { autoSwap: false, guidanceScale: 1.3, glossary: '' };

export interface Hardware {
  platform: NodeJS.Platform;
  arch: string;
  nvidia: boolean;
  vulkan: boolean;
}

function onPath(name: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  return dirs.some((d) => exts.some((e) => d && fs.existsSync(path.join(d, name + e))));
}

/** What this computer offers to run models on. */
export function detectHardware(): Hardware {
  const platform = process.platform;
  const arch = process.arch;
  let nvidia = false;
  let vulkan = false;
  if (platform === 'win32') {
    const sys = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
    nvidia = fs.existsSync(path.join(sys, 'nvcuda.dll'));
    vulkan = fs.existsSync(path.join(sys, 'vulkan-1.dll'));
  } else if (platform === 'linux') {
    nvidia = fs.existsSync('/proc/driver/nvidia/version') || onPath('nvidia-smi');
    const ld = spawnSync('ldconfig', ['-p'], { encoding: 'utf8', timeout: 3000 });
    vulkan = /libvulkan\.so\.1/.test(ld.stdout ?? '') || ['/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/usr/lib'].some((d) => fs.existsSync(path.join(d, 'libvulkan.so.1')));
  }
  return { platform, arch, nvidia, vulkan };
}

/**
 * The audio.cpp builds to try, best first. Windows and Linux builds are x64
 * only (Windows on Arm runs them emulated). The CPU and Vulkan builds are
 * the portable ones, which do not assume the build machine's processor. On
 * Linux an NVIDIA GPU runs the Vulkan build: audio.cpp ships no Linux CUDA
 * server.
 */
export function runtimeChoices(hw: Hardware): RuntimeChoice[] {
  const out: RuntimeChoice[] = [];
  if (hw.platform === 'darwin') {
    const arch = hw.arch === 'arm64' ? 'arm64' : 'x64';
    out.push({ backend: 'metal', asset: new RegExp(`^audio-.*-bin-macos-${arch}-metal\\.tar\\.gz$`) });
    return out;
  }
  if (hw.platform === 'win32') {
    // CUDA 12 runs on older drivers (and older GPUs) than CUDA 13.
    if (hw.nvidia) out.push({ backend: 'cuda', asset: /^audio-.*-bin-windows-x64-cuda12\.[\d.]+\.zip$/, extra: /^audio-.*-cudart-windows-x64-cuda12\.[\d.]+\.zip$/ });
    if (hw.vulkan) out.push({ backend: 'vulkan', asset: /^audio-.*-bin-windows-x64-vulkan-portable\.zip$/ });
    out.push({ backend: 'cpu', asset: /^audio-.*-bin-windows-x64-cpu-portable\.zip$/ });
    return out;
  }
  if (hw.vulkan || hw.nvidia) out.push({ backend: 'vulkan', asset: /^audio-.*-bin-ubuntu-x64-vulkan-portable\.tar\.gz$/ });
  out.push({ backend: 'cpu', asset: /^audio-.*-bin-ubuntu-x64-cpu-portable\.tar\.gz$/ });
  return out;
}

interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

/**
 * The GPU in `audiocpp_server --list-devices --json` for this backend. Builds
 * before the JSON form print lines like `CUDA:0 "NVIDIA GeForce GTX 1660 SUPER" [GPU]`.
 */
export function deviceFromList(out: string, backend: Backend): string | undefined {
  const brace = out.indexOf('{');
  if (brace >= 0) {
    try {
      const data = JSON.parse(out.slice(brace)) as { devices?: Array<{ backend?: string | null; name?: string | null; description?: string | null; type?: string | null }> };
      const gpus = (data.devices ?? []).filter((d) => d.type !== 'cpu' && d.type !== 'accel');
      const d = gpus.find((g) => (g.backend ?? '').toLowerCase() === backend) ?? gpus[0];
      return (d?.description || d?.name || undefined)?.trim();
    } catch {
      // the text form, below
    }
  }
  const lines = [...out.matchAll(/^\s*(\w+):\d+ "([^"]+)" \[(\w+)\]/gm)].filter((m) => m[3]!.toUpperCase() !== 'CPU');
  return (lines.find((m) => m[1]!.toLowerCase() === backend) ?? lines[0])?.[2]?.trim();
}

function listedDevice(exe: string, cwd: string, env: Record<string, string>, backend: Backend): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(exe, ['--list-devices', '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(deviceFromList(out, backend));
    });
  });
}

/** The transcript in a Qwen3-ASR answer that still has its markers ("language English<asr_text>…"). */
export function transcriptFromAnswer(answer: string): string {
  let text = answer;
  const i = text.indexOf('<asr_text>');
  if (i >= 0) text = text.slice(i + '<asr_text>'.length);
  else text = text.replace(/^\s*language\s+[A-Za-z]+\s*$/, '');
  return text.replace(/<\/?asr_text>/g, '').replace(/<\|[^|]*\|>/g, '').trim();
}

/** The glossary setting as Qwen3-ASR's context: the terms, comma separated, without blanks or repeats. */
export function glossaryContext(glossary: string): string {
  const terms = glossary.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
  return [...new Set(terms)].join(', ');
}

/** A reply as VibeVoice's one-speaker script ("Speaker 1: …"). */
export function speakerScript(text: string): string {
  return `Speaker 1: ${text.replace(/\s+/g, ' ').trim()}`;
}

export interface DictationOptions {
  dir?: string;
  hardware?: () => Hardware;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Environment variables not passed to audiocpp_server (provider keys). */
  hideEnv?: readonly string[];
  onChange?: (status: DictationStatus) => void;
  /** The models (tests use small stand-ins). */
  asrModel?: ModelFile;
  ttsModel?: ModelFile;
  /** Where the files come from (tests). */
  modelBaseUrl?: string;
  releasesUrl?: string;
  /** Keep audiocpp_server running (no idle stop), and start it again when it exits. */
  keepLoaded?: boolean;
  /** Settings → STT & TTS, read at each use. */
  settings?: () => SpeechSettings;
  /** Milliseconds between download attempts (tests). */
  retryDelay?: number;
}

/** A download that failed on the way (no connection, dropped, a server error): worth another try. */
class NetworkError extends Error {}
const DOWNLOAD_ATTEMPTS = 6;

/** fetch's "fetch failed" with the reason it wraps (a connect timeout, a reset). */
function networkMessage(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return cause ? `${getErrorMessage(error)} (${cause})` : getErrorMessage(error);
}

/** How long audiocpp_server must have run for its exit not to count as one of the quick failures. */
const STEADY_MS = 60_000;
const RESTARTS = 3;

interface State {
  runtimes: Record<string, { dir: string; tag: string }>;
  working?: Backend;
  failed?: Backend[];
}

export class Dictation {
  readonly dir: string;
  private readonly asrModel: ModelFile;
  private readonly ttsModel: ModelFile;
  private readonly fetch: typeof fetch;
  private status_: Omit<DictationStatus, 'voice'>;
  private voice_: VoiceStatus;
  private installing: Promise<void> | null = null;
  private installingVoice: Promise<void> | null = null;
  private starting: Promise<string> | null = null;
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private idle: NodeJS.Timeout | null = null;
  private busy = 0;
  private closed = false;
  private restart: NodeJS.Timeout | null = null;
  private quickExits = 0;
  /** Whether the running server's config has VibeVoice. */
  private serverHasVoice = false;
  /** Downloads, one at a time. */
  private downloads: Promise<unknown> = Promise.resolve();
  /** Speaking, one reply at a time. */
  private speaking: Promise<unknown> = Promise.resolve();
  /** While the models are swapped: settles when Qwen3-ASR is back. */
  private swapped: Promise<void> | null = null;

  constructor(private readonly options: DictationOptions = {}) {
    this.dir = options.dir ?? path.join(sfagentsHome(), 'dictation');
    this.fetch = options.fetch ?? fetch;
    this.asrModel = options.asrModel ?? ASR_MODEL;
    this.ttsModel = options.ttsModel ?? TTS_MODEL;
    this.status_ = { state: 'missing', downloadSize: 0 };
    this.voice_ = { state: 'missing', downloadSize: 0, reference: false };
    this.refreshInstalled();
    this.refreshVoice();
  }

  // ---------------------------------------------------------------- state

  private stateFile(): string {
    return path.join(this.dir, 'audiocpp.json');
  }

  /** The runtimes installed so far, and the one that worked. */
  private readState(): State {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
    } catch {
      return { runtimes: {} };
    }
  }

  private writeState(s: State): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.stateFile(), `${JSON.stringify(s, null, 2)}\n`);
  }

  private modelPath(f: ModelFile): string {
    return path.join(this.dir, 'models', path.basename(f.name));
  }

  private have(f: ModelFile): boolean {
    try {
      return fs.statSync(this.modelPath(f)).size === f.size;
    } catch {
      return false;
    }
  }

  /** The reference voice clip VibeVoice copies (Settings → STT & TTS). */
  get voicePath(): string {
    return path.join(this.dir, 'voice.wav');
  }

  private runtimeBytes(): number {
    if (Object.keys(this.readState().runtimes).length) return 0;
    // Roughly: the CUDA build comes with its runtime libraries.
    return this.choices()[0]?.backend === 'cuda' ? 1_050_000_000 : 80_000_000;
  }

  private settings(): SpeechSettings {
    return { ...DEFAULT_SPEECH_SETTINGS, ...this.options.settings?.() };
  }

  private refreshInstalled(): void {
    const st = this.readState();
    const ready = this.have(this.asrModel) && Object.keys(st.runtimes).length > 0;
    this.set({
      state: ready ? (this.child ? 'running' : 'ready') : 'missing',
      downloadSize: ready ? 0 : (this.have(this.asrModel) ? 0 : this.asrModel.size) + this.runtimeBytes(),
      backend: st.working,
      device: this.child ? this.status_.device : undefined,
    });
  }

  private refreshVoice(state?: VoiceStatus['state']): void {
    const have = this.have(this.ttsModel);
    this.setVoice({
      state: state ?? (have ? 'ready' : 'missing'),
      downloadSize: have ? 0 : this.ttsModel.size,
      reference: fs.existsSync(this.voicePath),
    });
  }

  private set(s: Omit<DictationStatus, 'voice'>): void {
    this.status_ = s;
    this.options.onChange?.(this.status());
  }

  private setVoice(v: VoiceStatus): void {
    this.voice_ = v;
    this.options.onChange?.(this.status());
  }

  status(): DictationStatus {
    return { ...this.status_, voice: this.voice_ };
  }

  // ---------------------------------------------------------------- install

  /** Downloads Qwen3-ASR and a runtime. Safe to call again (it resumes). */
  install(): Promise<void> {
    if (this.installing) return this.installing;
    if (this.status_.state !== 'missing' && this.status_.state !== 'error') return Promise.resolve();
    this.installing = (async () => {
      try {
        const st = this.readState();
        if (Object.keys(st.runtimes).length === 0) await this.installRuntime(this.choices(st)[0]!);
        await this.downloadModel(this.asrModel, 'Speech model', (progress) => this.set({ state: 'installing', downloadSize: this.status_.downloadSize, progress }));
        this.refreshInstalled();
      } catch (error) {
        this.set({ state: 'error', downloadSize: this.status_.downloadSize, error: getErrorMessage(error) });
        throw error;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  /**
   * Downloads VibeVoice (resuming). A running server is started again with
   * VibeVoice in its config.
   */
  installVoice(): Promise<void> {
    if (this.installingVoice) return this.installingVoice;
    if (this.have(this.ttsModel)) return Promise.resolve();
    // Installing at once, also while it waits for the speech model's download.
    this.setVoice({ ...this.voice_, state: 'installing', progress: undefined, error: undefined });
    this.installingVoice = (async () => {
      try {
        await this.downloadModel(this.ttsModel, 'Voice model', (progress) => this.setVoice({ ...this.voice_, state: 'installing', progress }));
        this.refreshVoice();
        if (this.child && !this.serverHasVoice) {
          this.stop();
          await this.start();
        }
      } catch (error) {
        this.setVoice({ ...this.voice_, state: 'error', progress: undefined, error: getErrorMessage(error) });
        throw error;
      } finally {
        this.installingVoice = null;
      }
    })();
    return this.installingVoice;
  }

  private downloadModel(f: ModelFile, label: string, report: (p: Progress) => void): Promise<void> {
    fs.mkdirSync(path.join(this.dir, 'models'), { recursive: true });
    return this.download(`${this.options.modelBaseUrl ?? MODEL_REPO}/${f.name}`, this.modelPath(f), f.size, f.sha256, label, report);
  }

  private choices(st = this.readState()): RuntimeChoice[] {
    const hw = (this.options.hardware ?? detectHardware)();
    const all = runtimeChoices(hw);
    const failed = new Set(st.failed ?? []);
    const ok = all.filter((c) => !failed.has(c.backend));
    return ok.length ? ok : all.slice(-1);
  }

  /** Recent audio.cpp releases, newest first. */
  private async releases(): Promise<Array<{ tag: string; assets: ReleaseAsset[] }>> {
    try {
      const res = await this.fetch(this.options.releasesUrl ?? RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SF-Agents' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Array<{ tag_name: string; draft?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string | null }> }>;
      if (!Array.isArray(data)) throw new Error('unexpected answer');
      const list = data
        .filter((r) => !r.draft && /^v\d/.test(r.tag_name))
        .map((r) => ({
          tag: r.tag_name,
          assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: a.digest?.startsWith('sha256:') ? a.digest.slice(7) : undefined })),
        }));
      if (!list.length) throw new Error('no builds listed');
      return list;
    } catch (error) {
      this.options.log?.(`dictation: the audio.cpp release list is unavailable (${getErrorMessage(error)}); using ${FALLBACK_TAG}`);
      // Without the list, the names the release workflow gives its files.
      const t = FALLBACK_TAG;
      const base = `https://github.com/0xShug0/audio.cpp/releases/download/${t}`;
      const names = [
        `audio-${t}-bin-macos-arm64-metal.tar.gz`, `audio-${t}-bin-macos-x64-metal.tar.gz`,
        `audio-${t}-bin-ubuntu-x64-cpu-portable.tar.gz`, `audio-${t}-bin-ubuntu-x64-vulkan-portable.tar.gz`,
        `audio-${t}-bin-windows-x64-cpu-portable.zip`, `audio-${t}-bin-windows-x64-vulkan-portable.zip`,
        `audio-${t}-bin-windows-x64-cuda12.4.zip`, `audio-${t}-cudart-windows-x64-cuda12.4.zip`,
      ];
      return [{ tag: t, assets: names.map((name) => ({ name, url: `${base}/${name}`, size: 0 })) }];
    }
  }

  private async installRuntime(choice: RuntimeChoice): Promise<void> {
    // The newest release that has this build.
    const all = await this.releases();
    const rel = all.find((r) => r.assets.some((a) => choice.asset.test(a.name)) && (!choice.extra || r.assets.some((a) => choice.extra!.test(a.name))));
    const asset = rel?.assets.find((a) => choice.asset.test(a.name));
    if (!rel || !asset) throw new Error(`No recent audio.cpp release has a ${choice.backend} build for this computer.`);
    const extra = choice.extra ? rel.assets.find((a) => choice.extra!.test(a.name)) : undefined;
    const target = path.join(this.dir, 'audiocpp', choice.backend);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const label = `audio.cpp (${choice.backend === 'cpu' ? 'CPU' : choice.backend === 'cuda' ? 'CUDA' : choice.backend === 'metal' ? 'Metal' : 'Vulkan'})`;
    for (const a of [asset, ...(extra ? [extra] : [])]) {
      const file = path.join(this.dir, 'audiocpp', a.name);
      await this.download(a.url, file, a.size || undefined, a.sha256, label, (progress) => this.set({ state: 'installing', downloadSize: this.status_.downloadSize, progress }));
      await extract(file, target);
      fs.rmSync(file, { force: true });
    }
    const server = findFile(target, process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server');
    if (!server) throw new Error(`The audio.cpp ${choice.backend} build has no audiocpp_server.`);
    if (process.platform !== 'win32') for (const f of fs.readdirSync(path.dirname(server))) if (f.startsWith('audiocpp_')) fs.chmodSync(path.join(path.dirname(server), f), 0o755);
    if (process.platform === 'darwin') spawnSync('xattr', ['-dr', 'com.apple.quarantine', target]);
    // The CUDA runtime libraries go next to the binaries.
    if (extra) {
      const bin = path.dirname(server);
      for (const f of listFiles(target)) {
        if (/(cudart|cublas|cufft)/i.test(path.basename(f)) && path.dirname(f) !== bin) fs.copyFileSync(f, path.join(bin, path.basename(f)));
      }
    }
    const st = this.readState();
    st.runtimes[choice.backend] = { dir: path.relative(this.dir, path.dirname(server)), tag: rel.tag };
    this.writeState(st);
  }

  /**
   * One download at a time (Qwen3-ASR and VibeVoice in parallel saturate the
   * line, and the second connection timed out). A dropped or refused
   * connection is retried, resuming where it stopped.
   */
  private download(url: string, file: string, size: number | undefined, sha256: string | undefined, label: string, report: (p: Progress) => void): Promise<void> {
    const run = this.downloads.then(async () => {
      const release = this.lockDownloads();
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            return await this.downloadOnce(url, file, size, sha256, label, report);
          } catch (error) {
            if (!(error instanceof NetworkError) || attempt >= DOWNLOAD_ATTEMPTS) throw error;
            const wait = Math.min(30_000, 2000 * 2 ** (attempt - 1));
            this.options.log?.(`dictation: downloading ${path.basename(file)}: ${getErrorMessage(error)}; trying again in ${wait / 1000} s`);
            await new Promise((r) => setTimeout(r, this.options.retryDelay ?? wait));
          }
        }
      } finally {
        release();
      }
    });
    this.downloads = run.catch(() => {});
    return run;
  }

  /**
   * Only one SF Agents downloads into this folder at a time: two (an old one
   * still running next to a new one) appending to the same .part file corrupt it.
   */
  private lockDownloads(): () => void {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, 'download.lock');
    for (let i = 0; i < 2; i++) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        return () => fs.rmSync(lock, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(fs.readFileSync(lock, 'utf8').trim());
        if (pid && pid !== process.pid && alive(pid)) throw new Error(`Another SF Agents (process ${pid}) is downloading the speech models. Close it, or let it finish.`);
        fs.rmSync(lock, { force: true }); // left by one that stopped
      }
    }
    throw new Error('The download lock could not be taken.');
  }

  /** Downloads to a .part file (resuming one that exists), checks it, and renames it. */
  private async downloadOnce(url: string, file: string, size: number | undefined, sha256: string | undefined, label: string, report: (p: Progress) => void): Promise<void> {
    if (size !== undefined && fs.existsSync(file) && fs.statSync(file).size === size) return;
    const part = `${file}.part`;
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size !== undefined && have > size) {
      fs.rmSync(part);
      have = 0;
    }
    let res: Response;
    try {
      res = await this.fetch(url, { headers: { 'User-Agent': 'SF-Agents', ...(have > 0 ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow' });
    } catch (error) {
      throw new NetworkError(networkMessage(error));
    }
    if (res.status >= 500 || res.status === 429) throw new NetworkError(`HTTP ${res.status}`);
    if (!res.ok || !res.body) throw new Error(`Downloading ${path.basename(file)} failed: HTTP ${res.status}.`);
    if (have > 0 && res.status !== 206) have = 0; // the server ignored the range: start over
    const resumed = have > 0;
    const total = size ?? have + Number(res.headers.get('content-length') ?? 0);
    let done = have;
    let last = 0;
    const progress = (force = false) => {
      const now = Date.now();
      if (!force && now - last < 250) return;
      last = now;
      report({ label, done, total });
    };
    progress(true);
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (c: Buffer) => {
      done += c.length;
      progress();
    });
    try {
      await pipeline(body, fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }));
    } catch (error) {
      // What arrived stays in the .part file for the next attempt.
      throw new NetworkError(networkMessage(error));
    }
    progress(true);
    if (sha256) {
      const got = await hashFile(part);
      if (got !== sha256) {
        fs.rmSync(part, { force: true });
        // A resumed download that went wrong: once more, from the start.
        if (resumed) throw new NetworkError('it did not match its checksum after resuming; starting over');
        throw new Error(`${path.basename(file)} did not match its checksum; it was removed. Try again.`);
      }
    }
    fs.renameSync(part, file);
  }

  // ---------------------------------------------------------------- running

  /** Starts audiocpp_server with Qwen3-ASR loaded (if it is not running) and resolves with its address. */
  start(): Promise<string> {
    if (this.url && this.child) {
      this.touch();
      return Promise.resolve(this.url);
    }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        if (!this.have(this.asrModel) || Object.keys(this.readState().runtimes).length === 0) throw new Error('Dictation is not set up yet.');
        let lastError: unknown;
        for (;;) {
          const st = this.readState();
          const choice = st.working ? this.choices(st).find((c) => c.backend === st.working) ?? this.choices(st)[0]! : this.choices(st)[0]!;
          try {
            if (!st.runtimes[choice.backend]) {
              this.set({ ...this.status_, state: 'installing' });
              await this.installRuntime(choice);
            }
            const url = await this.launch(choice.backend);
            const now = this.readState();
            now.working = choice.backend;
            this.writeState(now);
            this.removeLlamaCpp();
            return url;
          } catch (error) {
            lastError = error;
            this.options.log?.(`dictation: the ${choice.backend} build did not start: ${getErrorMessage(error)}`);
            const now = this.readState();
            if (choice.backend === 'cpu' || this.choices(now).length <= 1) throw lastError;
            now.failed = [...new Set([...(now.failed ?? []), choice.backend])];
            if (now.working === choice.backend) delete now.working;
            this.writeState(now);
          }
        }
      } catch (error) {
        this.set({ state: 'error', downloadSize: this.status_.downloadSize, error: getErrorMessage(error) });
        throw error;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** The server's config: Qwen3-ASR loaded at start, VibeVoice (when downloaded) on its first use. */
  private writeConfig(backend: Backend, port: number): string {
    const models: unknown[] = [{ id: ASR_ID, family: 'qwen3_asr', path: this.modelPath(this.asrModel), task: 'asr', mode: 'offline', lazy: false }];
    this.serverHasVoice = this.have(this.ttsModel);
    if (this.serverHasVoice) models.push({ id: TTS_ID, family: 'vibevoice', path: this.modelPath(this.ttsModel), task: 'tts', mode: 'offline', lazy: true });
    const config = {
      host: '127.0.0.1',
      port,
      backend,
      device: 0,
      // The server's default is one thread, which leaves the CPU build (and the CPU parts of the others) slow.
      threads: Math.min(16, os.availableParallelism()),
      lazy_load: true,
      // The swap is done here, not by a residency limit.
      max_loaded_models: 0,
      // Requests are queued here; speaking a long reply can take minutes.
      busy_timeout_ms: 0,
      models,
    };
    const file = path.join(this.dir, 'server.json');
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return file;
  }

  private async launch(backend: Backend): Promise<string> {
    const st = this.readState();
    const bin = path.join(this.dir, st.runtimes[backend]!.dir);
    const exe = path.join(bin, process.platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server');
    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !this.options.hideEnv?.includes(k)) env[k] = v;
    if (process.platform === 'linux') env['LD_LIBRARY_PATH'] = [bin, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(':');
    const args = ['--config', this.writeConfig(backend, port), '--no-ui', '--backend', backend, '--host', '127.0.0.1', '--port', String(port), '--log'];
    this.set({ state: 'starting', downloadSize: 0, backend });
    this.refreshVoice();
    const child = spawn(exe, args, { cwd: bin, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    let head = '';
    const keep = (d: Buffer) => {
      log = (log + d.toString()).slice(-64_000);
      if (head.length < 256_000) head += d.toString();
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const url = `http://127.0.0.1:${port}`;
    const exited = new Promise<never>((_, reject) => {
      child.once('error', (e) => reject(e));
      child.once('exit', (code) => reject(new Error(`audiocpp_server exited (${code ?? 'signal'}). ${lastLines(log)}`)));
    });
    exited.catch(() => {});
    const deadline = Date.now() + START_TIMEOUT_MS;
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error('audiocpp_server did not become ready in time.');
        const ok = await Promise.race([
          this.fetch(`${url}/health`).then((r) => r.ok, () => false),
          exited,
        ]);
        if (ok) break;
        await Promise.race([new Promise((r) => setTimeout(r, 400)), exited]);
      }
      // Qwen3-ASR is loaded and runs: a GPU build that cannot load it fails here, and the next build is tried.
      await Promise.race([this.recognize(url, silence(0.5)), exited]);
    } catch (error) {
      child.kill();
      throw error;
    }
    const device = backend === 'cpu' ? 'CPU' : (await listedDevice(exe, bin, env, backend)) ?? backend.toUpperCase();
    // What it said while starting, for when that is not what was expected.
    try {
      fs.writeFileSync(path.join(this.dir, 'audiocpp-server.log'), head.length < 256_000 ? head : `${head}\n…\n${log}`);
    } catch {
      // not worth failing over
    }
    this.child = child;
    this.url = url;
    const started = Date.now();
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.url = null;
      if (this.closed) return;
      this.refreshInstalled();
      this.refreshVoice();
      if (!this.options.keepLoaded) return;
      // Kept loaded: start it again, unless it keeps exiting soon after it starts.
      this.quickExits = Date.now() - started < STEADY_MS ? this.quickExits + 1 : 0;
      if (this.quickExits >= RESTARTS) {
        this.options.log?.(`dictation: audiocpp_server exited (${code ?? 'signal'}) ${RESTARTS} times soon after starting; it starts again when dictation is next used. ${lastLines(log)}`);
        return;
      }
      this.options.log?.(`dictation: audiocpp_server exited (${code ?? 'signal'}); starting it again.`);
      this.restart = setTimeout(() => {
        this.restart = null;
        this.start().catch((error) => this.options.log?.(`dictation: ${getErrorMessage(error)}`));
      }, 3000);
      this.restart.unref?.();
    });
    this.set({ state: 'running', downloadSize: 0, backend, device });
    this.touch();
    return url;
  }

  private touch(): void {
    if (this.options.keepLoaded) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.busy === 0) this.stop();
      else this.touch();
    }, IDLE_MS);
    this.idle.unref?.();
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    const c = this.child;
    this.child = null;
    this.url = null;
    c?.kill();
    if (!this.closed) {
      this.refreshInstalled();
      this.refreshVoice();
    }
  }

  /** Speech (a WAV file) to text. While the models are swapped, it waits for Qwen3-ASR to be back. */
  async transcribe(wav: Buffer, language?: string): Promise<string> {
    // Counted as busy before anything is awaited, so a swap that starts now waits for it.
    while (this.swapped) await this.swapped;
    this.busy++;
    try {
      const url = await this.start();
      return await this.recognize(url, wav, language, glossaryContext(this.settings().glossary));
    } finally {
      this.busy--;
      this.touch();
    }
  }

  private async recognize(url: string, wav: Buffer, language?: string, context?: string): Promise<string> {
    // The server reads the audio from a file (its upload form has no token cap).
    const tmp = path.join(this.dir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, `${crypto.randomUUID()}.wav`);
    fs.writeFileSync(file, wav);
    try {
      const res = await this.fetch(`${url}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ASR_ID,
          audio: file,
          ...(language ? { language } : {}),
          ...(context ? { text: context } : {}),
          // Speech runs at a few tokens a second; a cap keeps a confused model from looping.
          options: { max_tokens: Math.ceil(wavSeconds(wav) * 8) + 32 },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } | string };
      if (!res.ok) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) ?? `audiocpp_server answered HTTP ${res.status}.`);
      const text = data.text ?? '';
      return text.includes('<asr_text>') ? transcriptFromAnswer(text) : text.trim();
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // ---------------------------------------------------------------- speaking

  /** Text to speech (a WAV file), in the reference voice when one is set. One reply at a time. */
  speak(text: string): Promise<Buffer> {
    if (!text.trim()) return Promise.reject(new Error('There is nothing to say.'));
    if (!this.have(this.ttsModel)) return Promise.reject(new Error('Text to speech is not set up yet.'));
    const run = this.speaking.then(() => this.speakNow(text));
    this.speaking = run.catch(() => {});
    return run;
  }

  private async speakNow(text: string): Promise<Buffer> {
    const s = this.settings();
    let url = await this.start();
    if (!this.serverHasVoice) {
      // Downloaded after the server started.
      this.stop();
      url = await this.start();
    }
    let back: (() => void) | null = null;
    if (s.autoSwap) {
      this.swapped = new Promise((resolve) => (back = resolve));
      while (this.busy > 0) await new Promise((r) => setTimeout(r, 50));
      await this.unload(url, [ASR_ID]);
    }
    this.refreshVoice('speaking');
    try {
      const reference = fs.existsSync(this.voicePath);
      const res = await this.fetch(`${url}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TTS_ID,
          input: speakerScript(text),
          response_format: 'wav',
          options: {
            guidance_scale: Math.min(3, Math.max(0.5, s.guidanceScale)),
            ...(reference ? { voice_samples: this.voicePath } : {}),
          },
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) ?? `audiocpp_server answered HTTP ${res.status}.`);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      if (s.autoSwap) {
        await this.unload(url, [TTS_ID]).catch((error) => this.options.log?.(`dictation: unloading VibeVoice failed: ${getErrorMessage(error)}`));
        // Qwen3-ASR straight back into memory, before anyone dictates.
        await this.recognize(url, silence(0.5)).catch((error) => this.options.log?.(`dictation: reloading Qwen3-ASR failed: ${getErrorMessage(error)}`));
        this.swapped = null;
        (back as (() => void) | null)?.();
      }
      this.refreshVoice(this.child ? (s.autoSwap ? 'ready' : 'loaded') : undefined);
    }
  }

  /** After the settings change: with the swap on, VibeVoice does not stay in memory. */
  applySettings(): void {
    if (this.voice_.state !== 'loaded' || !this.url || !this.settings().autoSwap) return;
    const url = this.url;
    this.speaking = this.speaking.then(() =>
      this.unload(url, [TTS_ID]).then(
        () => this.refreshVoice(),
        (error) => this.options.log?.(`dictation: unloading VibeVoice failed: ${getErrorMessage(error)}`),
      ),
    );
  }

  private async unload(url: string, ids: string[]): Promise<void> {
    const res = await this.fetch(`${url}/v1/tasks/unload_models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_ids: ids }) });
    if (!res.ok) throw new Error(`audiocpp_server answered HTTP ${res.status}.`);
  }

  /** Sets (or with null, removes) the reference voice clip, a WAV file. */
  setReference(wav: Buffer | null): void {
    if (wav) {
      if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('The voice clip must be a WAV file.');
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(`${this.voicePath}.tmp`, wav);
      fs.renameSync(`${this.voicePath}.tmp`, this.voicePath);
    } else fs.rmSync(this.voicePath, { force: true });
    this.setVoice({ ...this.voice_, reference: !!wav });
  }

  /** What the llama.cpp version of dictation downloaded (about 2.5 GB), now unused. */
  private removeLlamaCpp(): void {
    for (const f of LLAMA_LEFTOVERS) {
      try {
        fs.rmSync(path.join(this.dir, f), { recursive: true, force: true });
      } catch {
        // tried again at the next start
      }
    }
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}

// -------------------------------------------------------------------- helpers

/** Length of a PCM WAV file in seconds (from its header; 16 kHz mono when unreadable). */
export function wavSeconds(wav: Buffer): number {
  try {
    if (wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE') {
      const byteRate = wav.readUInt32LE(28);
      if (byteRate > 0) return Math.max(0, wav.length - 44) / byteRate;
    }
  } catch {
    // fall through
  }
  return Math.max(0, wav.length - 44) / 32000;
}

/** A 16 kHz mono WAV of silence, to load the model. */
function silence(seconds: number): Buffer {
  const samples = Math.round(16000 * seconds);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

/** Whether a process is running (EPERM: it is, as another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lastLines(log: string): string {
  return log.trim().split('\n').slice(-4).join(' ').slice(-600);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function hashFile(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Unpacks a .tar.gz or .zip with the system tar (bsdtar reads zip on Windows 10+ and macOS). */
function extract(archive: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = archive.endsWith('.zip') && process.platform === 'linux' ? null : ['-xf', archive, '-C', dir];
    // On Windows, the system's bsdtar (not a GNU tar from Git or MSYS on the PATH).
    const tar = process.platform === 'win32' ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const child = args ? spawn(tar, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }) : spawn('unzip', ['-q', '-o', archive, '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking ${path.basename(archive)} failed: ${err.trim().slice(-300)}`))));
  });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function findFile(dir: string, name: string): string | undefined {
  return listFiles(dir).find((f) => path.basename(f) === name);
}
