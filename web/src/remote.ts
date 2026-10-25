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
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getErrorMessage, readJsonFile, sfagentsHome, writeFileAtomic } from '@sfagents/core';
import { runElevatedWindows } from './privileges.js';

const RELEASES = 'https://api.github.com/repos/linckosz/moonlight-web/releases?per_page=10';
const PROJECT = 'https://github.com/linckosz/moonlight-web';
/** Where a MoonlightWeb already running usually answers (its HTTP port and its fallbacks). */
const KNOWN_PORTS = [80, 8080, 18080, 28080];
const START_TIMEOUT_MS = 60_000;
/** Used when GitHub cannot say which release is the newest. */
const FALLBACK_TAG = 'v0.4.0';

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** The HTTP port an installed MoonlightWeb was set to (its settings.json, per user). */
function configuredPorts(): number[] {
  const home = os.homedir();
  const dirs =
    process.platform === 'win32'
      ? [path.join(process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), 'MoonlightWeb', 'MoonlightWeb')]
      : process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'MoonlightWeb', 'MoonlightWeb')]
        : [path.join(process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share'), 'MoonlightWeb', 'MoonlightWeb')];
  const out: number[] = [];
  for (const d of dirs) {
    const port = readJsonFile<{ http_port?: unknown }>(path.join(d, 'settings.json'), {}).http_port;
    if (typeof port === 'number' && port > 0 && port < 65536) out.push(port);
  }
  return out;
}

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
        for (const port of this.options.knownPorts ?? [...configuredPorts(), ...KNOWN_PORTS, ...range(49080, 49090)]) urls.push(`http://127.0.0.1:${port}`);
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

  /** The newest MoonlightWeb release file for this computer. */
  private async latestInstaller(pattern: RegExp): Promise<{ tag: string; name: string; url: string; size: number }> {
    try {
      const res = await this.fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SF-Agents' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const releases = (await res.json()) as Array<{ tag_name: string; draft?: boolean; prerelease?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number }> }>;
      const rel = releases.filter((r) => !r.draft && !r.prerelease).find((r) => r.assets.some((a) => pattern.test(a.name)));
      const asset = rel?.assets.find((a) => pattern.test(a.name));
      if (rel && asset) return { tag: rel.tag_name, name: asset.name, url: asset.browser_download_url, size: asset.size };
    } catch {
      // the API is rate-limited: the release page's redirect names the tag too
    }
    let tag = FALLBACK_TAG;
    try {
      const res = await this.fetch(`${PROJECT}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'SF-Agents' } });
      const m = /\/releases\/tag\/(v[\d.]+)$/.exec(res.headers.get('location') ?? '');
      if (m) tag = m[1]!;
    } catch {
      // keep the known release
    }
    const v = tag.slice(1);
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const name = process.platform === 'win32' ? `MoonlightWeb-installer-${v}-win-${arch}.exe` : process.platform === 'darwin' ? `moonlightweb-${v}-macos-arm64.pkg` : `moonlightweb-${v}-x86_64.AppImage`;
    return { tag, name, url: `${PROJECT}/releases/download/${tag}/${name}`, size: 0 };
  }

  /**
   * Installs MoonlightWeb with no questions but the system's own approval:
   * Windows' administrator prompt (the installer adds the virtual display
   * driver and its scheduled tasks; it runs silently), macOS' password prompt
   * for the package, nothing on Linux (the AppImage runs as you; one polkit
   * prompt gives it the input devices it types and clicks with).
   */
  install(): Promise<void> {
    if (this.installing) return this.installing;
    const pattern = installerPattern();
    if (!pattern) return Promise.reject(new Error(`MoonlightWeb has no build for this computer. See ${PROJECT}.`));
    this.installing = (async () => {
      try {
        const rel = await this.latestInstaller(pattern);
        fs.mkdirSync(this.dir, { recursive: true });
        const file = path.join(this.dir, process.platform === 'linux' ? 'MoonlightWeb.AppImage' : rel.name);
        await this.download(rel.url, file, rel.size, `MoonlightWeb ${rel.tag}`);
        if (process.platform === 'linux') {
          fs.chmodSync(file, 0o755);
          await linuxInputAccess(this.options.log);
        } else {
          this.set({ state: 'installing', progress: { label: 'Waiting for administrator approval', done: 0, total: 0 } });
          if (process.platform === 'win32') await runElevatedWindows([{ file, args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'] }]);
          else await runElevatedMac(`/usr/sbin/installer -pkg ${shellQuote(file)} -target /`);
          fs.rmSync(file, { force: true });
        }
        this.set({ state: 'starting' });
        // The installer starts MoonlightWeb itself; give it a moment.
        const deadline = Date.now() + START_TIMEOUT_MS;
        for (;;) {
          this.status_ = { ...this.status_, state: 'missing' };
          await this.ensure();
          if (this.status_.state === 'ready' || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (this.status_.state !== 'ready') throw new Error(this.status_.error ?? 'MoonlightWeb was installed but does not answer yet.');
      } catch (error) {
        this.set({ state: 'error', error: getErrorMessage(error) });
        throw error;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  /**
   * At start: find MoonlightWeb, or install it, so Remote Desktop works the
   * first time it is opened. Never throws; problems end up in status().
   */
  async autoSetup(): Promise<void> {
    const s = await this.ensure();
    if (s.state === 'ready') {
      if (process.platform === 'linux') await linuxInputAccess(this.options.log).catch(() => undefined);
      return;
    }
    if (s.state === 'missing' && s.canInstall) await this.install().catch(() => undefined);
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${path.basename(cmd)} exited with code ${code}`))));
  });
}

