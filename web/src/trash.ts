/**
 * Moving files to the system's Trash or Recycle Bin, and putting them back.
 *
 *  - Windows: the Recycle Bin, through the shell's own FileSystem.DeleteFile
 *    / DeleteDirectory with SendToRecycleBin (Windows PowerShell; the paths
 *    travel in an environment variable, never in the script text).
 *  - macOS: ~/.Trash (or the volume's .Trashes/<uid> on another drive).
 *  - Linux and other Unix: the freedesktop.org Trash specification: the
 *    home trash ($XDG_DATA_HOME/Trash with files/ and info/*.trashinfo), or
 *    $topdir/.Trash-$uid on another file system.
 *
 * On macOS and Linux a small log in SF Agents' state directory remembers
 * where each item came from, so Put Back works for anything trashed here
 * (Linux also reads the .trashinfo files other apps write).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface TrashOutcome {
  path: string;
  /** Where it went (macOS and Linux). */
  trashPath?: string;
  error?: string;
}

interface LogEntry {
  trashPath: string;
  original: string;
  at: number;
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = $env:SFAGENTS_TRASH_PATHS | ConvertFrom-Json
$out = @()
foreach ($p in $paths) {
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    $out += @{ path = $p }
  } catch {
    $out += @{ path = $p; error = $_.Exception.Message }
  }
}
ConvertTo-Json -Compress -InputObject @($out)
`;

function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "name.ext", "name 2.ext", … — the first that does not exist in `dir`. */
export async function freeName(dir: string, name: string, exists: (p: string) => Promise<boolean> = pathExists): Promise<string> {
  if (!(await exists(path.join(dir, name)))) return name;
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const base = stem.replace(/ \d+$/, '');
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function moveAcross(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fsp.cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

export class Trash {
  private readonly logFile: string | undefined;

  constructor(
    private readonly options: { platform?: NodeJS.Platform; home?: string; stateDir?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.logFile = options.stateDir ? path.join(options.stateDir, 'trash-log.json') : undefined;
  }

  private get platform() {
    return this.options.platform ?? process.platform;
  }
  private get home() {
    return this.options.home ?? os.homedir();
  }
  private get env() {
    return this.options.env ?? process.env;
  }

  /** The home trash folder whose contents can be browsed (null on Windows). */
  location(): string | null {
    if (this.platform === 'win32') return null;
    if (this.platform === 'darwin') return path.join(this.home, '.Trash');
    return path.join(this.env.XDG_DATA_HOME || path.join(this.home, '.local', 'share'), 'Trash', 'files');
  }

  async trash(paths: string[]): Promise<TrashOutcome[]> {
    if (this.platform === 'win32') return this.trashWindows(paths);
    const out: TrashOutcome[] = [];
    for (const p of paths) {
      try {
        const trashPath = this.platform === 'darwin' ? await this.trashMac(p) : await this.trashFreedesktop(p);
        await this.log({ trashPath, original: p, at: Date.now() });
        out.push({ path: p, trashPath });
      } catch (error) {
        out.push({ path: p, error: (error as Error).message });
      }
    }
    return out;
  }

  private trashWindows(paths: string[]): Promise<TrashOutcome[]> {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
        { env: { ...process.env, SFAGENTS_TRASH_PATHS: JSON.stringify(paths) }, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          try {
            const parsed = JSON.parse(stdout) as TrashOutcome[];
            resolve(paths.map((p) => parsed.find((o) => o.path === p) ?? { path: p, error: 'The Recycle Bin did not report this item.' }));
          } catch {
            resolve(paths.map((p) => ({ path: p, error: error?.message ?? 'Could not reach the Recycle Bin.' })));
          }
        },
      );
    });
  }

  private async trashMac(p: string): Promise<string> {
    let trashDir = path.join(this.home, '.Trash');
    const st = await fsp.lstat(p);
    const home = await fsp.stat(this.home).catch(() => undefined);
    if (home && st.dev !== home.dev) {
      // Another volume keeps its own trash: /Volumes/<name>/.Trashes/<uid>.
      const top = await this.mountTop(p, st.dev);
      const candidate = path.join(top, '.Trashes', String(process.getuid?.() ?? 501));
      if (await pathExists(candidate)) trashDir = candidate;
    }
    await fsp.mkdir(trashDir, { recursive: true });
    const name = await freeName(trashDir, path.basename(p));
    const target = path.join(trashDir, name);
    try {
      await fsp.rename(p, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('This drive has no Trash. Delete it permanently instead.');
      throw error;
    }
    return target;
  }

  private async mountTop(p: string, dev: number): Promise<string> {
    let top = path.resolve(p);
    for (;;) {
      const parent = path.dirname(top);
      if (parent === top) return top;
      const st = await fsp.stat(parent).catch(() => undefined);
      if (!st || st.dev !== dev) return top;
      top = parent;
    }
  }

  /** The freedesktop.org Trash specification 1.0. */
  private async trashFreedesktop(p: string): Promise<string> {
    const abs = path.resolve(p);
    const st = await fsp.lstat(abs);
    const homeTrash = path.join(this.env.XDG_DATA_HOME || path.join(this.home, '.local', 'share'), 'Trash');
    let trashRoot = homeTrash;
    let infoPath = abs;
    const homeStat = await fsp.stat(this.home).catch(() => undefined);
    if (homeStat && homeStat.dev !== st.dev) {
      // Another file system: $topdir/.Trash-$uid, with paths relative to $topdir.
      const top = await this.mountTop(abs, st.dev);
      trashRoot = path.join(top, `.Trash-${process.getuid?.() ?? 1000}`);
      infoPath = path.relative(top, abs);
    }
    const files = path.join(trashRoot, 'files');
    const info = path.join(trashRoot, 'info');
    await fsp.mkdir(files, { recursive: true, mode: 0o700 });
    await fsp.mkdir(info, { recursive: true, mode: 0o700 });
    // Reserve the name by creating its .trashinfo exclusively (the spec's rule against races).
    let name = path.basename(abs);
    let infoFile = '';
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? name : `${name}.${i}`;
      try {
        if (await pathExists(path.join(files, candidate))) continue;
        infoFile = path.join(info, `${candidate}.trashinfo`);
        const encoded = infoPath.split(path.sep).map((s) => encodeURIComponent(s)).join('/');
        await fsp.writeFile(infoFile, `[Trash Info]\nPath=${encoded}\nDeletionDate=${stamp()}\n`, { flag: 'wx', mode: 0o600 });
        name = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const target = path.join(files, name);
    try {
      await fsp.rename(abs, target);
    } catch (error) {
      await fsp.rm(infoFile, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('This drive has no Trash. Delete it permanently instead.');
      throw error;
    }
    return target;
  }

  private async readLog(): Promise<LogEntry[]> {
    if (!this.logFile) return [];
    try {
      return JSON.parse(await fsp.readFile(this.logFile, 'utf8')) as LogEntry[];
    } catch {
      return [];
    }
  }

  private async log(entry: LogEntry): Promise<void> {
    if (!this.logFile) return;
    const all = (await this.readLog()).filter((e) => e.trashPath !== entry.trashPath && fs.existsSync(e.trashPath));
    all.push(entry);
    await fsp.mkdir(path.dirname(this.logFile), { recursive: true });
    await fsp.writeFile(this.logFile, JSON.stringify(all.slice(-5000)));
  }

  /** Where a trashed item came from, if known. */
  async originOf(trashPath: string): Promise<string | undefined> {
    const logged = (await this.readLog()).find((e) => e.trashPath === trashPath);
    if (logged) return logged.original;
    if (this.platform === 'win32' || this.platform === 'darwin') return undefined;
    // freedesktop: files/<name> ↔ info/<name>.trashinfo
    const filesDir = path.dirname(trashPath);
    if (path.basename(filesDir) !== 'files') return undefined;
    const root = path.dirname(filesDir);
    try {
      const text = await fsp.readFile(path.join(root, 'info', `${path.basename(trashPath)}.trashinfo`), 'utf8');
      const raw = /^Path=(.*)$/m.exec(text)?.[1];
      if (!raw) return undefined;
      const decoded = raw.split('/').map((s) => decodeURIComponent(s)).join('/');
      // Relative paths belong to the trash's own top directory.
      return path.isAbsolute(decoded) ? decoded : path.join(path.dirname(root), decoded);
    } catch {
      return undefined;
    }
  }

  /** Puts trashed items back where they came from (keeping both if something took their place). */
  async restore(trashPaths: string[]): Promise<TrashOutcome[]> {
    const out: TrashOutcome[] = [];
    for (const t of trashPaths) {
      try {
        const original = await this.originOf(t);
        if (!original) throw new Error('Where this item came from is not known.');
        await fsp.mkdir(path.dirname(original), { recursive: true });
        const name = await freeName(path.dirname(original), path.basename(original));
        const target = path.join(path.dirname(original), name);
        await moveAcross(t, target);
        await this.forget(t);
        out.push({ path: target });
      } catch (error) {
        out.push({ path: t, error: (error as Error).message });
      }
    }
    return out;
  }

  private async forget(trashPath: string): Promise<void> {
    if (this.platform !== 'win32' && this.platform !== 'darwin') {
      const filesDir = path.dirname(trashPath);
      if (path.basename(filesDir) === 'files') await fsp.rm(path.join(path.dirname(filesDir), 'info', `${path.basename(trashPath)}.trashinfo`), { force: true });
    }
    if (!this.logFile) return;
    const all = (await this.readLog()).filter((e) => e.trashPath !== trashPath);
    await fsp.writeFile(this.logFile, JSON.stringify(all)).catch(() => undefined);
  }

  /** Permanently removes everything in the home trash. */
  async empty(): Promise<number> {
    if (this.platform === 'win32') {
      await new Promise<void>((resolve, reject) =>
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction Stop'], { windowsHide: true, timeout: 120_000 }, (e) => (e ? reject(new Error('Could not empty the Recycle Bin.')) : resolve())),
      );
      return 0;
    }
    const dir = this.location();
    if (!dir) return 0;
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      await fsp.rm(path.join(dir, n), { recursive: true, force: true });
      await this.forget(path.join(dir, n));
    }
    return names.length;
  }
}
