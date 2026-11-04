import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GitHubPullRequests, GitWorkspaces } from '@sfagents/core';
import { makeTempDir } from './helpers.js';

test('Git helper commands disable repository hooks/fsmonitor and refuse embedded credentials', async () => {
  let env: Record<string, string> | undefined;
  const ws = new GitWorkspaces({ file: path.join(makeTempDir(), 'workspaces.json'), credential: async () => ({ username: 'u', password: 'memory-only' }), run: async (_script, o) => { env = o.env; return { code: 1, stdout: '', stderr: 'test stop' }; } });
  await assert.rejects(ws.clone('https://user:password@github.com/o/r.git'), /embedded credentials/);
  assert.equal(env, undefined);
  await assert.rejects(ws.clone('https://github.com/o/r.git'), /test stop/);
  const config = Object.fromEntries(Array.from({ length: Number(env!['GIT_CONFIG_COUNT']) }, (_, i) => [env![`GIT_CONFIG_KEY_${i}`], env![`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(config['core.hooksPath'], '/dev/null');
  assert.equal(config['core.fsmonitor'], 'false');
});

test('PRs default to disabled; enabled PRs persist checks/reviews and merge only the reviewed SHA', async () => {
  const file = path.join(makeTempDir(), 'workspaces.json');
  fs.writeFileSync(file, JSON.stringify({ repos: { demo: { name: 'demo', url: 'https://github.com/person/demo.git', defaultBranch: 'main' } }, tasks: { 'demo/fix': { repo: 'demo', task: 'fix', agent: 'main', created: '', used: '', pr: { number: 1, url: 'https://github.com/person/demo/pull/1', sha: 'old' } } } }));
  let merged = false;
  const calls: string[] = [];
  const ws = new GitWorkspaces({ file, run: async () => ({ code: 0, stdout: '', stderr: '' }), credential: async () => ({ username: 'u', password: 'never-persist-this' }), fetch: (async (url: any, init: any) => {
    const p = new URL(url).pathname; calls.push(p);
    assert.equal(init.redirect, 'error');
    let body: any;
    if (p.endsWith('/merge')) { assert.equal(JSON.parse(init.body).sha, 'new'); merged = true; body = { merged: true, message: 'Merged' }; }
    else if (p.endsWith('/pulls/1')) body = { state: merged ? 'closed' : 'open', merged, head: { sha: 'new' } };
    else if (p.endsWith('/check-runs')) body = { check_runs: [{ status: 'completed', conclusion: 'failure' }] };
    else if (p.endsWith('/status')) body = { state: 'success', total_count: 1 };
    else body = [{ body: 'Please fix the test.', user: { login: 'reviewer' }, path: 'a.ts', line: 3 }];
    return new Response(JSON.stringify(body));
  }) as typeof fetch });
  const disabled = new GitHubPullRequests(ws, () => false);
  await assert.rejects(disabled.refresh('demo', 'fix', new AbortController().signal), /Settings/);
  assert.equal(calls.length, 0);
  const prs = new GitHubPullRequests(ws, () => true);
  assert.match(await prs.refresh('demo', 'fix', new AbortController().signal), /reviewer \(a.ts:3\)/);
  assert.equal(ws.taskMetadata('demo', 'fix').pr?.checks, 'fail');
  await assert.rejects(prs.merge('demo', 'fix', 'old', new AbortController().signal), /changed/);
  assert.equal(merged, false);
  assert.equal(await prs.merge('demo', 'fix', 'new', new AbortController().signal), 'Merged');
  assert.equal(ws.taskMetadata('demo', 'fix').pr?.state, 'merged');
  ws.setTaskMetadata('demo', 'fix', { ci: { sha: 'new', state: 'fail', updated: '' } });
  assert.equal(new GitWorkspaces({ file, run: async () => ({ code: 0, stdout: '', stderr: '' }) }).taskMetadata('demo', 'fix').ci?.state, 'fail');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /never-persist-this/);
});
