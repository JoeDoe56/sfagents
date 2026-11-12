import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  cleanCommandOutput,
  AgentRuntime,
  hostWorkspacesDir,
  loadAgentTree,
  ToolErrorType,
  type AnyDeclarativeTool,
  type ToolResult,
} from '@sfagents/core';
import { baseAgent, makeTempDir, NO_CONTAINER_TESTS, writeJson, writeAgent } from './helpers.js';

const isWin = process.platform === 'win32';

interface Fixture {
  dir: string;
  work: string;
  outside: string;
  tools: Map<string, AnyDeclarativeTool>;
}

/** An agent whose test folder is a folder in /workspaces (commands run there with `directory`). */
async function fixture(limits: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = makeTempDir();
  fs.mkdirSync(hostWorkspacesDir(), { recursive: true });
  const work = fs.mkdtempSync(path.join(hostWorkspacesDir(), 'tools-'));
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'a.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(work, 'src', 'b.ts'), 'export const Beta = 2;\n');
  const outside = makeTempDir();
  writeAgent(dir, baseAgent('main', { limits }));
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

test('command output: progress redraws keep what stayed, repeated lines collapse, code is untouched', () => {
  const raw = 'Downloading 10%\rDownloading 50%\rDownloading 100%\n\x1b[32mok\x1b[0m\nwarn x\nwarn x\nwarn x\nwarn x\nsame\nsame\n  indented(code) {\n';
  assert.equal(cleanCommandOutput(raw), 'Downloading 100%\nok\nwarn x\n[the line above repeated 3 more times]\nsame\nsame\n  indented(code) {');
  assert.equal(cleanCommandOutput('a\r\nb\r\n'), 'a\nb');
});

describe('shell tool', () => {
  test('every agent has the shell; schema validation rejects bad arguments', async () => {
    const f = await fixture();
    assert.ok(f.tools.has('shell'));
    assert.throws(() => f.tools.get('shell')!.build({}), /Command cannot be empty/);
    assert.throws(() => f.tools.get('shell')!.build({ job_action: 'restart' }), /job_action|must be equal to one of/);
  });
});

describe('shell (in the agent container)', { skip: NO_CONTAINER_TESTS }, () => {
  test('runs a command in the container without asking, and reports exit codes', async () => {
    const f = await fixture();
    const ok = await call(f, 'shell', { command: 'echo hello && pwd', directory: path.basename(f.work) });
    assert.equal(ok.permission, 'allow');
    assert.match(ok.result!.llmContent, /Stdout: hello/);
    assert.match(ok.result!.llmContent, /Exit Code: 0/);
    assert.match(ok.result!.llmContent, /Directory: \/workspaces\/tools-/);
    const fail = await call(f, 'shell', { command: 'exit 3' });
    assert.match(fail.result!.llmContent, /Exit Code: 3/);
  });

  test('times out and kills long commands', async () => {
    const f = await fixture({ shellTimeoutSeconds: 1 });
    const started = Date.now();
    const r = await call(f, 'shell', { command: isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30' });
    assert.equal(r.result!.error?.type, ToolErrorType.EXECUTION_TIMEOUT);
    assert.ok(Date.now() - started < 10_000);
  });

  test('runs a command in the background, reads its new output and stops it', async () => {
    const f = await fixture();
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

  test('edits files with sfa-patch (apply_patch format) on stdin', async () => {
    const f = await fixture();
    const patch = '*** Begin Patch\n*** Update File: src/a.txt\n@@\n alpha\n-beta\n+beta with "quotes" || pipes & ampersands\n*** Add File: src/c.txt\n+new file\n*** End Patch\n';
    const r = await call(f, 'shell', { command: 'sfa-patch', stdin: patch, directory: path.basename(f.work) });
    assert.equal(r.result!.error, undefined, r.result!.llmContent);
    assert.match(r.result!.llmContent, /M src\/a\.txt/);
    assert.equal(fs.readFileSync(path.join(f.work, 'src', 'a.txt'), 'utf8'), 'alpha\nbeta with "quotes" || pipes & ampersands\ngamma\n');
    assert.equal(fs.readFileSync(path.join(f.work, 'src', 'c.txt'), 'utf8'), 'new file\n');
  });

  test("commands get the person's Git name and email, so commits work in the empty home", async (t) => {
    const name = spawnSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).stdout?.trim();
    if (!name) return t.skip('no global Git user.name here');
    const f = await fixture();
    const r = await call(f, 'shell', { command: isWin ? 'echo %GIT_AUTHOR_NAME%' : 'echo "$GIT_AUTHOR_NAME"' });
    assert.match(r.result!.llmContent, new RegExp(`Stdout: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('does not leak the provider API key into commands', async () => {
    const f = await fixture();
    process.env['OPENROUTER_API_KEY'] = 'should-not-leak';
    try {
      const r = await call(f, 'shell', { command: isWin ? 'echo %OPENROUTER_API_KEY%' : 'echo "key=${OPENROUTER_API_KEY:-unset}"' });
      assert.doesNotMatch(r.result!.llmContent, /should-not-leak/);
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
    }
  });

  test('a missing working folder is explained', async () => {
    const f = await fixture();
    const r = await call(f, 'shell', { command: 'echo hi', directory: 'no-such-folder' });
    assert.match(r.result!.llmContent, /does not exist in the container/);
  });
});
