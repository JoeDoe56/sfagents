/**
 * Live provider tests (OpenRouter). Run with: npm run test:live
 * Requires OPENROUTER_API_KEY. Model: SFAGENTS_LIVE_MODEL or
 * anthropic/claude-haiku-5.5. Each test uses small turn and token limits.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  addSection,
  AgentRuntime,
  AgentTerminateMode,
  ConversationService,
  loadAgentTree,
  readConversation,
  type RuntimeEvent,
} from '@sfagents/core';
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

  test('persistent conversation: restart replays tool calls and reasoning across processes', async () => {
    const dir = project();
    writeJson(path.join(dir, 'agent.json'), agent('main', { reasoning: 'medium', workspace: { roots: ['work'] }, tools: { allow: ['read_file'] } }));
    const env = { OPENROUTER_API_KEY: KEY };
    const one = await runCli(['start', '--yes'], { cwd: dir, env, input: 'Read shared/inventory.txt and tell me the item count. Also remember that my badge number is 5521.\n/exit\n', timeoutMs: 150_000 });
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout.replace(/,/g, ''), /1749/);
    const file = path.join(dir, '.sfagents', 'conversation.md');
    const stored = readConversation(file).state;
    assert.ok(stored.messages.some((m) => m.role === 'tool' && m.tool === 'read_file'), 'tool exchange stored');
    const two = await runCli(['start'], { cwd: dir, env, input: 'What is my badge number, and what count did the file show? Answer briefly.\n/exit\n', timeoutMs: 150_000 });
    assert.equal(two.code, 0, two.stderr);
    const answer = two.stdout.split('Answer briefly.')[1] ?? two.stdout;
    assert.match(answer, /5521/);
    assert.match(answer.replace(/,/g, ''), /1749/);
    assert.doesNotMatch(two.stdout, /error:/i);
  });

  test('persistent conversation: an old fact outside the context is retrieved with section tools', async () => {
    const dir = project();
    writeJson(path.join(dir, 'agent.json'), agent('main', { context: { recentExchanges: 2 }, limits: { maxTurns: 8, timeoutSeconds: 180 } }));
    const tree = loadAgentTree(path.join(dir, 'agent.json'));
    const file = path.join(dir, '.sfagents', 'conversation.md');
    const conv = ConversationService.open(file, { configDir: tree.configDir });
    const say = (u: string, a: string) => {
      const r = conv.beginRootRun(tree.root);
      r.user(u);
      r.start(tree.root);
      r.assistant({ role: 'assistant', content: a }, 'stop');
      r.end({ agentId: 'main', status: AgentTerminateMode.GOAL, text: a, turns: 1, toolCalls: [], usage: {}, durationMs: 1 });
    };
    addSection(conv.main, { title: 'Data center move' });
    say('For the data center move, the cutover date is November 14 and the rack label prefix is QX-77.', 'Noted: November 14, rack prefix QX-77.');
    addSection(conv.main, { title: 'Team lunch' });
    for (let i = 0; i < 5; i++) say(`Lunch option ${i}: tacos or ramen?`, `Option ${i} noted.`);
    const runtime = track(new AgentRuntime({ tree, conversation: conv }));
    const events: RuntimeEvent[] = [];
    const result = await runtime.createSession().run('What rack label prefix did we choose for the data center move?', { onEvent: (e) => events.push(e) });
    conv.close();
    assert.equal(result.status, AgentTerminateMode.GOAL, result.error);
    const used = result.toolCalls.map((c) => c.name);
    assert.ok(used.some((n) => ['search_conversation', 'fetch_section', 'search_sections'].includes(n)), `used: ${used.join(', ')}`);
    assert.match(result.text, /QX-77/);
    const ctx = events.find((e) => e.type === 'context') as Extract<RuntimeEvent, { type: 'context' }>;
    assert.equal(ctx.omittedExchanges, 5);
  });

  test('persistent conversation: the model files distinct topics into sections', async () => {
    const dir = project();
    writeJson(path.join(dir, 'agent.json'), agent('main'));
    const r = await runCli(['start'], {
      cwd: dir,
      env: { OPENROUTER_API_KEY: KEY },
      input:
        "Let's plan the database migration for our billing service: we move from MySQL 5.7 to Postgres 16 next month.\n" +
        'For that migration, list three risks briefly.\n' +
        'Switching topics completely: I want to start learning watercolor painting. What three supplies should I buy first?\n/exit\n',
      timeoutMs: 200_000,
    });
    assert.equal(r.code, 0, r.stderr);
    const state = readConversation(path.join(dir, '.sfagents', 'conversation.md')).state;
    const titles = [...state.sections.values()].map((s) => s.title);
    assert.ok(state.sections.size >= 2, `sections: ${JSON.stringify(titles)}`);
    const migration = state.messages.find((m) => m.role === 'user' && m.content.includes('MySQL'))!;
    const painting = state.messages.find((m) => m.role === 'user' && m.content.includes('watercolor'))!;
    assert.ok(state.sectionOf(painting.id), 'painting message filed');
    assert.notEqual(state.sectionOf(migration.id), state.sectionOf(painting.id), `titles: ${JSON.stringify(titles)}`);
  });
});