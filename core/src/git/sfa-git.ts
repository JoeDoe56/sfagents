/**
 * `sfa-git` and `sfa-ci`: an agent's Git commands that need SF Agents
 * (cloning, task workspaces, pushing, CI). They run in SF Agents and its
 * Git helper container, never with credentials in the agent's container.
 * Plain git (status, diff, commit, log, rebase) works in the workspace as
 * usual.
 */

import type { NetworkLevel } from '../container/network.js';
import { getErrorMessage } from '../utils/errors.js';
import { GitError, githubRepo, taskOfPath, type GitWorkspaces } from './workspaces.js';

export const GIT_COMMAND = 'sfa-git';
export const CI_COMMAND = 'sfa-ci';

export const GIT_USAGE = `Usage (a task is a folder /workspaces/<repo>/<task> on branch sfagents/<task>):
  sfa-git clone <https-url> [name]   clone a repository into /workspaces/<name>
  sfa-git task <repo> <task>         start a task from the latest default branch (or continue it); cd there
  sfa-git tasks                      the tasks: repo, branch, ahead/behind, unsquashed checkpoints
  sfa-git update                     rebase this task on the latest default branch (conflicts are yours to resolve)
  sfa-git finish -m "message"        squash this task's run checkpoints into one commit
  sfa-git push                       push this task's branch (sfagents/<task>)
  sfa-git push --main                push this task to the default branch (fast-forward only; finish first)
  sfa-git undo                       undo the last run's checkpoint in this task
Run the task commands inside the task's folder. SF Agents commits each task after every run (a checkpoint).
There is no force push and no deleting remote branches; pushing .github/workflows changes asks the person.`;

export const CI_USAGE = `Usage: sfa-ci [--workflow <file.yml>] [--timeout <minutes>]
  Pushes this task's branch, waits for its GitHub Actions runs (starting --workflow by workflow_dispatch),
  and prints each run's result with the failing jobs' logs. Their uploaded artifacts are unpacked in .sfa-ci/<run>/.
  Only for public GitHub repositories.`;

/** What an agent's sfa-git and sfa-ci may do. */
export interface GitGrant {
  workspaces: GitWorkspaces;
  agentId: string;
  level: NetworkLevel;
  /** Asks the person (pushing workflow changes); false when there is no one to ask. */
  approve: (question: string) => Promise<boolean>;
}

type Reply = { ok: true; text: string } | { ok: false; error: string };

const remote = (level: NetworkLevel) => level === 'git' || level === 'on';
const NEEDS_GIT = 'This needs network level "git" (or "on") in the agent’s settings.';

function here(cwd: string | undefined): { repo: string; task: string } {
  const t = cwd ? taskOfPath(cwd) : undefined;
  if (!t) throw new GitError('Run this inside a task folder (/workspaces/<repo>/<task>); sfa-git tasks lists them.');
  return t;
}

