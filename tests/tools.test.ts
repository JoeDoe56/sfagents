import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  AgentRuntime,
  detectSandbox,
  loadAgentTree,
  ToolErrorType,
  type AnyDeclarativeTool,
  type ToolResult,
} from '@sfagents/core';
import { baseAgent, makeTempDir, writeJson, writeAgent } from './helpers.js';

const isWin = process.platform === 'win32';
const sandboxed = (await detectSandbox()).ok;

interface Fixture {
  dir: string;
  work: string;
  outside: string;
  tools: Map<string, AnyDeclarativeTool>;
}

async function fixture(allow: string[], limits: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = makeTempDir();
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'a.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(work, 'src', 'b.ts'), 'export const Beta = 2;\n');
  const outside = makeTempDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET beta\n');
  writeAgent(dir, baseAgent('main', { workspace: { roots: ['work'] }, tools: { allow }, limits }));
  const tree = loadAgentTree(dir);
  const runtime = new AgentRuntime({ tree, providerFactory: () => { throw new Error('unused'); } });
  const tools = await runtime.buildTools(tree.root, ['main'], () => {});
  return { dir, work, outside, tools };
}

/** Runs a tool the way the executor does: build → permission → execute. */
async function call(f: Fixture, name: string, args: Record<string, unknown>): Promise<{ permission: string; result?: ToolResult; reason?: string }> {
  const tool = f.tools.get(name);
  assert.ok(tool, `tool ${name} registered`);
  const invocation = tool.build(args);
  const permission = await invocation.getDefaultPermission();
  const signal = new AbortController().signal;
  if (permission === 'deny') return { permission, reason: invocation.getDenialReason?.(), result: await invocation.execute(signal) };
  return { permission, result: await invocation.execute(signal) };
}

