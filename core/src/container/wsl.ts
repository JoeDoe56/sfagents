/**
 * Windows: SF Agents' own WSL2 distro, "sfagents", where its Docker Engine
 * runs. It is separate from Docker Desktop (which runs Immich) and is set up
 * so a container escape reaches as little as possible:
 *
 * - Windows drives are not mounted ([automount] enabled=false). Only the
 *   agents' folders are, read-only, one drvfs mount each under /mnt/sfa-roots.
 * - Linux cannot start Windows programs ([interop] enabled=false).
 * - Its Docker CLI and socket are SF Agents' own (/opt/sfagents/bin/docker,
 *   /run/sfagents/docker.sock), so Docker Desktop's integration can't swap
 *   them for the Docker Desktop engine.
 *
 * The distro is imported from a root filesystem built by CI
 * (container/wsl), and needs no administrator rights: WSL itself is already
 * installed with Docker Desktop.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsWslExe, WSL_DISTRO } from './docker.js';

/** Inside the distro: the shared workspaces folder (bind-mounted as /workspaces). */
export const DISTRO_WORKSPACES = '/srv/sfagents/workspaces';
export const DISTRO_ROOTS = '/mnt/sfa-roots';

export function distroWorkspacesDir(): string {
  return DISTRO_WORKSPACES;
}

/** The workspaces folder as Windows sees it (SF Agents reads artifacts there). */
export function windowsWorkspacesDir(): string {
  return `\\\\wsl.localhost\\${WSL_DISTRO}${DISTRO_WORKSPACES.replace(/\//g, '\\')}`;
}

export interface WslResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs wsl.exe. Its own messages are UTF-16; commands in the distro answer in UTF-8. */
export function wsl(args: readonly string[], options: { input?: string; timeoutMs?: number; utf16?: boolean } = {}): Promise<WslResult> {
  return new Promise((resolve) => {
    const child = spawn(windowsWslExe(), [...args], { windowsHide: true, stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, WSL_UTF8: '1' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
    if (options.input !== undefined) child.stdin?.end(options.input);
    const decode = (b: Buffer) => {
      // WSL_UTF8=1 makes newer wsl.exe answer in UTF-8; older ones still send UTF-16LE.
      const utf16 = options.utf16 !== false && b.length >= 2 && b[1] === 0 && b[0] !== 0;
      return (utf16 ? b.toString('utf16le') : b.toString('utf8')).replace(/\0/g, '');
    };
    const done = (code: number | null, extra = '') => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: decode(Buffer.concat(out)), stderr: decode(Buffer.concat(err)) + extra });
    };
    child.on('error', (error) => done(null, error.message));
    child.on('close', (code) => done(code));
  });
}

/** Runs a shell command as root in the sfagents distro. */
export function inDistro(script: string, timeoutMs = 120_000): Promise<WslResult> {
  return wsl(['-d', WSL_DISTRO, '-u', 'root', '--exec', 'sh', '-c', script], { timeoutMs, utf16: false });
}

export type WslStatus =
  | { state: 'ready' }
  | { state: 'no-wsl'; detail: string }
  | { state: 'no-distro' }
  | { state: 'no-docker'; detail: string };

/** Whether WSL, the distro and its Docker Engine are there. */
export async function wslStatus(): Promise<WslStatus> {
  const list = await wsl(['--list', '--quiet']);
  if (list.code !== 0 && !list.stdout.trim()) return { state: 'no-wsl', detail: (list.stderr || list.stdout).trim() || `wsl.exe exit code ${list.code}` };
  const distros = list.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!distros.some((d) => d.toLowerCase() === WSL_DISTRO)) return { state: 'no-distro' };
  const engine = await inDistro('/opt/sfagents/bin/docker -H unix:///run/sfagents/docker.sock version --format "{{.Server.Version}}"', 60_000);
  if (engine.code !== 0) return { state: 'no-docker', detail: (engine.stderr || engine.stdout).trim() };
  return { state: 'ready' };
}

