import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  loadAgentTree,
  ToolErrorType,
  type AnyDeclarativeTool,
  type ToolResult,
} from '@sfagents/core';
import { baseAgent, makeTempDir, writeJson } from './helpers.js';

const isWin = process.platform === 'win32';

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
  writeJson(path.join(dir, 'agent.json'), baseAgent('main', { workspace: { roots: ['work'] }, tools: { allow }, limits }));
  const tree = loadAgentTree(path.join(dir, 'agent.json'));
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

describe('filesystem isolation', () => {
  test('read_file inside the root works with relative and absolute paths', async () => {
    const f = await fixture(['read_file']);
    const rel = await call(f, 'read_file', { file_path: 'src/a.txt' });
    assert.equal(rel.permission, 'allow');
    assert.match(rel.result!.llmContent, /alpha\nbeta\ngamma/);
    const abs = await call(f, 'read_file', { file_path: path.join(f.work, 'src', 'a.txt'), offset: 1, limit: 1 });
    assert.match(abs.result!.llmContent, /Showing lines 2-2 of 4[\s\S]*beta/);
  });

  test('paths outside the roots are rejected (absolute, .., config dir)', async () => {
    const f = await fixture(['read_file', 'list_directory', 'glob', 'grep', 'write_file']);
    for (const p of [path.join(f.outside, 'secret.txt'), '../../' + path.relative(path.dirname(path.dirname(f.work)), path.join(f.outside, 'secret.txt')), '../agent.json']) {
      const r = await call(f, 'read_file', { file_path: p });
      assert.equal(r.permission, 'deny', `read ${p}`);
      assert.match(r.reason!, /outside this agent's permitted workspace roots/);
      assert.equal(r.result!.error?.type, ToolErrorType.PATH_NOT_IN_WORKSPACE, 'execute re-checks too');
    }
    assert.equal((await call(f, 'list_directory', { path: f.outside })).permission, 'deny');
    assert.equal((await call(f, 'glob', { pattern: '*', path: f.outside })).permission, 'deny');
    assert.equal((await call(f, 'grep', { pattern: 'beta', path: f.outside })).permission, 'deny');
    const w = await call(f, 'write_file', { file_path: path.join(f.outside, 'x.txt'), content: 'x' });
    assert.equal(w.permission, 'deny');
    assert.equal(fs.existsSync(path.join(f.outside, 'x.txt')), false);
  });

  test('symlinks that escape the root are rejected', { skip: isWin }, async () => {
    const f = await fixture(['read_file', 'write_file', 'glob', 'grep', 'list_directory']);
    fs.symlinkSync(path.join(f.outside, 'secret.txt'), path.join(f.work, 'link.txt'));
    fs.symlinkSync(f.outside, path.join(f.work, 'linkdir'));
    fs.symlinkSync(path.join(f.outside, 'missing-target.txt'), path.join(f.work, 'dangling.txt'));
    assert.equal((await call(f, 'read_file', { file_path: 'link.txt' })).permission, 'deny');
    assert.equal((await call(f, 'read_file', { file_path: 'linkdir/secret.txt' })).permission, 'deny');
    const viaDangling = await call(f, 'write_file', { file_path: 'dangling.txt', content: 'pwned' });
    assert.equal(viaDangling.permission, 'deny');
    assert.equal(fs.existsSync(path.join(f.outside, 'missing-target.txt')), false);
    const newUnderLink = await call(f, 'write_file', { file_path: 'linkdir/new.txt', content: 'x' });
    assert.equal(newUnderLink.permission, 'deny');
    // Search tools silently skip escaping entries instead of reading through them.
    const g = await call(f, 'glob', { pattern: '**/*.txt' });
    assert.doesNotMatch(g.result!.llmContent, /secret|link\.txt/);
    const gr = await call(f, 'grep', { pattern: 'TOP SECRET' });
    assert.match(gr.result!.llmContent, /No matches/);
  });

  test('agent and MCP configuration files are write-protected', async () => {
    const dir = makeTempDir();
    writeJson(path.join(dir, 'agent.json'), baseAgent('main', { tools: { allow: ['write_file', 'edit', 'read_file'] } }));
    const tree = loadAgentTree(path.join(dir, 'agent.json'));
    const runtime = new AgentRuntime({ tree, providerFactory: () => { throw new Error('unused'); } });
    const tools = await runtime.buildTools(tree.root, ['main'], () => {});
    const f: Fixture = { dir, work: dir, outside: dir, tools };
    assert.equal((await call(f, 'read_file', { file_path: 'agent.json' })).permission, 'allow');
    const w = await call(f, 'write_file', { file_path: 'agent.json', content: '{}' });
    assert.equal(w.permission, 'deny');
    assert.match(w.reason!, /protected SF Agents configuration file/);
    assert.equal((await call(f, 'write_file', { file_path: 'mcp.json', content: '{}' })).permission, 'deny');
    assert.equal((await call(f, 'edit', { file_path: 'agent.json', old_string: 'main', new_string: 'x' })).permission, 'deny');
  });

  test('the configuration .env (API keys) is invisible to every file tool', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-supersecret\n');
    writeJson(path.join(dir, 'agent.json'), baseAgent('main', { tools: { allow: ['read_file', 'write_file', 'grep', 'glob', 'list_directory'] } }));
    const tree = loadAgentTree(path.join(dir, 'agent.json'));
    const runtime = new AgentRuntime({ tree, providerFactory: () => { throw new Error('unused'); } });
    const tools = await runtime.buildTools(tree.root, ['main'], () => {});
    const f: Fixture = { dir, work: dir, outside: dir, tools };
    const r = await call(f, 'read_file', { file_path: '.env' });
    assert.equal(r.permission, 'deny');
    assert.match(r.reason!, /credentials/);
    assert.equal((await call(f, 'write_file', { file_path: '.env', content: 'x' })).permission, 'deny');
    for (const js of ['0', '1']) {
      process.env['SFAGENTS_GREP_JS'] = js;
      try {
        const g = await call(f, 'grep', { pattern: 'supersecret' });
        assert.match(g.result!.llmContent, /No matches/, `grep strategy js=${js}`);
      } finally {
        delete process.env['SFAGENTS_GREP_JS'];
      }
    }
    const gl = await call(f, 'glob', { pattern: '**/.env' });
    assert.match(gl.result!.llmContent, /No files found/);
    if (!isWin) {
      fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));
      assert.equal((await call(f, 'read_file', { file_path: 'innocent.txt' })).permission, 'deny', 'symlink to .env');
    }
  });
});

