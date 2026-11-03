import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentFormError,
  AppSettings,
  ConversationService,
  MemorySecretStore,
  ProviderRegistry,
  containerIdFor,
  containerName,
  duplicateAgentFile,
  instructionsLength,
  loadAgentTree,
  mergeWslConfig,
  newAgentForm,
  parseAgentDefinition,
  readAgentForm,
  saveAgentForm,
  validateAgentForm,
  writeWslMemoryCap,
  wslMemoryMb,
  type AgentForm,
} from '@sfagents/core';
import { WebServer } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent, writeJson } from './helpers.js';

const LIMITS = { maxMemoryMb: 16384, maxCpus: 8, providers: ['OpenRouter 1', 'Claude'] };

function project(agents: Array<Record<string, unknown>> = [baseAgent('main')]) {
  const dir = makeTempDir();
  for (const a of agents) writeAgent(dir, a);
  writeJson(path.join(dir, 'mcp.json'), { mcpServers: { files: { command: 'node', args: ['x.js'] }, web: { command: 'node', args: ['y.js'] } } });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompts', 'rules.txt'), 'Be careful.\n');
  return { dir, tree: () => loadAgentTree(dir) };
}

const form = (extra: Partial<AgentForm> = {}): AgentForm => ({
  ...newAgentForm(LIMITS),
  name: 'writer',
  description: 'Writes things.',
  provider: 'Claude',
  model: 'claude-sonnet-5-5',
  instructions: 'You write.\n@rules.txt',
  network: 'pkg',
  ...extra,
});

const agentFile = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, 'agents', `${name}.json`), 'utf8')) as Record<string, unknown>;

describe('agent files: container resources and voice', () => {
  test('container and voice are checked like every other field', () => {
    const d = parseAgentDefinition({ ...baseAgent('a'), container: { memoryMb: 8192, cpus: 2.5 }, voice: { speak: true } }, 'a.json', 'a');
    assert.deepEqual(d.container, { memoryMb: 8192, cpus: 2.5 });
    assert.deepEqual(d.voice, { speak: true });
    assert.throws(() => parseAgentDefinition({ ...baseAgent('a'), container: { memoryMb: 100 } }, 'a.json', 'a'), /container\.memoryMb.*between 512/);
    assert.throws(() => parseAgentDefinition({ ...baseAgent('a'), container: { disk: 1 } }, 'a.json', 'a'), /container\.disk.*unknown field/);
    assert.throws(() => parseAgentDefinition({ ...baseAgent('a'), voice: { speak: 'yes' } }, 'a.json', 'a'), /voice\.speak.*true or false/);
  });
});

