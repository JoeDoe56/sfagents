/**
 * Processes, users, services and startup apps for the monitor's windows
 * (Task Manager's Processes, Details, Users, Services and Startup tabs).
 *
 *  - Linux: /proc (stat, status, cmdline, exe, cwd, fd, io), `who`,
 *    `systemctl`, and ~/.config/autostart (whose entries can be switched
 *    on and off, as the desktop's own settings do).
 *  - macOS: `ps`, `lsof` for the working folder, `who`, `launchctl`, and
 *    the LaunchAgents folders.
 *  - Windows: Win32_Process, Get-Service and Win32_StartupCommand through
 *    one long-lived PowerShell, and `query user`.
 *
 * CPU use is the share of the whole machine (all cores), as Task Manager
 * shows it, from the difference between two readings. Ending a process
 * sends SIGTERM (Unix) or terminates it (Windows); Force Quit sends
 * SIGKILL. The system's own critical processes and SF Agents itself are
 * refused.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { SystemSource } from './system.js';
import { PowerShell } from './powershell.js';

export interface ProcessRow {
  pid: number;
  ppid: number | null;
  name: string;
  user: string | null;
  /** Share of the whole machine's CPU time, 0–1. */
  cpu: number | null;
  /** Resident memory (working set) in bytes. */
  memory: number | null;
  threads: number | null;
  started: number | null;
  path: string | null;
}

export interface ProcessDetail extends ProcessRow {
  command: string | null;
  cwd: string | null;
  state: string | null;
  priority: number | null;
  virtual: number | null;
  swap: number | null;
  files: number | null;
  handles: number | null;
  ioRead: number | null;
  ioWrite: number | null;
  children: ProcessRow[];
  parent: ProcessRow | null;
  protected: string | null;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export const PRIORITY_LEVELS = {
  low: os.constants.priority.PRIORITY_LOW,
  belowNormal: os.constants.priority.PRIORITY_BELOW_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  aboveNormal: os.constants.priority.PRIORITY_ABOVE_NORMAL,
  high: os.constants.priority.PRIORITY_HIGH,
} as const;
export type PriorityLevel = keyof typeof PRIORITY_LEVELS;

const WINDOWS_CRITICAL = new Set(['system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'memcompression', 'secure system', 'fontdrvhost.exe', 'dwm.exe']);

interface CpuSample {
  at: number;
  /** pid → [cpu milliseconds, start time] (start time tells a reused pid apart). */
  times: Map<number, [number, number | null]>;
}

// ------------------------------------------------------------------ parsers

/** /proc/[pid]/stat: the fields after the command name (which may contain spaces and parentheses). */
export function parseProcStat(text: string): { comm: string; state: string; ppid: number; utime: number; stime: number; threads: number; starttime: number; rss: number } | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 2).trim().split(/\s+/);
  // f[0] is field 3 (state).
  return {
    comm: text.slice(open + 1, close),
    state: f[0]!,
    ppid: Number(f[1]),
    utime: Number(f[11]),
    stime: Number(f[12]),
    threads: Number(f[17]),
    starttime: Number(f[19]),
    rss: Number(f[21]),
  };
}

/** `ps -axww -o pid=,ppid=,pcpu=,rss=,etime=,user=,comm=` (macOS and BSD). */
export function parsePs(text: string, cores: number, now = Date.now()): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const comm = m[7]!.trim();
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: path.posix.basename(comm) || comm,
      user: m[6]!,
      cpu: Math.min(1, Number(m[3]) / 100 / Math.max(1, cores)),
      memory: Number(m[4]) * 1024,
      threads: null,
      started: now - parseEtime(m[5]!) * 1000,
      path: comm.startsWith('/') ? comm : null,
    });
  }
  return rows;
}

