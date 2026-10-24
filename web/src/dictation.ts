/**
 * Dictation: speech to text on this computer with Qwen3-ASR 1.7B (Q8_0, from
 * unsloth's GGUF build), run by llama.cpp's llama-server.
 *
 * Nothing is bundled. The first use downloads, into <SF Agents home>/dictation:
 *   - a llama.cpp release build for this platform, GPU first: Metal on macOS;
 *     CUDA when an NVIDIA driver is present; else Vulkan when a Vulkan loader
 *     is; else the CPU build. When a GPU build cannot start or load the model,
 *     the next one is tried, down to the CPU build.
 *   - the model and its audio encoder (about 2.5 GB), checked against their
 *     SHA-256.
 * llama-server then runs on demand on a loopback port (started when the mic
 * button is pressed, so it loads while you speak) and stops after ten idle
 * minutes to give the memory back.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getErrorMessage, sfagentsHome } from '@sfagents/core';

const MODEL_REPO = 'https://huggingface.co/unslothai/Qwen3-ASR-1.7B-GGUF/resolve/main';
export interface ModelFile {
  name: string;
  size: number;
  sha256: string;
}
export const MODEL_FILES: readonly [ModelFile, ModelFile] = [
  { name: 'Qwen3-ASR-1.7B-Q8_0.gguf', size: 2_165_034_944, sha256: '58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57' },
  { name: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', size: 355_709_344, sha256: '46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d' },
] as const;
// The builds are published as pre-releases, so "latest" does not find them: list the recent ones.
const RELEASES = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
/** A release known to run Qwen3-ASR, used when the GitHub API cannot be reached. */
const FALLBACK_TAG = 'b11846';
const IDLE_MS = 10 * 60_000;
const START_TIMEOUT_MS = 180_000;

export type Backend = 'metal' | 'cuda' | 'vulkan' | 'cpu';

export interface RuntimeChoice {
  backend: Backend;
  /** Matches the release asset (the tag is not part of the pattern). */
  asset: RegExp;
  /** Extra archive with the CUDA runtime libraries, unpacked next to the binaries. */
  extra?: RegExp;
}

export interface DictationStatus {
  state: 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'error';
  /** Bytes still to download before first use. */
  downloadSize: number;
  progress?: { label: string; done: number; total: number };
  backend?: Backend;
  device?: string;
  error?: string;
}

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

/** The llama.cpp builds to try, best first. */
export function runtimeChoices(hw: Hardware): RuntimeChoice[] {
  const arch = hw.arch === 'arm64' ? 'arm64' : 'x64';
  const out: RuntimeChoice[] = [];
  if (hw.platform === 'darwin') {
    // The macOS builds use Metal (and fall back to the CPU by themselves).
    out.push({ backend: 'metal', asset: new RegExp(`-bin-macos-${arch}\\.(tar\\.gz|zip)$`) });
    return out;
  }
  if (hw.platform === 'win32') {
    if (hw.nvidia) out.push({ backend: 'cuda', asset: new RegExp(`^llama-.*-bin-win-cuda-12\\.[\\d.]+-${arch}\\.zip$`), extra: new RegExp(`^cudart-llama-bin-win-cuda-12\\.[\\d.]+-${arch}\\.zip$`) });
    if (hw.vulkan) out.push({ backend: 'vulkan', asset: new RegExp(`^llama-.*-bin-win-vulkan-${arch}\\.zip$`) });
    out.push({ backend: 'cpu', asset: new RegExp(`^llama-.*-bin-win-cpu-${arch}\\.zip$`) });
    return out;
  }
  // Linux (and other Unix): the Ubuntu builds.
  if (hw.nvidia) {
    const cuda = arch === 'x64' ? '12\\.[\\d.]+' : '1[23]\\.[\\d.]+';
    out.push({ backend: 'cuda', asset: new RegExp(`^llama-.*-bin-ubuntu-cuda-${cuda}-${arch}\\.tar\\.gz$`), extra: new RegExp(`^cudart-llama-.*-bin-ubuntu-cuda-${cuda}-${arch}\\.tar\\.gz$`) });
  }
  if (hw.vulkan) out.push({ backend: 'vulkan', asset: new RegExp(`^llama-.*-bin-ubuntu-vulkan-${arch}\\.tar\\.gz$`) });
  out.push({ backend: 'cpu', asset: new RegExp(`^llama-.*-bin-ubuntu-${arch}\\.tar\\.gz$`) });
  return out;
}

interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

