import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  AgentTerminateMode,
  hostWorkspacesDir,
  loadAgentTree,
  ProviderError,
  ToolErrorType,
  type ConfirmationHandler,
  type ConfirmationRequest,
  type RuntimeEvent,
} from '@sfagents/core';
import { baseAgent, catFile, collectEvents, lastToolContent, makeTempDir, scriptedFactory, stdioServerConfig, writeFileCommand, writeJson, type Script, writeAgent } from './helpers.js';


const ECHO = 'mcp__local__echo';

function setup(agent: Record<string, unknown>) {
  const dir = makeTempDir();
  // Commands start in /workspaces.
  fs.mkdirSync(hostWorkspacesDir(), { recursive: true });
  fs.writeFileSync(path.join(hostWorkspacesDir(), 'notes.txt'), 'The answer is 42.\n');
  writeJson(path.join(dir, 'mcp.json'), { mcpServers: { local: stdioServerConfig() } });
  writeAgent(dir, { ...baseAgent('main'), ...agent });
  return { dir, tree: loadAgentTree(path.join(dir, 'agent.json')) };
}

function runtimeWith(agent: Record<string, unknown>, script: Script, opts: { confirm?: ConfirmationHandler; approveAll?: boolean } = {}) {
  const { dir, tree } = setup(agent);
  const { factory, providers } = scriptedFactory(script);
  const runtime = new AgentRuntime({ tree, providerFactory: factory, ...opts });
  return { dir, tree, runtime, providers };
}