describe('removed file tools', () => {
  test('old agent files still load: the file tools become shell, read-only when none of them could write', async () => {
    const ro = await fixture(['read_file', 'glob', 'grep', 'list_directory']);
    assert.deepEqual([...ro.tools.keys()], ['shell']);
    const rw = await fixture(['read_file', 'edit']);
    assert.deepEqual([...rw.tools.keys()], ['shell']);
    const tree = loadAgentTree(ro.dir);
    assert.ok(tree.warnings.some((w) => /read_file, glob, grep, list_directory were replaced by shell.*read-only/.test(w)), tree.warnings.join('\n'));
    assert.deepEqual(tree.root.access.map((r) => r.access), ['read']);
    assert.deepEqual(loadAgentTree(rw.dir).root.access, []);
    if (!sandboxed) return;
    const denied = await call(ro, 'shell', { command: isWin ? 'type src\\a.txt && echo x>src\\a.txt' : 'cat src/a.txt && echo x > src/a.txt' });
    assert.match(denied.result!.llmContent, /alpha/);
    assert.equal(fs.readFileSync(path.join(ro.work, 'src', 'a.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
    await call(rw, 'shell', { command: isWin ? 'echo changed>src\\a.txt' : 'echo changed > src/a.txt' });
    assert.equal(fs.readFileSync(path.join(rw.work, 'src', 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'changed\n');
  });

  test('auto-approval entries for removed tools are ignored', async () => {
    const dir = makeTempDir();
    writeAgent(dir, baseAgent('main', { tools: { allow: ['write_file'], autoApprove: ['write_file'] } }));
    assert.deepEqual(loadAgentTree(dir).root.definition.tools?.autoApprove, []);
  });

  test('schema validation rejects bad arguments', async () => {
    const f = await fixture(['shell']);
    assert.throws(() => f.tools.get('shell')!.build({}), /Command cannot be empty/);
    assert.throws(() => f.tools.get('shell')!.build({ job_action: 'restart' }), /job_action|must be equal to one of/);
  });
});

describe('shell', { skip: !sandboxed && 'no OS sandbox on this machine' }, () => {
  test('runs an allowed command in the sandbox without asking, and reports exit codes', async () => {
    const f = await fixture(['shell']);
    const ok = await call(f, 'shell', { command: isWin ? 'echo hello' : 'echo hello && pwd' });
    assert.equal(ok.permission, 'allow');
    assert.match(ok.result!.llmContent, /Stdout: hello/);
    assert.match(ok.result!.llmContent, /Exit Code: 0/);
    if (!isWin) assert.match(ok.result!.llmContent, new RegExp(f.work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const fail = await call(f, 'shell', { command: 'exit 3' });
    assert.match(fail.result!.llmContent, /Exit Code: 3/);
  });

  test('times out and kills long commands', async () => {
    const f = await fixture(['shell'], { shellTimeoutSeconds: 1 });
    const started = Date.now();
    const r = await call(f, 'shell', { command: isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30' });
    assert.equal(r.result!.error?.type, ToolErrorType.EXECUTION_TIMEOUT);
    assert.ok(Date.now() - started < 10_000);
  });

  test('runs a command in the background, reads its new output and stops it', async () => {
    const f = await fixture(['shell']);
    // Inline: Node cannot resolve a script file's path under the temp folder inside the Windows sandbox.
    const started = await call(f, 'shell', { command: `"${process.execPath}" -e "let n = 0; console.log('ready'); setInterval(() => console.log('tick ' + ++n), 200)"`, background: true, timeout_seconds: 2 });
    assert.equal(started.result!.error, undefined, started.result!.llmContent);
    const id = /Job: (job-\d+)/.exec(started.result!.llmContent)?.[1];
    assert.ok(id, started.result!.llmContent);
    assert.match(started.result!.llmContent, /State: running/);
    assert.match(started.result!.llmContent, /New output: ready/);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const output = await call(f, 'shell', { job_action: 'output', job_id: id });
    // Only output not read before.
    assert.match(output.result!.llmContent, /New output: tick \d+/);
    const list = await call(f, 'shell', { job_action: 'list' });
    assert.match(list.result!.llmContent, new RegExp(`Job: ${id}[\\s\\S]*State: running`));
    const stopped = await call(f, 'shell', { job_action: 'stop', job_id: id });
    assert.match(stopped.result!.llmContent, /State: exited \(stopped\)/);
    const done = await call(f, 'shell', { command: `"${process.execPath}" -e "console.log('quick')"`, background: true });
    assert.match(done.result!.llmContent, /State: exited with code 0[\s\S]*quick/);
  });

  test('edits files with apply_patch and a patch on stdin', async () => {
    const f = await fixture(['shell']);
    const patch = '*** Begin Patch\n*** Update File: src/a.txt\n@@\n alpha\n-beta\n+beta with "quotes" || pipes & ampersands\n*** Add File: src/c.txt\n+new file\n*** End Patch\n';
    const r = await call(f, 'shell', { command: 'apply_patch', stdin: patch });
    assert.equal(r.result!.error, undefined, r.result!.llmContent);
    assert.match(r.result!.llmContent, /M src\/a\.txt/);
    assert.equal(fs.readFileSync(path.join(f.work, 'src', 'a.txt'), 'utf8'), 'alpha\nbeta with "quotes" || pipes & ampersands\ngamma\n');
    assert.equal(fs.readFileSync(path.join(f.work, 'src', 'c.txt'), 'utf8'), 'new file\n');
  });

  test("commands get the person's Git name and email, so commits work in the empty home", async (t) => {
    const name = spawnSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).stdout?.trim();
    if (!name) return t.skip('no global Git user.name here');
    const f = await fixture(['shell']);
    const r = await call(f, 'shell', { command: isWin ? 'echo %GIT_AUTHOR_NAME%' : 'echo "$GIT_AUTHOR_NAME"' });
    assert.match(r.result!.llmContent, new RegExp(`Stdout: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('does not leak the provider API key into commands', async () => {
    const f = await fixture(['shell']);
    process.env['OPENROUTER_API_KEY'] = 'should-not-leak';
    try {
      const r = await call(f, 'shell', { command: isWin ? 'echo %OPENROUTER_API_KEY%' : 'echo "key=${OPENROUTER_API_KEY:-unset}"' });
      assert.doesNotMatch(r.result!.llmContent, /should-not-leak/);
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
    }
  });

  test('working directory outside the roots is denied', async () => {
    const f = await fixture(['shell']);
    assert.equal((await call(f, 'shell', { command: 'echo hi', directory: f.outside })).permission, 'deny');
  });
});