/** What the llama-server output says it runs on. */
export function deviceFromLog(log: string): string | undefined {
  const m =
    /using device (\w+) \(([^)]+)\)/.exec(log) ??
    /ggml_vulkan: 0 = ([^|\n(]+)/.exec(log) ??
    /Device 0: ([^,\n]+)/.exec(log) ??
    /GPU name:\s+(.+)/.exec(log);
  if (!m) return undefined;
  return (m[2] ?? m[1])!.trim();
}

/** The transcript in Qwen3-ASR's answer ("language English<asr_text>…"). */
export function transcriptFromAnswer(answer: string): string {
  let text = answer;
  const i = text.indexOf('<asr_text>');
  if (i >= 0) text = text.slice(i + '<asr_text>'.length);
  else text = text.replace(/^\s*language\s+[A-Za-z]+\s*/, '');
  return text.replace(/<\/?asr_text>/g, '').replace(/<\|[^|]*\|>/g, '').trim();
}

export interface DictationOptions {
  dir?: string;
  hardware?: () => Hardware;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Environment variables not passed to llama-server (provider keys). */
  hideEnv?: readonly string[];
  onChange?: (status: DictationStatus) => void;
  /** The model and its audio encoder (tests use small stand-ins). */
  models?: readonly [ModelFile, ModelFile];
  /** Where the files come from (tests). */
  modelBaseUrl?: string;
  releasesUrl?: string;
}

export class Dictation {
  readonly dir: string;
  private readonly models: readonly [ModelFile, ModelFile];
  private readonly fetch: typeof fetch;
  private status_: DictationStatus;
  private installing: Promise<void> | null = null;
  private starting: Promise<string> | null = null;
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private idle: NodeJS.Timeout | null = null;
  private busy = 0;
  private closed = false;

  constructor(private readonly options: DictationOptions = {}) {
    this.dir = options.dir ?? path.join(sfagentsHome(), 'dictation');
    this.fetch = options.fetch ?? fetch;
    this.models = options.models ?? MODEL_FILES;
    this.status_ = { state: 'missing', downloadSize: 0 };
    this.refreshInstalled();
  }

  // ---------------------------------------------------------------- state

  private stateFile(): string {
    return path.join(this.dir, 'runtime.json');
  }

