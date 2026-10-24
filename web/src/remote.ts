/**
 * Remote Desktop: this computer's screen in a sheet, through MoonlightWeb
 * (https://github.com/linckosz/moonlight-web, GPL-3.0).
 *
 * MoonlightWeb captures and encodes the screen itself and streams it to a
 * browser over WebRTC; on Windows its installer adds a virtual display
 * driver, so a stream can have a monitor of its own at the client's size.
 * SF Agents does not reimplement any of that. It:
 *
 *   - finds MoonlightWeb (a server already answering on this computer, or an
 *     install it can start), or installs it: the official installer on
 *     Windows and macOS, the AppImage (run by SF Agents) on Linux;
 *   - serves MoonlightWeb's page through its own address, as the application
 *     "remote" under /apps/remote/ (apps.ts), so it is behind SF Agents'
 *     sign-in and needs no port of its own. A request that comes from SF
 *     Agents on 127.0.0.1 is one MoonlightWeb trusts as the computer itself,
 *     so there is no second sign-in;
 *   - changes the page on its way through (remote-embed.ts) so that, in SF
 *     Agents' sheet, it goes straight to the virtual display, at the sheet's
 *     size, turned as the device is;
 *   - keeps each device's own settings (resolution scale, and the display's
 *     scaling on Windows, applied when that device streams and read back
 *     when it stops).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getErrorMessage, readJsonFile, sfagentsHome, writeFileAtomic } from '@sfagents/core';

const RELEASES = 'https://api.github.com/repos/linckosz/moonlight-web/releases?per_page=10';
const PROJECT = 'https://github.com/linckosz/moonlight-web';
/** Where a MoonlightWeb already running usually answers (its HTTP port and its fallbacks). */
const KNOWN_PORTS = [80, 8080, 18080, 28080];
const START_TIMEOUT_MS = 60_000;

export interface RemoteStatus {
  state: 'missing' | 'installing' | 'starting' | 'ready' | 'error';
  /** The MoonlightWeb address SF Agents talks to (loopback). */
  url?: string;
  version?: string;
  /** SF Agents started it (and stops it when it stops). */
  managed?: boolean;
  /** Can SF Agents install MoonlightWeb on this computer? */
  canInstall: boolean;
  progress?: { label: string; done: number; total: number };
  error?: string;
  /** For the sheet: where MoonlightWeb comes from. */
  project: string;
}

export interface DeviceRemoteSettings {
  /** Stream pixels per device pixel (0.5 to 1). */
  scale: number;
  /** Windows scaling of the virtual display while this device streams, in percent; null = Windows' own. */
  displayScale: number | null;
}

const DEFAULT_SETTINGS: DeviceRemoteSettings = { scale: 1, displayScale: null };

/** Where an installed MoonlightWeb lives, per platform. */
export function installedCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const pf = [env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)']].filter(Boolean) as string[];
    return pf.flatMap((d) => [path.join(d, 'MoonlightWeb', 'MoonlightWeb.exe'), path.join(d, 'Moonlight-Web', 'MoonlightWeb.exe')]);
  }
  if (platform === 'darwin') return ['/Applications/MoonlightWeb.app/Contents/MacOS/MoonlightWeb'];
  return ['/opt/moonlightweb/bin/moonlightweb-launch', '/usr/bin/moonlightweb', '/usr/local/bin/moonlightweb'];
}

