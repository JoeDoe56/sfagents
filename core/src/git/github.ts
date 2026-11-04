import { GitError, githubRepo, type GitWorkspaces } from './workspaces.js';

/** Credentials stay in the host process. Never follow redirects with an Authorization header. */
export async function githubApi(ws: GitWorkspaces, repo: string, endpoint: string, signal: AbortSignal, init: RequestInit = {}): Promise<any> {
  const gh = githubRepo(ws.repo(repo).url);
  if (!gh) throw new GitError('Pull requests work with GitHub repositories only.');
  const login = await ws.login(repo);
  const r = await ws.fetchApi(`https://api.github.com/repos/${gh.owner}/${gh.name}${endpoint}`, {
    ...init, signal, redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sfagents', 'Content-Type': 'application/json', ...(login ? { Authorization: `Bearer ${login.password}` } : {}) },
  });
  if (!r.ok) throw new GitError(`GitHub answered ${r.status} for ${endpoint.split('?')[0]}.`);
  return r.status === 204 ? undefined : r.json();
}

export class GitHubPullRequests {
  constructor(readonly ws: GitWorkspaces, readonly enabled: () => boolean) {}

  private check(): void {
    if (!this.enabled()) throw new GitError('Turn on Pull Requests in Settings first.');
  }

  async open(repo: string, task: string, approve: (q: string) => Promise<boolean>, signal: AbortSignal): Promise<string> {
    this.check();
    const r = this.ws.repo(repo);
    if (!githubRepo(r.url)) throw new GitError('Pull requests work with GitHub repositories only.');
    await this.ws.push(repo, task, { toMain: false, approve });
    const head = `sfagents/${task}`;
    const gh = githubRepo(r.url)!;
    const found = await githubApi(this.ws, repo, `/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${head}`)}`, signal);
    const draft = await this.ws.draftMessage(repo, task);
    const pr = found[0] ?? await githubApi(this.ws, repo, '/pulls', signal, {
      method: 'POST', body: JSON.stringify({ title: draft.split('\n')[0] || task, body: draft, head, base: r.defaultBranch, draft: true }),
    });
    this.ws.setTaskMetadata(repo, task, { pr: { number: pr.number, url: pr.html_url, state: pr.state, sha: pr.head.sha, checks: 'pending', comments: '', updated: new Date().toISOString() } });
    await this.refresh(repo, task, signal);
    return pr.html_url;
  }

  async refresh(repo: string, task: string, signal: AbortSignal): Promise<string> {
    this.check();
    const saved = this.ws.taskMetadata(repo, task).pr;
    if (!saved) throw new GitError('Open a draft pull request for this task first.');
    const pr = await githubApi(this.ws, repo, `/pulls/${saved.number}`, signal);
    const checks = await githubApi(this.ws, repo, `/commits/${pr.head.sha}/check-runs?per_page=100`, signal);
    const statuses = await githubApi(this.ws, repo, `/commits/${pr.head.sha}/status`, signal);
    const all: any[] = checks.check_runs ?? [];
    const state = all.some((c) => c.status === 'completed' && !['success', 'skipped', 'neutral'].includes(c.conclusion)) || ['failure', 'error'].includes(statuses.state)
      ? 'fail' : all.some((c) => c.status !== 'completed') || (statuses.total_count > 0 && statuses.state === 'pending') ? 'pending' : all.length || statuses.total_count > 0 ? 'pass' : 'none';
    const pages = async (endpoint: string) => {
      const rows: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const next = await githubApi(this.ws, repo, `${endpoint}?per_page=100&page=${page}`, signal);
        rows.push(...next);
        if (next.length < 100) break;
      }
      return rows;
    };
    const comments = [...await pages(`/pulls/${saved.number}/comments`), ...await pages(`/issues/${saved.number}/comments`), ...await pages(`/pulls/${saved.number}/reviews`)]
      .filter((c) => c.body?.trim()).sort((a, b) => String(a.created_at ?? a.submitted_at).localeCompare(String(b.created_at ?? b.submitted_at)))
      .map((c) => `${c.user?.login ?? 'Reviewer'}${c.path ? ` (${c.path}:${c.line ?? c.original_line ?? ''})` : ''}: ${c.body}`).join('\n\n').slice(-60_000);
    this.ws.setTaskMetadata(repo, task, { pr: { ...saved, state: pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state, sha: pr.head.sha, checks: state, comments, updated: new Date().toISOString() } });
    return `PR #${saved.number}: ${pr.merged ? 'merged' : pr.state}; checks ${state}\n${comments || 'No review comments.'}`;
  }

  /** Called only by the person's Merge click; GitHub checks the reviewed SHA atomically. */
  async merge(repo: string, task: string, sha: string, signal: AbortSignal): Promise<string> {
    this.check();
    const pr = this.ws.taskMetadata(repo, task).pr;
    if (!pr || pr.sha !== sha) throw new GitError('The pull request changed. Refresh it and review the latest head before merging.');
    const current = await githubApi(this.ws, repo, `/pulls/${pr.number}`, signal);
    if (current.head.sha !== sha) throw new GitError('The pull request head changed. Refresh before merging.');
    if (current.draft) {
      const login = await this.ws.login(repo);
      if (!login) throw new GitError('Marking a draft ready needs a GitHub login.');
      const response = await this.ws.fetchApi('https://api.github.com/graphql', { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${login.password}`, 'Content-Type': 'application/json', 'User-Agent': 'sfagents' },
        body: JSON.stringify({ query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}', variables: { id: current.node_id } }) });
      const data = await response.json() as { errors?: unknown[] };
      if (!response.ok || data.errors?.length) throw new GitError('GitHub refused to mark the draft ready for review.');
    }
    const result = await githubApi(this.ws, repo, `/pulls/${pr.number}/merge`, signal, { method: 'PUT', body: JSON.stringify({ sha, merge_method: 'squash' }) });
    if (!result.merged) throw new GitError(result.message || 'GitHub refused the merge.');
    await this.refresh(repo, task, signal);
    return result.message;
  }
}