  /** The runtimes installed so far, and the one that worked. */
  private readState(): { runtimes: Record<string, { dir: string; tag: string }>; working?: Backend; failed?: Backend[] } {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
    } catch {
      return { runtimes: {} };
    }
  }

  private writeState(s: ReturnType<Dictation['readState']>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.stateFile(), `${JSON.stringify(s, null, 2)}\n`);
  }

  private modelReady(): boolean {
    return this.models.every((f) => {
      try {
        return fs.statSync(path.join(this.dir, 'models', f.name)).size === f.size;
      } catch {
        return false;
      }
    });
  }

  private missingBytes(): number {
    let n = 0;
    for (const f of this.models) {
      let have = 0;
      try {
        have = fs.statSync(path.join(this.dir, 'models', f.name)).size === f.size ? f.size : 0;
      } catch {
        have = 0;
      }
      n += f.size - have;
    }
    if (Object.keys(this.readState().runtimes).length === 0) n += 60_000_000; // roughly, a llama.cpp build
    return n;
  }

  private refreshInstalled(): void {
    const st = this.readState();
    const ready = this.modelReady() && Object.keys(st.runtimes).length > 0;
    this.set({ state: ready ? (this.child ? 'running' : 'ready') : 'missing', downloadSize: ready ? 0 : this.missingBytes(), backend: st.working });
  }

  private set(s: DictationStatus): void {
    this.status_ = s;
    this.options.onChange?.(s);
  }

  status(): DictationStatus {
    return this.status_;
  }

  // ---------------------------------------------------------------- install

  /** Downloads the model and a runtime. Safe to call again (it resumes). */
  install(): Promise<void> {
    if (this.installing) return this.installing;
    if (this.status_.state !== 'missing' && this.status_.state !== 'error') return Promise.resolve();
    this.installing = (async () => {
      try {
        fs.mkdirSync(path.join(this.dir, 'models'), { recursive: true });
        const st = this.readState();
        if (Object.keys(st.runtimes).length === 0) await this.installRuntime(this.choices(st)[0]!);
        for (const f of this.models) await this.download(`${this.options.modelBaseUrl ?? MODEL_REPO}/${f.name}`, path.join(this.dir, 'models', f.name), f.size, f.sha256, f.name.startsWith('mmproj') ? 'Audio encoder' : 'Speech model');
        this.refreshInstalled();
      } catch (error) {
        this.set({ state: 'error', downloadSize: this.missingBytes(), error: getErrorMessage(error) });
        throw error;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  private choices(st = this.readState()): RuntimeChoice[] {
    const hw = (this.options.hardware ?? detectHardware)();
    const all = runtimeChoices(hw);
    const failed = new Set(st.failed ?? []);
    const ok = all.filter((c) => !failed.has(c.backend));
    return ok.length ? ok : all.slice(-1);
  }

  /** Recent llama.cpp releases, newest first. */
  private async releases(): Promise<Array<{ tag: string; assets: ReleaseAsset[] }>> {
    try {
      const res = await this.fetch(this.options.releasesUrl ?? RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SF-Agents' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Array<{ tag_name: string; draft?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string | null }> }>;
      if (!Array.isArray(data)) throw new Error('unexpected answer');
      const list = data
        .filter((r) => !r.draft && /^b\d+$/.test(r.tag_name))
        .map((r) => ({
          tag: r.tag_name,
          assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: a.digest?.startsWith('sha256:') ? a.digest.slice(7) : undefined })),
        }));
      if (!list.length) throw new Error('no builds listed');
      return list;
    } catch (error) {
      this.options.log?.(`dictation: the llama.cpp release list is unavailable (${getErrorMessage(error)}); using ${FALLBACK_TAG}`);
      // Without the list, guess the names the release workflow gives its files.
      const t = FALLBACK_TAG;
      const base = `https://github.com/ggml-org/llama.cpp/releases/download/${t}`;
      const names = [
        `llama-${t}-bin-macos-arm64.tar.gz`, `llama-${t}-bin-macos-x64.tar.gz`,
        `llama-${t}-bin-ubuntu-x64.tar.gz`, `llama-${t}-bin-ubuntu-arm64.tar.gz`,
        `llama-${t}-bin-ubuntu-vulkan-x64.tar.gz`, `llama-${t}-bin-ubuntu-vulkan-arm64.tar.gz`,
        `llama-${t}-bin-ubuntu-cuda-12.8-x64.tar.gz`, `cudart-llama-${t}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
        `llama-${t}-bin-ubuntu-cuda-13.4-arm64.tar.gz`, `cudart-llama-${t}-bin-ubuntu-cuda-13.4-arm64.tar.gz`,
        `llama-${t}-bin-win-cpu-x64.zip`, `llama-${t}-bin-win-cpu-arm64.zip`,
        `llama-${t}-bin-win-vulkan-x64.zip`, `llama-${t}-bin-win-vulkan-arm64.zip`,
        `llama-${t}-bin-win-cuda-12.4-x64.zip`, 'cudart-llama-bin-win-cuda-12.4-x64.zip',
      ];
      return [{ tag: t, assets: names.map((name) => ({ name, url: `${base}/${name}`, size: 0 })) }];
    }
  }

  private async installRuntime(choice: RuntimeChoice): Promise<void> {
    // The newest release that has this build (a release's files appear over an hour or so).
    const all = await this.releases();
    const rel = all.find((r) => r.assets.some((a) => choice.asset.test(a.name)) && (!choice.extra || r.assets.some((a) => choice.extra!.test(a.name))));
    const asset = rel?.assets.find((a) => choice.asset.test(a.name));
    if (!rel || !asset) throw new Error(`No recent llama.cpp release has a ${choice.backend} build for this computer.`);
    const extra = choice.extra ? rel.assets.find((a) => choice.extra!.test(a.name)) : undefined;
    const target = path.join(this.dir, 'runtime', choice.backend);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const a of [asset, ...(extra ? [extra] : [])]) {
      const file = path.join(this.dir, 'runtime', a.name);
      await this.download(a.url, file, a.size || undefined, a.sha256, `llama.cpp (${choice.backend === 'cpu' ? 'CPU' : choice.backend === 'cuda' ? 'CUDA' : choice.backend === 'metal' ? 'Metal' : 'Vulkan'})`);
      await extract(file, target);
      fs.rmSync(file, { force: true });
    }
    const server = findFile(target, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    if (!server) throw new Error(`The llama.cpp ${choice.backend} build has no llama-server.`);
    if (process.platform !== 'win32') fs.chmodSync(server, 0o755);
    if (process.platform === 'darwin') spawnSync('xattr', ['-dr', 'com.apple.quarantine', target]);
    // The CUDA runtime libraries go next to the binaries.
    if (extra) {
      const bin = path.dirname(server);
      for (const f of listFiles(target)) {
        if (/(cudart|cublas)/i.test(path.basename(f)) && path.dirname(f) !== bin) fs.copyFileSync(f, path.join(bin, path.basename(f)));
      }
    }
    const st = this.readState();
    st.runtimes[choice.backend] = { dir: path.relative(this.dir, path.dirname(server)), tag: rel.tag };
    this.writeState(st);
  }

  /** Downloads to a .part file (resuming one that exists), checks it, and renames it. */
  private async download(url: string, file: string, size: number | undefined, sha256: string | undefined, label: string): Promise<void> {
    if (size !== undefined && fs.existsSync(file) && fs.statSync(file).size === size) return;
    const part = `${file}.part`;
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size !== undefined && have > size) {
      fs.rmSync(part);
      have = 0;
    }
    const res = await this.fetch(url, { headers: { 'User-Agent': 'SF-Agents', ...(have > 0 ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Downloading ${path.basename(file)} failed: HTTP ${res.status}.`);
    if (have > 0 && res.status !== 206) have = 0; // the server ignored the range: start over
    const total = size ?? have + Number(res.headers.get('content-length') ?? 0);
    let done = have;
    let last = 0;
    const progress = (force = false) => {
      const now = Date.now();
      if (!force && now - last < 250) return;
      last = now;
      this.set({ state: 'installing', downloadSize: this.status_.downloadSize, progress: { label, done, total } });
    };
    progress(true);
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (c: Buffer) => {
      done += c.length;
      progress();
    });
    await pipeline(body, fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }));
    progress(true);
    if (sha256) {
      const got = await hashFile(part);
      if (got !== sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(`${path.basename(file)} did not match its checksum; it was removed. Try again.`);
      }
    }
    fs.renameSync(part, file);
  }

  // ---------------------------------------------------------------- running

  /** Starts llama-server (if it is not running) and resolves with its address. */
  start(): Promise<string> {
    if (this.url && this.child) {
      this.touch();
      return Promise.resolve(this.url);
    }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        if (!this.modelReady() || Object.keys(this.readState().runtimes).length === 0) throw new Error('Dictation is not set up yet.');
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
        this.set({ state: 'error', downloadSize: this.missingBytes(), error: getErrorMessage(error) });
        throw error;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private async launch(backend: Backend): Promise<string> {
    const st = this.readState();
    const bin = path.join(this.dir, st.runtimes[backend]!.dir);
    const exe = path.join(bin, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    const port = await freePort();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !this.options.hideEnv?.includes(k)) env[k] = v;
    if (process.platform === 'linux') env['LD_LIBRARY_PATH'] = [bin, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(':');
    const args = [
      '-m', path.join(this.dir, 'models', this.models[0].name),
      '--mmproj', path.join(this.dir, 'models', this.models[1].name),
      '--host', '127.0.0.1', '--port', String(port),
      '-ngl', backend === 'cpu' ? '0' : '999',
      '-c', '8192', '-np', '1', '--no-webui',
    ];
    this.set({ state: 'starting', downloadSize: 0, backend });
    const child = spawn(exe, args, { cwd: bin, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = '';
    const keep = (d: Buffer) => {
      log = (log + d.toString()).slice(-64_000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const url = `http://127.0.0.1:${port}`;
    const exited = new Promise<never>((_, reject) => {
      child.once('error', (e) => reject(e));
      child.once('exit', (code) => reject(new Error(`llama-server exited (${code ?? 'signal'}). ${lastLines(log)}`)));
    });
    exited.catch(() => {});
    const deadline = Date.now() + START_TIMEOUT_MS;
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error('llama-server did not become ready in time.');
        const ok = await Promise.race([
          this.fetch(`${url}/health`).then((r) => r.ok, () => false),
          exited,
        ]);
        if (ok) break;
        await Promise.race([new Promise((r) => setTimeout(r, 400)), exited]);
      }
    } catch (error) {
      child.kill();
      throw error;
    }
    // A GPU build that found no GPU runs on the CPU: fine, but say so.
    const device = backend === 'cpu' ? 'CPU' : deviceFromLog(log) ?? 'CPU';
    this.child = child;
    this.url = url;
    child.once('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.url = null;
      if (!this.closed) this.refreshInstalled();
    });
    this.set({ state: 'running', downloadSize: 0, backend, device });
    this.touch();
    return url;
  }

  private touch(): void {
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
    const c = this.child;
    this.child = null;
    this.url = null;
    c?.kill();
    if (!this.closed) this.refreshInstalled();
  }

  /** Speech (a WAV file) to text. */
  async transcribe(wav: Buffer, language?: string): Promise<string> {
    const url = await this.start();
    this.busy++;
    try {
      const prompt = language ? [{ type: 'text', text: `language ${language}` }] : [];
      const res = await this.fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }, ...prompt] }],
          temperature: 0,
          // Speech runs at a few tokens a second; a cap keeps a confused model from looping.
          max_tokens: Math.ceil(wavSeconds(wav) * 8) + 32,
          stream: false,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? `llama-server answered HTTP ${res.status}.`);
      return transcriptFromAnswer(data.choices?.[0]?.message?.content ?? '');
    } finally {
      this.busy--;
      this.touch();
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
