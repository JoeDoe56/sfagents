import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  BrightDataWeb,
  MemorySecretStore,
  ProviderRegistry,
  hostWorkspacesDir,
  loadAgentTree,
  type AnyDeclarativeTool,
  type ToolResult,
  formatWebResult,
  parseWebCommand,
  unwrapUntrusted,
  type WebAccess,
  type WebReply,
  type WebRequest,
} from '@sfagents/core';
import { baseAgent, makeTempDir, NO_CONTAINER_TESTS, writeAgent } from './helpers.js';


class FakeWeb implements WebAccess {
  calls: WebRequest[] = [];
  async request(req: WebRequest): Promise<WebReply> {
    this.calls.push(req);
    if (req.op === 'search') {
      if (req.searches.some((s) => s.query.includes('fail'))) throw new Error('upstream said no');
      const results = req.searches.map((s) => ({ organic: [{ title: `About ${s.query}`, link: 'https://example.com/' }] }));
      return { text: JSON.stringify(results.length === 1 ? results[0] : results) };
    }
    if (req.urls.some((u) => u.includes('fail'))) throw new Error('upstream said no');
    if (req.urls.length === 1) return { text: `# Page ${req.urls[0]}`, ...(req.urls[0]!.includes('thin') ? { notes: ['markdown was nearly empty; showing plain text'] } : {}) };
    return { text: JSON.stringify(req.urls.map((url) => ({ url, format: req.format, content: `# Page ${url}` }))) };
  }
  async close(): Promise<void> {}
}

async function tools(agent: Record<string, unknown>, web: WebAccess): Promise<{ dir: string; tools: Map<string, AnyDeclarativeTool> }> {
  const dir = makeTempDir();
  writeAgent(dir, baseAgent('main', agent));
  const tree = loadAgentTree(dir);
  const runtime = new AgentRuntime({ tree, web, providerFactory: () => { throw new Error('unused'); } });
  return { dir, tools: await runtime.buildTools(tree.root, ['main'], () => {}) };
}

async function sh(t: Map<string, AnyDeclarativeTool>, command: string): Promise<ToolResult> {
  return t.get('shell')!.build({ command }).execute(new AbortController().signal);
}

const stdout = (r: ToolResult) => /Stdout: ([\s\S]*?)\n(?:Stderr:|Exit Code:)/.exec(r.llmContent)?.[1] ?? '';
const stderr = (r: ToolResult) => /Stderr: ([\s\S]*?)\nExit Code:/.exec(r.llmContent)?.[1] ?? '';

