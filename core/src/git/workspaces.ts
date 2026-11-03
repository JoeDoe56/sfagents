/**
 * Git workspaces: each repository the agents work on is cloned once into
 * /workspaces/<repo>/.repo (a bare clone), and each task is a worktree in
 * /workspaces/<repo>/<task> on branch sfagents/<task>, started from the
 * latest default branch. Agents on the same repository share its history;
 * each task has its own folder.
 *
 * Every Git command here runs in SF Agents' own Git helper container (the
 * same image and /workspaces, network level "git"), never in an agent's:
 * the credentials for fetching and pushing (from Git Credential Manager or
 * gh on this computer) go only there, and SF Agents builds every push
 * itself: no force pushes, no remote deletes, and a change to
 * .github/workflows asks the person first.
 *
 * After each agent run, SF Agents commits the agent's task workspaces (a
 * checkpoint). Any run can be undone; when the task is done the checkpoints
 * are squashed into one commit with a real message.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sfagentsHome } from '../settings/home.js';
import { getErrorMessage } from '../utils/errors.js';

export const CONTAINER_WORKSPACES_DIR = '/workspaces';
/** Subject prefix of checkpoint commits (squashed by finish). */
export const CHECKPOINT_PREFIX = 'sfagents checkpoint: ';
export const TASK_BRANCH_PREFIX = 'sfagents/';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class GitError extends Error {}

/** Runs a shell script in the Git helper container, in `cwd` (a /workspaces path). */
export type GitRunner = (script: string, o: { cwd: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A login for a Git host, from this computer's own Git (Credential Manager) or gh. */
export interface GitCredential {
  username: string;
  password: string;
}

export interface TaskRecord {
  repo: string;
  task: string;
  /** The agent working in it (last to use it). */
  agent: string;
  created: string;
  used: string;
}

export interface RepoRecord {
  name: string;
  url: string;
  defaultBranch: string;
}

interface StoreData {
  repos: Record<string, RepoRecord>;
  tasks: Record<string, TaskRecord>;
}

export interface WorkspaceInfo extends TaskRecord {
  path: string;
  branch: string;
  defaultBranch: string;
  url: string;
  /** Commits ahead of and behind origin/<default>. */
  ahead: number;
  behind: number;
  /** Checkpoint commits not squashed yet. */
  checkpoints: number;
  /** Files changed since the last real commit (checkpoints and uncommitted work). */
  changed: number;
  /** Lines added and removed since then (tracked files). */
  added: number;
  removed: number;
  /** Uncommitted changes right now. */
  dirty: boolean;
  /** Disk use in KB. */
  sizeKb?: number;
}

export interface ReviewHunk {
  header: string;
  lines: string[];
}

export interface ReviewFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  /** The diff's header lines (diff --git, index, ---, +++). */
  head: string[];
  hunks: ReviewHunk[];
  binary?: boolean;
}

/** Quotes for sh. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The task a container path is in ("/workspaces/app/fix-login/src" → app, fix-login). */
export function taskOfPath(p: string): { repo: string; task: string } | undefined {
  const m = /^\/workspaces\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path.posix.normalize(p));
  if (!m || m[2] === '.repo' || !NAME.test(m[1]!) || !NAME.test(m[2]!)) return undefined;
  return { repo: m[1]!, task: m[2]! };
}

/** The repository's name from its address ("https://github.com/o/My-App.git" → My-App). */
export function repoNameOf(url: string): string {
  const base = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return base.replace(/\.git$/i, '');
}

/** A GitHub repository's owner and name, from its address. */
export function githubRepo(url: string): { owner: string; name: string } | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

/**
 * A login for `url`'s host from this computer: `gh auth token` for GitHub
 * when gh is signed in, else `git credential fill` (Git Credential Manager
 * on Windows). Undefined when there is none; public repositories need none.
 */
