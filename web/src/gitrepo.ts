/**
 * The Git workspace's repository layer: status, the combined change list,
 * history, branches, commits of selected files, and the per-repository
 * activity lock that every mutating operation goes through.
 *
 * Reads never take git's optional locks. Operations run through
 * RepoLocks.run, which atomically rechecks that no agent is working on the
 * repository (any of its worktrees) and that no other user operation is
 * underway, so a stale UI request is rejected here and not only disabled
 * in the page.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

export class RepoBusyError extends Error {}
export class GitOpError extends Error {}

const TIMEOUT_MS = 30000;
const MAX_BUFFER = 8 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function runGit(cwd: string, args: string[], o: { readOnly?: boolean; stdin?: string } = {}): Promise<GitResult> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(o.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}) };
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr ?? '') });
    });
    if (o.stdin !== undefined) child.stdin?.end(o.stdin);
  });
}

/** The identity shared by a repository and all its worktrees: its common git dir. */
export async function repoKey(top: string): Promise<string> {
  const r = await runGit(top, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { readOnly: true });
  return r.ok ? path.resolve(r.out.trim()) : path.resolve(top);
}

// ------------------------------------------------------------------ the activity lock

export class RepoLocks {
  private agents = new Map<string, Set<string>>(); // repo key → agents working in it
  private ops = new Map<string, string>(); // repo key → the user operation underway

  /** An agent starts or stops working on a repository (any worktree of it). */
  setAgentBusy(key: string, agent: string, busy: boolean): void {
    let set = this.agents.get(key);
    if (busy) {
      if (!set) this.agents.set(key, (set = new Set()));
      set.add(agent);
    } else if (set) {
      set.delete(agent);
      if (!set.size) this.agents.delete(key);
    }
  }

  workingAgents(key: string): string[] {
    return [...(this.agents.get(key) ?? [])];
  }

  /** Why actions are disabled, or undefined when the repository is free. */
  reason(key: string): string | undefined {
    if (this.agents.get(key)?.size) return 'Agent is working on this repository.';
    const op = this.ops.get(key);
    return op ? `${op} is in progress.` : undefined;
  }

  /** Whether an agent may start work: not while a user operation owns the repository. */
  agentMayStart(key: string): boolean {
    return !this.ops.has(key);
  }

  /** Runs a mutating operation if the repository is free; the lock is released on success, failure and cancellation. */
  async run<T>(key: string, label: string, fn: () => Promise<T>): Promise<T> {
    const why = this.reason(key);
    if (why) throw new RepoBusyError(why);
    this.ops.set(key, label);
    try {
      return await fn();
    } finally {
      this.ops.delete(key);
    }
  }
}

// ------------------------------------------------------------------ status

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechange' | 'submodule';

export interface ChangeFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  /** The index (staged) and work tree columns of git status. */
  index: string;
  worktree: string;
  /** Lines, or null when no textual count exists (binary, submodule). */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export interface RepoStatus {
  branch: string;
  detached: boolean;
  head: string;
  upstream: string;
  /** Commits not on the upstream / on the upstream but not here; null when there is no upstream. */
  ahead: number | null;
  behind: number | null;
  files: ChangeFile[];
  conflicts: number;
  /** A merge, rebase or similar is in progress. */
  operation: string;
}

function kindOf(xy: string, submodule: boolean): ChangeKind {
  if (submodule) return 'submodule';
  if (/U/.test(xy) || xy === 'AA' || xy === 'DD') return 'conflicted';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  if (xy.includes('T')) return 'typechange';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

async function gitDir(top: string): Promise<string> {
  const r = await runGit(top, ['rev-parse', '--path-format=absolute', '--git-dir'], { readOnly: true });
  return r.out.trim();
}

async function inProgress(top: string): Promise<string> {
  const dir = await gitDir(top);
  const { existsSync } = await import('node:fs');
  for (const [name, label] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
    if (dir && existsSync(path.join(dir, name))) return label;
  }
  return '';
}

/** Combined line counts against HEAD (staged and unstaged together), from numstat. */
async function numstat(top: string, against: string): Promise<Map<string, { added: number | null; removed: number | null; binary: boolean }>> {
  const r = await runGit(top, ['diff', '--numstat', '-z', '-M', against], { readOnly: true });
  const out = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
  const parts = r.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]!);
    if (!m) continue;
    let file = m[3]!;
    if (file === '') {
      i += 2;
      file = parts[i] ?? '';
    }
    const binary = m[1] === '-';
    out.set(file, { added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary });
  }
  return out;
}