describe('sfa-web (in the agent container)', { skip: NO_CONTAINER_TESTS }, () => {
  test('a container reaches the web through SF Agents, and results can go to files', async () => {
    const web = new FakeWeb();
    const { tools: t } = await tools({ network: 'on' }, web);
    const out = `results-${Date.now()}.json`;
    const r = await sh(t, `sfa-web search kiln temperatures > ${out} && cat ${out}; sfa-web markdown https://example.com/glaze`);
    assert.match(stdout(r), /"About kiln temperatures"/);
    assert.match(stdout(r), /# Page https:\/\/example.com\/glaze/);
    assert.deepEqual(web.calls, [
      { op: 'search', searches: [{ query: 'kiln temperatures', engine: 'google' }] },
      { op: 'fetch', format: 'markdown', urls: ['https://example.com/glaze'] },
    ]);
    assert.match(fs.readFileSync(path.join(hostWorkspacesDir(), out), 'utf8'), /About kiln/);
    assert.match(t.get('shell')!.description, /sfa-web search/);
  });

  test('errors, bad addresses and the per-run quota are reported to the command', async () => {
    const web = new FakeWeb();
    const { tools: t } = await tools({ network: 'on', limits: { webRequests: 2 } }, web);
    const r = await sh(t, 'sfa-web html file:///etc/passwd; echo "exit=$?"; sfa-web search please fail; sfa-web search one; sfa-web search two');
    assert.match(stderr(r), /Only http and https addresses/);
    assert.match(stdout(r), /exit=1/);
    assert.match(stderr(r), /upstream said no/);
    assert.match(stdout(r), /About one/);
    assert.match(stderr(r), /used all of its web requests/);
    assert.deepEqual(web.calls.map((c) => c.op === 'search' && c.searches[0]!.query), ['please fail', 'one']);
  });

  test('options, batches, notes, and a quota counted per search and page', async () => {
    const web = new FakeWeb();
    const { tools: t } = await tools({ network: 'on', limits: { webRequests: 4 } }, web);
    const r = await sh(t, `sfa-web search --engine bing --country DE --time week glaze recipes; sfa-web text https://a.example/ https://b.example/; sfa-web markdown https://thin.example/; sfa-web search --each 'one' 'two'; echo "exit=$?"`);
    assert.deepEqual(web.calls[0], { op: 'search', searches: [{ query: 'glaze recipes', engine: 'bing', country: 'de', timeRange: 'week' }] });
    assert.deepEqual(web.calls[1], { op: 'fetch', format: 'text', urls: ['https://a.example/', 'https://b.example/'] });
    assert.match(stdout(r), /"url":"https:\/\/b.example\/"/);
    assert.match(stderr(r), /sfa-web: markdown was nearly empty/);
    assert.match(stderr(r), /has 0 web requests left|used all of its web requests/);
    assert.match(stdout(r), /exit=1/);
    assert.equal(web.calls.length, 3);
  });

  test('agents below network "on" get no web requests', async () => {
    const web = new FakeWeb();
    const { tools: t } = await tools({ network: 'pkg' }, web);
    const r = await sh(t, 'sfa-web search cats; echo "exit=$?"');
    assert.match(stdout(r), /exit=1/);
    assert.equal(web.calls.length, 0);
    assert.doesNotMatch(t.get('shell')!.description, /sfa-web/);
  });
});

describe('web access setup', () => {
  test('the Bright Data key lives in the keyring; without one the agent is told how to add it', async () => {
    const registry = new ProviderRegistry({ dir: makeTempDir(), secrets: new MemorySecretStore() });
    assert.equal(await registry.webKey(), null);
    const web = new BrightDataWeb(() => registry.webKey());
    await assert.rejects(web.request({ op: 'search', searches: [{ query: 'x', engine: 'google' }] }), /add a Bright Data API key in Settings/);
    await registry.setWebKey(' bd-key-123 ');
    assert.equal(await registry.webKey(), 'bd-key-123');
    assert.ok(!fs.readdirSync(registry.dir).some((f) => fs.readFileSync(path.join(registry.dir, f), 'utf8').includes('bd-key')), 'never in a file');
    await registry.setWebKey(null);
    assert.equal(await registry.webKey(), null);
    await assert.rejects(registry.setWebKey('has spaces'), /does not look like an API key/);
  });

  test('connection errors never repeat the key', async () => {
    const web = new BrightDataWeb(async () => 'secret-key-xyz', 'http://127.0.0.1:9/mcp');
    await assert.rejects(web.request({ op: 'search', searches: [{ query: 'x', engine: 'google' }] }), (error: Error) => {
      assert.match(error.message, /Could not reach Bright Data/);
      assert.doesNotMatch(error.message, /secret-key-xyz/);
      return true;
    });
  });
});

describe('sfa-web command line and Bright Data replies', () => {
  test('parses searches with options, batches and page formats', () => {
    assert.deepEqual(parseWebCommand(['search', 'cats', 'and', 'dogs']), { ok: true, req: { op: 'search', searches: [{ query: 'cats and dogs', engine: 'google' }] } });
    assert.deepEqual(parseWebCommand(['search', '--page', '2', '--time', 'hour', 'news']), { ok: true, req: { op: 'search', searches: [{ query: 'news', engine: 'google', page: 2, timeRange: 'hour' }] } });
    assert.deepEqual(parseWebCommand(['search', '--each', 'a b', 'c']), { ok: true, req: { op: 'search', searches: [{ query: 'a b', engine: 'google' }, { query: 'c', engine: 'google' }] } });
    assert.deepEqual(parseWebCommand(['search', '--', '--engine']), { ok: true, req: { op: 'search', searches: [{ query: '--engine', engine: 'google' }] } });
    assert.deepEqual(parseWebCommand(['ld_json', 'https://x.example/']), { ok: true, req: { op: 'fetch', format: 'ld_json', urls: ['https://x.example/'] } });
    const bad = (args: string[], re: RegExp) => {
      const p = parseWebCommand(args);
      assert.equal(p.ok, false);
      assert.match(!p.ok ? p.error : '', re);
    };
    bad(['search', '--engine', 'yahoo', 'x'], /--engine must be/);
    bad(['search', '--engine', 'bing', '--time', 'hour', 'x'], /Bing supports/);
    bad(['search', '--country', 'usa', 'x'], /two-letter/);
    bad(['search', '--each', '1', '2', '3', '4', '5', '6'], /At most 5 searches/);
    bad(['search', '--bogus', 'x'], /Unknown option/);
    bad(['html', 'ftp://x/'], /Only http and https/);
    bad(['text', 'https://a/', 'https://b/', 'https://c/', 'https://d/', 'https://e/', 'https://f/'], /At most 5 pages/);
    bad(['pdf', 'https://a/'], /Usage/);
  });

  test('unwraps Bright Data\'s untrusted-content markers and prints one page as its content', () => {
    const wrap = (body: string) => `SECURITY NOTICE: ... (id abc123) ...\n=====UNTRUSTED_abc123_BEGIN=====\n${body}\n=====UNTRUSTED_abc123_END=====`;
    assert.equal(unwrapUntrusted(wrap('hello')), 'hello');
    assert.equal(unwrapUntrusted('plain'), 'plain');
    const page = formatWebResult({ op: 'fetch', format: 'html', urls: ['https://x.example/'] }, wrap(JSON.stringify({ url: 'https://x.example/', title: 'X', format: 'html', content: '<h1>X</h1>' })));
    assert.deepEqual(page, { text: '<h1>X</h1>' });
    const fallback = formatWebResult({ op: 'fetch', format: 'ld_json', urls: ['https://x.example/'] }, JSON.stringify({ url: 'https://x.example/', format: 'markdown', content: '# X', notes: ['ld_json is not available on this page; returned markdown'] }));
    assert.equal(fallback.text, '# X');
    assert.deepEqual(fallback.notes, ['returned markdown instead of ld_json', 'ld_json is not available on this page; returned markdown']);
    assert.throws(() => formatWebResult({ op: 'fetch', format: 'markdown', urls: ['https://x.example/'] }, JSON.stringify({ url: 'https://x.example/', error: 'Page not found: gone' })), /Page not found/);
    const batch = formatWebResult({ op: 'fetch', format: 'text', urls: ['https://a/', 'https://b/'] }, wrap(JSON.stringify([{ url: 'https://a/', content: 'A' }, { url: 'https://b/', error: 'blocked' }])));
    assert.deepEqual(JSON.parse(batch.text), [{ url: 'https://a/', content: 'A' }, { url: 'https://b/', error: 'blocked' }]);
    const search = formatWebResult({ op: 'search', searches: [{ query: 'q', engine: 'google' }] }, wrap('{"organic":[]}'));
    assert.deepEqual(JSON.parse(search.text), { organic: [] });
    assert.equal(formatWebResult({ op: 'fetch', format: 'markdown', urls: ['https://a/'] }, '# not json').text, '# not json');
  });
});