/** Runs `sfa-git <args>`; `cwd` is the command's folder in the container. */
export async function runGitCommand(grant: GitGrant | undefined, args: readonly string[], o: { cwd?: string }): Promise<Reply> {
  if (!grant) return { ok: false, error: 'Git workspaces are not available here.' };
  const [op, ...rest] = args;
  const ws = grant.workspaces;
  try {
    switch (op) {
      case 'clone': {
        if (!remote(grant.level)) return { ok: false, error: NEEDS_GIT };
        if (!rest[0]) return { ok: false, error: GIT_USAGE };
        const r = await ws.clone(rest[0], rest[1]);
        return { ok: true, text: `Cloned into /workspaces/${r.name} (default branch ${r.defaultBranch}). Start a task: sfa-git task ${r.name} <task>` };
      }
      case 'task': {
        const [repo, task] = rest;
        if (!repo || !task) return { ok: false, error: GIT_USAGE };
        const t = await ws.task(repo, task, grant.agentId, remote(grant.level));
        return { ok: true, text: `${t.created ? 'Started' : 'Continuing'} task ${task} in ${t.path} (branch sfagents/${task}). cd ${t.path}` };
      }
      case 'tasks': {
        const list = await ws.list();
        if (!list.length) return { ok: true, text: 'No tasks yet. sfa-git clone <url>, then sfa-git task <repo> <task>.' };
        return {
          ok: true,
          text: list.map((w) => `${w.path}  ${w.branch}  ${w.ahead} ahead, ${w.behind} behind origin/${w.defaultBranch}  ${w.checkpoints} checkpoint(s)${w.dirty ? ', uncommitted changes' : ''}  (${w.agent}, ${w.used.slice(0, 16).replace('T', ' ')})`).join('\n'),
        };
      }
      case 'update': {
        if (!remote(grant.level)) return { ok: false, error: NEEDS_GIT };
        const t = here(o.cwd);
        return { ok: true, text: await ws.update(t.repo, t.task) };
      }
      case 'finish': {
        const t = here(o.cwd);
        const i = rest.indexOf('-m');
        const message = i >= 0 ? rest.slice(i + 1).join(' ') : '';
        if (!message) return { ok: false, error: `Give the commit message: sfa-git finish -m "message". A draft from the runs:\n${await ws.draftMessage(t.repo, t.task)}` };
        return { ok: true, text: `Committed ${await ws.finish(t.repo, t.task, message)}` };
      }
      case 'push': {
        if (!remote(grant.level)) return { ok: false, error: NEEDS_GIT };
        if (rest.some((a) => /^(-f|--force.*|--delete|-d|\+.*|:.*)$/.test(a))) return { ok: false, error: 'sfa-git never force-pushes or deletes remote branches.' };
        const t = here(o.cwd);
        return { ok: true, text: await ws.push(t.repo, t.task, { toMain: rest.includes('--main'), approve: grant.approve }) };
      }
      case 'undo': {
        const t = here(o.cwd);
        return { ok: true, text: await ws.undo(t.repo, t.task) };
      }
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        return { ok: true, text: GIT_USAGE };
      default:
        return { ok: false, error: `Unknown: sfa-git ${op}. For everyday Git (status, diff, commit, log) use git itself.\n${GIT_USAGE}` };
    }
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/** Runs `sfa-ci`: push, wait for GitHub Actions, report. */
export async function runCiCommand(grant: GitGrant | undefined, args: readonly string[], o: { cwd?: string; signal: AbortSignal }): Promise<Reply> {
  if (!grant) return { ok: false, error: 'Git workspaces are not available here.' };
  if (args.includes('-h') || args.includes('--help')) return { ok: true, text: CI_USAGE };
  if (!remote(grant.level)) return { ok: false, error: NEEDS_GIT };
  const ws = grant.workspaces;
  try {
    const t = here(o.cwd);
    const repo = ws.repo(t.repo);
    const gh = githubRepo(repo.url);
    if (!gh) return { ok: false, error: 'sfa-ci works with GitHub repositories only.' };
    const opt = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const workflow = opt('--workflow');
    const timeoutMs = Math.min(120, Math.max(1, Number(opt('--timeout') ?? 30))) * 60_000;
    const login = await ws.login(t.repo);
    const api = async (p: string, init: RequestInit = {}) => {
      const res = await ws.fetchApi(`https://api.github.com/repos/${gh.owner}/${gh.name}${p}`, {
        ...init,
        signal: o.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sfagents', ...(login ? { Authorization: `Bearer ${login.password}` } : {}), ...(init.headers ?? {}) },
      });
      return res;
    };
    const info = await api('');
    if (!info.ok) return { ok: false, error: `GitHub answered ${info.status} for ${gh.owner}/${gh.name}.` };
    if ((await info.json() as { private?: boolean }).private !== false) return { ok: false, error: 'sfa-ci is only for public repositories (Actions minutes on private ones cost money).' };
    const pushed = await ws.push(t.repo, t.task, { toMain: false, approve: grant.approve });
    const sha = await ws.head(t.repo, t.task);
    const branch = `sfagents/${t.task}`;
    if (workflow) {
      const d = await api(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: branch }), headers: { 'Content-Type': 'application/json' } });
      if (!d.ok) return { ok: false, error: `${pushed} Starting ${workflow} failed: GitHub answered ${d.status} (it needs "on: workflow_dispatch", and a login that may run workflows).` };
    }
    type Run = { id: number; name: string; status: string; conclusion: string | null; html_url: string };
    const end = Date.now() + timeoutMs;
    let runs: Run[] = [];
    for (let quiet = 0; ; ) {
      const r = await api(`/actions/runs?head_sha=${sha}&per_page=30`);
      runs = r.ok ? ((await r.json()) as { workflow_runs: Run[] }).workflow_runs : [];
      if (!runs.length && ++quiet > 12) return { ok: true, text: `${pushed} No workflow ran for ${sha.slice(0, 7)} within two minutes. Pass --workflow <file.yml> to start one (it needs "on: workflow_dispatch").` };
      if (runs.length && runs.every((x) => x.status === 'completed')) break;
      if (Date.now() > end) return { ok: true, text: `${pushed} Still running after ${timeoutMs / 60_000} minutes:\n${runs.map((x) => `${x.name}: ${x.status} ${x.html_url}`).join('\n')}` };
      await new Promise((res) => setTimeout(res, 10_000));
      if (o.signal.aborted) throw new Error('Stopped.');
    }
    const out: string[] = [pushed];
    for (const run of runs) {
      out.push(`${run.conclusion === 'success' ? 'PASS' : 'FAIL'} ${run.name}: ${run.conclusion} ${run.html_url}`);
      if (run.conclusion !== 'success') {
        const jobs = await api(`/actions/runs/${run.id}/jobs?per_page=50`);
        for (const job of jobs.ok ? ((await jobs.json()) as { jobs: Array<{ id: number; name: string; conclusion: string }> }).jobs : []) {
          if (job.conclusion === 'success' || job.conclusion === 'skipped') continue;
          const log = await api(`/actions/jobs/${job.id}/logs`);
          const text = log.ok ? await log.text() : `(log not available: ${log.status})`;
          out.push(`--- ${job.name} (${job.conclusion}), last lines:`, text.split('\n').slice(-120).join('\n'));
        }
      }
      // Uploaded screenshots and builds, unpacked into the task.
      const arts = await api(`/actions/runs/${run.id}/artifacts?per_page=20`);
      for (const a of arts.ok ? ((await arts.json()) as { artifacts: Array<{ id: number; name: string; size_in_bytes: number; archive_download_url: string }> }).artifacts : []) {
        if (a.size_in_bytes > 100 * 1024 * 1024 || !login) {
          out.push(`artifact ${a.name}: ${login ? 'over 100 MB, not downloaded' : 'downloading needs a GitHub login on this computer'}`);
          continue;
        }
        const zip = await ws.fetchApi(a.archive_download_url, { signal: o.signal, headers: { Authorization: `Bearer ${login.password}`, 'User-Agent': 'sfagents' } });
        if (!zip.ok) continue;
        const rel = `.sfa-ci/${run.id}/${a.name.replace(/[^\w.-]+/g, '_')}/artifact.zip`;
        await ws.writeFile(t.repo, t.task, rel, Buffer.from(await zip.arrayBuffer()), true);
        out.push(`artifact ${a.name}: unpacked in ${rel.replace(/\/artifact\.zip$/, '')}`);
      }
    }
    return { ok: true, text: out.join('\n') };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}
