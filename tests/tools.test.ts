import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    assert.throws(() => f.tools.get('shell')!.build({}), /must have required property 'command'/);
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