/** ps elapsed time: [[dd-]hh:]mm:ss → seconds. */
export function parseEtime(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** `who`: one row per login session. */
export function parseWho(text: string): { user: string; terminal: string; since: string; from: string | null }[] {
  const out: { user: string; terminal: string; since: string; from: string | null }[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+(.+?)(?:\s+\((.*)\))?\s*$/.exec(line);
    if (m) out.push({ user: m[1]!, terminal: m[2]!, since: m[3]!.trim(), from: m[4] ?? null });
  }
  return out;
}

/** `systemctl list-units --type=service --all --no-pager --no-legend --plain`. */
export function parseSystemctl(text: string): { name: string; description: string; state: string; sub: string; load: string }[] {
  const out: { name: string; description: string; state: string; sub: string; load: string }[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*●?\s*(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) out.push({ name: m[1]!, load: m[2]!, state: m[3]!, sub: m[4]!, description: m[5]!.trim() });
  }
  return out;
}

/** A freedesktop .desktop file's [Desktop Entry] keys. */
export function parseDesktopEntry(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inEntry = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) inEntry = t === '[Desktop Entry]';
    else if (inEntry) {
      const m = /^([\w-]+)\s*=\s*(.*)$/.exec(t);
      if (m && !(m[1]! in out)) out[m[1]!] = m[2]!;
    }
  }
  return out;
}

// ------------------------------------------------------------------ monitor

export interface ServiceRow {
  name: string;
  description: string;
  /** running, stopped, failed, … */
  state: string;
  detail: string;
  scope: 'system' | 'user';
  startup: string | null;
  pid: number | null;
}

export interface StartupRow {
  id: string;
  name: string;
  command: string;
  location: string;
  enabled: boolean;
  /** Whether it can be switched from here. */
  toggle: boolean;
}

export class ProcessMonitor {
  private previous: CpuSample | undefined;
  private clockTicks: number | undefined;
  private pageSize: number | undefined;
  private bootTime: number | undefined;
  private usersById: Map<number, string> | undefined;
  private lastList: ProcessRow[] = [];
  private readonly powershell: PowerShell | undefined;

  constructor(
    private readonly src: SystemSource,
    options: { powershell?: PowerShell } = {},
  ) {
    this.powershell = src.platform === 'win32' ? (options.powershell ?? new PowerShell()) : options.powershell;
  }

  close(): void {
    this.powershell?.close();
  }

  private get cores(): number {
    return Math.max(1, this.src.cpus().length);
  }

  // ---------------------------------------------------------------- list

  async list(): Promise<{ processes: ProcessRow[]; at: number; self: number; cores: number }> {
    let rows: ProcessRow[];
    if (this.src.platform === 'linux') rows = await this.withCpu(() => this.linuxRows());
    else if (this.src.platform === 'win32') rows = await this.withCpu(() => this.windowsRows());
    else {
      const out = await this.src.run('ps', ['-axww', '-o', 'pid=,ppid=,pcpu=,rss=,etime=,user=,comm=']);
      if (!out) throw new ProcessError('Could not list processes.', 500);
      rows = parsePs(out, this.cores);
    }
    this.lastList = rows;
    return { processes: rows, at: Date.now(), self: process.pid, cores: this.cores };
  }

  /** Runs `read` twice a moment apart (or once after a recent reading) and fills in CPU shares. */
  private async withCpu(read: () => Promise<{ row: ProcessRow; cpuMs: number }[]>): Promise<ProcessRow[]> {
    let before = this.previous;
    if (!before || Date.now() - before.at > 15_000) {
      const first = await read();
      before = { at: Date.now(), times: new Map(first.map((r) => [r.row.pid, [r.cpuMs, r.row.started]])) };
      await new Promise((r) => setTimeout(r, 400));
    }
    const now = await read();
    const at = Date.now();
    const wall = Math.max(1, at - before.at) * this.cores;
    this.previous = { at, times: new Map(now.map((r) => [r.row.pid, [r.cpuMs, r.row.started]])) };
    return now.map(({ row, cpuMs }) => {
      const was = before!.times.get(row.pid);
      const same = was && was[1] === row.started;
      return { ...row, cpu: same ? Math.min(1, Math.max(0, (cpuMs - was![0]) / wall)) : null };
    });
  }

