import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  AccountState,
  AppSettings,
  CodexProvider,
  FailoverProvider,
  MemorySecretStore,
  PlanUsageStore,
  ProviderError,
  ProviderRegistry,
  claudePlanUsage,
  codexDefaultAnswer,
  codexError,
  codexExecutable,
  codexPlanUsage,
  createDefaultProviderFactory,
  checkProviders,
  findAuthUrl,
  loadAgentTree,
  parseSetting,
  prepareClaudeRequest,
  toCodexItems,
  type CodexConnection,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '@sfagents/core';
import { baseAgent, makeTempDir, writeAgent } from './helpers.js';

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, ...over });

async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const out: ModelStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function fake(name: string, behaviour: 'ok' | 'limit' | 'broken', seen: string[]): ModelProvider {
  return {
    id: name,
    async *stream(req) {
      seen.push(`${name}:${req.model}`);
      if (behaviour === 'limit') throw new ProviderError('usage limit reached', 429);
      if (behaviour === 'broken') throw new ProviderError('bad request', 400);
      yield { type: 'text', text: name };
      yield { type: 'done', message: { role: 'assistant', content: name }, toolCalls: [], finishReason: 'stop' };
    },
  };
}

describe('provider registry and keyring', () => {
  test('providers are listed by name; keys live only in the secret store', async () => {
    const dir = makeTempDir();
    const secrets = new MemorySecretStore();
    const reg = new ProviderRegistry({ dir, secrets });
    assert.equal(reg.suggestName('openrouter'), 'OpenRouter 1');
    const a = await reg.add({ name: 'OpenRouter 1', kind: 'openrouter', secret: { apiKey: 'sk-or-v1-secret-a' } });
    const b = await reg.add({ name: 'Local llama', kind: 'custom', baseUrl: 'http://127.0.0.1:8080/v1/', secret: {} });
    assert.equal(reg.suggestName('openrouter'), 'OpenRouter 2');
    assert.equal(b.baseUrl, 'http://127.0.0.1:8080/v1', 'trailing slash trimmed');
    assert.equal(reg.find('openrouter 1')?.id, a.id, 'names match case-insensitively');
    const file = fs.readFileSync(reg.file, 'utf8');
    assert.doesNotMatch(file, /sk-or-v1/);
    assert.deepEqual(await reg.secret(a.id), { apiKey: 'sk-or-v1-secret-a' });
    await assert.rejects(() => reg.add({ name: 'openrouter 1', kind: 'openrouter', secret: { apiKey: 'x' } }), /already exists/);
    await assert.rejects(() => reg.add({ name: 'x', kind: 'custom', baseUrl: 'ftp://nope', secret: {} }), /http\(s\) address/);
    reg.update(a.id, { name: 'OpenRouter work' });
    assert.equal(reg.find('OpenRouter work')?.id, a.id);
    await reg.remove(a.id);
    assert.equal(await reg.secret(a.id), null, 'removing a provider removes its key');
    assert.deepEqual(reg.list().map((r) => r.name), ['Local llama']);
    // Another process (the CLI) adding a provider shows up without reopening.
    const other = new ProviderRegistry({ dir, secrets });
    await other.add({ name: 'Claude 1', kind: 'anthropic', secret: { token: 'sk-ant-oat01-x' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(reg.find('Claude 1'));
  });

  test('without a keyring, adding a provider is refused and nothing is listed', async () => {
    const reg = new ProviderRegistry({ dir: makeTempDir(), secrets: new MemorySecretStore(false) });
    await assert.rejects(() => reg.add({ name: 'OpenRouter 1', kind: 'openrouter', secret: { apiKey: 'k' } }), /No system keyring is available/);
    assert.equal(reg.list().length, 0);
  });
});

describe('agent provider lists and failover', () => {
  test('"provider" takes a name, a list, or entries with their own model', () => {
    const dir = makeTempDir();
    writeAgent(dir, baseAgent('main', { provider: ['Claude 1', { provider: 'OpenRouter 1', model: 'anthropic/claude-sonnet-5.5' }], model: 'claude-sonnet-5-5' }));
    const d = loadAgentTree(dir).root.definition;
    assert.equal(d.provider, 'Claude 1');
    assert.deepEqual(d.providers, [
      { provider: 'Claude 1', model: 'claude-sonnet-5-5' },
      { provider: 'OpenRouter 1', model: 'anthropic/claude-sonnet-5.5' },
    ]);
  });

  test('a limit moves to the next account, which stays current; other errors do not', async () => {
    const seen: string[] = [];
    const accounts = new AccountState();
    const providers: Record<string, ModelProvider> = { A: fake('A', 'limit', seen), B: fake('B', 'ok', seen) };
    const failover = new FailoverProvider('main', [{ provider: 'A', model: 'm1' }, { provider: 'B', model: 'm2' }], (c) => providers[c.provider]!, accounts);
    const events = await collect(failover.stream(request()));
    assert.deepEqual(seen, ['A:m1', 'B:m2']);
    assert.match((events.find((e) => e.type === 'notice') as { text: string }).text, /Switched to "B" \(m2\): "A": usage limit/);
    assert.equal(accounts.get('main'), 'B');
    seen.length = 0;
    await collect(failover.stream(request()));
    assert.deepEqual(seen, ['B:m2'], 'the next request starts with the current account');

    const broken = new FailoverProvider('x', [{ provider: 'C', model: 'm' }, { provider: 'B', model: 'm' }], (c) => (c.provider === 'C' ? fake('C', 'broken', seen) : providers['B']!), new AccountState());
    await assert.rejects(() => collect(broken.stream(request())), /bad request/);
  });

  test('the factory finds added providers by name, and says which are missing', async () => {
    const dir = makeTempDir();
    const reg = new ProviderRegistry({ dir, secrets: new MemorySecretStore() });
    const project = makeTempDir();
    writeAgent(project, baseAgent('main', { provider: ['Nope', 'Local'] }));
    const def = loadAgentTree(project).root.definition;
    assert.match(checkProviders(def, reg, {})[0]!, /"Nope", which is not set up/);
    await reg.add({ name: 'Local', kind: 'custom', baseUrl: 'http://127.0.0.1:9/v1', secret: {} });
    assert.deepEqual(checkProviders(def, reg, {}), [], 'one usable provider is enough');
    const factory = createDefaultProviderFactory({ registry: reg, env: {} });
    assert.ok(factory(def) instanceof FailoverProvider);
  });
});

describe('ChatGPT and Claude adapters', () => {
  test('chat messages become Codex history items; the system prompt becomes the thread instructions', () => {
    const { instructions, items } = toCodexItems([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
    ]);
    assert.match(instructions, /^be brief\n\n[\s\S]*Do not use apply_patch/);
    assert.deepEqual(items, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] },
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"file_path":"a"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'A' },
    ]);
    // Nothing Codex asks to run is allowed.
    assert.deepEqual(codexDefaultAnswer('item/commandExecution/requestApproval'), { decision: 'decline' });
    assert.deepEqual(codexDefaultAnswer('item/fileChange/requestApproval'), { decision: 'decline' });
    assert.equal(codexDefaultAnswer('item/tool/requestUserInput'), undefined);
    assert.equal(codexError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }).status, 429);
    assert.equal(codexError({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).status, 401);
    assert.equal(codexError({ message: 'x', codexErrorInfo: 'serverOverloaded' }).retryable, true);
  });

  test('Codex: text streams, SF Agents tool calls are captured and the turn is interrupted, usage is recorded', async () => {
    const usage = new PlanUsageStore();
    const sent: Array<[string, any]> = [];
    const listeners: Array<(m: string, p: any) => void> = [];
    const notify = (m: string, p: any) => listeners.forEach((l) => l(m, p));
    let serve: (m: string, p: any) => any = () => undefined;
    const conn: CodexConnection = {
      closed: false,
      onNotification(l) {
        listeners.push(l);
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
      onServerRequest(h) {
        serve = h;
        return () => {};
      },
      close() {},
      async request(method, params) {
        sent.push([method, params]);
        const T = 't1';
        const U = 'u1';
        if (method === 'thread/start') return { thread: { id: T } };
        if (method === 'turn/start') {
          setTimeout(() => {
            notify('item/agentMessage/delta', { threadId: T, turnId: U, delta: 'Hel' });
            notify('item/agentMessage/delta', { threadId: 'other', turnId: 'x', delta: 'NOT MINE' });
            notify('item/agentMessage/delta', { threadId: T, turnId: U, delta: 'lo' });
            notify('rawResponseItem/completed', { threadId: T, turnId: U, item: { type: 'function_call', call_id: 'k', name: 'grep', arguments: '{"pattern":"x"}' } });
            void serve('item/tool/call', { threadId: T, turnId: U, callId: 'k', tool: 'grep', arguments: { pattern: 'x' } });
            notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 2_000_500_000 }, planType: 'plus' } });
            notify('rawResponse/completed', { threadId: T, turnId: U, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
          }, 5);
          return { turn: { id: U } };
        }
        if (method === 'turn/interrupt') {
          setTimeout(() => notify('turn/completed', { threadId: T, turn: { id: U, status: 'interrupted', error: null } }), 5);
          return {};
        }
        return {};
      },
    };
    const provider = new CodexProvider('OpenAI 1', 'rec-1', makeTempDir(), { connect: async () => conn, usage });
    const events = await collect(
      provider.stream(
        request({
          reasoning: 'max',
          messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
          tools: [{ name: 'grep', description: 'd', parameters: { type: 'object' } }],
        }),
      ),
    );
    const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;
    assert.equal(done.message.content, 'Hello');
    assert.deepEqual(done.toolCalls.map((c) => [c.id, c.name, c.args, c.rawArguments]), [['k', 'grep', { pattern: 'x' }, '{"pattern":"x"}']]);
    assert.equal(done.finishReason, 'tool_calls');
    assert.equal(done.usage?.totalTokens, 7);
    const start = sent.find(([m]) => m === 'thread/start')![1];
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.ephemeral, true);
    assert.deepEqual(start.dynamicTools.map((t: any) => t.name), ['grep']);
    assert.match(start.baseInstructions, /^sys/);
    assert.deepEqual(sent.find(([m]) => m === 'thread/inject_items')![1].items, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
    assert.equal(sent.find(([m]) => m === 'turn/start')![1].effort, 'xhigh');
    assert.ok(sent.some(([m]) => m === 'turn/interrupt'), 'the turn stops once the response is complete');
    const u = usage.get('rec-1')!;
    assert.equal(u.fiveHour?.usedPercent, 42);
    assert.equal(u.weekly?.usedPercent, 7);
    assert.equal(u.weekly?.resetsAt, 2_000_500_000_000);
    assert.equal(u.plan, 'plus');
  });

  test('plan usage from Codex snapshots and Claude rate-limit events; a past window shows as unused', () => {
    assert.deepEqual(codexPlanUsage({ primary: { usedPercent: 99.5, windowDurationMins: 300, resetsAt: null }, secondary: null, rateLimitReachedType: 'primary' }), {
      fiveHour: { usedPercent: 99.5, resetsAt: undefined, windowMinutes: 300 },
      limitReached: true,
    });
    assert.equal(codexPlanUsage({ primary: null, secondary: null }), null);
    const claude = claudePlanUsage({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81, resetsAt: 2_000_000_000 });
    assert.deepEqual(claude, { weekly: { usedPercent: 81, resetsAt: 2_000_000_000_000 }, limitReached: false });
    const both = claudePlanUsage({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resets_at: 2_000_000_000 }, seven_day: { utilization: 0.5, resets_at: 2_000_100_000 } } });
    assert.equal(both?.fiveHour?.usedPercent, 25);
    assert.equal(both?.weekly?.usedPercent, 50);
    assert.equal(claudePlanUsage({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2_000_000_000 })?.fiveHour?.usedPercent, 100);
    const store = new PlanUsageStore();
    store.update('a', { fiveHour: { usedPercent: 60, resetsAt: Date.now() - 1000 }, weekly: { usedPercent: 30 } });
    store.update('a', { limitReached: false });
    assert.equal(store.get('a')!.fiveHour!.usedPercent, 0, 'past its reset time');
    assert.equal(store.get('a')!.weekly!.usedPercent, 30, 'a report without a window keeps the last one');
  });

  test('the real Codex binary offers only our tools (and its apply_patch, whose writes are declined)', async (t) => {
    let exe: string;
    try {
      exe = codexExecutable();
    } catch {
      t.skip('Codex is not installed for this platform');
      return;
    }
    void exe;
    // A Responses endpoint on this computer stands in for OpenAI.
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        bodies.push(body);
        const sse = (e: unknown) => res.write(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse({ type: 'response.created', response: { id: 'r' } });
        const answered = body.input.some((i: any) => i.type === 'custom_tool_call_output');
        const item = !answered && bodies.length === 1
          ? { type: 'custom_tool_call', id: 'p', call_id: 'call_p', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: written.txt\n+x\n*** End Patch\n', status: 'completed' }
          : bodies.length === 2
            ? { type: 'function_call', id: 'f', call_id: 'call_f', name: 'grep', arguments: '{"pattern":"y"}' }
            : { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] };
        sse({ type: 'response.output_item.added', output_index: 0, item });
        if (item.type === 'message') sse({ type: 'response.output_text.delta', output_index: 0, item_id: 'm', content_index: 0, delta: 'done' });
        sse({ type: 'response.output_item.done', output_index: 0, item });
        sse({ type: 'response.completed', response: { id: 'r', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const home = makeTempDir();
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `model_provider = "mock"\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "SFAGENTS_TEST_MOCK_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
    );
    const saved = { key: process.env['SFAGENTS_TEST_MOCK_KEY'], np: process.env['NO_PROXY'], np2: process.env['no_proxy'] };
    process.env['SFAGENTS_TEST_MOCK_KEY'] = 'x';
    process.env['NO_PROXY'] = process.env['no_proxy'] = '127.0.0.1,localhost';
    const provider = new CodexProvider('OpenAI 1', 'rec', home);
    try {
      const events = await collect(provider.stream(request({ model: 'gpt-5.5', tools: [{ name: 'grep', description: 'search', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } }] })));
      const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;
      assert.deepEqual(done.toolCalls.map((c) => [c.name, c.args]), [['grep', { pattern: 'y' }]]);
      assert.equal(bodies.length, 2, 'the declined patch went back to the model once; the tool call ended the turn');
      assert.deepEqual(bodies[0].tools.map((x: any) => x.name).sort(), ['apply_patch', 'grep']);
      assert.ok(bodies[1].input.some((i: any) => i.type === 'custom_tool_call_output' && /rejected/i.test(i.output)), 'the patch was declined');
      assert.equal(fs.existsSync(path.join(home, 'work', 'written.txt')), false, 'nothing was written');
      assert.ok(!JSON.stringify(bodies[0].input).includes('environment_context'), 'no extra context about this computer');
      const events2 = await collect(provider.stream(request({ model: 'gpt-5.5' })));
      assert.equal((events2.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>).message.content, 'done');
    } finally {
      provider.close();
      server.close();
      for (const [k, v] of [['SFAGENTS_TEST_MOCK_KEY', saved.key], ['NO_PROXY', saved.np], ['no_proxy', saved.np2]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('Claude requests carry the whole conversation; the sign-in address is found in terminal output', () => {
    const p = prepareClaudeRequest(
      request({
        model: 'claude-haiku',
        reasoning: 'high',
        messages: [
          { role: 'system', content: 'You are main.' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'calling', tool_calls: [{ id: 't1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 't1', content: 'ok' },
        ],
        tools: [{ name: 'shell', description: 'run', parameters: { type: 'object' } }],
      }),
    );
    assert.equal(p.model, 'claude-haiku-5-5');
    assert.equal(p.effort, 'high');
    assert.match(p.systemPrompt, /^You are main\.[\s\S]*Do not inspect this computer/);
    assert.match(p.prompt, /"tool_call":\{"id":"t1","name":"shell"/);
    assert.deepEqual(p.tools.map((t) => t.name), ['shell']);
    const out = '\x1b]8;id=x;https://claude.com/cai/oauth/authorize?code=true&client_id=a&state=s1\x07https://claude.com/cai/oauth/authorize?code=true&client_id=a&state=s1\x1b]8;;\x07\r\n';
    assert.equal(findAuthUrl(out), 'https://claude.com/cai/oauth/authorize?code=true&client_id=a&state=s1');
    assert.equal(findAuthUrl('https://evil.example/?state=1 '), null);
  });
});

describe('app settings', () => {
  test('validated, stored per user, defaults when unset', () => {
    const s = new AppSettings(makeTempDir());
    assert.equal(s.get('web.port'), 8093);
    s.set({ 'web.port': '9001', 'cli.showReasoning': 'on' });
    assert.equal(s.get('web.port'), 9001);
    assert.equal(s.get('cli.showReasoning'), true);
    assert.throws(() => s.set({ 'web.port': 70000 }), /1 to 65535/);
    assert.throws(() => parseSetting('nope', 1), /Unknown setting/);
    assert.throws(() => parseSetting('sensors.lhm', 'ftp://x'), /"auto", "off"/);
    s.set({ 'web.port': null });
    assert.equal(s.get('web.port'), 8093);
    assert.ok(s.all().find((x) => x.key === 'web.port')!.restart);
    assert.ok(fs.existsSync(path.join(path.dirname(s.file), 'settings.json')));
  });
});
