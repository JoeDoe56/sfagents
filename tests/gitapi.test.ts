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