async function untrackedCount(top: string, file: string): Promise<{ added: number | null; removed: number; binary: boolean }> {
  const r = await runGit(top, ['diff', '--no-index', '--numstat', '--', '/dev/null', file], { readOnly: true });
  const m = /^(-|\d+)\t(-|\d+)\t/.exec(r.out);
  if (!m) return { added: null, removed: 0, binary: false };
  return m[1] === '-' ? { added: null, removed: 0, binary: true } : { added: Number(m[1]), removed: 0, binary: false };
}

export async function repoStatus(top: string): Promise<RepoStatus> {
  const r = await runGit(top, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { readOnly: true });
  if (!r.ok) throw new GitOpError(r.err.trim() || 'Git could not read this repository.');
  const parts = r.out.split('\0');
  const status: RepoStatus = { branch: '', detached: false, head: '', upstream: '', ahead: null, behind: null, files: [], conflicts: 0, operation: '' };
  const entries: { path: string; oldPath?: string; xy: string; submodule: boolean; untracked: boolean }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!;
    if (!rec) continue;
    if (rec.startsWith('# branch.oid ')) status.head = rec.slice(13) === '(initial)' ? '' : rec.slice(13);
    else if (rec.startsWith('# branch.head ')) {
      const b = rec.slice(14);
      status.detached = b === '(detached)';
      status.branch = b;
    } else if (rec.startsWith('# branch.upstream ')) status.upstream = rec.slice(18);
    else if (rec.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(rec);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (rec.startsWith('1 ')) {
      const f = rec.split(' ');
      entries.push({ path: f.slice(8).join(' '), xy: f[1]!, submodule: f[2]!.startsWith('S'), untracked: false });
    } else if (rec.startsWith('2 ')) {
      const f = rec.split(' ');
      entries.push({ path: f.slice(9).join(' '), oldPath: parts[++i] ?? '', xy: f[1]!, submodule: f[2]!.startsWith('S'), untracked: false });
    } else if (rec.startsWith('u ')) {
      const f = rec.split(' ');
      entries.push({ path: f.slice(10).join(' '), xy: f[1]!, submodule: false, untracked: false });
    } else if (rec.startsWith('? ')) entries.push({ path: rec.slice(2), xy: '??', submodule: false, untracked: true });
  }
  const head = await runGit(top, ['rev-parse', '--verify', '-q', 'HEAD'], { readOnly: true });
  const stats = await numstat(top, head.ok ? 'HEAD' : EMPTY_TREE);
  for (const e of entries) {
    const s = stats.get(e.path);
    let counts = s ?? { added: 0 as number | null, removed: 0 as number | null, binary: false };
    if (e.untracked) counts = await untrackedCount(top, e.path);
    else if (e.submodule) counts = { added: null, removed: null, binary: false };
    else if (!s && e.xy.includes('U')) counts = { added: null, removed: null, binary: false };
    status.files.push({
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      kind: e.untracked ? 'untracked' : kindOf(e.xy, e.submodule),
      index: e.untracked ? ' ' : e.xy[0]!,
      worktree: e.untracked ? '?' : e.xy[1]!,
      added: counts.added,
      removed: counts.removed,
      binary: counts.binary,
    });
  }
  status.conflicts = status.files.filter((f) => f.kind === 'conflicted').length;
  status.operation = await inProgress(top);
  return status;
}

