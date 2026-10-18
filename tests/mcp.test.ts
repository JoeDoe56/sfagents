import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  AgentRuntime,
  AgentTerminateMode,
  loadAgentTree,
  McpManager,
  mcpFunctionName,
  ToolErrorType,
  transformMcpResult,
} from '@sfagents/core';
import {
  baseAgent,
  collectEvents,
  lastToolContent,
  makeTempDir,
  scriptedFactory,
  startHttpMcpServer,
  stdioServerConfig,
  toolContents,
  writeJson,
  type Script,
} from './helpers.js';

const runtimes: AgentRuntime[] = [];
after(async () => {
  await Promise.all(runtimes.map((r) => r.dispose()));
});

function setup(agent: Record<string, unknown>, servers: Record<string, unknown>, script: Script, opts: { approveAll?: boolean; extraFiles?: Record<string, unknown> } = {}) {
  const dir = makeTempDir();
  writeJson(path.join(dir, 'agent.json'), { ...baseAgent('main'), ...agent });
  writeJson(path.join(dir, 'mcp.json'), { mcpServers: servers });
  for (const [f, v] of Object.entries(opts.extraFiles ?? {})) writeJson(path.join(dir, f), v);
  const tree = loadAgentTree(path.join(dir, 'agent.json'));
  const { factory, providers } = scriptedFactory(script);
  const runtime = new AgentRuntime({ tree, providerFactory: factory, approveAll: opts.approveAll });
  runtimes.push(runtime);
  return { runtime, providers, tree };
}

const echoThenAnswer: Script = (req, n) =>
  n === 0 ? { toolCalls: [{ name: 'mcp__local__echo', args: { text: 'ping' } }] } : { text: `Tool said: ${lastToolContent(req)}` };

