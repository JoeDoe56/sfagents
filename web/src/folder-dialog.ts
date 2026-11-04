import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

export interface FolderDialogResult { code: number | null; stdout: string; stderr: string }
export type FolderDialogRunner = (command: string, args: string[], signal: AbortSignal) => Promise<FolderDialogResult>;

function stop(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
}

export const runFolderDialog: FolderDialogRunner = (command, args, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^NODE_OPTIONS$|^LD_PRELOAD$|^DYLD_/i.test(key)) delete env[key];
  const child = spawn(command, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = ''; let stderr = '';
  const abort = () => { stop(child); child.stdout.destroy(); child.stderr.destroy(); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on('data', (chunk: string) => { if (stdout.length < 32768) stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { if (stderr.length < 32768) stderr += chunk; });
  child.once('error', (error) => { signal.removeEventListener('abort', abort); reject(error); });
  child.once('close', (code) => { signal.removeEventListener('abort', abort); resolve({ code, stdout, stderr }); });
});

/** Opens a native dialog on the SF Agents host; never uploads or copies the selected folder. */
export async function pickNativeFolder(signal: AbortSignal, options: { platform?: NodeJS.Platform; run?: FolderDialogRunner; directoryExists?: (folder: string) => boolean } = {}): Promise<string | null> {
  signal.throwIfAborted();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runFolderDialog;
  let result: FolderDialogResult;
  let folder: unknown;
  if (platform === 'win32') {
    const script = fileURLToPath(new URL('../native/folder-dialog.ps1', import.meta.url));
    result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script], signal);
    if (result.code !== 0) throw new Error('The Windows folder dialog could not open.');
    folder = (JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as { folder: unknown }).folder;
  } else if (platform === 'darwin') {
    result = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose Project Folder")'], signal);
    if (result.code !== 0 && /user cancel|\(-128\)/i.test(result.stderr)) return null;
    if (result.code !== 0) throw new Error('The macOS folder dialog could not open.');
    folder = result.stdout.replace(/\r?\n$/, '');
  } else if (platform === 'linux') {
    let selected: FolderDialogResult | undefined;
    for (const [command, args] of [
      ['zenity', ['--file-selection', '--directory', '--title=Choose Project Folder']],
      ['kdialog', ['--getexistingdirectory', '.', '--title', 'Choose Project Folder']],
    ] as const) {
      try { selected = await run(command, [...args], signal); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!selected) throw new Error('Install zenity (GTK) or kdialog (KDE) on the SF Agents computer to use its native folder dialog.');
    if (/cannot open display|could not connect to display|failed to open display/i.test(selected.stderr)) throw new Error('No graphical desktop is available on the SF Agents computer.');
    if (selected.code === 1) return null;
    if (selected.code !== 0) throw new Error('The Linux folder dialog could not open.');
    folder = selected.stdout.replace(/\r?\n$/, '');
  } else throw new Error('Native folder selection is supported on Windows, macOS and Linux.');
  signal.throwIfAborted();
  if (folder === null || folder === '') return null;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof folder !== 'string' || /[\x00-\x1f]/.test(folder) || !paths.isAbsolute(folder)) throw new Error('The folder dialog did not return a full filesystem path.');
  const resolved = paths.resolve(folder);
  if (!(options.directoryExists ?? ((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true))(resolved)) throw new Error('The selected folder is no longer available.');
  return resolved;
}