describe('the agent editor (core)', () => {
  test('a new form chooses nothing that must be chosen, and the sliders start within the cap', () => {
    const f = newAgentForm({ maxMemoryMb: 2048, maxCpus: 2 });
    assert.equal(f.network, null);
    assert.equal(f.memoryMb, 2048);
    assert.equal(f.cpus, 2);
  });

  test('each field says what is wrong with it', () => {
    const { tree } = project([baseAgent('main'), baseAgent('Writer')]);
    const errors = validateAgentForm(tree(), form({ network: null, instructions: ' ', mcpServers: ['nope'], memoryMb: 32768, cpus: 0, provider: '', model: 'x' }), LIMITS);
    assert.match(errors.name!, /already an agent named "writer"/, 'names clash without regard to case');
    assert.match(errors.network!, /Choose/);
    assert.match(errors.instructions!, /Write/);
    assert.match(errors.mcpServers!, /nope/);
    assert.match(errors.memoryMb!, /16384 MB/);
    assert.match(errors.cpus!, /Between/);
    assert.match(errors.provider!, /provider this model is from/);
    assert.deepEqual(validateAgentForm(tree(), form({ name: 'Writer' }), LIMITS, 'Writer'), {}, 'its own name is no clash');
    assert.match(validateAgentForm(tree(), form({ instructions: '@missing.txt' }), LIMITS).instructions!, /missing\.txt/);
    assert.match(validateAgentForm(tree(), form({ provider: 'Gone' }), LIMITS).provider!, /not a provider in Settings/);
    assert.match(validateAgentForm(tree(), form({ name: 'a/b' }), LIMITS).name!, /can’t contain/);
    assert.match(validateAgentForm(tree(), form({ model: '' }), LIMITS).model!, /model/);
  });

  test('saving writes the agent file; nothing is written when a field is wrong', () => {
    const { dir, tree } = project();
    assert.throws(() => saveAgentForm(tree(), form({ network: null }), LIMITS), (e: unknown) => e instanceof AgentFormError && !!e.errors.network);
    assert.equal(fs.existsSync(path.join(dir, 'agents', 'writer.json')), false);
    saveAgentForm(tree(), form({ mcpServers: ['files'], memoryMb: 8192, speak: true }), LIMITS);
    assert.deepEqual(agentFile(dir, 'writer'), {
      description: 'Writes things.',
      provider: 'Claude',
      model: 'claude-sonnet-5-5',
      systemPrompt: 'You write.\n@rules.txt',
      network: 'pkg',
      tools: { mcpServers: ['files'] },
      container: { memoryMb: 8192 },
      voice: { speak: true },
    });
    const t = tree();
    assert.equal(t.byId.get('writer')!.definition.systemPrompt, 'You write.\nBe careful.', 'it loads, with the prompt file filled in');
    assert.deepEqual(readAgentForm(t, 'writer'), form({ mcpServers: ['files'], memoryMb: 8192, speak: true }));
    assert.equal(instructionsLength('You write.\n@rules.txt', [{ name: 'rules.txt', chars: 11 }]), 'You write.\nBe careful.'.length);
  });

  test('what the form does not show is kept: limits, failover providers, per-tool MCP lists', () => {
    const { dir, tree } = project([
      baseAgent('main', {
        provider: ['OpenRouter 1', { provider: 'Claude', model: 'claude-haiku-5-5' }],
        limits: { maxTurns: 7 },
        tools: { mcpServers: [{ server: 'files', tools: ['read'] }, 'web'], autoApprove: ['mcp__web__*', 'mcp__files__read'] },
        systemPrompt: ['One.', 'Two.'],
      }),
    ]);
    const f = readAgentForm(tree(), 'main');
    assert.equal(f.provider, 'OpenRouter 1');
    assert.equal(f.instructions, 'One.\n\nTwo.');
    assert.deepEqual(f.mcpServers, ['files', 'web']);
    saveAgentForm(tree(), { ...f, description: 'Now described.', mcpServers: ['files'] }, LIMITS, 'main');
    const raw = agentFile(dir, 'main');
    assert.deepEqual(raw['limits'], { maxTurns: 7 });
    assert.deepEqual(raw['provider'], ['OpenRouter 1', { provider: 'Claude', model: 'claude-haiku-5-5' }]);
    assert.deepEqual(raw['systemPrompt'], ['One.', 'Two.'], 'unchanged instructions keep their form');
    assert.deepEqual(raw['tools'], { mcpServers: [{ server: 'files', tools: ['read'] }], autoApprove: ['mcp__files__read'] });
    assert.equal(raw['description'], 'Now described.');
  });

  test('renaming moves the file, and other agents\' grants follow', () => {
    const { dir, tree } = project([baseAgent('main', { agents: ['2-helper.json'] }), baseAgent('helper', { name: 'Helper Label' })]);
    saveAgentForm(tree(), { ...readAgentForm(tree(), 'helper'), name: 'researcher' }, LIMITS, 'helper');
    assert.equal(fs.existsSync(path.join(dir, 'agents', 'helper.json')), false);
    assert.equal(agentFile(dir, 'researcher')['name'], undefined, 'the old label goes with the old name');
    assert.deepEqual(agentFile(dir, 'main')['agents'], ['2-researcher.json']);
    assert.equal(tree().byId.get('main')!.grants.get('researcher'), 2);
  });

  test('duplicating makes "<name> copy", numbered when taken', () => {
    const { dir, tree } = project();
    assert.equal(duplicateAgentFile(tree(), 'main'), 'main copy');
    assert.equal(duplicateAgentFile(tree(), 'main'), 'main copy 2');
    assert.equal(agentFile(dir, 'main copy')['id'], undefined);
    assert.ok(tree().byId.has('main copy 2'));
  });
});

describe('the WSL memory cap', () => {
  test('is written to .wslconfig with a backup of the file from before, and read back', () => {
    const dir = makeTempDir();
    const file = path.join(dir, '.wslconfig');
    fs.writeFileSync(file, '[wsl2]\r\nmemory=16GB\r\nprocessors=8\r\n');
    assert.equal(wslMemoryMb(file), 16384);
    const w = writeWslMemoryCap(24, file);
    assert.equal(w.changed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '[wsl2]\r\nmemory=24GB\r\nprocessors=8\r\n');
    assert.equal(fs.readFileSync(`${file}.sfagents-backup`, 'utf8'), '[wsl2]\r\nmemory=16GB\r\nprocessors=8\r\n');
    writeWslMemoryCap(20, file);
    assert.match(fs.readFileSync(`${file}.sfagents-backup`, 'utf8'), /memory=16GB/, 'the first backup is kept');
    assert.equal(writeWslMemoryCap(20, file).changed, false);
    assert.equal(wslMemoryMb(path.join(dir, 'none')), undefined);
    assert.match(mergeWslConfig('', { wsl2: { memory: '8GB' } }).text, /memory=8GB/);
  });

  test('Full Control Maximum and the WSL Memory Cap are settings', () => {
    const s = new AppSettings(makeTempDir());
    assert.equal(s.get('agents.fullControlMinutes'), 5);
    assert.equal(s.get('containers.wslMemoryGb'), 16);
    assert.throws(() => s.set({ 'agents.fullControlMinutes': 0 }), /from 1 to 120/);
  });
});