describe('MCP', () => {
  test('stdio: discovery, invocation and result returned to the model', async () => {
    const { runtime, providers } = setup(
      { tools: { mcpServers: ['local'], autoApprove: ['mcp__local__echo'] } },
      { local: stdioServerConfig() },
      echoThenAnswer,
    );
    const result = await runtime.createSession().run('use echo');
    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.text, 'Tool said: echo:ping');
    const names = providers.get('main')!.requests[0]!.request.tools!.map((t) => t.name).sort();
    assert.deepEqual(names, ['add', 'counter', 'echo', 'env_probe', 'fail', 'slow', 'structured', 'throw'].map((t) => `mcp__local__${t}`).sort());
  });

  test('Streamable HTTP: discovery, invocation, headers with ${VAR} expansion', async () => {
    const server = await startHttpMcpServer({ TEST_MCP_TOKEN: 'tok123' });
    process.env['SFAGENTS_TEST_TOKEN'] = 'tok123';
    try {
      const { runtime } = setup(
        { tools: { mcpServers: [{ server: 'remote', tools: ['add'] }], autoApprove: ['mcp__remote__*'] } },
        { remote: { httpUrl: server.url, headers: { Authorization: 'Bearer ${SFAGENTS_TEST_TOKEN}' } } },
        (req, n) => (n === 0 ? { toolCalls: [{ name: 'mcp__remote__add', args: { a: 2, b: 40 } }] } : { text: `sum=${lastToolContent(req)}` }),
      );
      const result = await runtime.createSession().run('add');
      assert.equal(result.text, 'sum=42');
      const states = await runtime.mcp.statusAll();
      assert.equal(states[0]!.status, 'connected');
      assert.equal(states[0]!.transport, 'http');
    } finally {
      delete process.env['SFAGENTS_TEST_TOKEN'];
      await server.stop();
    }
  });

  test('HTTP auth failure and undefined ${VAR} are reported, not sent literally', async () => {
    const server = await startHttpMcpServer({ TEST_MCP_TOKEN: 'tok123' });
    try {
      const manager = new McpManager({
        file: 'mcp.json',
        servers: {
          wrong: { httpUrl: server.url, headers: { Authorization: 'Bearer nope' } },
          missing: { httpUrl: server.url, headers: { Authorization: 'Bearer ${SFAGENTS_UNDEFINED_VAR}' } },
        },
      });
      const [wrong, missing] = await manager.statusAll();
      assert.equal(wrong!.status, 'error');
      assert.equal(missing!.status, 'error');
      assert.match(missing!.error!, /environment variable "SFAGENTS_UNDEFINED_VAR" is not set/);
      await manager.dispose();
    } finally {
      await server.stop();
    }
  });

  test('an agent denied a server never sees or invokes its tools', async () => {
    const { runtime, providers } = setup(
      { tools: { mcpServers: ['allowed'] } },
      { allowed: stdioServerConfig({ includeTools: ['add'] }), forbidden: stdioServerConfig() },
      (req, n) => (n === 0 ? { toolCalls: [{ name: 'mcp__forbidden__counter' }] } : { text: lastToolContent(req) ?? '' }),
      { approveAll: true },
    );
    const result = await runtime.createSession().run('try forbidden');
    const visible = providers.get('main')!.requests[0]!.request.tools!.map((t) => t.name);
    assert.deepEqual(visible, ['mcp__allowed__add'], 'server includeTools filter applied, forbidden server hidden');
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.TOOL_NOT_REGISTERED);
    assert.equal(runtime.mcp.isStarted('allowed'), true);
    assert.equal(runtime.mcp.isStarted('forbidden'), false, 'a server no agent may use is never started');
    assert.match(result.text, /not available/);
  });

  test('per-tool grants hide other tools on the same server', async () => {
    const { runtime, providers } = setup(
      { tools: { mcpServers: [{ server: 'local', tools: ['echo'] }] } },
      { local: stdioServerConfig() },
      (req, n) => (n === 0 ? { toolCalls: [{ name: 'mcp__local__counter' }] } : { text: lastToolContent(req) ?? '' }),
      { approveAll: true },
    );
    const result = await runtime.createSession().run('x');
    assert.deepEqual(providers.get('main')!.requests[0]!.request.tools!.map((t) => t.name), ['mcp__local__echo']);
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.TOOL_NOT_REGISTERED);
  });

  test('MCP calls need approval unless trusted or auto-approved', async () => {
    const denied = setup({ tools: { mcpServers: ['local'] } }, { local: stdioServerConfig() }, echoThenAnswer);
    const r1 = await denied.runtime.createSession().run('x');
    assert.equal(r1.toolCalls[0]!.errorType, ToolErrorType.EXECUTION_DENIED);
    const trusted = setup({ tools: { mcpServers: ['local'] } }, { local: stdioServerConfig({ trust: true }) }, echoThenAnswer);
    const r2 = await trusted.runtime.createSession().run('x');
    assert.equal(r2.toolCalls[0]!.ok, true);
  });

  test('isError results, protocol errors and structured content are normalized', async () => {
    const { runtime, providers } = setup(
      { tools: { mcpServers: ['local'] } },
      { local: stdioServerConfig({ trust: true }) },
      (_req, n) =>
        n === 0
          ? { toolCalls: [{ name: 'mcp__local__fail' }, { name: 'mcp__local__throw' }, { name: 'mcp__local__structured' }] }
          : { text: 'done' },
    );
    const result = await runtime.createSession().run('x');
    assert.deepEqual(result.toolCalls.map((c) => [c.ok, c.errorType]), [
      [false, ToolErrorType.MCP_TOOL_ERROR],
      [false, ToolErrorType.MCP_TOOL_ERROR],
      [true, undefined],
    ]);
    const contents = toolContents(providers.get('main')!.requests[1]!.request);
    assert.match(contents[0]!, /reported an error: deliberate failure/);
    assert.match(contents[1]!, /deliberate protocol error/);
    assert.equal(contents[2], '{"answer":42}\nsee structured content');
  });

  test('stdio servers do not inherit the provider API key', async () => {
    process.env['OPENROUTER_API_KEY'] = 'secret-value';
    process.env['SFAGENTS_VISIBLE'] = 'yes';
    try {
      const { runtime } = setup(
        { tools: { mcpServers: ['local'] } },
        { local: stdioServerConfig({ trust: true }) },
        (req, n) => (n === 0 ? { toolCalls: [{ name: 'mcp__local__env_probe', args: { names: ['OPENROUTER_API_KEY', 'SFAGENTS_VISIBLE'] } }] } : { text: lastToolContent(req) ?? '' }),
      );
      const result = await runtime.createSession().run('x');
      assert.deepEqual(JSON.parse(result.text), { OPENROUTER_API_KEY: false, SFAGENTS_VISIBLE: true });
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
      delete process.env['SFAGENTS_VISIBLE'];
    }
  });

  test('connection failures become warnings and the agent still answers', async () => {
    const { runtime } = setup(
      { tools: { mcpServers: ['broken'] } },
      { broken: { command: process.execPath, args: ['-e', 'process.stderr.write("boom from server"); process.exit(1)'], timeout: 5000 } },
      () => ({ text: 'answered without tools' }),
    );
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('x', { onEvent });
    assert.equal(result.status, AgentTerminateMode.GOAL);
    const warning = events.find((e) => e.type === 'warning') as { message: string } | undefined;
    assert.ok(warning);
    assert.match(warning.message, /MCP server "broken" \(stdio\) failed/);
  });

  test('slow MCP calls are bounded by the tool timeout and cancelled', async () => {
    const { runtime } = setup(
      { tools: { mcpServers: ['local'] }, limits: { toolTimeoutSeconds: 1 } },
      { local: stdioServerConfig({ trust: true }) },
      (_req, n) => (n === 0 ? { toolCalls: [{ name: 'mcp__local__slow', args: { ms: 20000 } }] } : { text: 'gave up' }),
    );
    const started = Date.now();
    const result = await runtime.createSession().run('x');
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.EXECUTION_TIMEOUT);
    assert.ok(Date.now() - started < 8000);
  });

  test('side-effecting calls are not replayed', async () => {
    const { runtime } = setup(
      { tools: { mcpServers: ['local'] } },
      { local: stdioServerConfig({ trust: true }) },
      (req, n) => (n < 2 ? { toolCalls: [{ name: 'mcp__local__counter' }] } : { text: toolContents(req).join(',') }),
    );
    const result = await runtime.createSession().run('x');
    assert.equal(result.text, 'counter=1,counter=2');
  });

  test('function names are provider-safe and bounded', () => {
    assert.equal(mcpFunctionName('srv', 'echo'), 'mcp__srv__echo');
    const odd = mcpFunctionName('srv', 'weird.name/with spaces');
    assert.match(odd, /^mcp__srv__weird_name_with_spaces_[0-9a-f]{8}$/);
    assert.ok(mcpFunctionName('a'.repeat(24), 'b'.repeat(80)).length <= 64);
    assert.equal(
      transformMcpResult('t', { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource_link', uri: 'file:///x', name: 'x' }] }),
      "[Tool 't' provided image data with mime-type image/png (3 bytes); binary content is not shown]\nResource Link: x at file:///x",
    );
  });
});
