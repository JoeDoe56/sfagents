/**
 * Live provider tests (OpenRouter). Run with: npm run test:live
 * Requires OPENROUTER_API_KEY. Model: SFAGENTS_LIVE_MODEL or
 * anthropic/claude-haiku-5.5. Each test uses small turn and token limits.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentRuntime, AgentTerminateMode, loadAgentTree, type RuntimeEvent } from '@sfagents/core';
import { makeTempDir, runCli, stdioServerConfig, writeJson } from './helpers.js';

const KEY = process.env['OPENROUTER_API_KEY'];
const MODEL = process.env['SFAGENTS_LIVE_MODEL'] ?? 'anthropic/claude-haiku-5.5';
const skip = KEY ? false : 'OPENROUTER_API_KEY is not set; live verification was NOT performed';

const runtimes: AgentRuntime[] = [];
after(async () => {
  await Promise.all(runtimes.map((r) => r.dispose()));
});

function agent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    provider: 'openrouter',
    model: MODEL,
    systemPrompt: `You are ${id}, a precise assistant. Use your tools when the task needs them. Keep answers short.`,
    maxOutputTokens: 2000,
    limits: { maxTurns: 8, timeoutSeconds: 180 },
    ...extra,
  };
}

function project() {
  const dir = makeTempDir('sfagents-live-');
  fs.mkdirSync(path.join(dir, 'work', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'shared', 'inventory.txt'), 'Item: blue widgets\nCount: 1749\nWarehouse code: ZEPHYR-8\n');
  writeJson(path.join(dir, 'mcp.json'), { mcpServers: { local: stdioServerConfig() } });
  return dir;
}

function track(r: AgentRuntime) {
  runtimes.push(r);
  return r;
}

describe(`live provider (${MODEL})`, { skip }, () => {
  test('CLI run: basic request returns a real final response', async () => {
    const dir = project();
    writeJson(path.join(dir, 'agent.json'), agent('main'));
    const r = await runCli(['run', 'Reply with exactly the word: TANGERINE'], { cwd: dir, env: { OPENROUTER_API_KEY: KEY }, timeoutMs: 120_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /TANGERINE/);
  });

  test('tool loop with reasoning: built-in file tool result reaches the answer', async () => {
    const dir = project();
    writeJson(path.join(dir, 'agent.json'), agent('main', { reasoning: 'medium', workspace: { roots: ['work'] }, tools: { allow: ['read_file', 'glob'] } }));
    const runtime = track(new AgentRuntime({ tree: loadAgentTree(path.join(dir, 'agent.json')) }));
    const events: RuntimeEvent[] = [];
    const result = await runtime.createSession().run('What is the warehouse code in the inventory file under shared/? Find and read it.', { onEvent: (e) => events.push(e) });
    assert.equal(result.status, AgentTerminateMode.GOAL, result.error);
    assert.ok(result.toolCalls.some((c) => c.name === 'read_file' && c.ok), JSON.stringify(result.toolCalls));
    assert.match(result.text, /ZEPHYR-8/);
  });

  test('MCP stdio tool through the model loop', async () => {
    const dir = project();
    writeJson(path.join(dir, 'agent.json'), agent('main', { tools: { mcpServers: [{ server: 'local', tools: ['add'] }], autoApprove: ['mcp__local__add'] } }));
    const runtime = track(new AgentRuntime({ tree: loadAgentTree(path.join(dir, 'agent.json')) }));
    const result = await runtime.createSession().run('Use the add tool to compute 1749 + 2486 and tell me the result.');
    assert.equal(result.status, AgentTerminateMode.GOAL, result.error);
    assert.ok(result.toolCalls.some((c) => c.name === 'mcp__local__add' && c.ok));
    assert.match(result.text.replace(/,/g, ''), /4235/);
  });

  test('delegation: root invokes a child that uses its own tool, then answers', async () => {
    const dir = project();
    writeJson(
      path.join(dir, 'agent.json'),
      agent('main', {
        reasoning: 'low',
        workspace: { roots: ['work'] },
        tools: { allow: ['read_file'] },
        systemPrompt: 'You are main, a coordinator. You must delegate file lookups to your child agent "clerk" with invoke_child instead of reading files yourself. Keep answers short.',
        spawn: { children: ['agents/1-Subagent-Clerk.json'] },
      }),
    );
    writeJson(
      path.join(dir, 'agents', '1-Subagent-Clerk.json'),
      agent('clerk', { description: 'Reads files in the shared folder and reports facts.', workspace: { roots: ['../work/shared'] }, tools: { allow: ['read_file'] } }),
    );
    const runtime = track(new AgentRuntime({ tree: loadAgentTree(path.join(dir, 'agent.json')) }));
    const events: RuntimeEvent[] = [];
    const result = await runtime.createSession().run('How many blue widgets are in inventory.txt? Ask the clerk.', { onEvent: (e) => events.push(e) });
    assert.equal(result.status, AgentTerminateMode.GOAL, result.error);
    const childEnd = events.find((e) => e.type === 'agent_end' && e.agentPath.join('/') === 'main/clerk');
    assert.ok(childEnd, 'clerk ran');
    assert.ok(events.some((e) => e.type === 'tool_result' && e.agentPath.join('/') === 'main/clerk' && e.name === 'read_file' && e.ok), 'clerk used read_file');
    assert.match(result.text.replace(/,/g, ''), /1749/);
  });

  test('interactive start keeps context across a follow-up', async () => {
    const dir = project();
    writeJson(path.join(dir, 'agent.json'), agent('main'));
    const r = await runCli(['start'], {
      cwd: dir,
      env: { OPENROUTER_API_KEY: KEY },
      input: 'Remember this code word: OSPREY. Just acknowledge.\nWhat code word did I give you? Answer with the word only.\n/exit\n',
      timeoutMs: 120_000,
    });
    assert.equal(r.code, 0, r.stderr);
    const afterSecond = r.stdout.split('What code word did I give you?')[1] ?? '';
    assert.match(afterSecond, /OSPREY/);
  });
});
