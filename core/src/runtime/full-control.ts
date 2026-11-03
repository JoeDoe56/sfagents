import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sfagentsHome } from '../settings/home.js';
import { isPathWithinRoot } from '../utils/paths.js';
import { sanitizeChildEnv } from '../utils/child-env.js';
import type { ConfirmationHandler } from './events.js';

export interface FullControlPlan { reason: string; plan: string; folders: string[] }
export interface FullControlStatus { id: string; agent: string; expires: number; folders: string[]; reason: string }
interface Snapshot { path: string; blob: string; hash: string; mode: number }
interface Journal { id: string; agent: string; folders: string[]; started: string; ended?: string; reason?: string; error?: string; before: Snapshot[]; after?: Snapshot[] }
const SECRET = /^(?:\.env(?:\..*)?|\.git|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.docker|\.ssh|\.aws|\.codex|\.agents|node_modules|\.venv|\.gnupg|\.test-temp|credentials(?:\..*)?|tokens?(?:\..*)?|secrets?(?:\..*)?|id_[a-z0-9]+|.*\.(?:pem|pfx|p12|key|kdbx))$/i;

/** Only files in the requested folders are journaled; symlinks and credentials are never copied. */
export class RollbackJournal {
  constructor(readonly dir = path.join(sfagentsHome(), 'full-control'), private readonly excluded: readonly string[] = []) {}

