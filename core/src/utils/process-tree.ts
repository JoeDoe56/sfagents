/**
 * Stops every process this one started, and the ones those started, so that
 * quitting SF Agents leaves nothing running: speech servers, screen mirroring's
 * helper, sensor workers, terminals, shell commands, MCP servers, the sandbox.
 *
 * Each part closes its own processes first (the server's close()); this is
 * the backstop for whatever is still alive after that. On Windows,
 * `taskkill /T /F` takes each process with its tree. Elsewhere, SIGTERM and,
 * after a moment, SIGKILL for anything left.
 */

import { execFile } from 'node:child_process';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * The processes under @p root, parents before children. A process whose
 * command line matches @p keep (and everything under it) is left alone.
 */
export function descendantsOf(rows: ProcessEntry[], root: number, keep?: (command: string) => boolean): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: ProcessEntry[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid) || keep?.(child.command)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** `pid ppid command` per line, as printed by listProcesses' commands. */
export function parseProcessList(text: string): ProcessEntry[] {
  const rows: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!.trim() });
  }
  return rows;
}

function run(file: string, args: string[], timeout: number): Promise<{ stdout: string; pid?: number }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) =>
      resolve({ stdout: String(stdout ?? ''), pid: child.pid }),
    );
  });
}

async function listProcesses(): Promise<{ rows: ProcessEntry[]; lister?: number }> {
  if (process.platform === 'win32') {
    const script =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }';
    const r = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 8_000);
    return { rows: parseProcessList(r.stdout), lister: r.pid };
  }
  const r = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], 5_000);
  return { rows: parseProcessList(r.stdout), lister: r.pid };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kills what is still running under this process. Resolves with the processes
 * it stopped. @p keep spares a process by its command line (and its children).
 */
export async function killProcessTree(
  options: { root?: number; keep?: (command: string) => boolean; graceMs?: number } = {},
): Promise<ProcessEntry[]> {
  const root = options.root ?? process.pid;
  const { rows, lister } = await listProcesses();
  // The listing's own process (and on Windows its console host) is not ours to stop.
  const skip = new Set<number>();
  for (const r of rows) if (r.pid === lister) for (const d of [r, ...descendantsOf(rows, r.pid)]) skip.add(d.pid);
  let targets = descendantsOf(rows, root, options.keep).filter((p) => !skip.has(p.pid));
  // Processes that were asked to quit get a moment to do it themselves.
  const grace = Date.now() + (options.graceMs ?? 0);
  while (Date.now() < grace && targets.some((p) => alive(p.pid))) await new Promise((r) => setTimeout(r, 100));
  targets = targets.filter((p) => alive(p.pid));
  if (!targets.length) return [];
  if (process.platform === 'win32') {
    // Direct children first: /T takes each one's tree with it, and the rest are named
    // too in case a parent already exited and left them behind.
    for (let i = 0; i < targets.length; i += 50) {
      const batch = targets.slice(i, i + 50).flatMap((p) => ['/PID', String(p.pid)]);
      await run('taskkill.exe', ['/F', '/T', ...batch], 10_000);
    }
    return targets;
  }
  for (const p of targets) {
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline && targets.some((p) => alive(p.pid))) await new Promise((r) => setTimeout(r, 100));
  for (const p of targets) {
    try {
      if (alive(p.pid)) process.kill(p.pid, 'SIGKILL');
    } catch {
      // already gone, or not ours
    }
  }
  return targets;
}
