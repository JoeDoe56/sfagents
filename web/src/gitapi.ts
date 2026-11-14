/**
 * The Git workspace API: the repositories every agent can reach (clean or
 * not, active or not), one entry per working context, with a short status
 * for the left edge, and the operations of gitrepo.ts addressed by id. The
 * repository activity lock lives here: agents mark the repositories they
 * work in, and every mutating call goes through RepoLocks.
 */

import path from 'node:path';
import { githubRepo, hostGitCredential } from '@sfagents/core';
import { findRepos, repoId } from './diffs.js';
import { RepoLocks, runGit, repoKey, repoStatus, fileDiff, history, commitDiff, compareBranch, branches, commitFiles, fetchRemote, pullBranch, pushBranch, publishBranch, checkoutBranch, discardFiles, mergeBranch, markResolved, finishMerge, undoCommit, revertCommit, initRepo, cloneRepo, GitOpError, RepoBusyError, type RepoStatus } from './gitrepo.js';

export interface RepoEntry {
  id: string;
  /** Shared by every worktree of one repository. */
  key: string;
  name: string;
  path: string;
  branch: string;
  /** The single most important condition, for the left edge. */
  status: string;
  agents: string[];
  working: string[];
  unavailable?: boolean;
}

export interface GitApiDeps {
  dirs: () => string[];
  /** Each agent's folders, to map access to repositories. */
  agentFolders: () => Record<string, string[]>;
}

/** The one short status the edge shows: conflicts, edits, unpushed commits, incoming, clean. */
export function edgeStatus(s: RepoStatus, working: boolean): string {
  const n = s.files.length;
  if (s.conflicts) return 'Merge conflict';
  if (n) return n === 1 ? '1 changed file' : `${n} changed files`;
  if (s.ahead) return s.ahead === 1 ? '1 commit to push' : `${s.ahead} commits to push`;
  if (s.behind) return s.behind === 1 ? '1 incoming commit' : `${s.behind} incoming commits`;
  return working ? 'Agent working' : 'Clean';
}

async function remoteUrl(top: string): Promise<string> {
  return (await runGit(top, ['remote', 'get-url', 'origin'], { readOnly: true })).out.trim();
}

async function gh(top: string, endpoint: string, init: RequestInit = {}): Promise<any> {
  const url = await remoteUrl(top);
  const repo = githubRepo(url);
  if (!repo) throw new GitOpError('Pull requests work with GitHub repositories only.');
  const login = await hostGitCredential(url).catch(() => undefined);
  const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}${endpoint}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sfagents', 'Content-Type': 'application/json', ...(login ? { Authorization: `Bearer ${login.password}` } : {}) },
  });
  if (r.status === 401 || r.status === 403) throw new GitOpError(login ? 'GitHub refused the request: your login lacks permission.' : 'No GitHub login found on this computer. Sign in with gh or Git Credential Manager.');
  if (!r.ok) throw new GitOpError(`GitHub answered ${r.status}.`);
  return r.json();
}

export class GitApi {
  readonly locks = new RepoLocks();
  private tops = new Map<string, string>(); // id → path
  private touched = new Map<string, Set<string>>(); // agent → repo keys it marked busy
  private keys = new Map<string, string>(); // path → repo key

  constructor(private deps: GitApiDeps) {}

  async repos(): Promise<RepoEntry[]> {
    const tops = await findRepos(this.deps.dirs());
    const access = this.deps.agentFolders();
    this.tops = new Map(tops.map((t) => [repoId(t), t]));
    return Promise.all(tops.map(async (top) => {
      const key = await repoKey(top);
      this.keys.set(top, key);
      const agents = Object.entries(access).filter(([, folders]) => folders.some((f) => top === f || top.startsWith(f + path.sep) || f.startsWith(top + path.sep))).map(([a]) => a);
      const working = this.locks.workingAgents(key);
      const base = { id: repoId(top), key, name: path.basename(top), path: top, agents, working };
      try {
        const s = await repoStatus(top);
        return { ...base, branch: s.detached ? s.head.slice(0, 7) : s.branch, status: edgeStatus(s, working.length > 0) };
      } catch {
        return { ...base, branch: '', status: 'Unavailable', unavailable: true };
      }
    }));
  }

  private async top(id: string): Promise<string> {
    if (!this.tops.has(id)) await this.repos();
    const top = this.tops.get(id);
    if (!top) throw new GitOpError('That repository is not available to any agent.');
    return top;
  }

  /** An agent's tool call mentions these paths: the repositories under them are busy until it finishes. */
  async agentTouched(agent: string, text: string): Promise<void> {
    if (!this.tops.size) await this.repos();
    for (const [top, key] of this.keys) {
      if (!text.includes(top) && !text.includes(top.replaceAll('\\', '/'))) continue;
      this.locks.setAgentBusy(key, agent, true);
      let set = this.touched.get(agent);
      if (!set) this.touched.set(agent, (set = new Set()));
      set.add(key);
    }
  }

