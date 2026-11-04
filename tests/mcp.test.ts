import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  AgentRuntime,
  AgentTerminateMode,
  loadAgentTree,
  McpManager,
  mcpApprover,
  runMcpCommand,
  transformMcpResult,
  type McpGrant,
  type McpServerGrant,
} from '@sfagents/core';
import {
  baseAgent,
  collectEvents,
  lastToolContent,
  makeTempDir,
  NO_CONTAINER_TESTS,
  scriptedFactory,
  startHttpMcpServer,
  stdioServerConfig,
  writeJson,
  type Script, writeAgent } from './helpers.js';

const runtimes: AgentRuntime[] = [];
const managers: McpManager[] = [];
after(async () => {
  await Promise.all([...runtimes.map((r) => r.dispose()), ...managers.map((m) => m.dispose())]);
});

function setup(agent: Record<string, unknown>, servers: Record<string, unknown>, script: Script, opts: { approveAll?: boolean; extraFiles?: Record<string, unknown> } = {}) {
  const dir = makeTempDir();
  writeAgent(dir, { ...baseAgent('main'), ...agent });
  writeJson(path.join(dir, 'mcp.json'), { mcpServers: servers });
  for (const [f, v] of Object.entries(opts.extraFiles ?? {})) writeJson(path.join(dir, f), v);
  const tree = loadAgentTree(path.join(dir, 'agent.json'));
  const { factory, providers } = scriptedFactory(script);
  const runtime = new AgentRuntime({ tree, providerFactory: factory, approveAll: opts.approveAll });
  runtimes.push(runtime);
  return { runtime, providers, tree };
}

/** sfa-mcp for one agent, without a container: servers and grants as in an agent file. */
function grant(servers: Record<string, unknown>, grants: Record<string, McpServerGrant>, approval: Partial<Parameters<typeof mcpApprover>[1]> = {}): McpGrant & { asked: string[] } {
  const manager = new McpManager({ file: 'mcp.json', servers: servers as never });
  managers.push(manager);
  const map = new Map(Object.entries(grants));
  const asked: string[] = [];
  const approve = mcpApprover(map, { agentPath: ['main'], autoApprove: [], sessionApprovals: new Set(), approveAll: false, ...approval });
  return { manager, servers: map, asked, approve: async (s, t, a, sig) => (asked.push(`${s}.${t}`), approve(s, t, a, sig)) };
}
const signal = () => new AbortController().signal;
const run = (g: McpGrant | undefined, ...args: string[]) => runMcpCommand(g, args, { signal: signal() });

