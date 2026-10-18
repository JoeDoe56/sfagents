import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, runCli, startMockOpenAI, stdioServerConfig, writeJson, type MockChatHandler } from './helpers.js';

let mock: Awaited<ReturnType<typeof startMockOpenAI>>;
let handler: MockChatHandler = () => ({ text: 'unset' });

before(async () => {
  mock = await startMockOpenAI((body) => handler(body));
});
after(async () => {
  await mock.stop();
});

function lastTool(body: { messages: Array<Record<string, unknown>> }): string | undefined {
  const tools = body.messages.filter((m) => m['role'] === 'tool');
  return tools.length ? String(tools[tools.length - 1]!['content']) : undefined;
}

function project(agent: Record<string, unknown> = {}, extra: (dir: string) => void = () => {}) {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'work', 'hello.txt'), 'hello from the workspace\n');
  writeJson(path.join(dir, 'agent.json'), {
    id: 'main',
    provider: 'openai-compatible',
    providerOptions: { baseUrl: mock.baseUrl, apiKeyEnv: 'MOCK_API_KEY' },
    model: 'mock/model',
    systemPrompt: 'You are main.',
    workspace: { roots: ['work'] },
    ...agent,
  });
  // The key comes from an untracked .env next to agent.json.
  fs.writeFileSync(path.join(dir, '.env'), 'MOCK_API_KEY=test-key\n');
  extra(dir);
  return dir;
}