  /** Every run ended (done, cancelled or failed): nothing is busy. */
  allDone(): void {
    for (const agent of [...this.touched.keys()]) this.agentDone(agent);
  }

  /** The agent's run ended (done, cancelled or failed). */
  agentDone(agent: string): void {
    for (const key of this.touched.get(agent) ?? []) this.locks.setAgentBusy(key, agent, false);
    this.touched.delete(agent);
  }

  async handle(method: string, parts: string[], query: URLSearchParams, body: Record<string, unknown>): Promise<unknown> {
    if (!parts[0]) return { repos: await this.repos() };
    if (parts[0] === 'init' && method === 'POST') { await initRepo(String(body['path'] ?? '')); return { repos: await this.repos() }; }
    if (parts[0] === 'clone' && method === 'POST') { await cloneRepo(String(body['url'] ?? ''), String(body['path'] ?? '')); return { repos: await this.repos() }; }
    const top = await this.top(parts[0]);
    const key = await repoKey(top);
    const lock = { busy: this.locks.reason(key) ?? null, working: this.locks.workingAgents(key) };
    switch (`${method} ${parts[1] ?? ''}`) {
      case 'GET status': {
        const status = await repoStatus(top);
        return { status, ...lock };
      }
      case 'GET file': {
        const status = await repoStatus(top);
        const file = status.files.find((f) => f.path === query.get('path'));
        if (!file) return { gone: true };
        return fileDiff(top, file);
      }
      case 'GET history': return { commits: await history(top, Number(query.get('limit')) || 100), ...lock };
      case 'GET commit': return commitDiff(top, query.get('newest') ?? 'HEAD', query.get('oldest') ?? undefined);
      case 'GET compare': return compareBranch(top, query.get('base') ?? '');
      case 'GET branches': return { branches: await branches(top) };
      case 'POST commit': {
        const paths = Array.isArray(body['paths']) ? body['paths'].map(String) : [];
        const sha = await commitFiles(top, this.locks, { paths, title: String(body['title'] ?? ''), description: typeof body['description'] === 'string' ? body['description'] : undefined });
        return { commit: sha };
      }
      case 'POST fetch': return { output: await fetchRemote(top, this.locks) };
      case 'POST pull': return { output: await pullBranch(top, this.locks) };
      case 'POST push': return { output: await pushBranch(top, this.locks) };
      case 'POST publish': return { output: await publishBranch(top, this.locks, typeof body['remote'] === 'string' ? body['remote'] : undefined) };
      case 'POST checkout': {
        await checkoutBranch(top, this.locks, { name: String(body['name'] ?? ''), create: body['create'] === true, from: typeof body['from'] === 'string' ? body['from'] : undefined });
        return { ok: true };
      }
      case 'POST discard': { await discardFiles(top, this.locks, Array.isArray(body['paths']) ? body['paths'].map(String) : []); return { ok: true }; }
      case 'POST merge': return mergeBranch(top, this.locks, String(body['source'] ?? ''));
      case 'POST resolve': { await markResolved(top, this.locks, String(body['path'] ?? '')); return { ok: true }; }
      case 'POST merge-finish': { await finishMerge(top, this.locks, body['action'] === 'abort' ? 'abort' : 'continue'); return { ok: true }; }
      case 'POST undo': return undoCommit(top, this.locks);
      case 'POST revert': return { commit: await revertCommit(top, this.locks, String(body['commit'] ?? '')) };
      case 'GET pulls': {
        const s = await repoStatus(top);
        const url = await remoteUrl(top);
        const g = githubRepo(url);
        if (!g) return { pulls: [], note: 'Pull requests are available for GitHub repositories only.' };
        const list = await gh(top, `/pulls?state=open&head=${encodeURIComponent(`${g.owner}:${s.branch}`)}`);
        return { pulls: list.map((p: any) => ({ number: p.number, title: p.title, url: p.html_url, base: p.base.ref, head: p.head.ref, draft: p.draft, state: p.state })) };
      }
      case 'POST pull-request': {
        const why = this.locks.reason(key);
        if (why) throw new RepoBusyError(why);
        const s = await repoStatus(top);
        if (!s.upstream) throw new GitOpError('Publish the branch before opening a pull request.');
        const title = String(body['title'] ?? '').trim();
        const base = String(body['base'] ?? '').trim();
        if (!title || !base) throw new GitOpError('A title and a base branch are required.');
        if (base === s.branch) throw new GitOpError('The base and head branch are the same.');
        const p = await gh(top, '/pulls', { method: 'POST', body: JSON.stringify({ title, body: String(body['description'] ?? ''), head: s.branch, base }) });
        return { url: p.html_url, number: p.number };
      }
      default: throw new GitOpError('Unknown Git action.');
    }
  }
}

export { GitOpError, RepoBusyError };
