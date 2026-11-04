import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AgentRuntime, AppSettings, ContainerManager, ConversationService, MemorySecretStore, ProviderRegistry, containerManager, loadAgentTree, rootMounts, setContainerManagerForTesting, type AgentContainerSpec } from '@sfagents/core';
import { WebServer } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent, writeJson } from './helpers.js';

test('each agent receives only its own read-only roots, including tools built before an edit', async () => {
  const dir = makeTempDir(); const a = makeTempDir('project A-'); const b = makeTempDir('project B-');
  writeAgent(dir, baseAgent('main', { folders: [a] }));
  writeAgent(dir, baseAgent('helper', { folders: [b] }));
  writeAgent(dir, baseAgent('empty'));
  const previous = containerManager(); const specs: AgentContainerSpec[] = [];
  class InspectManager extends ContainerManager {
    override async prepare(spec: AgentContainerSpec): Promise<string> { specs.push(spec); throw new Error('Stop before executing.'); }
  }
  const manager = new InspectManager(); setContainerManagerForTesting(manager);
  const runtime = new AgentRuntime({ tree: loadAgentTree(dir) });
  try {
    const built = new Map<string, Awaited<ReturnType<AgentRuntime['buildTools']>>>();
    for (const id of ['main', 'helper', 'empty']) {
      const tools = await runtime.buildTools(runtime.tree.byId.get(id)!, [id], () => {});
      built.set(id, tools);
      await tools.get('shell')!.build({ command: 'true' }).execute(new AbortController().signal);
    }
    assert.deepEqual(specs.map((s) => [s.agentId, s.roots]), [['main', [a]], ['helper', [b]], ['empty', []]]);
    for (const spec of specs) {
      const mounts = rootMounts(spec.roots);
      const args = manager.createArgs(spec.agentId, spec, mounts, [...spec.roots], []);
      const roots = args.filter((v) => v.includes('dst=/roots/'));
      assert.equal(roots.length, spec.roots.length);
      assert.ok(roots.every((v) => v.endsWith(',readonly')));
    }
    writeAgent(dir, baseAgent('main', { folders: [] })); runtime.reload(loadAgentTree(dir));
    await built.get('main')!.get('shell')!.build({ command: 'true' }).execute(new AbortController().signal);
    assert.deepEqual(specs.at(-1)!.roots, []);
    assert.deepEqual(runtime.projectFolders('helper'), [b]);
    assert.deepEqual(runtime.projectFolders('missing'), []);
    assert.deepEqual(runtime.projectFolders(), [b]);
  } finally { await runtime.dispose(); manager.bridge.stop(); setContainerManagerForTesting(previous); }
});

test('the web editor saves folders per agent and ignores the former global setting', async () => {
  const dir = makeTempDir(); const home = makeTempDir(); const folder = makeTempDir('project-');
  writeAgent(dir, baseAgent('main')); writeAgent(dir, baseAgent('helper'));
  writeJson(path.join(home, 'settings.json'), { 'agents.folders': [makeTempDir('old-global-')] });
  const tree = loadAgentTree(dir);
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: dir });
  const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(true) });
  const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory,
    registry, settings: new AppSettings(home), auth: false, watchAgents: false, enablePushToTalk: false });
  const base = (await server.start()).replace(/\/$/, '');
  const call = async (url: string, body?: unknown) => {
    const r = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() as any };
  };
  try {
    assert.equal((await call('/api/settings')).data.settings.some((v: { key: string }) => v.key === 'agents.folders'), false);
    const main = (await call('/api/agent-editor?agent=main')).data;
    assert.deepEqual(main.form.folders, []);
    const bad = await call('/api/agent-editor', { action: 'save', original: 'main', form: { ...main.form, folders: ['relative'] } });
    assert.equal(bad.status, 422); assert.match(bad.data.errors.folders, /full path/);
    const saved = await call('/api/agent-editor', { action: 'save', original: 'main', form: { ...main.form, folders: [folder] } });
    assert.equal(saved.status, 200); assert.deepEqual(saved.data.form.folders, [folder]);
    assert.deepEqual((await call('/api/agent-editor?agent=helper')).data.form.folders, []);
    const workspaces = (await call('/api/workspaces')).data;
    assert.deepEqual(workspaces.foldersByAgent.main, [folder]);
    assert.deepEqual(workspaces.foldersByAgent.helper, []);
    assert.equal(workspaces.folders, undefined);
    const clear = await call('/api/agent-editor', { action: 'save', original: 'main', form: { ...saved.data.form, folders: [] } });
    assert.equal(clear.status, 200);
    assert.deepEqual((await call('/api/workspaces')).data.foldersByAgent.main, []);
  } finally { await server.close(); conversation.close(); registry.close(); }
});