describe('the agent editor (server)', () => {
  async function start() {
    const { dir, tree } = project([baseAgent('main'), baseAgent('helper')]);
    const t = tree();
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: t.configDir });
    const home = makeTempDir();
    const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(true) });
    const server = new WebServer({ tree: t, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, registry, settings: new AppSettings(home), auth: false });
    const base = (await server.start()).replace(/\/$/, '');
    const call = async (p: string, body?: unknown) => {
      const res = await fetch(`${base}${p}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    return {
      dir,
      call,
      async stop() {
        await server.close();
        conversation.close();
        registry.close();
      },
    };
  }

  test('the form, saving with errors by field, a new agent, a rename, duplicate, reset and delete', async () => {
    const s = await start();
    try {
      const got = await s.call('/api/agent-editor?agent=main');
      assert.equal(got.status, 200);
      assert.equal(got.json.form.network, 'off');
      assert.deepEqual(got.json.choices.mcpServers, ['files', 'web']);
      assert.deepEqual(got.json.choices.promptFiles, [{ name: 'rules.txt', chars: 11 }]);
      assert.deepEqual(got.json.choices.networkLevels.map((l: { value: string }) => l.value), ['off', 'pkg', 'git', 'on']);
      assert.ok(got.json.choices.memoryMb.max >= 512);
      const blank = await s.call('/api/agent-editor');
      assert.equal(blank.json.form.network, null);
      assert.equal(blank.json.original, null);

      const bad = await s.call('/api/agent-editor', { action: 'save', form: { ...blank.json.form, name: 'helper' } });
      assert.equal(bad.status, 422);
      assert.match(bad.json.errors.name, /already/);
      assert.ok(bad.json.errors.network && bad.json.errors.instructions);

      const made = await s.call('/api/agent-editor', { action: 'save', form: { ...blank.json.form, name: 'writer', provider: 'openrouter', model: 'x/y', instructions: 'Write.', network: 'git' } });
      assert.equal(made.status, 200, JSON.stringify(made.json));
      assert.equal(made.json.original, 'writer');
      assert.ok((await s.call('/api/agents')).json.agents.some((a: { id: string }) => a.id === 'writer'), 'loaded at once');

      const renamed = await s.call('/api/agent-editor', { action: 'save', original: 'writer', form: { ...made.json.form, name: 'author' } });
      assert.equal(renamed.json.original, 'author');
      const ids = (await s.call('/api/agents')).json.agents.map((a: { id: string }) => a.id);
      assert.ok(ids.includes('author') && !ids.includes('writer'));

      const copy = await s.call('/api/agent-editor', { action: 'duplicate', agent: 'author' });
      assert.equal(copy.json.original, 'author copy');

      // Reset Environment removes the container (the stand-in for Docker keeps a list).
      const state = path.join(process.env['SFA_FAKE_DOCKER_STATE']!, 'state.json');
      const read = () => (fs.existsSync(state) ? (JSON.parse(fs.readFileSync(state, 'utf8')) as { containers: Record<string, unknown> }) : { containers: {} });
      const name = containerName(containerIdFor('author'));
      const before = read();
      before.containers[name] = { running: true };
      fs.writeFileSync(state, JSON.stringify(before));
      assert.equal((await s.call('/api/agent-editor', { action: 'reset', agent: 'author' })).status, 200);
      assert.equal(read().containers[name], undefined);

      assert.equal((await s.call('/api/agent-editor', { action: 'delete', agent: 'author copy' })).json.deleted, 'author copy');
      assert.equal(fs.existsSync(path.join(s.dir, 'agents', 'author copy.json')), false);
      assert.equal((await s.call('/api/agent-editor', { action: 'delete', agent: 'nobody' })).status, 404);
      await s.call('/api/agent-editor', { action: 'delete', agent: 'author' });
      await s.call('/api/agent-editor', { action: 'delete', agent: 'helper' });
      const last = await s.call('/api/agent-editor', { action: 'delete', agent: 'main' });
      assert.equal(last.status, 409, 'the only agent stays');
    } finally {
      await s.stop();
    }
  });
});