/** The release file to install for this computer. */
export function installerPattern(platform: NodeJS.Platform = process.platform, arch: string = process.arch): RegExp | null {
  if (platform === 'win32') return new RegExp(`-installer-.*-win-${arch === 'arm64' ? 'arm64' : 'x64'}\\.exe$`, 'i');
  if (platform === 'darwin') return arch === 'arm64' ? /-macos-arm64\.pkg$/i : null;
  if (platform === 'linux') return arch === 'x64' ? /-x86_64\.AppImage$/ : null;
  return null;
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

export interface RemoteOptions {
  dir?: string;
  /** Reads app settings: remote.server ("auto" or a MoonlightWeb address). */
  setting?: (key: string) => unknown;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  onChange?: (status: RemoteStatus) => void;
  hideEnv?: readonly string[];
  /** Ports to look for a running MoonlightWeb on (tests). */
  knownPorts?: number[];
  /** Installed executables to look for (tests). */
  candidates?: string[];
}

export class RemoteDesktop {
  readonly dir: string;
  private readonly fetch: typeof fetch;
  private status_: RemoteStatus;
  private child: ChildProcess | null = null;
  private finding: Promise<RemoteStatus> | null = null;
  private installing: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: RemoteOptions = {}) {
    this.dir = options.dir ?? path.join(sfagentsHome(), 'remote');
    this.fetch = options.fetch ?? fetch;
    this.status_ = { state: 'missing', canInstall: installerPattern() !== null, project: PROJECT };
  }

  status(): RemoteStatus {
    return this.status_;
  }

  /** The MoonlightWeb address for the app proxy, when it is up. */
  target(): string | undefined {
    return this.status_.state === 'ready' ? this.status_.url : undefined;
  }

  private set(s: Partial<RemoteStatus>): void {
    this.status_ = { canInstall: installerPattern() !== null, project: PROJECT, ...s } as RemoteStatus;
    this.options.onChange?.(this.status_);
  }

  /** A MoonlightWeb answering at @p base? */
  private async probe(base: string): Promise<{ version: string } | null> {
    try {
      const res = await this.fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      if (!res.ok) return null;
      const j = (await res.json()) as { status?: unknown; version?: unknown; debug?: unknown };
      // MoonlightWeb's health answer: status, version, name, debug, verbose.
      if (j.status === 'ok' && typeof j.version === 'string' && typeof j.debug === 'boolean') return { version: j.version };
      return null;
    } catch {
      return null;
    }
  }

  /** Finds MoonlightWeb, starting the installed one when none is running. */
  ensure(): Promise<RemoteStatus> {
    if (this.status_.state === 'ready' && this.status_.url) {
      // Still there? (A server restarted on another port is found again.)
      return this.probe(this.status_.url).then((ok) => (ok ? this.status_ : ((this.status_ = { ...this.status_, state: 'missing' }), this.ensure())));
    }
    if (this.finding) return this.finding;
    this.finding = (async () => {
      try {
        const configured = this.options.setting?.('remote.server');
        const urls = typeof configured === 'string' && configured && configured !== 'auto' ? [configured.replace(/\/+$/, '')] : [];
        for (const port of this.options.knownPorts ?? KNOWN_PORTS) urls.push(`http://127.0.0.1:${port}`);
        for (const url of urls) {
          const found = await this.probe(url);
          if (found) {
            this.set({ state: 'ready', url, version: found.version, managed: false });
            return this.status_;
          }
        }
        const exe = this.executable();
        if (!exe) {
          this.set({ state: 'missing' });
          return this.status_;
        }
        await this.launch(exe);
        return this.status_;
      } catch (error) {
        this.set({ state: 'error', error: getErrorMessage(error) });
        return this.status_;
      } finally {
        this.finding = null;
      }
    })();
    return this.finding;
  }

  private executable(): string | undefined {
    const appImage = path.join(this.dir, 'MoonlightWeb.AppImage');
    const all = [...(this.options.candidates ?? installedCandidates()), appImage];
    return all.find((f) => fs.existsSync(f));
  }

  private async launch(exe: string): Promise<void> {
    const port = await freePort();
    const config = path.join(this.dir, 'config');
    fs.mkdirSync(config, { recursive: true });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !this.options.hideEnv?.includes(k)) env[k] = v;
    // MW_SERVICE: no desktop shortcut, no window (MoonlightWeb runs headless).
    env['MW_SERVICE'] = '1';
    // An AppImage needs FUSE; extracting it each time works without.
    if (exe.endsWith('.AppImage')) env['APPIMAGE_EXTRACT_AND_RUN'] = '1';
    const args = ['--port', String(port), '--config', path.join(config, 'settings.json'), '--autostart'];
    this.set({ state: 'starting', managed: true });
    const child = spawn(exe, args, { cwd: path.dirname(exe), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: false });
    let log = '';
    const keep = (d: Buffer) => (log = (log + d.toString()).slice(-16_000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const url = `http://127.0.0.1:${port}`;
    let exited: Error | null = null;
    child.once('error', (e) => (exited = e));
    child.once('exit', (code) => {
      exited ??= new Error(`MoonlightWeb exited (${code ?? 'signal'}). ${log.trim().split('\n').slice(-3).join(' ')}`);
      if (this.child === child) {
        this.child = null;
        if (!this.closed) this.set({ state: 'error', error: exited.message });
      }
    });
    this.child = child;
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (exited) throw exited;
      const found = await this.probe(url);
      if (found) {
        this.set({ state: 'ready', url, version: found.version, managed: true });
        this.options.log?.(`remote: MoonlightWeb ${found.version} started on ${url}`);
        return;
      }
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('MoonlightWeb did not start in time.');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---------------------------------------------------------------- install

  /** Downloads MoonlightWeb and installs it (or, on Linux, keeps the AppImage to run). */
  install(): Promise<void> {
    if (this.installing) return this.installing;
    const pattern = installerPattern();
    if (!pattern) return Promise.reject(new Error(`MoonlightWeb has no build for this computer. See ${PROJECT}.`));
    this.installing = (async () => {
      try {
        const res = await this.fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SF-Agents' } });
        if (!res.ok) throw new Error(`The MoonlightWeb releases could not be listed (HTTP ${res.status}).`);
        const releases = (await res.json()) as Array<{ tag_name: string; draft?: boolean; prerelease?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number }> }>;
        const rel = releases.filter((r) => !r.draft && !r.prerelease).find((r) => r.assets.some((a) => pattern.test(a.name)));
        const asset = rel?.assets.find((a) => pattern.test(a.name));
        if (!rel || !asset) throw new Error(`No MoonlightWeb release has a build for this computer. See ${PROJECT}.`);
        fs.mkdirSync(this.dir, { recursive: true });
        const file = path.join(this.dir, process.platform === 'linux' ? 'MoonlightWeb.AppImage' : asset.name);
        await this.download(asset.browser_download_url, file, asset.size, `MoonlightWeb ${rel.tag_name}`);
        if (process.platform === 'linux') {
          fs.chmodSync(file, 0o755);
        } else {
          // The installer asks for administrator rights itself (it installs the
          // virtual display driver); SF Agents waits for it to finish.
          this.set({ state: 'installing', progress: { label: 'Waiting for the installer', done: 0, total: 0 } });
          await runInstaller(file);
        }
        this.set({ state: 'missing' });
        await this.ensure();
        if (this.status_.state !== 'ready') throw new Error(this.status_.error ?? 'MoonlightWeb was installed but does not answer yet. Try again in a moment.');
      } catch (error) {
        this.set({ state: 'error', error: getErrorMessage(error) });
        throw error;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  private async download(url: string, file: string, size: number, label: string): Promise<void> {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'SF-Agents' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Downloading ${label} failed: HTTP ${res.status}.`);
    let done = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (c: Buffer) => {
      done += c.length;
      if (Date.now() - last > 250) {
        last = Date.now();
        this.set({ state: 'installing', progress: { label, done, total: size } });
      }
    });
    await pipeline(body, fs.createWriteStream(`${file}.part`));
    if (size && fs.statSync(`${file}.part`).size !== size) throw new Error(`${label} did not download completely. Try again.`);
    fs.renameSync(`${file}.part`, file);
  }

  // ---------------------------------------------------------------- devices

  private settingsFile(): string {
    return path.join(this.dir, 'devices.json');
  }

  deviceSettings(device: string): DeviceRemoteSettings {
    const all = readJsonFile<Record<string, Partial<DeviceRemoteSettings>>>(this.settingsFile(), {});
    return { ...DEFAULT_SETTINGS, ...(all[device] ?? {}) };
  }

  saveDeviceSettings(device: string, patch: Partial<DeviceRemoteSettings>): DeviceRemoteSettings {
    const all = readJsonFile<Record<string, Partial<DeviceRemoteSettings>>>(this.settingsFile(), {});
    const next = { ...DEFAULT_SETTINGS, ...(all[device] ?? {}) };
    if (patch.scale !== undefined) {
      if (typeof patch.scale !== 'number' || !(patch.scale >= 0.5 && patch.scale <= 1)) throw new Error('The resolution scale must be from 0.5 to 1.');
      next.scale = patch.scale;
    }
    if (patch.displayScale !== undefined) {
      if (patch.displayScale !== null && !DISPLAY_SCALES.includes(patch.displayScale)) throw new Error(`The display scaling must be one of ${DISPLAY_SCALES.join(', ')}.`);
      next.displayScale = patch.displayScale;
    }
    all[device] = next;
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.settingsFile(), `${JSON.stringify(all, null, 2)}\n`);
    return next;
  }

  close(): void {
    this.closed = true;
    this.child?.kill();
    this.child = null;
  }
}

/** Windows' scaling steps, in percent. */
export const DISPLAY_SCALES = [100, 125, 150, 175, 200, 225, 250, 300, 350];

function runInstaller(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'darwin'
        ? spawn('open', ['-W', file], { stdio: 'ignore' })
        : // Windows: the installer's own UAC prompt; shell so a "requires elevation" exe can start.
          spawn('cmd.exe', ['/d', '/s', '/c', `start "" /wait "${file}"`], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`The MoonlightWeb installer ended with code ${code}.`))));
  });
}

/** Is a command available (for diagnostics in the sheet)? */
export function hasCommand(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