export async function hostGitCredential(url: string): Promise<GitCredential | undefined> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return undefined;
  }
  const run = (cmd: string, args: string[], input?: string) =>
    new Promise<string | undefined>((resolve) => {
      const child = execFile(cmd, args, { timeout: 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto' } }, (error, stdout) => resolve(error ? undefined : String(stdout)));
      if (input !== undefined) child.stdin?.end(input);
    });
  if (host === 'github.com') {
    const token = (await run('gh', ['auth', 'token']))?.trim();
    if (token) return { username: 'x-access-token', password: token };
  }
  const out = await run('git', ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`);
  if (!out) return undefined;
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim();
  const username = get('username');
  const password = get('password');
  return username && password ? { username, password } : undefined;
}

/** Where SF Agents keeps what it knows of the workspaces. */
class WorkspaceStore {
  constructor(readonly file: string) {}

  read(): StoreData {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreData>;
      return { repos: d.repos ?? {}, tasks: d.tasks ?? {} };
    } catch {
      return { repos: {}, tasks: {} };
    }
  }

  write(d: StoreData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, `${JSON.stringify(d, null, 2)}\n`);
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  update(fn: (d: StoreData) => void): void {
    const d = this.read();
    fn(d);
    this.write(d);
  }
}

export interface GitWorkspacesOptions {
  run: GitRunner;
  /** Logins for fetching and pushing (default: hostGitCredential). */
  credential?: (url: string) => Promise<GitCredential | undefined>;
  /** GitHub's API (sfa-ci, public checks): default fetch. */
  fetch?: typeof fetch;
  /** The person's name and email for commits. */
  identity?: () => Record<string, string>;
  file?: string;
  onChange?: () => void;
}

/** The workspaces, and every Git operation on them. */
export class GitWorkspaces {
  private readonly store: WorkspaceStore;
  readonly fetchApi: typeof fetch;

  constructor(private readonly o: GitWorkspacesOptions) {
    this.store = new WorkspaceStore(o.file ?? path.join(sfagentsHome(), 'workspaces.json'));
    this.fetchApi = o.fetch ?? fetch;
  }

  // ---------------------------------------------------------------- running git

  private env(extra: Record<string, string> = {}): Record<string, string> {
    return { GIT_TERMINAL_PROMPT: '0', ...(this.o.identity?.() ?? {}), ...extra };
  }

  /** Git's environment with a login for the remote (only in the helper container). */
  private async authEnv(url: string): Promise<Record<string, string>> {
    const c = await (this.o.credential ?? hostGitCredential)(url).catch(() => undefined);
    if (!c) return {};
    return {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '!f() { test "$1" = get || exit 0; echo "username=$SFA_GIT_USER"; echo "password=$SFA_GIT_PASSWORD"; }; f',
      SFA_GIT_USER: c.username,
      SFA_GIT_PASSWORD: c.password,
    };
  }

  private async sh(cwd: string, script: string, o: { env?: Record<string, string>; stdin?: string; timeoutMs?: number; ok?: boolean } = {}): Promise<string> {
    const r = await this.o.run(script, { cwd, env: this.env(o.env), ...(o.stdin !== undefined ? { stdin: o.stdin } : {}), timeoutMs: o.timeoutMs ?? 120_000 });
    if (r.code !== 0 && o.ok !== false) throw new GitError((r.stderr || r.stdout).trim().split('\n').slice(-12).join('\n') || `git failed (exit ${r.code})`);
    return r.stdout;
  }

  private repoDir(repo: string): string {
    return `${CONTAINER_WORKSPACES_DIR}/${repo}`;
  }

  taskDir(repo: string, task: string): string {
    return `${CONTAINER_WORKSPACES_DIR}/${repo}/${task}`;
  }

  private repoRecord(repo: string): RepoRecord {
    const r = this.store.read().repos[repo];
    if (!r) throw new GitError(`No repository "${repo}" in /workspaces: clone it first (sfa-git clone <url>).`);
    return r;
  }

  private changed(): void {
    this.o.onChange?.();
  }

  // ---------------------------------------------------------------- repositories and tasks

  /** Clones a repository into /workspaces/<name>/.repo. */
  async clone(url: string, name = repoNameOf(url)): Promise<RepoRecord> {
    if (!/^https:\/\/[^\s]+$/.test(url)) throw new GitError('Give the repository’s https address (git@ addresses become https in the container).');
    if (!NAME.test(name)) throw new GitError(`"${name}" can’t be a folder name: letters, digits, . _ and - only.`);
    const existing = this.store.read().repos[name];
    if (existing) return existing;
    const dir = this.repoDir(name);
    await this.sh(CONTAINER_WORKSPACES_DIR, `mkdir -p ${q(name)} && cd ${q(name)} && test ! -e .repo && git clone -q --bare ${q(url)} .repo && git -C .repo config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git -C .repo fetch -q origin`, { env: await this.authEnv(url), timeoutMs: 30 * 60_000 });
    const head = (await this.sh(dir, 'git -C .repo symbolic-ref --short HEAD', { ok: false })).trim() || 'main';
    const record = { name, url, defaultBranch: head };
    this.store.update((d) => (d.repos[name] = record));
    this.changed();
    return record;
  }

  /**
   * A task's workspace: a new worktree on sfagents/<task> from the latest
   * default branch, or the existing one (continued). `fetch` gets the
   * latest default branch first (when the agent may reach Git hosts).
   */
  async task(repo: string, task: string, agent: string, fetchFirst: boolean): Promise<{ path: string; created: boolean }> {
    if (!NAME.test(task)) throw new GitError(`"${task}" can’t be a task name: letters, digits, . _ and - only (it becomes the branch sfagents/${task}).`);
    const r = this.repoRecord(repo);
    const dir = this.taskDir(repo, task);
    const exists = (await this.sh(this.repoDir(repo), `test -e ${q(task)}/.git && echo yes`, { ok: false })).trim() === 'yes';
    const now = new Date().toISOString();
    if (!exists) {
      if (fetchFirst) await this.sh(this.repoDir(repo), 'git -C .repo fetch -q origin', { env: await this.authEnv(r.url), timeoutMs: 10 * 60_000 });
      const branch = `${TASK_BRANCH_PREFIX}${task}`;
      const has = (await this.sh(this.repoDir(repo), `git -C .repo rev-parse -q --verify ${q(`refs/heads/${branch}`)}`, { ok: false })).trim();
      await this.sh(this.repoDir(repo), has ? `git -C .repo worktree add -q ../${q(task)} ${q(branch)}` : `git -C .repo worktree add -q -b ${q(branch)} ../${q(task)} ${q(`origin/${r.defaultBranch}`)}`);
    }
    this.store.update((d) => {
      d.tasks[`${repo}/${task}`] = { repo, task, agent, created: d.tasks[`${repo}/${task}`]?.created ?? now, used: now };
    });
    this.changed();
    return { path: dir, created: !exists };
  }

  private taskRecord(repo: string, task: string): TaskRecord {
    const t = this.store.read().tasks[`${repo}/${task}`];
    if (!t) throw new GitError(`No task "${task}" in ${repo}: start it with sfa-git task ${repo} ${task}.`);
    return t;
  }

  /** The tasks, with their branch and state. */
  async list(o: { size?: boolean } = {}): Promise<WorkspaceInfo[]> {
    const d = this.store.read();
    const out: WorkspaceInfo[] = [];
    for (const t of Object.values(d.tasks)) {
      const r = d.repos[t.repo];
      if (!r) continue;
      try {
        out.push(await this.info(t, r, o.size === true));
      } catch {
        // gone from /workspaces (deleted by hand): dropped from the list
        this.store.update((s) => delete s.tasks[`${t.repo}/${t.task}`]);
      }
    }
    return out.sort((a, b) => b.used.localeCompare(a.used));
  }

  private async info(t: TaskRecord, r: RepoRecord, size: boolean): Promise<WorkspaceInfo> {
    const dir = this.taskDir(t.repo, t.task);
    const out = await this.sh(dir, [
      'git rev-parse --abbrev-ref HEAD',
      `git rev-list --left-right --count HEAD...${q(`origin/${r.defaultBranch}`)} 2>/dev/null || echo "0 0"`,
      'git log --first-parent --format=%s -n 300',
      'echo ---',
      'git status --porcelain | wc -l',
      ...(size ? ['du -sk . | cut -f1'] : []),
    ].join('; '));
    const [branch, counts, ...rest] = out.split('\n');
    const sep = rest.indexOf('---');
    const subjects = rest.slice(0, sep);
    const [dirtyCount, sizeKb] = rest.slice(sep + 1);
    let checkpoints = 0;
    while (checkpoints < subjects.length && subjects[checkpoints]!.startsWith(CHECKPOINT_PREFIX)) checkpoints++;
    const [ahead, behind] = (counts ?? '0 0').trim().split(/\s+/).map(Number);
    const base = await this.base(dir);
    const [changedOut, numstat = ''] = (await this.sh(dir, `{ git diff --name-only ${q(base)}; git ls-files --others --exclude-standard; } | sort -u | wc -l; echo ---; git diff --numstat ${q(base)}`)).split('---\n');
    const changed = Number(changedOut!.trim());
    let added = 0;
    let removed = 0;
    for (const l of numstat.split('\n')) {
      const [a, d] = l.split('\t');
      added += Number(a) || 0;
      removed += Number(d) || 0;
    }
    return {
      ...t,
      path: dir,
      branch: branch?.trim() ?? '',
      defaultBranch: r.defaultBranch,
      url: r.url,
      ahead: ahead ?? 0,
      behind: behind ?? 0,
      checkpoints,
      changed,
      added,
      removed,
      dirty: Number(dirtyCount) > 0,
      ...(sizeKb ? { sizeKb: Number(sizeKb) } : {}),
    };
  }

  /** The last commit that is not a checkpoint: what review and squash compare with. */
  private async base(dir: string): Promise<string> {
    const lines = (await this.sh(dir, 'git log --first-parent --format=%H%x09%s -n 500')).split('\n').filter(Boolean);
    for (const l of lines) {
      const [hash, subject] = l.split('\t');
      if (!subject?.startsWith(CHECKPOINT_PREFIX)) return hash!;
    }
    return lines.at(-1)?.split('\t')[0] ?? 'HEAD';
  }

  // ---------------------------------------------------------------- checkpoints

  /** Commits a task's changes as a checkpoint; false when there was nothing to commit. */
  async checkpoint(repo: string, task: string, label: string): Promise<boolean> {
    const dir = this.taskDir(repo, task);
    const subject = `${CHECKPOINT_PREFIX}${label.replace(/\s+/g, ' ').trim().slice(0, 100) || 'agent run'}`;
    const out = await this.sh(dir, `git add -A && if git diff --cached --quiet; then echo none; else git commit -q --no-verify -m ${q(subject)} && echo made; fi`);
    const made = out.trim().endsWith('made');
    if (made) this.changed();
    return made;
  }

  /** After an agent's run: a checkpoint in each task it works in. */
  async checkpointAgent(agent: string, label: string): Promise<void> {
    for (const t of Object.values(this.store.read().tasks)) {
      if (t.agent !== agent) continue;
      try {
        await this.checkpoint(t.repo, t.task, label);
      } catch {
        // a task folder removed by hand, or Git busy: the next run commits it
      }
    }
  }

  /** Undoes the last run: back to before its checkpoint (what was there is kept under refs/sfagents/undo). */
  async undo(repo: string, task: string): Promise<string> {
    const dir = this.taskDir(repo, task);
    const subject = (await this.sh(dir, 'git log -1 --format=%s')).trim();
    if (!subject.startsWith(CHECKPOINT_PREFIX)) throw new GitError('The last commit is not a run’s checkpoint: there is no run to undo.');
    // What is undone stays reachable (refs/sfagents/undo/<task>), uncommitted edits included.
    await this.sh(dir, `s=$(git stash create); git update-ref ${q(`refs/sfagents/undo/${task}`)} "\${s:-HEAD}" && git reset -q --hard HEAD~1 && git clean -fdq`);
    this.changed();
    return `Undid “${subject.slice(CHECKPOINT_PREFIX.length)}”.`;
  }

  /** The commit message drafted from the checkpoints (what each run was asked to do). */
  async draftMessage(repo: string, task: string): Promise<string> {
    const dir = this.taskDir(repo, task);
    const subjects = (await this.sh(dir, 'git log --first-parent --format=%s -n 300')).split('\n');
    const labels: string[] = [];
    for (const s of subjects) {
      if (!s.startsWith(CHECKPOINT_PREFIX)) break;
      const l = s.slice(CHECKPOINT_PREFIX.length);
      if (!/^(before |rejected a change)/.test(l) && !labels.includes(l)) labels.unshift(l);
    }
    if (!labels.length) return task.replace(/[-_]+/g, ' ');
    const first = labels[0]!.replace(/[.\s]+$/, '');
    const title = (first.charAt(0).toUpperCase() + first.slice(1)).slice(0, 72);
    return labels.length === 1 ? title : `${title}\n\n${labels.slice(1).map((l) => `- ${l}`).join('\n')}`;
  }

  /** Squashes the checkpoints (and anything uncommitted) into one commit. */
  async finish(repo: string, task: string, message: string): Promise<string> {
    if (!message.trim()) throw new GitError('Give the commit a message.');
    const dir = this.taskDir(repo, task);
    const base = await this.base(dir);
    await this.sh(dir, `git add -A && git reset -q --soft ${q(base)} && if git diff --cached --quiet; then echo none; else git commit -q --no-verify -F - && echo made; fi`, { stdin: message.trim() + '\n' });
    this.changed();
    return (await this.sh(dir, 'git log -1 --format=%h%x20%s')).trim();
  }

  // ---------------------------------------------------------------- review

  /** The task's work since the last real commit, file by file and hunk by hunk. */
  async review(repo: string, task: string): Promise<{ files: ReviewFile[]; message: string; base: string }> {
    const dir = this.taskDir(repo, task);
    const base = await this.base(dir);
    const patch = await this.sh(dir, `git add -A -N . && git -c core.quotepath=off diff --no-color --no-ext-diff ${q(base)}`);
    return { files: parsePatch(patch), message: await this.draftMessage(repo, task), base };
  }

  /** Takes one hunk back out of the workspace (reject), as a checkpoint. */
  async rejectHunk(repo: string, task: string, file: string, hunk: number): Promise<void> {
    const { files } = await this.review(repo, task);
    const f = files.find((x) => x.path === file);
    const h = f?.hunks[hunk];
    if (!f || !h) throw new GitError('That change is no longer there (the workspace changed): look again.');
    const one = [...f.head, h.header, ...h.lines, ''].join('\n');
    await this.sh(this.taskDir(repo, task), 'git apply -R --whitespace=nowarn -', { stdin: one });
    await this.checkpoint(repo, task, `rejected a change in ${file}`);
  }

  // ---------------------------------------------------------------- remote

  /** Rebases the task on the latest default branch; conflicts are left for the agent to resolve. */
  async update(repo: string, task: string): Promise<string> {
    const r = this.repoRecord(repo);
    const dir = this.taskDir(repo, task);
    await this.checkpoint(repo, task, 'before update from main');
    await this.sh(dir, 'git fetch -q origin', { env: await this.authEnv(r.url), timeoutMs: 10 * 60_000 });
    const out = await this.sh(dir, `git rebase -q ${q(`origin/${r.defaultBranch}`)} 2>&1 && echo REBASED || { echo CONFLICT; git diff --name-only --diff-filter=U; }`, { ok: false });
    this.changed();
    if (out.includes('REBASED')) return `Up to date with origin/${r.defaultBranch}.`;
    const files = out.split('CONFLICT')[1]?.trim() ?? '';
    return `Conflicts with origin/${r.defaultBranch} in:\n${files}\nResolve them in ${dir}, then git add the files and run: git rebase --continue (or git rebase --abort to go back).`;
  }

  /**
   * Pushes the task: its branch, or with `toMain` the default branch (a
   * fast-forward only: the task must be up to date and squashed). Never a
   * force push. `approve` is asked when .github/workflows changes.
   */
  async push(repo: string, task: string, o: { toMain: boolean; approve: (question: string) => Promise<boolean> }): Promise<string> {
    const r = this.repoRecord(repo);
    this.taskRecord(repo, task);
    const dir = this.taskDir(repo, task);
    const auth = await this.authEnv(r.url);
    await this.checkpoint(repo, task, 'before push');
    await this.sh(dir, 'git fetch -q origin', { env: auth, timeoutMs: 10 * 60_000 });
    const main = `origin/${r.defaultBranch}`;
    const branch = `${TASK_BRANCH_PREFIX}${task}`;
    if (o.toMain) {
      const behind = (await this.sh(dir, `git merge-base --is-ancestor ${q(main)} HEAD && echo ok`, { ok: false })).trim();
      if (behind !== 'ok') throw new GitError(`${r.defaultBranch} has moved on: update from main first (sfa-git update), then push.`);
      const subjects = (await this.sh(dir, `git log --format=%s ${q(main)}..HEAD`)).split('\n').filter(Boolean);
      if (!subjects.length) return `Nothing to push: ${r.defaultBranch} already has this.`;
      if (subjects.some((s) => s.startsWith(CHECKPOINT_PREFIX))) throw new GitError('The task still has run checkpoints: squash them into a commit first (sfa-git finish -m "message").');
    }
    const remoteBranch = (await this.sh(dir, `git rev-parse -q --verify ${q(`refs/remotes/origin/${branch}`)}`, { ok: false })).trim();
    const against = o.toMain || !remoteBranch ? main : `origin/${branch}`;
    const workflows = (await this.sh(dir, `git diff --name-only ${q(against)} HEAD -- .github/workflows`)).trim();
    if (workflows && !(await o.approve(`Push changes to GitHub Actions workflows (${workflows.split('\n').join(', ')}) to ${o.toMain ? r.defaultBranch : branch}?`))) {
      throw new GitError('Not pushed: changes to .github/workflows need the person’s approval, and they did not give it.');
    }
    const target = o.toMain ? r.defaultBranch : branch;
    // No "+", no --force, no ":ref": a fast-forward or nothing.
    await this.sh(dir, `git push -q origin ${q(`HEAD:refs/heads/${target}`)}`, { env: auth, timeoutMs: 10 * 60_000 });
    this.changed();
    return `Pushed to ${target}.`;
  }

  /**
   * Fast-forwards the person's own checkout (a folder on this computer) to
   * the task: the task's branch is pushed, then fetched there. Stops when
   * that copy has uncommitted changes or has gone another way.
   */
  async pullInto(repo: string, task: string, folder: string, approve: (q: string) => Promise<boolean>): Promise<string> {
    const git = (args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile('git', args, { cwd: folder, timeout: 10 * 60_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) =>
          error ? reject(new GitError(String(stderr || error.message).trim())) : resolve(String(stdout)),
        ),
      );
    if (!fs.existsSync(path.join(folder, '.git'))) throw new GitError(`${folder} is not a Git checkout.`);
    if ((await git(['status', '--porcelain'])).trim()) throw new GitError(`${folder} has uncommitted changes: commit or stash them first. Nothing was changed.`);
    await this.push(repo, task, { toMain: false, approve });
    const branch = `${TASK_BRANCH_PREFIX}${task}`;
    await git(['fetch', '-q', 'origin', branch]);
    try {
      await git(['merge', '--ff-only', '-q', 'FETCH_HEAD']);
    } catch (error) {
      throw new GitError(`${folder} can’t be fast-forwarded to ${branch} (it has commits the task doesn’t): ${getErrorMessage(error)}`);
    }
    return `${folder} now has ${branch}.`;
  }

  /** Removes a task's worktree and its local branch (the remote branch stays). */
  async remove(repo: string, task: string): Promise<void> {
    await this.sh(this.repoDir(repo), `git -C .repo worktree remove --force ../${q(task)}; git -C .repo branch -q -D ${q(`${TASK_BRANCH_PREFIX}${task}`)} 2>/dev/null; rm -rf ${q(task)}; true`);
    this.store.update((d) => delete d.tasks[`${repo}/${task}`]);
    this.changed();
  }

  /** The commit the task is at (sfa-ci). */
  async head(repo: string, task: string): Promise<string> {
    return (await this.sh(this.taskDir(repo, task), 'git rev-parse HEAD')).trim();
  }

  /** A login for a repository's host (sfa-ci's API calls). */
  async login(repo: string): Promise<GitCredential | undefined> {
    return (this.o.credential ?? hostGitCredential)(this.repoRecord(repo).url).catch(() => undefined);
  }

  repo(repo: string): RepoRecord {
    return this.repoRecord(repo);
  }

  /** Writes a file into a task (sfa-ci's downloads), through the helper. */
  async writeFile(repo: string, task: string, rel: string, data: Buffer, unzip: boolean): Promise<void> {
    const dir = path.posix.dirname(rel);
    await this.sh(this.taskDir(repo, task), `mkdir -p ${q(dir)} && base64 -d > ${q(rel)}${unzip ? ` && cd ${q(dir)} && unzip -oq ${q(path.posix.basename(rel))} && rm -f ${q(path.posix.basename(rel))}` : ''}`, { stdin: data.toString('base64') });
  }
}

/** A unified diff, split into files and hunks. */
export function parsePatch(patch: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  let f: ReviewFile | undefined;
  let h: ReviewHunk | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      f = { path: m?.[1] ?? line, status: 'modified', head: [line], hunks: [] };
      h = undefined;
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) {
      h = { header: line, lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (h) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\')) h.lines.push(line);
      continue;
    }
    f.head.push(line);
    if (line.startsWith('new file')) f.status = 'added';
    else if (line.startsWith('deleted file')) f.status = 'deleted';
    else if (line.startsWith('rename ')) f.status = 'renamed';
    else if (line.startsWith('Binary files')) f.binary = true;
  }
  return files;
}
