import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepoLocks, RepoBusyError, repoStatus, fileDiff, history, commitDiff, compareBranch, branches, commitFiles, repoKey } from '@sfagents/web';
import { makeTempDir } from './helpers.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
const write = (dir: string, f: string, text: string | Buffer) => fs.writeFileSync(path.join(dir, f), text);

function repo(): string {
  const dir = makeTempDir('gitrepo-');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'a.txt', 'one\ntwo\n');
  write(dir, 'b.txt', 'b1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}

describe('git workspace repository layer', () => {
  test('status combines staged, unstaged, untracked, binary and renamed changes', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\ntwo\nthree\n');
    git(dir, 'add', 'a.txt');
    write(dir, 'a.txt', 'one\ntwo\nthree\nfour\n'); // staged and unstaged
    write(dir, 'new.txt', 'x\ny\n');
    write(dir, 'bin.dat', Buffer.from([0, 1, 2, 0]));
    git(dir, 'mv', 'b.txt', 'c.txt');
    const s = await repoStatus(dir);
    const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
    assert.equal(by['a.txt']!.added, 2);
    assert.equal(by['new.txt']!.kind, 'untracked');
    assert.equal(by['new.txt']!.added, 2);
    assert.equal(by['bin.dat']!.binary, true);
    assert.equal(by['bin.dat']!.added, null);
    assert.equal(by['c.txt']!.kind, 'renamed');
    assert.equal(by['c.txt']!.oldPath, 'b.txt');
    assert.equal(s.branch, 'main');
    assert.equal(s.upstream, '');
    assert.equal(s.ahead, null);
    const d = await fileDiff(dir, by['a.txt']!);
    assert.match(d.patch, /\+four/);
  });

  test('a staged change cancelled by a later edit is not listed with lines', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'changed\n');
    git(dir, 'add', 'a.txt');
    write(dir, 'a.txt', 'one\ntwo\n');
    const s = await repoStatus(dir);
    const f = s.files.find((x) => x.path === 'a.txt')!;
    assert.equal(f.index, 'M');
    assert.equal(f.added, 0);
  });

  test('commitFiles commits only the chosen files and keeps the rest', async () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\ntwo\nthree\n');
    write(dir, 'new.txt', 'n\n');
    const locks = new RepoLocks();
    await commitFiles(dir, locks, { paths: ['a.txt'], title: 'Add three', description: 'Because.' });
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'Add three');
    assert.equal(git(dir, 'log', '-1', '--format=%b'), 'Because.');
    assert.deepEqual((await repoStatus(dir)).files.map((f) => f.path), ['new.txt']);
    await assert.rejects(commitFiles(dir, locks, { paths: ['new.txt'], title: ' ' }), /title/);
    await assert.rejects(commitFiles(dir, locks, { paths: ['gone.txt'], title: 'x' }), /Changed since/);
  });

  test('the lock rejects operations while an agent works, per repository, across worktrees', async () => {
    const a = repo();
    const b = repo();
    const wt = path.join(makeTempDir('wt-'), 'w');
    git(a, 'worktree', 'add', '-q', '-b', 'side', wt);
    const locks = new RepoLocks();
    const keyA = await repoKey(a);
    assert.equal(await repoKey(wt), keyA);
    locks.setAgentBusy(keyA, 'main', true);
    write(wt, 'a.txt', 'edit\n');
    await assert.rejects(commitFiles(wt, locks, { paths: ['a.txt'], title: 'x' }), RepoBusyError);
    write(b, 'a.txt', 'edit\n');
    await commitFiles(b, locks, { paths: ['a.txt'], title: 'ok' });
    locks.setAgentBusy(keyA, 'main', false);
    await commitFiles(wt, locks, { paths: ['a.txt'], title: 'now ok' });
  });

  test('an operation owns the repository until it finishes, even when it fails', async () => {
    const locks = new RepoLocks();
    let release: () => void = () => {};
    const first = locks.run('k', 'Push', () => new Promise<void>((r) => (release = r)));
    assert.equal(locks.agentMayStart('k'), false);
    await assert.rejects(locks.run('k', 'Pull', async () => {}), RepoBusyError);
    release();
    await first;
    await assert.rejects(locks.run('k', 'Pull', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(locks.agentMayStart('k'), true);
  });

  test('history marks pushed state, ranges are net diffs, compare uses the merge base', async () => {
    const dir = repo();
    const remote = makeTempDir('remote-');
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'a.txt', 'one\ntwo\nthree\n');
    git(dir, 'commit', '-qam', 'add three');
    write(dir, 'a.txt', 'one\ntwo\nthree\nfour\n');
    git(dir, 'commit', '-qam', 'add four');
    const h = await history(dir);
    assert.equal(h[0]!.pushed, null); // feature has no upstream
    git(dir, 'push', '-q', '-u', 'origin', 'feature');
    write(dir, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n');
    git(dir, 'commit', '-qam', 'add five');
    const h2 = await history(dir);
    assert.deepEqual(h2.map((c) => c.pushed), [false, true, true, true]);
    assert.equal((await repoStatus(dir)).ahead, 1);
    const range = await commitDiff(dir, h2[0]!.id, h2[1]!.id);
    assert.equal(range.files[0]!.added, 2); // net of both commits
    const cmp = await compareBranch(dir, 'main');
    assert.equal(cmp.commits.length, 3);
    assert.equal(cmp.files[0]!.added, 3);
  });

  test('branches lists local and remote and flags worktree checkouts', async () => {
    const dir = repo();
    const wt = path.join(makeTempDir('wt-'), 'w');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
    const list = await branches(dir);
    assert.equal(list.find((b) => b.name === 'main')!.current, true);
    assert.equal(list.find((b) => b.name === 'side')!.worktree, wt);
  });
});