describe('sfa-mcp', () => {
  test('list shows granted servers and tools; list <server> shows schemas', async () => {
    const g = grant({ local: stdioServerConfig(), other: stdioServerConfig({ includeTools: ['add'] }) }, { local: { tools: new Set(['echo', 'add']), trusted: false }, other: { trusted: false } });
    const all = await run(g, 'list');
    assert.ok(all.ok);
    assert.match(all.text, /^local \(2 tools\)\n  echo - Echoes .*\n  add - /m);
    assert.doesNotMatch(all.text, /counter/);
    assert.match(all.text, /^other \(1 tool\)/m);
    const one = await run(g, 'list', 'local');
    assert.ok(one.ok);
    assert.match(one.text, /## echo\n.*\nInput: \{.*"text"/);
    assert.equal((await run(g, 'list', 'nope')).ok, false);
    const help = await run(g);
    assert.ok(help.ok && /^Usage:/.test(help.text));
    const none = await run(undefined, 'list');
    assert.ok(!none.ok && /no MCP servers/.test(none.error));
  });

  test('call runs a granted tool; ungranted tools, bad JSON and unknown servers are refused', async () => {
    const g = grant({ local: stdioServerConfig() }, { local: { tools: new Set(['echo']), trusted: true } });
    assert.deepEqual(await run(g, 'call', 'local', 'echo', '{"text":"ping"}'), { ok: true, text: 'echo:ping' });
    assert.deepEqual(await runMcpCommand(g, ['call', 'local', 'echo', '--stdin'], { stdin: '{"text":"long"}', signal: signal() }), { ok: true, text: 'echo:long' });
    const counter = await run(g, 'call', 'local', 'counter');
    assert.ok(!counter.ok && /no tool "counter"/.test(counter.error));
    const bad = await run(g, 'call', 'local', 'echo', '{text:');
    assert.ok(!bad.ok && /not valid JSON/.test(bad.error));
    const arr = await run(g, 'call', 'local', 'echo', '[1]');
    assert.ok(!arr.ok && /JSON object/.test(arr.error));
    const other = await run(g, 'call', 'forbidden', 'echo');
    assert.ok(!other.ok && /No MCP server "forbidden"/.test(other.error));
  });

  test('approval: asks unless trusted, auto-approved or allowed always; without a prompt it refuses', async () => {
    const servers = { local: stdioServerConfig() };
    const none = grant(servers, { local: { trusted: false } });
    const refused = await run(none, 'call', 'local', 'echo', '{"text":"x"}');
    assert.ok(!refused.ok && /no approval is possible in this non-interactive run/.test(refused.error));

    const asked: string[] = [];
    const always = grant(servers, { local: { trusted: false } }, {
      confirm: async (req) => {
        asked.push(req.toolName);
        assert.equal(req.details.type, 'mcp');
        return 'allow_always';
      },
    });
    assert.equal((await run(always, 'call', 'local', 'echo', '{"text":"a"}')).ok, true);
    assert.equal((await run(always, 'call', 'local', 'echo', '{"text":"b"}')).ok, true);
    assert.deepEqual(asked, ['mcp__local__echo'], 'allow always is remembered');

    const auto = grant(servers, { local: { trusted: false } }, { autoApprove: ['mcp__local__*'], confirm: async () => 'deny' });
    assert.equal((await run(auto, 'call', 'local', 'echo', '{"text":"a"}')).ok, true);
    const trusted = grant({ local: stdioServerConfig({ trust: true }) }, { local: { trusted: true } });
    assert.equal((await run(trusted, 'call', 'local', 'echo', '{"text":"a"}')).ok, true);
  });

  test('isError results, protocol errors and structured content are normalized', async () => {
    const g = grant({ local: stdioServerConfig() }, { local: { trusted: true } });
    const fail = await run(g, 'call', 'local', 'fail');
    assert.ok(!fail.ok && /reported an error: deliberate failure/.test(fail.error));
    const thrown = await run(g, 'call', 'local', 'throw');
    assert.ok(!thrown.ok && /deliberate protocol error/.test(thrown.error));
    assert.deepEqual(await run(g, 'call', 'local', 'structured'), { ok: true, text: '{"answer":42}\nsee structured content' });
  });

  test('a cancelled call stops; side-effecting calls run once each', async () => {
    const g = grant({ local: stdioServerConfig() }, { local: { trusted: true } });
    const ac = new AbortController();
    const started = Date.now();
    const slow = runMcpCommand(g, ['call', 'local', 'slow', '{"ms":20000}'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await slow;
    assert.ok(!r.ok && /cancelled/.test(r.error));
    assert.ok(Date.now() - started < 8000);
    assert.equal((await run(g, 'call', 'local', 'counter')).ok && 'ok', 'ok');
    assert.deepEqual(await run(g, 'call', 'local', 'counter'), { ok: true, text: 'counter=2' });
  });

  test('tools.defer is refused with a pointer to sfa-mcp', () => {
    const dir = makeTempDir();
    writeAgent(dir, { ...baseAgent('main'), tools: { mcpServers: ['local'], defer: true } });
    writeJson(path.join(dir, 'mcp.json'), { mcpServers: { local: stdioServerConfig() } });
    assert.throws(() => loadAgentTree(path.join(dir, 'agent.json')), /tools\.defer.*sfa-mcp/);
  });

  test('transformMcpResult summarizes binary blocks', () => {
    assert.equal(
      transformMcpResult('t', { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource_link', uri: 'file:///x', name: 'x' }] }),
      "[Tool 't' provided image data with mime-type image/png (3 bytes); binary content is not shown]\nResource Link: x at file:///x",
    );
  });
});

describe('MCP servers', () => {
  test('Streamable HTTP: discovery, invocation, headers with ${VAR} expansion', async () => {
    const server = await startHttpMcpServer({ TEST_MCP_TOKEN: 'tok123' });
    process.env['SFAGENTS_TEST_TOKEN'] = 'tok123';
    try {
      const g = grant({ remote: { httpUrl: server.url, headers: { Authorization: 'Bearer ${SFAGENTS_TEST_TOKEN}' } } }, { remote: { tools: new Set(['add']), trusted: true } });
      assert.deepEqual(await run(g, 'call', 'remote', 'add', '{"a":2,"b":40}'), { ok: true, text: '42' });
      const states = await g.manager.statusAll();
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

  test('stdio servers do not inherit the provider API key', async () => {
    process.env['OPENROUTER_API_KEY'] = 'secret-value';
    process.env['SFAGENTS_VISIBLE'] = 'yes';
    try {
      const g = grant({ local: stdioServerConfig() }, { local: { trusted: true } });
      const r = await run(g, 'call', 'local', 'env_probe', '{"names":["OPENROUTER_API_KEY","SFAGENTS_VISIBLE"]}');
      assert.ok(r.ok);
      assert.deepEqual(JSON.parse(r.text), { OPENROUTER_API_KEY: false, SFAGENTS_VISIBLE: true });
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
      delete process.env['SFAGENTS_VISIBLE'];
    }
  });

  test('a server that fails to start is listed as unavailable', async () => {
    const g = grant({ broken: { command: process.execPath, args: ['-e', 'process.stderr.write("boom from server"); process.exit(1)'], timeout: 5000 } }, { broken: { trusted: true } });
    const r = await run(g, 'list');
    assert.ok(r.ok);
    assert.match(r.text, /broken: unavailable \(MCP server "broken" \(stdio\) failed/);
  });

  test('agents get only the shell: MCP servers are named in its description and none start until used', async () => {
    const { runtime, providers } = setup(
      { tools: { mcpServers: ['allowed'] } },
      { allowed: stdioServerConfig(), forbidden: stdioServerConfig() },
      () => ({ text: 'answered' }),
    );
    const result = await runtime.createSession().run('hi');
    assert.equal(result.status, AgentTerminateMode.GOAL);
    const tools = providers.get('main')!.requests[0]!.request.tools!;
    assert.deepEqual(tools.map((t) => t.name), ['shell', 'message']);
    assert.match(tools[0]!.description, /Your MCP servers \(allowed\) are reached with `sfa-mcp`/);
    assert.equal(runtime.mcp.isStarted('allowed'), false);
    assert.equal(runtime.mcp.isStarted('forbidden'), false);
  });
});

describe('sfa-mcp in the agent container', { skip: NO_CONTAINER_TESTS }, () => {
  const call = (command: string): Script => (req, n) => (n === 0 ? { toolCalls: [{ name: 'shell', args: { command } }] } : { text: String(lastToolContent(req)) });

  test('the agent calls a tool from its shell, and the person is asked first', async () => {
    const dir = makeTempDir();
    writeAgent(dir, { ...baseAgent('main'), tools: { mcpServers: ['local'] } });
    writeJson(path.join(dir, 'mcp.json'), { mcpServers: { local: stdioServerConfig() } });
    const { factory } = scriptedFactory(call(`sfa-mcp call local echo '{"text":"ping"}'; sfa-mcp call local counter; echo "exit=$?"`));
    const asked: string[] = [];
    let n = 0;
    const runtime = new AgentRuntime({
      tree: loadAgentTree(path.join(dir, 'agent.json')),
      providerFactory: factory,
      confirm: async (req) => (asked.push(req.toolName), n++ === 0 ? 'allow_once' : 'deny'),
    });
    runtimes.push(runtime);
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('use echo', { onEvent });
    assert.match(result.text, /echo:ping/);
    assert.match(result.text, /did not allow local counter/);
    assert.match(result.text, /exit=1/);
    assert.deepEqual(asked, ['mcp__local__echo', 'mcp__local__counter']);
    assert.ok(!events.some((e) => e.type === 'error'));
  });
});
