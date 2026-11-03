import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AgentRuntime,
  CHECKPOINT_PREFIX,
  GitWorkspaces,
  containerManager,
  hostWorkspacesDir,
  loadAgentTree,
  parsePatch,
  runGitCommand,
  taskOfPath,
  type AnyDeclarativeTool,
  type ToolResult,
} from '@sfagents/core';
import { baseAgent, makeTempDir, NO_CONTAINER_TESTS, writeAgent } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('taskOfPath finds the task in a container path', () => {
  assert.deepEqual(taskOfPath('/workspaces/demo/fix-x'), { repo: 'demo', task: 'fix-x' });
  assert.deepEqual(taskOfPath('/workspaces/demo/fix-x/src/a'), { repo: 'demo', task: 'fix-x' });
  assert.equal(taskOfPath('/workspaces/demo'), undefined);
  assert.equal(taskOfPath('/workspaces/demo/.repo'), undefined);
  assert.equal(taskOfPath('/roots/x'), undefined);
});

test('parsePatch splits files and hunks', () => {
  const files = parsePatch(['diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+two', '@@ -9 +9,2 @@', ' x', '+y', 'diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1 @@', '+new', ''].join('\n'));
  assert.equal(files.length, 2);
  assert.equal(files[0]!.path, 'a.txt');
  assert.equal(files[0]!.hunks.length, 2);
  assert.equal(files[1]!.status, 'added');
});

