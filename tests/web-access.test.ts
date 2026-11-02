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
  type WebAccess,
  type WebOperation,
} from '@sfagents/core';
import { baseAgent, makeTempDir, NO_CONTAINER_TESTS, writeAgent } from './helpers.js';


class FakeWeb implements WebAccess {
  calls: Array<[WebOperation, string]> = [];
  async request(op: WebOperation, arg: string): Promise<string> {
    this.calls.push([op, arg]);
    if (arg.includes('fail')) throw new Error('upstream said no');
    return op === 'search' ? JSON.stringify({ organic: [{ title: `About ${arg}`, link: 'https://example.com/' }] }) : `# Page ${arg}`;
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

const stdout = (r: ToolResult) => /Stdout: ([\s\S]*?)\nStderr:/.exec(r.llmContent)?.[1] ?? '';
const stderr = (r: ToolResult) => /Stderr: ([\s\S]*?)\nExit Code:/.exec(r.llmContent)?.[1] ?? '';

describe('sfa-web (in the agent container)', { skip: NO_CONTAINER_TESTS }, () => {
  test('a container reaches the web through SF Agents, and results can go to files', async () => {
    const web = new FakeWeb();
    const { tools: t } = await tools({ network: 'on' }, web);
    const out = `results-${Date.now()}.json`;
    const r = await sh(t, `sfa-web search kiln temperatures > ${out} && cat ${out}; sfa-web markdown https://example.com/glaze`);
    assert.match(stdout(r), /"About kiln temperatures"/);
    assert.match(stdout(r), /# Page https:\/\/example.com\/glaze/);
    assert.deepEqual(web.calls, [['search', 'kiln temperatures'], ['markdown', 'https://example.com/glaze']]);
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
    assert.deepEqual(web.calls.map((c) => c[1]), ['please fail', 'one']);
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
    await assert.rejects(web.request('search', 'x'), /add a Bright Data API key in Settings/);
    await registry.setWebKey(' bd-key-123 ');
    assert.equal(await registry.webKey(), 'bd-key-123');
    assert.ok(!fs.readdirSync(registry.dir).some((f) => fs.readFileSync(path.join(registry.dir, f), 'utf8').includes('bd-key')), 'never in a file');
    await registry.setWebKey(null);
    assert.equal(await registry.webKey(), null);
    await assert.rejects(registry.setWebKey('has spaces'), /does not look like an API key/);
  });

  test('connection errors never repeat the key', async () => {
    const web = new BrightDataWeb(async () => 'secret-key-xyz', 'http://127.0.0.1:9/mcp');
    await assert.rejects(web.request('search', 'x'), (error: Error) => {
      assert.match(error.message, /Could not reach Bright Data/);
      assert.doesNotMatch(error.message, /secret-key-xyz/);
      return true;
    });
  });
});
