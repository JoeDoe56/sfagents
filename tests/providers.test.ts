import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AccountState,
  AppSettings,
  ChatGPTProvider,
  FailoverProvider,
  MemorySecretStore,
  OpenAITokens,
  ProviderError,
  ProviderRegistry,
  createDefaultProviderFactory,
  checkProviders,
  findAuthUrl,
  loadAgentTree,
  parseSetting,
  prepareClaudeRequest,
  toResponsesInput,
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
  test('chat messages become Responses input; the stream becomes text and tool calls', async () => {
    const input = toResponsesInput([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
    ]);
    assert.deepEqual(input, [
      { role: 'developer', content: 'be brief' },
      { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] },
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"file_path":"a"}', namespace: 'sfagents_tools' },
      { type: 'function_call_output', call_id: 'c1', output: 'A' },
    ]);
    const sse = [
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'k', name: 'grep', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"pattern":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"x"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join('');
    let sent: Record<string, unknown> = {};
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const tokens = new OpenAITokens({ clientId: 'c', refreshToken: 'r' }, async () => {}, fetcher);
    tokens.seed('access', Date.now() + 3_600_000);
    const provider = new ChatGPTProvider('OpenAI 1', tokens, fetcher);
    const events = await collect(provider.stream(request({ reasoning: 'max', tools: [{ name: 'grep', description: 'd', parameters: { type: 'object' } }] })));
    const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;
    assert.equal(done.message.content, 'Hello');
    assert.deepEqual(done.toolCalls.map((c) => [c.id, c.name, c.args]), [['k', 'grep', { pattern: 'x' }]]);
    assert.equal(done.usage?.totalTokens, 7);
    assert.deepEqual(sent['reasoning'], { effort: 'xhigh', summary: 'auto' });
    assert.equal(sent['store'], false);

    const limited = new ChatGPTProvider('OpenAI 2', tokens, (async () => new Response('{"error":{"message":"usage limit"}}', { status: 429 })) as unknown as typeof fetch);
    await assert.rejects(() => collect(limited.stream(request())), (e: unknown) => e instanceof ProviderError && e.status === 429);
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