describe('Git workspaces (in the Git helper container)', { skip: NO_CONTAINER_TESTS }, () => {
  const name = `demo${process.pid}${Date.now() % 100000}`;
  const url = `https://example.test/${name}.git`;
  let origin: string;
  let ws: GitWorkspaces;
  let host: (p: string) => string;
  const runtimes: AgentRuntime[] = [];

  before(() => {
    const dir = makeTempDir();
    // The remote: a bare repository here, reached as https://example.test/… by insteadOf.
    origin = path.join(dir, 'origin.git');
    const seed = path.join(dir, 'seed');
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(seed, 'a.txt'), 'one\ntwo\nthree\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'first');
    git(dir, 'clone', '-q', '--bare', seed, origin);
    const mapping = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`, GIT_CONFIG_VALUE_0: url };
    ws = new GitWorkspaces({
      run: (script, o) => containerManager().runGit(script, { ...o, env: { ...o.env, ...mapping } }),
      credential: async () => undefined,
      identity: () => ({ GIT_AUTHOR_NAME: 'Person', GIT_AUTHOR_EMAIL: 'p@example.test', GIT_COMMITTER_NAME: 'Person', GIT_COMMITTER_EMAIL: 'p@example.test' }),
      file: path.join(dir, 'workspaces.json'),
    });
    host = (p) => path.join(hostWorkspacesDir(), name, p);
  });
  after(async () => {
    await Promise.all(runtimes.map((r) => r.dispose()));
  });

  test('clone, task, checkpoint, review, reject, squash, push to main', async () => {
    const r = await ws.clone(url, name);
    assert.equal(r.defaultBranch, 'main');
    const t = await ws.task(name, 'fix-a', 'main', true);
    assert.equal(t.created, true);
    assert.equal(t.path, `/workspaces/${name}/fix-a`);
    assert.equal(fs.readFileSync(host('fix-a/a.txt'), 'utf8'), 'one\ntwo\nthree\n');

    // A run changes two files; SF Agents commits the task after it.
    fs.writeFileSync(host('fix-a/a.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(host('fix-a/b.txt'), 'new\n');
    await ws.checkpointAgent('main', 'make two loud');
    let [info] = await ws.list();
    assert.equal(info!.branch, 'sfagents/fix-a');
    assert.equal(info!.checkpoints, 1);
    assert.equal(info!.changed, 2);
    assert.equal(info!.ahead, 1);
    assert.equal(info!.dirty, false);

    // Review: both files; rejecting b.txt's hunk takes it back out.
    let review = await ws.review(name, 'fix-a');
    assert.deepEqual(review.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
    assert.equal(review.message, 'Make two loud');
    await ws.rejectHunk(name, 'fix-a', 'b.txt', 0);
    assert.equal(fs.existsSync(host('fix-a/b.txt')), false);
    review = await ws.review(name, 'fix-a');
    assert.deepEqual(review.files.map((f) => f.path), ['a.txt']);

    // Pushing to main needs the checkpoints squashed first.
    await assert.rejects(ws.push(name, 'fix-a', { toMain: true, approve: async () => true }), /checkpoints/);
    await ws.finish(name, 'fix-a', 'Make two loud');
    [info] = await ws.list();
    assert.equal(info!.checkpoints, 0);
    assert.equal(info!.ahead, 1);
    assert.match(await ws.push(name, 'fix-a', { toMain: true, approve: async () => true }), /Pushed to main/);
    assert.equal(git(origin, 'log', '-1', '--format=%s %an', 'main'), 'Make two loud Person');
  });

  test('undo takes the last run back out; workflow changes need approval', async () => {
    await ws.task(name, 'undo-me', 'helper', true);
    fs.writeFileSync(host('undo-me/a.txt'), 'changed\n');
    assert.equal(await ws.checkpoint(name, 'undo-me', 'break a.txt'), true);
    assert.match(await ws.undo(name, 'undo-me'), /break a\.txt/);
    assert.equal(fs.readFileSync(host('undo-me/a.txt'), 'utf8'), 'one\nTWO\nthree\n');
    await assert.rejects(ws.undo(name, 'undo-me'), /no run to undo/);

    fs.mkdirSync(host('undo-me/.github/workflows'), { recursive: true });
    fs.writeFileSync(host('undo-me/.github/workflows/ci.yml'), 'on: push\n');
    let asked = '';
    await assert.rejects(ws.push(name, 'undo-me', { toMain: false, approve: async (q) => ((asked = q), false) }), /approval/);
    assert.match(asked, /ci\.yml/);
    assert.match(await ws.push(name, 'undo-me', { toMain: false, approve: async () => true }), /sfagents\/undo-me/);
    assert.match(git(origin, 'log', '-1', '--format=%s', 'sfagents/undo-me'), new RegExp(`^${CHECKPOINT_PREFIX}`));
  });

  test('update from main rebases the task', async () => {
    await ws.task(name, 'later', 'main', true);
    // main moves on (another task pushed); the task catches up.
    await ws.task(name, 'mover', 'main', true);
    fs.writeFileSync(host('mover/c.txt'), 'c\n');
    await ws.checkpoint(name, 'mover', 'add c');
    await ws.finish(name, 'mover', 'Add c');
    await ws.push(name, 'mover', { toMain: true, approve: async () => false });
    let info = (await ws.list()).find((w) => w.task === 'later')!;
    assert.equal(fs.existsSync(host('later/c.txt')), false);
    assert.match(await ws.update(name, 'later'), /Up to date/);
    info = (await ws.list()).find((w) => w.task === 'later')!;
    assert.equal(info.behind, 0);
    assert.equal(fs.existsSync(host('later/c.txt')), true);
  });

  test('sfa-git in the agent’s shell works in the task it is in, and network level decides what reaches remotes', async () => {
    // The stand-in for Docker maps only the starting folder, so the folder is the shell's `directory`.
    const shell = async (network: string, command: string, directory?: string) => {
      const dir = makeTempDir();
      writeAgent(dir, baseAgent('main', { network }));
      const tree = loadAgentTree(dir);
      const runtime = new AgentRuntime({ tree, providerFactory: () => { throw new Error('unused'); }, git: ws });
      runtimes.push(runtime);
      const tools: Map<string, AnyDeclarativeTool> = await runtime.buildTools(tree.root, ['main'], () => {});
      const r: ToolResult = await tools.get('shell')!.build({ command, ...(directory ? { directory } : {}) }).execute(new AbortController().signal);
      return r.llmContent;
    };
    assert.match(await shell('off', 'sfa-git tasks', `/workspaces/${name}/later`), /sfagents\/later/);
    assert.match(await shell('off', 'sfa-git push', `/workspaces/${name}/later`), /network level "git"/);
    assert.match(await shell('off', 'sfa-git undo'), /inside a task folder/);
    fs.writeFileSync(host('later/d.txt'), 'd\n');
    await ws.checkpoint(name, 'later', 'add d');
    assert.match(await shell('git', 'sfa-git undo', `/workspaces/${name}/later/`), /add d/);
    assert.match(await shell('git', 'sfa-git push --force', `/workspaces/${name}/later`), /never force-pushes/);
  });
});
