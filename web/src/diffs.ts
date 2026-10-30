/**
 * Uncommitted changes in the Git repositories the agents work in: what the
 * pills above the composer show (one per repository with changes) and the
 * diff each one opens.
 *
 * The repositories are the project folder's and those of the agents'
 * workspace roots, plus any repository directly inside one of them (a
 * workspace of several checkouts). Git runs read-only (status and diff,
 * with optional locks off so it never blocks the agents' own git).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RepoChanges {
  /** Stable id for the repository (its path, hashed). */
  id: string;
  /** The repository folder's name. */
  name: string;
  path: string;
  branch: string;
  /** Changed, added, deleted and untracked files. */
  files: number;
  added: number;
  removed: number;
}

export interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  added: number;
  removed: number;
  /** Unified diff of the file (empty for binary files). */
  patch: string;
  binary?: boolean;
}

const GIT_TIMEOUT_MS = 8000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_DIFFS = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', '.sfagents', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target']);
// Never take or wait for git's index lock: the agents may be running git too.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

function git(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: GIT_ENV, timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, out: String(stdout ?? '') });
    });
  });
}

export function repoId(top: string): string {
  return createHash('sha256').update(top).digest('hex').slice(0, 12);
}

/** The repositories under `dirs`: each dir's own, and those directly inside it. */
export async function findRepos(dirs: readonly string[]): Promise<string[]> {
  const tops = new Set<string>();
  const candidates = new Set<string>();
  for (const dir of dirs) {
    candidates.add(dir);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (fs.existsSync(path.join(dir, e.name, '.git'))) candidates.add(path.join(dir, e.name));
    }
  }
  await Promise.all(
    [...candidates].map(async (dir) => {
      const r = await git(dir, ['rev-parse', '--show-toplevel'], 64 * 1024);
      if (r.ok && r.out.trim()) tops.add(path.resolve(r.out.trim()));
    }),
  );
  return [...tops].sort();
}

interface StatusEntry {
  path: string;
  status: DiffFile['status'];
}

/** Parses `git status --porcelain=v1 -z`. */
function parseStatus(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3);
    if (xy === '??') entries.push({ path: file, status: 'untracked' });
    else if (xy.includes('R') || xy.includes('C')) {
      entries.push({ path: file, status: 'renamed' });
      i++; // the original path follows
    } else if (xy.includes('D')) entries.push({ path: file, status: 'deleted' });
    else if (xy.includes('A')) entries.push({ path: file, status: 'added' });
    else entries.push({ path: file, status: 'modified' });
  }
  return entries;
}

/** What to diff against: HEAD, or git's empty tree in a repository without commits. */
async function base(top: string): Promise<string> {
  const head = await git(top, ['rev-parse', '--verify', '-q', 'HEAD'], 1024);
  return head.ok ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

/** Lines added and removed per file (tracked changes), from `git diff --numstat`. */
async function numstat(top: string, against: string): Promise<Map<string, { added: number; removed: number; binary: boolean }>> {
  const r = await git(top, ['diff', '--numstat', '-z', '-M', against]);
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  const parts = r.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]!);
    if (!m) continue;
    let file = m[3]!;
    // A rename: the old and new paths follow as their own records.
    if (file === '') {
      i += 2;
      file = parts[i] ?? '';
    }
    out.set(file, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  return out;
}

function countLines(file: string): number {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return 0;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\0')) return 0;
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

/** One repository's changes, or undefined when it has none (or git cannot read it). */
export async function repoChanges(top: string): Promise<RepoChanges | undefined> {
  const status = await git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) return undefined;
  const entries = parseStatus(status.out);
  if (!entries.length) return undefined;
  const [branch, stats] = await Promise.all([git(top, ['rev-parse', '--abbrev-ref', 'HEAD'], 1024), base(top).then((b) => numstat(top, b))]);
  let added = 0;
  let removed = 0;
  for (const s of stats.values()) {
    added += s.added;
    removed += s.removed;
  }
  for (const e of entries) if (e.status === 'untracked') added += countLines(path.join(top, e.path));
  return { id: repoId(top), name: path.basename(top), path: top, branch: branch.ok ? branch.out.trim() : '', files: entries.length, added, removed };
}

/** Every repository with uncommitted changes. */
export async function changedRepos(dirs: readonly string[]): Promise<RepoChanges[]> {
  const repos = await findRepos(dirs);
  const changes = await Promise.all(repos.map((r) => repoChanges(r)));
  return changes.filter((c): c is RepoChanges => !!c);
}

/** Splits a unified diff into per-file patches, keyed by the new path. */
function splitPatch(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const chunks = text.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue;
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(chunk)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const file = plus && plus !== '/dev/null' ? plus : (header?.[2] ?? header?.[1]);
    if (file) out.set(file.trim(), chunk);
  }
  return out;
}

/** The diff of one repository, file by file (tracked changes against HEAD, and untracked files as added). */
export async function repoDiff(top: string): Promise<{ repo: RepoChanges | undefined; files: DiffFile[]; truncated: boolean }> {
  const [repo, status] = await Promise.all([repoChanges(top), git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])]);
  const entries = parseStatus(status.out);
  const against = await base(top);
  const [patch, stats] = await Promise.all([git(top, ['diff', '-M', '--no-color', '--no-ext-diff', against]), numstat(top, against)]);
  let truncated = patch.out.length >= MAX_DIFF_BYTES - 1;
  const patches = splitPatch(patch.out);
  const files: DiffFile[] = [];
  let untracked = 0;
  for (const e of entries) {
    if (e.status === 'untracked') {
      if (untracked++ >= MAX_UNTRACKED_DIFFS) {
        truncated = true;
        files.push({ path: e.path, status: 'untracked', added: 0, removed: 0, patch: '' });
        continue;
      }
      // An untracked file as an added one; git diff exits 1 when there is a difference.
      const r = await git(top, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', e.path], 1024 * 1024);
      const binary = /^Binary files/m.test(r.out);
      files.push({ path: e.path, status: 'untracked', added: countLines(path.join(top, e.path)), removed: 0, patch: binary ? '' : r.out, ...(binary ? { binary } : {}) });
      continue;
    }
    const s = stats.get(e.path);
    files.push({ path: e.path, status: e.status, added: s?.added ?? 0, removed: s?.removed ?? 0, patch: s?.binary ? '' : (patches.get(e.path) ?? ''), ...(s?.binary ? { binary: true } : {}) });
  }
  return { repo, files, truncated };
}