/** Folder names under /mnt/sfa-roots: stable per Windows path. */
export function distroRootDir(windowsPath: string): string {
  const base = (windowsPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'root').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${DISTRO_ROOTS}/${base}-${createHash('sha256').update(windowsPath.toLowerCase()).digest('hex').slice(0, 8)}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mounts each Windows folder read-only in the distro (once; mounts last until
 * WSL restarts) and returns the distro paths, in the same order.
 */
export async function mountRootsInDistro(windowsPaths: readonly string[]): Promise<string[]> {
  const dirs = windowsPaths.map(distroRootDir);
  if (!dirs.length) return dirs;
  const script = windowsPaths
    .map((p, i) => {
      const d = shellQuote(dirs[i]!);
      return `mkdir -p ${d} && (mountpoint -q ${d} || mount -t drvfs ${shellQuote(p)} ${d} -o ro,noatime,uid=1000,gid=1000) || { echo "cannot mount ${p.replace(/["$`\\]/g, '')}" >&2; exit 1; }`;
    })
    .join('\n');
  const result = await inDistro(script);
  if (result.code !== 0) throw new Error(`Could not share the agent's folders with its container: ${(result.stderr || result.stdout).trim()}`);
  return dirs;
}

/** The release with the distro's root filesystem (built by .github/workflows/agent-image.yml). */
export const WSL_ROOTFS_URL = 'https://github.com/JoeDoe56/sfagents/releases/download/wsl-rootfs-docker/sfagents-wsl.tar.gz';

/** The WSL settings SF Agents needs, merged into %UserProfile%\.wslconfig. */
export const WSLCONFIG_SETTINGS: Record<string, Record<string, string>> = {
  wsl2: { memory: '16GB', swap: '8GB' },
  experimental: { autoMemoryReclaim: 'gradual', sparseVhd: 'true' },
};

/**
 * Merges settings into a .wslconfig text, keeping everything else (and any
 * value Caleb set himself for the same key, unless `force`).
 */
export function mergeWslConfig(text: string, settings: Record<string, Record<string, string>>, force = false): { text: string; changed: string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const changed: string[] = [];
  for (const [section, values] of Object.entries(settings)) {
    let start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section.toLowerCase()}]`);
    if (start < 0) {
      if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
      lines.push(`[${section}]`);
      start = lines.length - 1;
    }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    for (const [key, value] of Object.entries(values)) {
      const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`, 'i').test(l));
      if (at >= 0) {
        if (!force || lines[at]!.split('=')[1]!.trim() === value) continue;
        lines[at] = `${key}=${value}`;
      } else {
        // After the section's last setting, before any blank lines.
        let insert = end;
        while (insert > start + 1 && lines[insert - 1]!.trim() === '') insert--;
        lines.splice(insert, 0, `${key}=${value}`);
        end++;
      }
      changed.push(`[${section}] ${key}=${value}`);
    }
  }
  return { text: lines.join('\r\n').replace(/(\r\n)*$/, '\r\n'), changed };
}

/** WSLCONFIG_SETTINGS with the WSL Memory Cap setting (GB). */
export function wslConfigSettings(memoryGb: number): Record<string, Record<string, string>> {
  return { ...WSLCONFIG_SETTINGS, wsl2: { ...WSLCONFIG_SETTINGS['wsl2'], memory: `${memoryGb}GB` } };
}

/**
 * Writes the WSL Memory Cap to .wslconfig (the previous file is kept as
 * .wslconfig.sfagents-backup). WSL is never restarted here: it takes effect
 * the next time WSL starts. Returns whether the file changed.
 */