describe('sfagents CLI', () => {
  test('--help and --version', async () => {
    const help = await runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /sfagents start[\s\S]*sfagents run[\s\S]*agents validate[\s\S]*mcp list/);
    const version = await runCli(['--version']);
    assert.equal(version.stdout.trim(), '0.1.0');
  });

  test('agents validate prints the tree; invalid config exits 2 with file and field', async () => {
    const dir = project({ spawn: { children: ['agents/1-Subagent-Worker.json'] } }, (d) =>
      writeJson(path.join(d, 'agents', '1-Subagent-Worker.json'), {
        id: 'worker',
        provider: 'openai-compatible',
        providerOptions: { baseUrl: mock.baseUrl, apiKeyEnv: 'MOCK_API_KEY' },
        model: 'mock/model',
        systemPrompt: 'w',
      }),
    );
    const ok = await runCli(['agents', 'validate'], { cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^main/m);
    assert.match(ok.stdout, /└─ worker/);
    assert.match(ok.stdout, /2 agent definitions valid/);

    writeJson(path.join(dir, 'agents', '1-Subagent-Worker.json'), { id: 'worker', provider: 'openrouter', model: 'm', systemPrompt: 'w', tools: { allow: ['shell'] } });
    const bad = await runCli(['agents', 'validate', '--config', dir]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /agents[\\/]1-Subagent-Worker\.json \[tools\.allow\]: "shell" is only allowed on the root agent/);

    const missing = await runCli(['agents', 'validate'], { cwd: makeTempDir() });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No agent definition found/);
  });

  test('run: streams the answer to stdout and tool activity to stderr', async () => {
    handler = (body) =>
      lastTool(body) === undefined
        ? { toolCalls: [{ name: 'read_file', args: { file_path: 'hello.txt' } }] }
        : { text: `File contents: ${lastTool(body)!.trim()}` };
    const dir = project({ tools: { allow: ['read_file'] } });
    const r = await runCli(['run', 'read', 'hello.txt'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'File contents: hello from the workspace');
    assert.match(r.stderr, /⚙ read_file hello\.txt/);
    assert.match(r.stderr, /✓ Read 2 lines/);
    const lastRequest = mock.requests[mock.requests.length - 1] as { messages: Array<{ role: string; content: string }> };
    assert.equal(lastRequest.messages[1]!.content, 'read hello.txt');
  });

  test('run --json returns the structured result; a denied call in non-interactive mode is explained', async () => {
    handler = (body) =>
      lastTool(body) === undefined ? { toolCalls: [{ name: 'write_file', args: { file_path: 'out.txt', content: 'x' } }] } : { text: lastTool(body)! };
    const dir = project({ tools: { allow: ['write_file'] } });
    const r = await runCli(['run', '--json', 'write a file'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'GOAL');
    assert.equal(result.toolCalls[0].errorType, 'execution_denied');
    assert.match(result.text, /no approval is possible in this non-interactive run/);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'out.txt')), false);

    const yes = await runCli(['run', '--yes', 'write a file'], { cwd: dir });
    assert.equal(yes.code, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'work', 'out.txt'), 'utf8'), 'x');
  });

  test('run reads the task from stdin with "-"', async () => {
    handler = (body) => ({ text: `got: ${String(body.messages[1]!['content']).trim()}` });
    const r = await runCli(['run', '-'], { cwd: project(), input: 'piped task text\n' });
    assert.equal(r.stdout.trim(), 'got: piped task text');
  });

  test('missing API key fails before any model call', async () => {
    const dir = project();
    fs.rmSync(path.join(dir, '.env'));
    const before = mock.requests.length;
    const r = await runCli(['run', 'hi'], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /MOCK_API_KEY is not set/);
    assert.equal(mock.requests.length, before);
  });

  test('provider errors exit 1 with a readable message', async () => {
    handler = () => ({ error: new Error('upstream overloaded') });
    const r = await runCli(['run', 'hi'], { cwd: project() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Model request failed \(HTTP 500\)/);
  });

  test('start: interactive session keeps context across follow-up messages', async () => {
    handler = (body) => {
      const users = body.messages.filter((m) => m['role'] === 'user').map((m) => String(m['content']));
      return { text: users.length === 1 ? 'Nice to meet you, Ada.' : `Earlier you said: ${users[0]}` };
    };
    const r = await runCli(['start'], { cwd: project(), input: 'My name is Ada.\nWhat did I say first?\n/exit\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Nice to meet you, Ada\./);
    assert.match(r.stdout, /Earlier you said: My name is Ada\./);
  });

  test('start: shows child invocation status', async () => {
    handler = (body) => {
      const system = String(body.messages[0]!['content']);
      if (system.startsWith('You are worker')) return { text: 'worker result 99' };
      return lastTool(body) === undefined
        ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'worker', task: 'compute' } }] }
        : { text: `Final: ${JSON.parse(lastTool(body)!).response}` };
    };
    const dir = project({ spawn: { children: ['agents/1-Subagent-Worker.json'] } }, (d) =>
      writeJson(path.join(d, 'agents', '1-Subagent-Worker.json'), {
        id: 'worker',
        description: 'computes',
        provider: 'openai-compatible',
        providerOptions: { baseUrl: mock.baseUrl, apiKeyEnv: 'MOCK_API_KEY' },
        model: 'mock/model',
        systemPrompt: 'You are worker.',
      }),
    );
    const r = await runCli(['start'], { cwd: dir, input: 'delegate please\n/exit\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /↳ worker started: compute/);
    assert.match(r.stdout, /↳ worker completed in [\d.]+s, 1 turn, 0 tool calls/);
    assert.match(r.stdout, /Final: worker result 99/);
  });

  test('mcp list shows status, tools and grants', async () => {
    const dir = project({ tools: { mcpServers: ['local'] } }, (d) =>
      writeJson(path.join(d, 'mcp.json'), {
        mcpServers: { local: stdioServerConfig(), broken: { command: process.execPath, args: ['-e', 'process.exit(3)'], timeout: 3000 } },
      }),
    );
    const r = await runCli(['mcp', 'list'], { cwd: dir });
    assert.equal(r.code, 1, 'a failing server makes the command fail');
    assert.match(r.stdout, /local\s+\[stdio\]\s+connected, 8 tools/);
    assert.match(r.stdout, /tools: echo, add, fail/);
    assert.match(r.stdout, /granted to: main/);
    assert.match(r.stdout, /broken\s+\[stdio\]\s+error/);
  });
});
