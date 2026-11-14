import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitApi, RepoBusyError } from '@sfagents/web';
import { makeTempDir } from './helpers.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}

describe('git workspace API', () => {
  test('lists clean repositories once, with the agents that reach them', async () => {
    const root = makeTempDir('gitapi-');
    const a = makeRepo(root, 'alpha');
    makeRepo(root, 'beta');
    const api = new GitApi({ dirs: () => [root], agentFolders: () => ({ one: [a], two: [a, root] }) });
    const repos = await api.repos();
    assert.equal(repos.length, 2);
    const alpha = repos.find((r) => r.name === 'alpha')!;
    assert.equal(alpha.status, 'Clean');
    assert.deepEqual(alpha.agents.sort(), ['one', 'two']);
  });

  test('an agent working on one repository locks it and not another', async () => {
    const root = makeTempDir('gitapi-');
    const a = makeRepo(root, 'alpha');
    const b = makeRepo(root, 'beta');
    const api = new GitApi({ dirs: () => [root], agentFolders: () => ({ one: [root] }) });
    const repos = await api.repos();
    await api.agentTouched('one', JSON.stringify({ command: `cd ${a} && ls` }));
    fs.writeFileSync(path.join(a, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(b, 'a.txt'), 'changed\n');
    const idA = repos.find((r) => r.path === a)!.id;
    const idB = repos.find((r) => r.path === b)!.id;
    await assert.rejects(api.handle('POST', [idA, 'commit'], new URLSearchParams(), { paths: ['a.txt'], title: 'x' }), RepoBusyError);
    await api.handle('POST', [idB, 'commit'], new URLSearchParams(), { paths: ['a.txt'], title: 'x' });
    api.allDone();
    await api.handle('POST', [idA, 'commit'], new URLSearchParams(), { paths: ['a.txt'], title: 'x' });
    assert.equal(git(a, 'log', '--oneline').split('\n').length, 2);
  });
});

describe('git remotes and branches', () => {
  test('publish, push, fetch, pull and branch switching protect work', async () => {
    const root = makeTempDir('gitapi-');
    const bare = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const a = makeRepo(root, 'alpha');
    git(a, 'remote', 'add', 'origin', bare);
    const api = new GitApi({ dirs: () => [a], agentFolders: () => ({}) });
    const id = (await api.repos())[0]!.id;
    const call = (action: string, body: Record<string, unknown> = {}) => api.handle('POST', [id, action], new URLSearchParams(), body);
    await assert.rejects(call('push'), /no upstream/);
    await call('publish');
    fs.writeFileSync(path.join(a, 'a.txt'), 'two\n');
    git(a, 'commit', '-qam', 'second');
    await call('push');
    assert.equal(git(a, 'rev-parse', 'HEAD'), git(bare, 'rev-parse', 'main'));
    await call('fetch');
    await call('pull');
    fs.writeFileSync(path.join(a, 'a.txt'), 'dirty\n');
    await assert.rejects(call('checkout', { name: 'feature', create: true }), /uncommitted/);
    git(a, 'checkout', '-q', 'a.txt');
    await call('checkout', { name: 'feature', create: true });
    assert.equal(git(a, 'branch', '--show-current'), 'feature');
  });
});

describe('merge, undo, revert, init', () => {
  test('undo keeps content, revert adds a commit, merge conflicts are resolvable', async () => {
    const root = makeTempDir('gitapi-');
    const a = makeRepo(root, 'alpha');
    const api = new GitApi({ dirs: () => [a], agentFolders: () => ({}) });
    const id = (await api.repos())[0]!.id;
    const call = (action: string, body: Record<string, unknown> = {}) => api.handle('POST', [id, action], new URLSearchParams(), body) as Promise<any>;
    fs.writeFileSync(path.join(a, 'a.txt'), 'two\n');
    git(a, 'commit', '-qam', 'second', '-m', 'body text');
    const u = await call('undo');
    assert.equal(u.title, 'second');
    assert.equal(fs.readFileSync(path.join(a, 'a.txt'), 'utf8'), 'two\n');
    assert.match(git(a, 'status', '--porcelain'), /a.txt/);
    git(a, 'commit', '-qam', 'again');
    const n = git(a, 'rev-list', '--count', 'HEAD');
    await call('revert', { commit: 'HEAD' });
    assert.equal(Number(git(a, 'rev-list', '--count', 'HEAD')), Number(n) + 1);
    git(a, 'checkout', '-q', '-b', 'other');
    fs.writeFileSync(path.join(a, 'a.txt'), 'other\n');
    git(a, 'commit', '-qam', 'o');
    git(a, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(a, 'a.txt'), 'main\n');
    git(a, 'commit', '-qam', 'm');
    const m = await call('merge', { source: 'other' });
    assert.deepEqual(m.conflicts, ['a.txt']);
    fs.writeFileSync(path.join(a, 'a.txt'), 'both\n');
    await call('resolve', { path: 'a.txt' });
    await call('merge-finish', { action: 'continue' });
    assert.equal(git(a, 'status', '--porcelain'), '');
    const target = path.join(root, 'fresh');
    await api.handle('POST', ['init'], new URLSearchParams(), { path: target });
    assert.ok(fs.existsSync(path.join(target, '.git')));
  });
});

describe('discard', () => {
  test('restores tracked files, removes new ones, rejects stale paths', async () => {
    const root = makeTempDir('gitapi-');
    const a = makeRepo(root, 'alpha');
    const api = new GitApi({ dirs: () => [a], agentFolders: () => ({}) });
    const id = (await api.repos())[0]!.id;
    fs.writeFileSync(path.join(a, 'a.txt'), 'x\n');
    fs.writeFileSync(path.join(a, 'n.txt'), 'n\n');
    await api.handle('POST', [id, 'discard'], new URLSearchParams(), { paths: ['a.txt', 'n.txt'] });
    assert.equal(git(a, 'status', '--porcelain'), '');
    await assert.rejects(api.handle('POST', [id, 'discard'], new URLSearchParams(), { paths: ['a.txt'] }), /Changed since/);
  });
});