describe('file tools', () => {
  test('write_file creates parent directories and asks for permission', async () => {
    const f = await fixture(['write_file']);
    const r = await call(f, 'write_file', { file_path: 'new/dir/file.txt', content: 'hello\n' });
    assert.equal(r.permission, 'ask');
    assert.equal(fs.readFileSync(path.join(f.work, 'new', 'dir', 'file.txt'), 'utf8'), 'hello\n');
  });

  test('write_file preserves CRLF and BOM of an existing file', async () => {
    const f = await fixture(['write_file']);
    fs.writeFileSync(path.join(f.work, 'crlf.txt'), '﻿one\r\ntwo\r\n');
    await call(f, 'write_file', { file_path: 'crlf.txt', content: 'three\nfour\n' });
    assert.equal(fs.readFileSync(path.join(f.work, 'crlf.txt'), 'utf8'), '﻿three\r\nfour\r\n');
  });

  test('edit: unique replacement, multiple matches, not found, create, no change', async () => {
    const f = await fixture(['edit']);
    const ok = await call(f, 'edit', { file_path: 'src/a.txt', old_string: 'beta', new_string: 'BETA' });
    assert.equal(ok.permission, 'ask');
    assert.equal(ok.result!.error, undefined);
    assert.equal(fs.readFileSync(path.join(f.work, 'src', 'a.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');

    fs.writeFileSync(path.join(f.work, 'dup.txt'), 'x\nx\n');
    const dup = await call(f, 'edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'y' });
    assert.equal(dup.result!.error?.type, ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH);
    const all = await call(f, 'edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true });
    assert.equal(all.result!.error, undefined);
    assert.equal(fs.readFileSync(path.join(f.work, 'dup.txt'), 'utf8'), 'y\ny\n');

    const missing = await call(f, 'edit', { file_path: 'src/a.txt', old_string: 'zzz', new_string: 'q' });
    assert.equal(missing.result!.error?.type, ToolErrorType.EDIT_NO_OCCURRENCE_FOUND);
    const created = await call(f, 'edit', { file_path: 'created.txt', old_string: '', new_string: 'new file' });
    assert.equal(created.result!.error, undefined);
    assert.equal(fs.readFileSync(path.join(f.work, 'created.txt'), 'utf8'), 'new file');
    const exists = await call(f, 'edit', { file_path: 'created.txt', old_string: '', new_string: 'again' });
    assert.equal(exists.result!.error?.type, ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE);
    const same = await call(f, 'edit', { file_path: 'created.txt', old_string: 'new', new_string: 'new' });
    assert.equal(same.result!.error?.type, ToolErrorType.EDIT_NO_CHANGE);
    // Relaxed matching from upstream editHelper: smart quotes in old_string.
    fs.writeFileSync(path.join(f.work, 'q.txt'), 'say "hi"\n');
    const smart = await call(f, 'edit', { file_path: 'q.txt', old_string: 'say “hi”', new_string: 'say "bye"' });
    assert.equal(smart.result!.error, undefined);
    assert.equal(fs.readFileSync(path.join(f.work, 'q.txt'), 'utf8'), 'say "bye"\n');
  });

  test('glob, grep and list_directory return workspace results', async () => {
    const f = await fixture(['glob', 'grep', 'list_directory']);
    const g = await call(f, 'glob', { pattern: '**/*.ts' });
    assert.match(g.result!.llmContent, /Found 1 file/);
    assert.match(g.result!.llmContent, /b\.ts/);
    const gr = await call(f, 'grep', { pattern: 'beta', glob: '*.txt' });
    assert.match(gr.result!.llmContent, /Found 1 match/);
    assert.match(gr.result!.llmContent, /L2: beta/);
    const ls = await call(f, 'list_directory', {});
    assert.match(ls.result!.llmContent, /\[DIR\] src/);
    assert.throws(() => f.tools.get('glob')!.build({ pattern: path.join(f.outside, '*') }), /must be relative/);
    assert.throws(() => f.tools.get('grep')!.build({ pattern: '(' }), /Invalid regular expression/);
  });

  test('grep JavaScript strategy searches basename filters recursively and preserves path filters', async () => {
    const f = await fixture(['grep']);
    fs.writeFileSync(path.join(f.work, 'root.txt'), 'beta\n');
    fs.mkdirSync(path.join(f.work, 'src', 'deep'));
    fs.writeFileSync(path.join(f.work, 'src', 'deep', 'nested.txt'), 'beta\n');
    const previous = process.env['SFAGENTS_GREP_JS'];
    process.env['SFAGENTS_GREP_JS'] = '1';
    try {
      for (const glob of ['*.txt', '**/*.txt']) {
        const r = await call(f, 'grep', { pattern: 'beta', glob });
        assert.equal(r.result!.error, undefined);
        assert.match(r.result!.llmContent, /Found 3 matches/, glob);
        assert.match(r.result!.llmContent, /File: root\.txt/);
        assert.match(r.result!.llmContent, /File: src[\\/]a\.txt/);
        assert.match(r.result!.llmContent, /File: src[\\/]deep[\\/]nested\.txt/);
        assert.doesNotMatch(r.result!.llmContent, /b\.ts/);
      }
      const scoped = await call(f, 'grep', { pattern: 'beta', glob: 'src/*.txt' });
      assert.match(scoped.result!.llmContent, /Found 1 match/);
      assert.match(scoped.result!.llmContent, /File: src[\\/]a\.txt/);
      assert.doesNotMatch(scoped.result!.llmContent, /root\.txt|nested\.txt|b\.ts/);
    } finally {
      if (previous === undefined) delete process.env['SFAGENTS_GREP_JS'];
      else process.env['SFAGENTS_GREP_JS'] = previous;
    }
  });

  test('grep JavaScript strategy (used on Windows) matches and stays contained', async () => {
    const f = await fixture(['grep']);
    process.env['SFAGENTS_GREP_JS'] = '1';
    try {
      const gr = await call(f, 'grep', { pattern: 'BETA' });
      assert.match(gr.result!.llmContent, /Found 2 matches/);
      assert.match(gr.result!.llmContent, /L1: export const Beta = 2;/);
      if (!isWin) {
        fs.symlinkSync(path.join(f.outside, 'secret.txt'), path.join(f.work, 'leak.txt'));
        const leak = await call(f, 'grep', { pattern: 'TOP SECRET' });
        assert.match(leak.result!.llmContent, /No matches/);
      }
    } finally {
      delete process.env['SFAGENTS_GREP_JS'];
    }
  });

  test('read_file reports binary files and missing files', async () => {
    const f = await fixture(['read_file']);
    fs.writeFileSync(path.join(f.work, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    assert.match((await call(f, 'read_file', { file_path: 'bin.dat' })).result!.llmContent, /binary file/);
    assert.equal((await call(f, 'read_file', { file_path: 'nope.txt' })).result!.error?.type, ToolErrorType.FILE_NOT_FOUND);
  });

  test('schema validation rejects bad arguments', async () => {
    const f = await fixture(['read_file']);
    assert.throws(() => f.tools.get('read_file')!.build({}), /must have required property 'file_path'/);
  });
});

describe('shell', () => {
  test('runs an allowed command, reports exit codes and asks for approval', async () => {
    const f = await fixture(['shell']);
    const ok = await call(f, 'shell', { command: isWin ? 'echo hello' : 'echo hello && pwd' });
    assert.equal(ok.permission, 'ask');
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