/** macOS: one password prompt for a shell command run as root. */
export function runElevatedMac(command: string): Promise<void> {
  const script = `do shell script ${JSON.stringify(command)} with administrator privileges with prompt "SF Agents installs MoonlightWeb for Remote Desktop."`;
  return run('/usr/bin/osascript', ['-e', script]);
}

const UINPUT_RULES = `KERNEL=="uinput", SUBSYSTEM=="misc", OPTIONS+="static_node=uinput", TAG+="uaccess", MODE="0660", GROUP="input"
KERNEL=="uhid", SUBSYSTEM=="misc", OPTIONS+="static_node=uhid", TAG+="uaccess", MODE="0660", GROUP="input"
`;

/**
 * Linux: MoonlightWeb types and clicks through /dev/uinput, which a user
 * may not open by default. Once, with polkit's prompt: MoonlightWeb's own
 * udev rule (the one its packages install) and the modules loaded at boot.
 */
export async function linuxInputAccess(log?: (line: string) => void): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    fs.accessSync('/dev/uinput', fs.constants.W_OK);
    return;
  } catch {
    // not yet
  }
  if (fs.existsSync('/etc/udev/rules.d/70-moonlightweb-uinput.rules')) return;
  if (!hasCommand('pkexec')) {
    log?.('remote: /dev/uinput is not writable and pkexec is missing; Remote Desktop can show the screen but not type or click.');
    return;
  }
  const script = [
    `printf '%s' ${shellQuote(UINPUT_RULES)} > /etc/udev/rules.d/70-moonlightweb-uinput.rules`,
    `printf 'uinput\\nuhid\\n' > /etc/modules-load.d/moonlightweb-uinput.conf`,
    'modprobe uinput; modprobe uhid',
    'udevadm control --reload-rules; udevadm trigger --subsystem-match=misc',
  ].join('; ');
  await run('pkexec', ['/bin/sh', '-c', script]).catch((error) => log?.(`remote: input access was not set up: ${getErrorMessage(error)}`));
}

/** Is a command available (for diagnostics in the sheet)? */
export function hasCommand(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
