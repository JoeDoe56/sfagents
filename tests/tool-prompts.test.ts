import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentRuntime, buildSystemPrompt, loadAgentTree, type AnyDeclarativeTool, type WebAccess } from '@sfagents/core';
import { baseAgent, makeTempDir, writeAgent } from './helpers.js';

/** What each agent is told about its tools must match what it really has. */

function web(ready: boolean): WebAccess {
  return { request: async () => ({ text: '' }), ready: async () => ready, close: async () => {} };
}

async function shellFor(agent: Record<string, unknown>, o: { ready?: boolean; main?: boolean } = {}): Promise<{ description: string; schema: Record<string, unknown>; tools: Map<string, AnyDeclarativeTool> }> {
  const dir = makeTempDir();
  writeAgent(dir, baseAgent('main', agent));
  const tree = loadAgentTree(dir);
  const runtime = new AgentRuntime({ tree, web: web(o.ready ?? true), providerFactory: () => { throw new Error('unused'); } });
  const tools = await runtime.buildTools(tree.root, o.main === false ? ['main', 'sub'] : ['main'], () => {});
  const shell = tools.get('shell')!;
  return { description: shell.description, schema: shell.schema.parameters as Record<string, unknown>, tools };
}

test('the shell names the folders the agent really has, or says it has none', async () => {
  const folder = makeTempDir('glazes-');
  const withFolder = await shellFor({ folders: [folder] });
  assert.match(withFolder.description, new RegExp(`/roots/${path.basename(folder)} \\(their ${folder.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\)`));
  const without = await shellFor({});
  assert.match(without.description, /No folders of the person's are shared with you/);
  assert.doesNotMatch(without.description, /project folders, read-only/);
  fs.rmSync(folder, { recursive: true, force: true });
});

test('network level decides what the agent is told it can install and reach', async () => {
  const off = (await shellFor({ network: 'off' })).description;
  assert.match(off, /cannot install or download anything/);
  assert.doesNotMatch(off, /sudo apt-get/);
  assert.match(off, /no web search and cannot fetch websites/);
  assert.doesNotMatch(off, /sfa-web/);
  const pkg = (await shellFor({ network: 'pkg' })).description;
  assert.match(pkg, /sudo apt-get/);
  assert.match(pkg, /including GitHub and other websites, is refused/);
  const on = (await shellFor({ network: 'on' })).description;
  assert.match(on, /sfa-web search <query>/);
  assert.match(on, /Your SF Agents commands are exactly: sfa-patch, sfa-web,/);
  assert.match(on, /Playwright/);
});

test('sfa-web without a Bright Data key is described as not set up', async () => {
  const d = (await shellFor({ network: 'on' }, { ready: false })).description;
  assert.match(d, /sfa-web .* is not set up/);
  assert.doesNotMatch(d, /sfa-web search <query>/);
});

test('only the main agent hears about full control and the host shell', async () => {
  const main = await shellFor({});
  assert.match(main.description, /full_control/);
  assert.ok(JSON.stringify(main.schema).includes('"host"'));
  const sub = await shellFor({}, { main: false });
  assert.doesNotMatch(sub.description, /full_control|target: "host"|--host/);
  assert.ok(!JSON.stringify(sub.schema).includes('"host"'), 'no host target in the schema');
});

test('the system prompt points at the shell for abilities and names the person\'s computer, not a platform the agent runs on', async () => {
  const dir = makeTempDir();
  writeAgent(dir, baseAgent('main', { network: 'git' }));
  const tree = loadAgentTree(dir);
  const prompt = buildSystemPrompt(tree.root, ['shell', 'message']);
  assert.match(prompt, /The person's computer: /);
  assert.match(prompt, /your commands do not run there/);
  assert.match(prompt, /network \(level "git"\)/);
  assert.doesNotMatch(prompt, /^Platform:/m);
});