/** The patch of one file against HEAD (staged and unstaged combined; an untracked file as added). */
export async function fileDiff(top: string, file: ChangeFile): Promise<{ patch: string; binary: boolean; unavailable: boolean }> {
  if (file.kind === 'submodule') return { patch: '', binary: false, unavailable: true };
  if (file.kind === 'untracked') {
    const r = await runGit(top, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', file.path], { readOnly: true });
    const binary = /^Binary files/m.test(r.out);
    return { patch: binary ? '' : r.out, binary, unavailable: false };
  }
  const head = await runGit(top, ['rev-parse', '--verify', '-q', 'HEAD'], { readOnly: true });
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const r = await runGit(top, ['diff', '--no-color', '--no-ext-diff', '-M', head.ok ? 'HEAD' : EMPTY_TREE, '--', ...paths], { readOnly: true });
  if (!r.ok) return { patch: '', binary: false, unavailable: true };
  const binary = /^Binary files|^GIT binary patch/m.test(r.out);
  return { patch: binary ? '' : r.out, binary, unavailable: false };
}

// ------------------------------------------------------------------ history

export interface CommitInfo {
  id: string;
  short: string;
  title: string;
  body: string;
  author: string;
  date: string;
  parents: string[];
  /** Whether the commit is on the configured upstream; null when there is none. */
  pushed: boolean | null;
  checkpoint: boolean;
}

export async function history(top: string, limit = 100, ref = 'HEAD'): Promise<CommitInfo[]> {
  const sep = '\x1f';
  const r = await runGit(top, ['log', ref, `-n${limit}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%s%x1f%b%x1e'], { readOnly: true });
  if (!r.ok) return [];
  const up = await runGit(top, ['rev-parse', '--verify', '-q', '@{upstream}'], { readOnly: true });
  let unpushed: Set<string> | null = null;
  if (up.ok) unpushed = new Set((await runGit(top, ['rev-list', `@{upstream}..${ref}`], { readOnly: true })).out.split('\n').filter(Boolean));
  return r.out
    .split('\x1e')
    .map((x) => x.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [id, short, author, date, parents, title, body] = rec.split(sep) as [string, string, string, string, string, string, string?];
      return { id, short, author, date, parents: parents ? parents.split(' ') : [], title, body: (body ?? '').trim(), pushed: unpushed ? !unpushed.has(id) : null, checkpoint: title.startsWith('sfagents checkpoint: ') };
    });
}

/** The change a commit introduced, or the net change over a contiguous range oldest..newest. */
export async function commitDiff(top: string, newest: string, oldest = newest): Promise<{ files: { path: string; added: number | null; removed: number | null; binary: boolean }[]; patch: string }> {
  const root = await runGit(top, ['rev-parse', '--verify', '-q', `${oldest}^`], { readOnly: true });
  const from = root.ok ? root.out.trim() : EMPTY_TREE;
  const ns = await runGit(top, ['diff', '--numstat', '-z', '-M', from, newest], { readOnly: true });
  const files: { path: string; added: number | null; removed: number | null; binary: boolean }[] = [];
  const parts = ns.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]!);
    if (!m) continue;
    let file = m[3]!;
    if (file === '') {
      i += 2;
      file = parts[i] ?? '';
    }
    const binary = m[1] === '-';
    files.push({ path: file, added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary });
  }
  const p = await runGit(top, ['diff', '--no-color', '--no-ext-diff', '-M', from, newest], { readOnly: true });
  return { files, patch: p.out };
}

/** Committed changes the current branch has over `base` since their common ancestor (merge-base..HEAD). */
export async function compareBranch(top: string, base: string): Promise<{ base: string; mergeBase: string; commits: CommitInfo[]; files: { path: string; added: number | null; removed: number | null; binary: boolean }[] }> {
  const mb = await runGit(top, ['merge-base', base, 'HEAD'], { readOnly: true });
  if (!mb.ok) throw new GitOpError(`No common ancestor with ${base}.`);
  const mergeBase = mb.out.trim();
  const commits = (await history(top, 500, `${mergeBase}..HEAD`)) as CommitInfo[];
  const ns = await runGit(top, ['diff', '--numstat', '-z', '-M', mergeBase, 'HEAD'], { readOnly: true });
  const files: { path: string; added: number | null; removed: number | null; binary: boolean }[] = [];
  const parts = ns.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]!);
    if (!m) continue;
    let file = m[3]!;
    if (file === '') {
      i += 2;
      file = parts[i] ?? '';
    }
    const binary = m[1] === '-';
    files.push({ path: file, added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]), binary });
  }
  return { base, mergeBase, commits, files };
}

// ------------------------------------------------------------------ branches

export interface BranchInfo {
  name: string;
  remote: boolean;
  current: boolean;
  /** The worktree that has it checked out, when it is not this one. */
  worktree?: string;
}

export async function branches(top: string): Promise<BranchInfo[]> {
  const [refs, wt] = await Promise.all([
    runGit(top, ['for-each-ref', '--format=%(refname)\x1f%(HEAD)', 'refs/heads', 'refs/remotes'], { readOnly: true }),
    runGit(top, ['worktree', 'list', '--porcelain'], { readOnly: true }),
  ]);
  const checkedOut = new Map<string, string>();
  let cur = '';
  for (const line of wt.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9);
    else if (line.startsWith('branch refs/heads/')) checkedOut.set(line.slice(18), cur);
  }
  const here = path.resolve(top);
  const out: BranchInfo[] = [];
  for (const line of refs.out.split('\n').filter(Boolean)) {
    const [ref, head] = line.split('\x1f') as [string, string];
    if (ref.endsWith('/HEAD')) continue;
    const remote = ref.startsWith('refs/remotes/');
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    const elsewhere = !remote ? checkedOut.get(name) : undefined;
    out.push({ name, remote, current: head === '*', ...(elsewhere && path.resolve(elsewhere) !== here ? { worktree: elsewhere } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ commit

/**
 * Commits only the given files (their whole current content against HEAD);
 * everything else stays uncommitted. Fails without touching anything when
 * the title is empty or a path is not a current change.
 */
export async function commitFiles(top: string, locks: RepoLocks, o: { paths: string[]; title: string; description?: string }): Promise<string> {
  const title = o.title.trim();
  if (!title) throw new GitOpError('Write a commit title.');
  if (!o.paths.length) throw new GitOpError('Select at least one change to commit.');
  const key = await repoKey(top);
  return locks.run(key, 'Commit', async () => {
    const status = await repoStatus(top);
    const known = new Set(status.files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
    const stale = o.paths.filter((p) => !known.has(p));
    if (stale.length) throw new GitOpError(`Changed since you selected it: ${stale.join(', ')}.`);
    if (status.conflicts) throw new GitOpError('Resolve the merge conflicts first.');
    const paths = [...new Set([...o.paths, ...status.files.filter((f) => o.paths.includes(f.path) && f.oldPath).map((f) => f.oldPath!)])];
    const add = await runGit(top, ['add', '-A', '--', ...paths]);
    if (!add.ok) throw new GitOpError(add.err.trim() || 'Could not select the files.');
    const message = o.description?.trim() ? `${title}\n\n${o.description.trim()}\n` : `${title}\n`;
    const c = await runGit(top, ['commit', '--only', '-F', '-', '--', ...paths], { stdin: message });
    if (!c.ok) throw new GitOpError((c.err || c.out).trim() || 'The commit failed.');
    return (await runGit(top, ['rev-parse', 'HEAD'], { readOnly: true })).out.trim();
  });
}

// ------------------------------------------------------------------ remotes and branches

async function remoteOp(top: string, locks: RepoLocks, label: string, args: string[], fail: string): Promise<string> {
  const key = await repoKey(top);
  return locks.run(key, label, async () => {
    const r = await runGit(top, args);
    if (!r.ok) throw new GitOpError((r.err || r.out).trim() || fail);
    return (r.out + r.err).trim();
  });
}

/** Fetch: refreshes remote information, integrates nothing. */
export function fetchRemote(top: string, locks: RepoLocks): Promise<string> {
  return remoteOp(top, locks, 'Fetch', ['fetch', '--prune'], 'Fetch failed.');
}

/** Pull: fast-forward only, never a silent rebase or merge commit. */
export async function pullBranch(top: string, locks: RepoLocks): Promise<string> {
  const s = await repoStatus(top);
  if (!s.upstream) throw new GitOpError('This branch has no upstream. Publish it first.');
  if (s.files.length) throw new GitOpError('Commit or discard your changes before pulling.');
  if (s.ahead && s.behind) throw new GitOpError('Local and remote history have diverged. Merge the upstream branch explicitly from the branch menu.');
  return remoteOp(top, locks, 'Pull', ['pull', '--ff-only', '--no-rebase'], 'Pull failed.');
}

/** Push the current branch to its upstream; never forced. */
export async function pushBranch(top: string, locks: RepoLocks): Promise<string> {
  const s = await repoStatus(top);
  if (!s.upstream) throw new GitOpError('This branch has no upstream. Publish it first.');
  if (s.behind) throw new GitOpError('The remote has commits you do not have. Pull first.');
  return remoteOp(top, locks, 'Push', ['push'], 'Push failed.');
}

/** Publish: push the branch and set its upstream, to an explicit remote. */
export async function publishBranch(top: string, locks: RepoLocks, remote = 'origin'): Promise<string> {
  const s = await repoStatus(top);
  if (s.detached) throw new GitOpError('Switch to a branch first.');
  const remotes = (await runGit(top, ['remote'], { readOnly: true })).out.split('\n').filter(Boolean);
  if (!remotes.includes(remote)) throw new GitOpError(remotes.length ? `No remote named ${remote}. Available: ${remotes.join(', ')}.` : 'This repository has no remote. Add one first.');
  return remoteOp(top, locks, 'Publish', ['push', '-u', remote, s.branch], 'Publish failed.');
}

/** Switch branch (creating one from `from` when asked); refuses while uncommitted work would be affected. */
export async function checkoutBranch(top: string, locks: RepoLocks, o: { name: string; create?: boolean; from?: string }): Promise<void> {
  const name = o.name.trim();
  if (!name || !(await runGit(top, ['check-ref-format', '--branch', name], { readOnly: true })).ok) throw new GitOpError('That is not a valid branch name.');
  const key = await repoKey(top);
  await locks.run(key, 'Switch branch', async () => {
    const s = await repoStatus(top);
    if (s.files.length) throw new GitOpError(`You have ${s.files.length} uncommitted change${s.files.length === 1 ? '' : 's'}. Commit or discard them, or open another worktree, before switching.`);
    const all = await branches(top);
    if (o.create) {
      if (all.some((b) => b.name === name && !b.remote)) throw new GitOpError(`A branch named ${name} already exists.`);
      const r = await runGit(top, ['checkout', '-b', name, ...(o.from ? [o.from] : [])]);
      if (!r.ok) throw new GitOpError(r.err.trim() || 'Could not create the branch.');
      return;
    }
    const local = all.find((b) => b.name === name && !b.remote);
    if (local?.worktree) throw new GitOpError(`${name} is checked out in another worktree: ${local.worktree}. Open that one instead.`);
    const remote = all.find((b) => b.remote && (b.name === name || b.name.replace(/^[^/]+\//, '') === name));
    const args = local ? ['checkout', name] : remote ? ['checkout', '--track', remote.name] : null;
    if (!args) throw new GitOpError(`No branch named ${name}.`);
    const r = await runGit(top, args);
    if (!r.ok) throw new GitOpError(r.err.trim() || 'Could not switch branch.');
  });
}

// ------------------------------------------------------------------ merge, undo, revert, clone, init

/** Merge `source` into the current branch. A conflict leaves the merge in progress for the window to resolve. */
export async function mergeBranch(top: string, locks: RepoLocks, source: string): Promise<{ conflicts: string[] }> {
  if (!source.trim()) throw new GitOpError('Choose the branch to merge from.');
  const key = await repoKey(top);
  return locks.run(key, 'Merge', async () => {
    const s = await repoStatus(top);
    if (s.operation) throw new GitOpError(`A ${s.operation} is already in progress.`);
    if (s.files.length) throw new GitOpError('Commit or discard your changes before merging.');
    const r = await runGit(top, ['merge', '--no-edit', '--no-ff', source]);
    if (r.ok) return { conflicts: [] };
    const after = await repoStatus(top);
    const conflicts = after.files.filter((f) => f.kind === 'conflicted').map((f) => f.path);
    if (conflicts.length) return { conflicts };
    throw new GitOpError((r.err || r.out).trim() || 'The merge failed.');
  });
}

/** Marks a conflicted file resolved (its current content is kept). */
export async function markResolved(top: string, locks: RepoLocks, file: string): Promise<void> {
  const key = await repoKey(top);
  await locks.run(key, 'Resolve', async () => {
    const r = await runGit(top, ['add', '--', file]);
    if (!r.ok) throw new GitOpError(r.err.trim() || 'Could not mark it resolved.');
  });
}

/** Finishes (continue) or cancels (abort) the merge in progress. */
export async function finishMerge(top: string, locks: RepoLocks, action: 'continue' | 'abort'): Promise<void> {
  const key = await repoKey(top);
  await locks.run(key, 'Merge', async () => {
    const s = await repoStatus(top);
    if (!/merge/i.test(s.operation)) throw new GitOpError('No merge is in progress.');
    if (action === 'abort') {
      const r = await runGit(top, ['merge', '--abort']);
      if (!r.ok) throw new GitOpError(r.err.trim() || 'Could not abort.');
      return;
    }
    if (s.conflicts) throw new GitOpError('Mark every conflicted file resolved first.');
    const r = await runGit(top, ['commit', '--no-edit']);
    if (!r.ok) throw new GitOpError((r.err || r.out).trim() || 'Could not finish the merge.');
  });
}

/** Undo the latest local, unpushed commit: its changes return to Changes, content intact (mixed reset, never hard). */
export async function undoCommit(top: string, locks: RepoLocks): Promise<{ title: string; description: string }> {
  const key = await repoKey(top);
  return locks.run(key, 'Undo', async () => {
    const [c] = await history(top, 1);
    if (!c) throw new GitOpError('There is no commit to undo.');
    if (c.pushed === true) throw new GitOpError('That commit is already pushed. Revert it instead.');
    if (c.parents.length !== 1) throw new GitOpError(c.parents.length ? 'A merge commit cannot be undone here.' : 'The first commit cannot be undone.');
    const s = await repoStatus(top);
    if (s.operation) throw new GitOpError(`Finish the ${s.operation} first.`);
    const r = await runGit(top, ['reset', '--mixed', '-q', 'HEAD~1']);
    if (!r.ok) throw new GitOpError(r.err.trim() || 'Undo failed.');
    return { title: c.title, description: c.body };
  });
}

/** Revert: a new commit that reverses `commit`, preserving history. A conflict aborts and changes nothing. */
export async function revertCommit(top: string, locks: RepoLocks, commit: string): Promise<string> {
  const key = await repoKey(top);
  return locks.run(key, 'Revert', async () => {
    const s = await repoStatus(top);
    if (s.files.length || s.operation) throw new GitOpError('Commit or discard your changes before reverting.');
    const parents = (await runGit(top, ['rev-list', '--parents', '-n', '1', commit], { readOnly: true })).out.trim().split(' ');
    if (parents.length > 2) throw new GitOpError('Reverting a merge commit is not supported.');
    const r = await runGit(top, ['revert', '--no-edit', commit]);
    if (!r.ok) {
      await runGit(top, ['revert', '--abort']);
      throw new GitOpError(/conflict/i.test(r.err + r.out) ? 'The revert conflicts with later changes, so nothing was changed.' : (r.err || r.out).trim() || 'Revert failed.');
    }
    return (await runGit(top, ['rev-parse', 'HEAD'], { readOnly: true })).out.trim();
  });
}

async function emptyOrMissing(dir: string): Promise<void> {
  const fs = await import('node:fs');
  if (!path.isAbsolute(dir)) throw new GitOpError('Choose an absolute folder.');
  if (fs.existsSync(path.join(dir, '.git'))) throw new GitOpError('That folder is already a Git repository.');
}

/** Initialize a repository in `dir`, keeping any files already there. */
export async function initRepo(dir: string): Promise<void> {
  await emptyOrMissing(dir);
  const fs = await import('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  const r = await runGit(dir, ['init', '-q']);
  if (!r.ok) throw new GitOpError(r.err.trim() || 'Could not initialize.');
}

/** Clone `url` into `dir`, which must be absent or empty. */
export async function cloneRepo(url: string, dir: string): Promise<void> {
  if (!url.trim() || url.startsWith('-')) throw new GitOpError('Enter a repository address.');
  await emptyOrMissing(dir);
  const fs = await import('node:fs');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new GitOpError('The destination folder is not empty.');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await runGit(path.dirname(dir), ['clone', '--', url, dir]);
  if (!r.ok) throw new GitOpError((r.err || r.out).trim() || 'Clone failed.');
}