  private scan(folders: readonly string[], save: boolean): Snapshot[] {
    const files: Snapshot[] = [];
    let bytes = 0;
    const visit = (p: string) => {
      if (SECRET.test(path.basename(p)) || this.excluded.some((e) => isPathWithinRoot(p, e))) return;
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) return;
      if (st.isDirectory()) { for (const name of fs.readdirSync(p)) visit(path.join(p, name)); return; }
      if (!st.isFile()) return;
      bytes += st.size;
      if (files.length >= 50_000 || bytes > 512 * 1024 * 1024) throw new Error('The rollback snapshot exceeds 512 MB or 50,000 files. Request smaller folders.');
      const data = fs.readFileSync(p);
      const hash = createHash('sha256').update(data).digest('hex');
      if (save) {
        fs.mkdirSync(path.join(this.dir, 'blobs'), { recursive: true });
        const blob = path.join(this.dir, 'blobs', hash);
        if (!fs.existsSync(blob)) fs.writeFileSync(blob, data, { mode: 0o600 });
      }
      files.push({ path: p, blob: hash, hash, mode: st.mode });
    };
    for (const p of folders) visit(p);
    return files;
  }

  private file(id: string): string {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid journal id.');
    return path.join(this.dir, `${id}.json`);
  }
  private write(j: Journal): void { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file(j.id), JSON.stringify(j), { mode: 0o600 }); }
  read(id: string): Journal { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); }
  start(agent: string, folders: string[]): Journal {
    const j: Journal = { id: randomUUID(), agent, folders, started: new Date().toISOString(), before: this.scan(folders, true) };
    this.write(j); return j;
  }
  end(id: string, reason: string): void {
    const j = this.read(id); j.ended = new Date().toISOString(); j.reason = reason;
    // Only hashes of the result, not a second copy of potentially sensitive contents.
    try { j.after = this.scan(j.folders, false); } catch (e) { j.error = e instanceof Error ? e.message : String(e); }
    this.write(j);
  }
  list(): Array<Omit<Journal, 'before' | 'after'>> {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((n) => /^[\da-f-]{36}\.json$/.test(n)).map((n) => {
      const { before: _b, after: _a, ...j } = this.read(n.slice(0, -5)); return j;
    }).sort((a, b) => b.started.localeCompare(a.started));
  }
  diff(id: string): Array<{ path: string; before: string | null; after: string | null; beforeText?: string; afterText?: string }> {
    const j = this.read(id);
    if (j.error) throw new Error(`Rollback unavailable: ${j.error}`);
    const before = new Map(j.before.map((f) => [f.path, f.hash]));
    const after = new Map((j.after ?? this.scan(j.folders, false)).map((f) => [f.path, f.hash]));
    const preview = (file: string): string | undefined => {
      try { const st = fs.statSync(file); if (!st.isFile() || st.size > 128_000) return undefined; const data = fs.readFileSync(file); return data.includes(0) ? undefined : data.toString('utf8'); } catch { return undefined; }
    };
    return [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).map((p) => {
      const old = before.get(p); const beforeText = old ? preview(path.join(this.dir, 'blobs', old)) : '';
      const afterText = after.has(p) ? preview(p) : '';
      return { path: p, before: old ?? null, after: after.get(p) ?? null, ...(beforeText !== undefined ? { beforeText } : {}), ...(afterText !== undefined ? { afterText } : {}) };
    });
  }
  undo(id: string): void {
    const j = this.read(id);
    if (j.error) throw new Error(`Rollback unavailable: ${j.error}`);
    if (!j.ended || !j.after) throw new Error('Stop the session before undoing it.');
    const changes = this.diff(id);
    // Refuse all writes if anything changed since the session; do not overwrite the person's later work.
    for (const c of changes) {
      if (!j.folders.some((r) => isPathWithinRoot(c.path, r))) throw new Error('Journal path outside its folders.');
      let parent = path.dirname(c.path);
      while (true) {
        if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`A folder became a symlink: ${parent}`);
        const next = path.dirname(parent); if (next === parent) break; parent = next;
      }
      const st = fs.lstatSync(c.path, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new Error(`A file became a symlink: ${c.path}`);
      const now = st?.isFile() ? createHash('sha256').update(fs.readFileSync(c.path)).digest('hex') : null;
      if (now !== c.after) throw new Error(`Changed since the session: ${c.path}. Nothing was undone.`);
    }
    const restore = new Map<string, Buffer>();
    for (const c of changes) {
      if (c.before === null) continue;
      const old = j.before.find((f) => f.path === c.path)!;
      if (!/^[\da-f]{64}$/.test(old.blob)) throw new Error('Invalid snapshot blob.');
      const data = fs.readFileSync(path.join(this.dir, 'blobs', old.blob));
      if (createHash('sha256').update(data).digest('hex') !== c.before) throw new Error('Snapshot checksum mismatch.');
      restore.set(c.path, data);
    }
    for (const c of changes) {
      if (c.before === null) fs.rmSync(c.path, { force: true });
      else {
        const old = j.before.find((f) => f.path === c.path)!;
        const data = restore.get(c.path)!;
        fs.mkdirSync(path.dirname(c.path), { recursive: true }); fs.writeFileSync(c.path, data, { mode: old.mode });
      }
    }
    j.after = j.before; this.write(j);
  }
}