export function writeWslMemoryCap(memoryGb: number, file = wslConfigPath()): { changed: boolean; file: string; backup?: string } {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { text, changed } = mergeWslConfig(before, { wsl2: { memory: `${memoryGb}GB` } }, true);
  if (!changed.length) return { changed: false, file };
  let backup: string | undefined;
  if (before) {
    backup = `${file}.sfagents-backup`;
    // The first backup is the file as it was before SF Agents changed it; keep it.
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, text);
  return { changed: true, file, ...(backup ? { backup } : {}) };
}

/** The WSL memory limit in .wslconfig, in MB (undefined when none is set). */
export function wslMemoryMb(file = wslConfigPath()): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^\s*memory\s*=\s*(\d+(?:\.\d+)?)\s*(GB|MB)?\s*$/im.exec(text);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2]?.toUpperCase() === 'MB' ? 1 : 1024));
}

export function wslConfigPath(): string {
  return path.join(os.homedir(), '.wslconfig');
}

/**
 * Sets the distro up: downloads the root filesystem, imports it (no admin
 * rights needed), turns its disk sparse and starts Docker. Reports each step.
 */
export async function setupDistro(o: { report(line: string): void; rootfs?: string; installDir?: string }): Promise<void> {
  const status = await wslStatus();
  if (status.state === 'no-wsl') throw new Error(`WSL is not available: ${status.detail}. Docker Desktop normally installs it; otherwise run "wsl --install --no-distribution" as administrator and restart.`);
  if (status.state === 'ready') {
    o.report('The sfagents WSL distro is already set up.');
    return;
  }
  // One distro per Windows account, wherever SF Agents' own data lives.
  const installDir = o.installDir ?? path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'SF Agents', 'wsl');
  if (status.state === 'no-distro') {
    let tar = o.rootfs;
    if (!tar) {
      tar = path.join(os.tmpdir(), `sfagents-wsl-${process.pid}.tar.gz`);
      o.report(`Downloading the distro (${WSL_ROOTFS_URL})…`);
      const [res, sum] = await Promise.all([fetch(WSL_ROOTFS_URL), fetch(`${WSL_ROOTFS_URL}.sha256`)]);
      if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
      if (!sum.ok) throw new Error(`Download of the checksum failed: HTTP ${sum.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const expected = (await sum.text()).trim().split(/\s+/)[0]!.toLowerCase();
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) throw new Error(`The downloaded distro does not match its checksum (expected ${expected}, got ${actual}).`);
      fs.writeFileSync(tar, bytes);
    }
    fs.mkdirSync(installDir, { recursive: true });
    o.report(`Importing it into ${installDir}…`);
    const imported = await wsl(['--import', WSL_DISTRO, installDir, tar, '--version', '2'], { timeoutMs: 30 * 60_000 });
    if (imported.code !== 0) throw new Error(`wsl --import failed: ${(imported.stderr || imported.stdout).trim()}`);
    if (!o.rootfs) fs.rmSync(tar, { force: true });
    // The disk is attached while the distro runs (an import may start it); stop the distro first.
    // It can stay attached for a few seconds after that.
    let sparse = { code: 1 as number | null, stdout: '', stderr: '' };
    for (let attempt = 0; attempt < 5 && sparse.code !== 0; attempt++) {
      await wsl(['--terminate', WSL_DISTRO], { timeoutMs: 60_000 });
      if (attempt) await new Promise((r) => setTimeout(r, 3000));
      sparse = await wsl(['--manage', WSL_DISTRO, '--set-sparse', 'true'], { timeoutMs: 120_000 });
    }
    if (sparse.code !== 0) o.report(`Note: could not make the distro's disk sparse (${(sparse.stderr || sparse.stdout).trim()}); it still works, but its disk file will not shrink.`);
  }
  o.report('Starting Docker in the distro…');
  for (let i = 0; i < 30; i++) {
    const s = await wslStatus();
    if (s.state === 'ready') {
      o.report('Docker is running in the sfagents distro.');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Docker did not start in the sfagents distro. Run: wsl -d sfagents -u root -- systemctl status sfagents-docker');
}