  private async linuxBasics(): Promise<void> {
    if (this.clockTicks !== undefined) return;
    this.clockTicks = Number((await this.src.run('getconf', ['CLK_TCK']))?.trim()) || 100;
    this.pageSize = Number((await this.src.run('getconf', ['PAGESIZE']))?.trim()) || 4096;
    const btime = /^btime\s+(\d+)/m.exec(this.src.readFile('/proc/stat') ?? '')?.[1];
    this.bootTime = btime ? Number(btime) * 1000 : Date.now() - this.src.uptime() * 1000;
  }

  private userOf(uid: number): string {
    if (!this.usersById) {
      this.usersById = new Map();
      for (const line of (this.src.readFile('/etc/passwd') ?? '').split('\n')) {
        const [name, , id] = line.split(':');
        if (name && id) this.usersById.set(Number(id), name);
      }
    }
    return this.usersById.get(uid) ?? String(uid);
  }

  private linuxRow(pid: number): { row: ProcessRow; cpuMs: number; stat: NonNullable<ReturnType<typeof parseProcStat>>; status: string } | null {
    const stat = parseProcStat(this.src.readFile(`/proc/${pid}/stat`) ?? '');
    if (!stat) return null;
    const status = this.src.readFile(`/proc/${pid}/status`) ?? '';
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    const cmdline = (this.src.readFile(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean);
    const exe = this.src.readLink(`/proc/${pid}/exe`);
    // The program's own name (comm is cut at 15 characters); kernel threads keep theirs.
    const argv0 = cmdline[0] ? path.posix.basename(cmdline[0]) : '';
    const name = argv0 && (argv0.startsWith(stat.comm.slice(0, 15)) || stat.comm.length >= 15) ? argv0 : stat.comm;
    const ticks = this.clockTicks ?? 100;
    return {
      row: {
        pid,
        ppid: stat.ppid,
        name,
        user: Number.isFinite(uid) ? this.userOf(uid) : null,
        cpu: null,
        memory: stat.rss * (this.pageSize ?? 4096),
        threads: stat.threads,
        started: Math.round((this.bootTime ?? 0) + (stat.starttime / ticks) * 1000),
        path: exe ? exe.replace(/ \(deleted\)$/, '') : null,
      },
      cpuMs: ((stat.utime + stat.stime) / ticks) * 1000,
      stat,
      status,
    };
  }

  private async linuxRows(): Promise<{ row: ProcessRow; cpuMs: number }[]> {
    await this.linuxBasics();
    const out: { row: ProcessRow; cpuMs: number }[] = [];
    for (const name of this.src.listDir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const r = this.linuxRow(Number(name));
      // Kernel threads (children of kthreadd) are not programs anyone can manage.
      if (r && r.stat.ppid !== 2 && Number(name) !== 2) out.push({ row: r.row, cpuMs: r.cpuMs });
    }
    return out;
  }

  private async windowsRows(): Promise<{ row: ProcessRow; cpuMs: number }[]> {
    type W = { p: number; pp: number; n: string; x: string | null; t: number; w: number; k: number; u: number; c: number | null };
    const list = await this.powershell!.json<W[] | W>(
      "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; x = $_.ExecutablePath; t = $_.ThreadCount; w = [int64]$_.WorkingSetSize; k = [int64]$_.KernelModeTime; u = [int64]$_.UserModeTime; c = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } } } | ConvertTo-Json -Compress",
    );
    if (!list) throw new ProcessError('Could not list processes (Windows PowerShell did not answer).', 500);
    return (Array.isArray(list) ? list : [list]).map((w) => ({
      row: { pid: w.p, ppid: w.pp, name: w.n, user: null, cpu: null, memory: w.w, threads: w.t, started: w.c, path: w.x || null },
      // 100-nanosecond units.
      cpuMs: (Number(w.k) + Number(w.u)) / 10_000,
    }));
  }

  // ---------------------------------------------------------------- detail

  private protection(row: ProcessRow): string | null {
    if (row.pid === process.pid) return "This is SF Agents itself. Stop it from the window it runs in.";
    if (this.src.platform === 'win32') {
      if (row.pid <= 4 || WINDOWS_CRITICAL.has(row.name.toLowerCase())) return 'Windows needs this process; ending it would shut the computer down.';
      return null;
    }
    if (row.pid <= 1) return 'The system needs this process.';
    if (this.src.platform === 'darwin' && ['kernel_task', 'launchd', 'WindowServer', 'loginwindow'].includes(row.name)) return 'macOS needs this process.';
    if (this.src.platform === 'linux' && (row.ppid === 2 || row.pid === 2)) return 'This is part of the Linux kernel.';
    return null;
  }

  async detail(pidInput: unknown): Promise<ProcessDetail> {
    const pid = this.pid(pidInput);
    const all = this.lastList.length ? this.lastList : (await this.list()).processes;
    let row = all.find((r) => r.pid === pid);
    const extra: Partial<ProcessDetail> = {};
    if (this.src.platform === 'linux') {
      await this.linuxBasics();
      const r = this.linuxRow(pid);
      if (!r) throw new ProcessError('That process has ended.', 404);
      row = { ...r.row, cpu: row?.cpu ?? null };
      const kb = (label: string) => {
        const v = new RegExp(`^${label}:\\s+(\\d+) kB`, 'm').exec(r.status)?.[1];
        return v ? Number(v) * 1024 : null;
      };
      const io = this.src.readFile(`/proc/${pid}/io`) ?? '';
      const states: Record<string, string> = { R: 'Running', S: 'Sleeping', D: 'Waiting for disk', Z: 'Zombie', T: 'Stopped', t: 'Traced', I: 'Idle', X: 'Dead' };
      Object.assign(extra, {
        command: (this.src.readFile(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean).join(' ') || null,
        cwd: this.src.readLink(`/proc/${pid}/cwd`),
        state: states[r.stat.state] ?? r.stat.state,
        virtual: kb('VmSize'),
        swap: kb('VmSwap'),
        files: this.src.listDir(`/proc/${pid}/fd`).length || null,
        ioRead: Number(/^read_bytes:\s+(\d+)/m.exec(io)?.[1] ?? NaN),
        ioWrite: Number(/^write_bytes:\s+(\d+)/m.exec(io)?.[1] ?? NaN),
      });
    } else if (this.src.platform === 'win32') {
      if (!row) throw new ProcessError('That process has ended.', 404);
      type D = { cmd: string | null; h: number | null; v: number | null; owner: string | null };
      const d = await this.powershell!.json<D>(
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction SilentlyContinue; [pscustomobject]@{ cmd = $p.CommandLine; h = $p.HandleCount; v = [int64]$p.VirtualSize; owner = if ($o -and $o.User) { $o.User } else { $null } } | ConvertTo-Json -Compress }`,
      ).catch(() => null);
      Object.assign(extra, { command: d?.cmd ?? null, handles: d?.h ?? null, virtual: d?.v ?? null });
      if (d?.owner) row = { ...row, user: d.owner };
    } else {
      if (!row) throw new ProcessError('That process has ended.', 404);
      const [args, cwd] = await Promise.all([this.src.run('ps', ['-ww', '-o', 'args=', '-p', String(pid)]), this.src.run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])]);
      Object.assign(extra, { command: args?.trim() || null, cwd: /^n(.*)$/m.exec(cwd ?? '')?.[1] ?? null });
    }
    let priority: number | null = null;
    try {
      priority = os.getPriority(pid);
    } catch {
      priority = null;
    }
    const clean = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
    return {
      ...row!,
      command: (extra.command as string | null) ?? null,
      cwd: (extra.cwd as string | null) ?? null,
      state: (extra.state as string | null) ?? null,
      priority,
      virtual: clean(extra.virtual),
      swap: clean(extra.swap),
      files: clean(extra.files),
      handles: clean(extra.handles),
      ioRead: clean(extra.ioRead),
      ioWrite: clean(extra.ioWrite),
      children: all.filter((r) => r.ppid === pid),
      parent: all.find((r) => r.pid === row!.ppid) ?? null,
      protected: this.protection(row!),
    };
  }

  private pid(input: unknown): number {
    const pid = Number(input);
    if (!Number.isSafeInteger(pid) || pid < 0) throw new ProcessError('A process id is required.');
    return pid;
  }

  // ---------------------------------------------------------------- actions

  /** Ends a process (and, with `tree`, everything it started, deepest first). */
  async end(pidInput: unknown, options: { force?: boolean; tree?: boolean } = {}): Promise<{ ended: number[]; failed: { pid: number; error: string }[] }> {
    const pid = this.pid(pidInput);
    const { processes } = await this.list();
    const row = processes.find((r) => r.pid === pid);
    if (!row) throw new ProcessError('That process has already ended.', 404);
    const blocked = this.protection(row);
    if (blocked) throw new ProcessError(blocked, 403);
    const targets: ProcessRow[] = [];
    if (options.tree) {
      const walk = (p: number) => {
        for (const child of processes.filter((r) => r.ppid === p && r.pid !== p)) {
          walk(child.pid);
          targets.push(child);
        }
      };
      walk(pid);
    }
    targets.push(row);
    const ended: number[] = [];
    const failed: { pid: number; error: string }[] = [];
    for (const t of targets) {
      const reason = this.protection(t);
      if (reason) {
        failed.push({ pid: t.pid, error: reason });
        continue;
      }
      try {
        process.kill(t.pid, options.force ? 'SIGKILL' : 'SIGTERM');
        ended.push(t.pid);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') ended.push(t.pid);
        else failed.push({ pid: t.pid, error: code === 'EPERM' ? `You don't have permission to end "${t.name}".` : (error as Error).message });
      }
    }
    if (!ended.length && failed.length) throw new ProcessError(failed[0]!.error, 403);
    return { ended, failed };
  }

  setPriority(pidInput: unknown, level: unknown): { priority: number } {
    const pid = this.pid(pidInput);
    if (typeof level !== 'string' || !(level in PRIORITY_LEVELS)) throw new ProcessError('Unknown priority.');
    try {
      os.setPriority(pid, PRIORITY_LEVELS[level as PriorityLevel]);
      return { priority: os.getPriority(pid) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (/EACCES|EPERM/.test(code) || /permission/i.test((error as Error).message)) throw new ProcessError('Raising a priority (or changing another user\'s process) needs administrator rights.', 403);
      if (/ESRCH/.test(code)) throw new ProcessError('That process has ended.', 404);
      throw new ProcessError((error as Error).message, 500);
    }
  }

  // ---------------------------------------------------------------- users

  async users(): Promise<{ users: { name: string; sessions: { terminal: string; since: string; from: string | null }[]; processes: number; cpu: number; memory: number }[] }> {
    const sessions: { user: string; terminal: string; since: string; from: string | null }[] = [];
    if (this.src.platform === 'win32') {
      const out = await this.src.run('query', ['user']);
      for (const line of (out ?? '').split(/\r?\n/).slice(1)) {
        const m = /^[\s>]*(\S+)\s+(\S*)\s+\d+\s+(\S+)\s+\S+\s+(.+)$/.exec(line);
        if (m) sessions.push({ user: m[1]!, terminal: m[2] || 'console', since: m[4]!.trim(), from: null });
      }
    } else {
      sessions.push(...parseWho((await this.src.run('who', [])) ?? ''));
    }
    let me = '';
    try {
      me = os.userInfo().username;
    } catch {
      me = '';
    }
    if (me && !sessions.some((s) => s.user.toLowerCase() === me.toLowerCase())) sessions.push({ user: me, terminal: 'SF Agents', since: '', from: null });
    const procs = this.lastList.length ? this.lastList : (await this.list().catch(() => ({ processes: [] as ProcessRow[] }))).processes;
    const names = [...new Set(sessions.map((s) => s.user))];
    return {
      users: names.map((name) => {
        const mine = procs.filter((p) => p.user?.toLowerCase() === name.toLowerCase());
        return {
          name,
          sessions: sessions.filter((s) => s.user === name).map(({ terminal, since, from }) => ({ terminal, since, from })),
          processes: mine.length,
          cpu: mine.reduce((a, p) => a + (p.cpu ?? 0), 0),
          memory: mine.reduce((a, p) => a + (p.memory ?? 0), 0),
        };
      }),
    };
  }

  // ---------------------------------------------------------------- services

  async services(): Promise<{ services: ServiceRow[] }> {
    const p = this.src.platform;
    if (p === 'linux') {
      const [system, user] = await Promise.all([
        this.src.run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain']),
        this.src.run('systemctl', ['--user', 'list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain']),
      ]);
      const map = (text: string | null, scope: 'system' | 'user'): ServiceRow[] =>
        parseSystemctl(text ?? '').map((s) => ({ name: s.name, description: s.description, state: s.state === 'active' ? 'running' : s.state === 'failed' ? 'failed' : 'stopped', detail: s.sub, scope, startup: null, pid: null }));
      if (system === null && user === null) throw new ProcessError('Services are managed by systemd, which is not available here.', 501);
      return { services: [...map(user, 'user'), ...map(system, 'system')] };
    }
    if (p === 'darwin') {
      const out = await this.src.run('launchctl', ['list']);
      const services: ServiceRow[] = [];
      for (const line of (out ?? '').split('\n').slice(1)) {
        const [pid, status, label] = line.split('\t');
        if (!label) continue;
        services.push({ name: label, description: label, state: pid !== '-' ? 'running' : status === '0' ? 'stopped' : 'failed', detail: pid !== '-' ? `PID ${pid}` : `exit ${status}`, scope: 'user', startup: null, pid: pid !== '-' ? Number(pid) : null });
      }
      return { services };
    }
    type S = { n: string; d: string; s: string; t: string };
    const list = await this.powershell!.json<S[] | S>("Get-Service | ForEach-Object { [pscustomobject]@{ n = $_.Name; d = $_.DisplayName; s = [string]$_.Status; t = [string]$_.StartType } } | ConvertTo-Json -Compress");
    if (!list) throw new ProcessError('Could not list services.', 500);
    return {
      services: (Array.isArray(list) ? list : [list]).map((s) => ({ name: s.n, description: s.d, state: s.s === 'Running' ? 'running' : s.s === 'Stopped' ? 'stopped' : s.s.toLowerCase(), detail: s.s, scope: 'system' as const, startup: s.t || null, pid: null })),
    };
  }

  async service(nameInput: unknown, action: unknown, scope: unknown): Promise<{ ok: true }> {
    if (typeof nameInput !== 'string' || !/^[\w.@:+\- ]{1,200}$/.test(nameInput)) throw new ProcessError('Unknown service.');
    if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new ProcessError('Unknown action.');
    const name = nameInput;
    const p = this.src.platform;
    let failed: string | null = null;
    if (p === 'linux') {
      const out = await this.runChecked('systemctl', [...(scope === 'user' ? ['--user'] : []), action, name]);
      failed = out;
    } else if (p === 'darwin') {
      const uid = process.getuid?.() ?? 501;
      const args = action === 'stop' ? ['kill', 'SIGTERM', `gui/${uid}/${name}`] : ['kickstart', ...(action === 'restart' ? ['-k'] : []), `gui/${uid}/${name}`];
      failed = await this.runChecked('launchctl', args);
    } else {
      const verb = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' }[action];
      const out = await this.powershell!.run(`${verb} -Name '${name.replace(/'/g, "''")}' -ErrorAction Stop; Write-Output 'OK'`, 60_000);
      if (!out || !out.includes('OK')) failed = out?.replace(/^ERROR: /, '').trim() || 'Windows did not answer.';
    }
    if (failed) {
      throw new ProcessError(/denied|authenticat|privilege|not permitted|permission/i.test(failed) ? 'This service can only be changed by an administrator.' : failed.split('\n')[0]!.slice(0, 300), /denied|authenticat|privilege|permission/i.test(failed) ? 403 : 500);
    }
    return { ok: true };
  }

  /** Runs a command; null when it succeeded, else its error output. */
  private runChecked(command: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(command, args, { timeout: 60_000, windowsHide: true }, (error, _stdout, stderr) => resolve(error ? String(stderr || error.message) : null));
    });
  }