/** A lease belongs to one main run, never an agent name or an approval remembered for later. */
export class FullControlManager {
  private active?: { owner: object; status: FullControlStatus; controller: AbortController; timer: NodeJS.Timeout };
  private requesting = false;
  readonly journal: RollbackJournal;
  constructor(private readonly o: { confirm?: ConfirmationHandler; minutes: () => number; journal?: RollbackJournal; onChange?: (s: FullControlStatus | null) => void; onEnd?: () => void }) { this.journal = o.journal ?? new RollbackJournal(); }
  status(): FullControlStatus | null { return this.active ? { ...this.active.status, folders: [...this.active.status.folders] } : null; }
  context(owner: object): string {
    if (this.active?.owner !== owner) return 'Full control: inactive. Host shell and host UI require a message full_control request approved by the person.';
    const seconds = Math.max(0, Math.ceil((this.active.status.expires - Date.now()) / 1000));
    return `Full control: ${Math.floor(seconds / 60)}m ${seconds % 60}s left. Always ask before sending, deleting, paying, publishing or entering a password.`;
  }
  require(owner: object): AbortSignal {
    if (!this.active || this.active.owner !== owner || Date.now() >= this.active.status.expires) throw new Error('No full-control session for this run. Request one through message.');
    return this.active.controller.signal;
  }
  async request(owner: object, agentPath: readonly string[], main: boolean, p: FullControlPlan, signal: AbortSignal): Promise<string> {
    if (!main || agentPath.length !== 1) throw new Error('Only the main agent chatting with the person can request full control.');
    if (!this.o.confirm) throw new Error('This front end cannot approve full control.');
    if (this.active || this.requesting) throw new Error('A full-control session is already active or awaiting approval.');
    if (!p.reason?.trim() || !p.plan?.trim() || !Array.isArray(p.folders) || !p.folders.length || p.folders.some((f) => typeof f !== 'string' || !path.isAbsolute(f))) throw new Error('Provide a reason, plan and absolute folders to snapshot.');
    const requested = [...new Set(p.folders.map((f) => fs.realpathSync(f)))];
    const folders = requested.filter((f) => !requested.some((r) => r !== f && isPathWithinRoot(f, r)));
    if (folders.some((f) => !fs.statSync(f).isDirectory())) throw new Error('Snapshot folders must be directories.');
    const minutes = this.o.minutes();
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error('Invalid full-control maximum.');
    this.requesting = true;
    try {
      const answer = await this.o.confirm({ agentPath, toolName: 'full_control', details: { type: 'info', title: 'Allow Full Control?', prompt: `${p.reason}\n\n${p.plan}\n\nUp to ${minutes} minutes, until idle. Snapshot folders:\n${folders.join('\n')}\nCredentials, dependencies and symlinks are excluded from rollback. Actions in apps cannot be undone by file rollback.` } }, signal);
      if (answer !== 'allow_once' || signal.aborted) return 'Full control denied. Only an explicit Allow Once grants one session.';
      const j = this.journal.start(agentPath[0]!, folders);
      const controller = new AbortController();
      const status = { id: j.id, agent: agentPath[0]!, expires: Date.now() + minutes * 60_000, folders, reason: p.reason };
      const timer = setTimeout(() => this.stop('time limit'), minutes * 60_000); timer.unref();
      this.active = { owner, status, controller, timer }; this.o.onChange?.(this.status());
      return `Full control allowed. ${this.context(owner)}`;
    } finally { this.requesting = false; }
  }
  async approveAction(owner: object, agent: string, question: string, signal: AbortSignal): Promise<boolean> {
    const lease = this.require(owner);
    return (await this.o.confirm?.({ agentPath: [agent], toolName: 'host_action', details: { type: 'info', title: 'Allow This Action?', prompt: question } }, AbortSignal.any([signal, lease]))) === 'allow_once' && !lease.aborted;
  }
  endRun(owner: object): void { if (this.active?.owner === owner) this.stop('agent idle'); }
  stop(reason = 'stopped by the person'): void {
    const active = this.active; if (!active) return;
    this.active = undefined; clearTimeout(active.timer); active.controller.abort(new Error(reason));
    try { this.journal.end(active.status.id, reason); }
    catch { /* The lease is revoked even if the journal disk becomes unavailable. */ }
    finally { this.o.onChange?.(null); this.o.onEnd?.(); }
  }
}

/** Host commands cannot outlive their lease, and never receive provider keys from the environment. */
export async function runHostShell(command: string, cwd: string, stdin: string | undefined, signal: AbortSignal, secretEnvNames: readonly string[]): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : (process.env['SHELL'] || '/bin/bash'), windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], {
      cwd, windowsHide: true, detached: !windows, env: sanitizeChildEnv(process.env, [...secretEnvNames, ...Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))]), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stop = () => {
      if (windows && child.pid) { const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
      else { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    let out = ''; const add = (c: Buffer) => { if (out.length < 2_000_000) out += c.toString('utf8'); };
    child.stdout.on('data', add); child.stderr.on('data', add); child.stdin.on('error', () => {}); child.stdin.end(stdin);
    child.on('error', (e) => { signal.removeEventListener('abort', stop); reject(e); });
    child.on('close', (code) => { signal.removeEventListener('abort', stop); resolve(`${out}\nExit code: ${code}${signal.aborted ? ' (session stopped)' : ''}`); });
  });
}