describe('single agent loop', () => {
  test('answers directly without tools', async () => {
    const { runtime, providers } = runtimeWith({}, () => ({ text: 'Hello there.' }));
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('hi', { onEvent });
    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.text, 'Hello there.');
    assert.equal(result.turns, 1);
    assert.equal(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), 'Hello there.');
    const req = providers.get('main')!.requests[0]!.request;
    assert.equal(req.messages[0]!.role, 'system');
    assert.match((req.messages[0] as { content: string }).content, /You are main\.[\s\S]*<environment>/);
    assert.deepEqual(req.tools?.map((t) => t.name), ['shell'], 'every agent has the shell');
  });

  test('executes an allowed tool and feeds the result into the next turn', async () => {
    const { runtime, providers } = runtimeWith({}, (req, n) =>
      n === 0
        ? { toolCalls: [{ name: 'shell', args: { command: catFile('notes.txt') } }] }
        : { text: `The file says: ${/Stdout: (.*)/.exec(lastToolContent(req) ?? '')?.[1]?.trim()}` },
    );
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('what is in notes.txt?', { onEvent });
    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.text, 'The file says: The answer is 42.');
    assert.deepEqual(result.toolCalls, [{ name: 'shell', ok: true, errorType: undefined }]);
    const second = providers.get('main')!.requests[1]!.request;
    assert.deepEqual(second.tools?.map((t) => t.name), ['shell']);
    assert.ok(events.some((e) => e.type === 'tool_request' && e.name === 'shell'));
    assert.ok(events.some((e) => e.type === 'tool_result' && e.ok));
  });

  test('rejects a tool the agent was never given, even if the model asks for it', async () => {
    const { runtime } = runtimeWith({}, (req, n) =>
      n === 0 ? { toolCalls: [{ name: 'write_file', args: { file_path: 'pwn.txt', content: 'x' } }, { name: 'message', args: { to: 'main', text: 'hi' } }] } : { text: lastToolContent(req) ?? '' },
    );
    const result = await runtime.createSession().run('go');
    assert.equal(result.toolCalls.length, 2);
    assert.ok(result.toolCalls.every((c) => !c.ok && c.errorType === ToolErrorType.TOOL_NOT_REGISTERED));
    assert.match(result.text, /Tool "message" is not available to agent "main"\. Available tools: shell/);
    assert.equal(fs.existsSync(path.join(hostWorkspacesDir(), 'pwn.txt')), false);
  });

  test('invalid tool arguments are returned to the model as errors', async () => {
    const { runtime } = runtimeWith({}, (req, n) =>
      n === 0 ? { toolCalls: [{ name: 'shell', args: { cmd: 'ls' } }] } : { text: lastToolContent(req) ?? '' },
    );
    const result = await runtime.createSession().run('go');
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.INVALID_TOOL_PARAMS);
    assert.match(result.text, /Invalid parameters for shell/);
  });

  test('calls needing approval are denied without a handler, and the model is told why', async () => {
    const { runtime } = runtimeWith({ tools: { mcpServers: ['local'] } }, (req, n) =>
      n === 0 ? { toolCalls: [{ name: ECHO, args: { text: 'hi' } }] } : { text: lastToolContent(req) ?? '' },
    );
    const result = await runtime.createSession().run('echo');
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.EXECUTION_DENIED);
    assert.match(result.text, /requires approval/);
    await runtime.dispose();
  });

  test('confirmation handler: deny, allow once, allow always; autoApprove and approveAll skip prompts; the shell never asks', async () => {
    const asked: ConfirmationRequest[] = [];
    const decisions = ['deny', 'allow_once', 'allow_always'] as const;
    const { runtime } = runtimeWith(
      { tools: { mcpServers: ['local'] } },
      (_req, n) => (n < 4 ? { toolCalls: [{ name: ECHO, args: { text: `m${n}` } }, { name: 'shell', args: { command: 'true' } }] } : { text: 'done' }),
      {
        confirm: async (r) => {
          asked.push(r);
          return decisions[asked.length - 1] ?? 'deny';
        },
      },
    );
    const result = await runtime.createSession().run('echo four times');
    assert.equal(asked.length, 3, 'the fourth call reuses "allow always"');
    assert.equal(asked[0]!.details.type, 'mcp');
    assert.deepEqual(asked[0]!.agentPath, ['main']);
    assert.deepEqual(result.toolCalls.filter((c) => c.name === ECHO).map((c) => c.ok), [false, true, true, true]);
    assert.ok(result.toolCalls.filter((c) => c.name === 'shell').every((c) => c.ok));
    await runtime.dispose();

    let prompts = 0;
    const auto = runtimeWith(
      { tools: { mcpServers: ['local'], autoApprove: [ECHO] } },
      (_req, n) => (n === 0 ? { toolCalls: [{ name: ECHO, args: { text: 'a' } }] } : { text: 'ok' }),
      { confirm: async () => (prompts++, 'deny') },
    );
    assert.equal((await auto.runtime.createSession().run('w')).toolCalls[0]!.ok, true);
    await auto.runtime.dispose();
    const all = runtimeWith(
      { tools: { mcpServers: ['local'] } },
      (_req, n) => (n === 0 ? { toolCalls: [{ name: ECHO, args: { text: 'a' } }] } : { text: 'ok' }),
      { approveAll: true, confirm: async () => (prompts++, 'deny') },
    );
    assert.equal((await all.runtime.createSession().run('w')).toolCalls[0]!.ok, true);
    await all.runtime.dispose();
    assert.equal(prompts, 0);
  });

  test('stops at the turn budget', async () => {
    const { runtime } = runtimeWith({ limits: { maxTurns: 3 } }, () => ({
      toolCalls: [{ name: 'shell', args: { command: catFile('notes.txt') } }],
    }));
    const result = await runtime.createSession().run('loop forever');
    assert.equal(result.status, AgentTerminateMode.MAX_TURNS);
    assert.equal(result.turns, 3);
    assert.match(result.error!, /limit of 3 model turns/);
  });

  test('surfaces provider errors', async () => {
    const { runtime } = runtimeWith({}, () => ({ error: new ProviderError('Model request failed (HTTP 401): bad key', 401) }));
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('hi', { onEvent });
    assert.equal(result.status, AgentTerminateMode.ERROR);
    assert.match(result.error!, /HTTP 401/);
    assert.ok(events.some((e) => e.type === 'error'));
  });

  test('missing API key is reported as a configuration problem', async () => {
    const { tree } = setup({});
    const runtime = new AgentRuntime({ tree, env: {} });
    const result = await runtime.createSession().run('hi');
    assert.equal(result.status, AgentTerminateMode.ERROR);
    assert.match(result.error!, /OPENROUTER_API_KEY is not set/);
  });

  test('tool exceptions are surfaced, not fatal', async () => {
    const { runtime } = runtimeWith({}, (req, n) =>
      n === 0 ? { toolCalls: [{ name: 'shell', args: { command: catFile('notes.txt') } }] } : { text: lastToolContent(req) ?? '' },
    );
    // Make the registered tool throw at execution time.
    const original = runtime.buildTools.bind(runtime);
    runtime.buildTools = async (...args) => {
      const tools = await original(...args);
      const tool = tools.get('shell')!;
      const build = tool.build.bind(tool);
      tool.build = (params: object) => {
        const inv = build(params);
        inv.execute = async () => {
          throw new Error('disk on fire');
        };
        return inv;
      };
      return tools;
    };
    const result = await runtime.createSession().run('go');
    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.UNHANDLED_EXCEPTION);
    assert.match(result.text, /disk on fire/);
  });

  test('agent timeout', async () => {
    const { runtime } = runtimeWith({ limits: { timeoutSeconds: 1 } }, () => ({ text: 'late', delayMs: 5000 }));
    const started = Date.now();
    const result = await runtime.createSession().run('hi');
    assert.equal(result.status, AgentTerminateMode.TIMEOUT);
    assert.ok(Date.now() - started < 4000);
  });

  test('cancellation mid-stream and mid-tool keeps the conversation valid', async () => {
    const { runtime } = runtimeWith({}, (_req, n) =>
      n === 0 ? { toolCalls: [{ name: 'shell', args: { command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30' } }, { name: 'shell', args: { command: 'echo never' } }] } : { text: 'after' },
      { approveAll: true },
    );
    const session = runtime.createSession();
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const pending = session.run('run it', {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'tool_request') setTimeout(() => controller.abort(), 200);
      },
    });
    const started = Date.now();
    const result = await pending;
    assert.equal(result.status, AgentTerminateMode.CANCELLED);
    assert.ok(Date.now() - started < 10_000);
    // Each tool call in the assistant message has a matching tool message.
    const assistant = session.messages.find((m) => m.role === 'assistant' && m.tool_calls)!;
    const ids = (assistant as { tool_calls: Array<{ id: string }> }).tool_calls.map((c) => c.id);
    for (const id of ids) assert.ok(session.messages.some((m) => m.role === 'tool' && m.tool_call_id === id), `response for ${id}`);
    // The session can continue afterwards.
    const next = await session.run('continue');
    assert.equal(next.status, AgentTerminateMode.GOAL);
  });

  test('follow-up messages keep in-process context', async () => {
    const { runtime, providers } = runtimeWith({}, (req) => {
      const users = req.messages.filter((m) => m.role === 'user').map((m) => (m as { content: string }).content);
      return { text: users.length === 1 ? 'Noted: your name is Ada.' : `You said earlier: ${users[0]}` };
    });
    const session = runtime.createSession();
    await session.run('My name is Ada.');
    const second = await session.run('What did I tell you?');
    assert.equal(second.text, 'You said earlier: My name is Ada.');
    const snapshot = providers.get('main')!.requests[1]!.messages as Array<{ role: string }>;
    assert.deepEqual(snapshot.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  });

  test('a session runs one turn at a time', async () => {
    const { runtime } = runtimeWith({}, () => ({ text: 'x', delayMs: 100 }));
    const session = runtime.createSession();
    const first = session.run('a');
    await assert.rejects(session.run('b'), /already running/);
    await first;
  });
});