  // ---------------------------------------------------------------- startup

  private autostartDirs(): { user: string; system: string[] } {
    const home = os.homedir();
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return { user: path.join(config, 'autostart'), system: (process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').map((d) => path.join(d, 'autostart')) };
  }

  async startup(): Promise<{ startup: StartupRow[] }> {
    const p = this.src.platform;
    if (p === 'linux') {
      const dirs = this.autostartDirs();
      const byId = new Map<string, StartupRow>();
      for (const dir of [...dirs.system, dirs.user]) {
        for (const file of this.src.listDir(dir).filter((f) => f.endsWith('.desktop'))) {
          const e = parseDesktopEntry(this.src.readFile(path.join(dir, file)) ?? '');
          const enabled = e.Hidden !== 'true' && e['X-GNOME-Autostart-enabled'] !== 'false';
          byId.set(file, { id: file, name: e.Name ?? file.replace(/\.desktop$/, ''), command: e.Exec ?? '', location: dir, enabled, toggle: true });
        }
      }
      return { startup: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (p === 'darwin') {
      const rows: StartupRow[] = [];
      for (const dir of [path.join(os.homedir(), 'Library', 'LaunchAgents'), '/Library/LaunchAgents']) {
        for (const file of this.src.listDir(dir).filter((f) => f.endsWith('.plist'))) {
          const text = this.src.readFile(path.join(dir, file)) ?? '';
          const program = /<key>Program<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1] ?? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1] ?? '';
          const disabled = /<key>Disabled<\/key>\s*<true\/>/.test(text);
          rows.push({ id: path.join(dir, file), name: file.replace(/\.plist$/, ''), command: program, location: dir, enabled: !disabled, toggle: false });
        }
      }
      return { startup: rows };
    }
    type W = { n: string; c: string; l: string; u: string };
    const list = await this.powershell!.json<W[] | W>("Get-CimInstance Win32_StartupCommand | ForEach-Object { [pscustomobject]@{ n = $_.Name; c = $_.Command; l = $_.Location; u = $_.User } } | ConvertTo-Json -Compress");
    return { startup: (list ? (Array.isArray(list) ? list : [list]) : []).map((s) => ({ id: `${s.l}|${s.n}`, name: s.n, command: s.c, location: `${s.l}${s.u ? ` (${s.u})` : ''}`, enabled: true, toggle: false })) };
  }

  /** Linux: switches an autostart entry on or off in the user's own autostart folder (as desktop settings do). */
  async setStartup(idInput: unknown, enabled: unknown): Promise<StartupRow> {
    if (this.src.platform !== 'linux') throw new ProcessError('Startup apps can only be switched from here on Linux.', 501);
    if (typeof idInput !== 'string' || !/^[\w.@+-]+\.desktop$/.test(idInput)) throw new ProcessError('Unknown startup app.');
    const { startup } = await this.startup();
    const row = startup.find((s) => s.id === idInput);
    if (!row) throw new ProcessError('Unknown startup app.', 404);
    const dirs = this.autostartDirs();
    const userFile = path.join(dirs.user, idInput);
    let text = (await fsp.readFile(userFile, 'utf8').catch(() => null)) ?? this.src.readFile(path.join(row.location, idInput)) ?? '[Desktop Entry]\n';
    text = text.replace(/^Hidden\s*=.*\n?/m, '').replace(/^X-GNOME-Autostart-enabled\s*=.*\n?/m, '');
    text = text.replace(/\[Desktop Entry\]\n?/, `[Desktop Entry]\nHidden=${enabled ? 'false' : 'true'}\nX-GNOME-Autostart-enabled=${enabled ? 'true' : 'false'}\n`);
    await fsp.mkdir(dirs.user, { recursive: true });
    await fsp.writeFile(userFile, text);
    return { ...row, enabled: !!enabled, location: dirs.user };
  }
}
