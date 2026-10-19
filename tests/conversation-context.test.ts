import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  addSection,
  AgentRuntime,
  AgentTerminateMode,
  buildWorkingContext,
  ContextBudgetError,
  ConversationService,
  loadAgentTree,
  readConversation,
  searchConversation,
  type AgentNode,
  type AgentTree,
  type ChatMessage,
  type RuntimeEvent,
} from '@sfagents/core';
import { baseAgent, lastToolContent, makeTempDir, scriptedFactory, writeJson, type Script } from './helpers.js';

const TARGET = { provider: 'openrouter', model: 'test/model' };

function tree(agent: Record<string, unknown> = {}): { dir: string; tree: AgentTree } {
  const dir = makeTempDir();
  writeJson(path.join(dir, 'agent.json'), { ...baseAgent('main'), ...agent });
  return { dir, tree: loadAgentTree(path.join(dir, 'agent.json')) };
}

function exchange(conv: ConversationService, root: AgentNode, user: string, assistant: string, toolCall?: { name: string; result: string }) {
  const r = conv.beginRootRun(root);
  r.user(user);
  r.start(root);
  if (toolCall) {
    r.assistant({ role: 'assistant', content: null, tool_calls: [{ id: `c${conv.state.nextSeq}`, type: 'function', function: { name: toolCall.name, arguments: '{}' } }] }, 'tool_calls');
    const id = `c${conv.state.nextSeq - 1}`;
    r.toolStart(id, toolCall.name);
    r.toolResult({ role: 'tool', tool_call_id: id, content: toolCall.result }, toolCall.name, 'ok');
  }
  r.assistant({ role: 'assistant', content: assistant }, 'stop');
  r.end({ agentId: 'main', status: AgentTerminateMode.GOAL, text: assistant, turns: 1, toolCalls: [], usage: {}, durationMs: 1 });
}

describe('working context', () => {
  test('keeps the most recent complete exchanges within the window and budget', () => {
    const { tree: t } = tree();
    const conv = ConversationService.memory(t.configDir);
    for (let i = 0; i < 30; i++) exchange(conv, t.root, `question ${i}`, `answer ${i} ${'x'.repeat(400)}`, i % 3 === 0 ? { name: 'read_file', result: `file ${i}` } : undefined);
    const byWindow = buildWorkingContext(conv.state, TARGET, { recentExchanges: 5, maxInputTokens: 100_000 }, '', { retrievable: true });
    assert.equal(byWindow.report.includedExchanges, 5);
    assert.equal(byWindow.report.omittedExchanges, 25);
    assert.equal((byWindow.messages[0] as { content: string }).content, 'question 25');
    // Every assistant tool call is followed by its result: no split groups.
    const m = byWindow.messages;
    m.forEach((msg, i) => {
      if (msg.role === 'assistant' && msg.tool_calls) assert.equal(m[i + 1]!.role, 'tool');
      if (msg.role === 'tool') assert.ok(m[i - 1]!.role === 'assistant');
    });
    assert.match(byWindow.systemExtra!, /25 earlier exchange\(s\) since the last context reset are not shown[\s\S]*search_conversation or fetch_section/);

    const byBudget = buildWorkingContext(conv.state, TARGET, { recentExchanges: 100, maxInputTokens: 1500 }, '', { retrievable: true });
    assert.ok(byBudget.report.includedExchanges < 10 && byBudget.report.includedExchanges >= 1);
    assert.ok(byBudget.report.estimatedTokens <= 1500, `${byBudget.report.estimatedTokens}`);
    assert.equal((byBudget.messages.at(-1) as { content: string }).content.startsWith('answer 29'), true, 'the newest exchange is kept');
  });

  test('a message that cannot fit the budget is a clear error, not a damaged request', () => {
    const { tree: t } = tree();
    const conv = ConversationService.memory(t.configDir);
    conv.beginRootRun(t.root).user('y'.repeat(40_000));
    assert.throws(
      () => buildWorkingContext(conv.state, TARGET, { maxInputTokens: 4000 }, 'system prompt', { retrievable: false }),
      (e: unknown) => e instanceof ContextBudgetError && /about 1000\d tokens \(estimated\)[\s\S]*context.maxInputTokens/.test(e.message),
    );
  });

  test('a large history: bounded index, bounded request, nothing unrelated loaded', () => {
    const { tree: t } = tree();
    const conv = ConversationService.memory(t.configDir);
    const sections: string[] = [];
    for (let s = 0; s < 150; s++) {
      const parent = s % 5 === 0 ? undefined : sections[s - (s % 5)];
      const rec = addSection(conv.main, { title: `Topic ${s} ${s % 5 === 0 ? 'area' : 'detail'}`, parent });
      sections.push(rec.section);
      for (let i = 0; i < 13; i++) exchange(conv, t.root, `topic ${s} question ${i} UNRELATED-BODY-${s}-${i}`, `topic ${s} answer ${i}`);
    }
    assert.equal(conv.state.messages.length, 150 * 13 * 2);
    const ctx = buildWorkingContext(conv.state, TARGET, {}, 'fixed', { retrievable: true });
    assert.equal(ctx.report.includedExchanges, 12);
    assert.ok(ctx.messages.length <= 24);
    assert.ok(ctx.report.indexEntries <= 60 && ctx.report.indexEntries > 10, `${ctx.report.indexEntries}`);
    assert.equal(ctx.report.indexTotal, 150);
    assert.match(ctx.systemExtra!, /more section\(s\) not listed — use list_sections \(paginated\)/);
    assert.match(ctx.systemExtra!, /\[s150\] Topic 149 detail .* ← current/);
    assert.match(ctx.systemExtra!, /\[s146\] Topic 145 area/, 'the current section\'s parent is shown');
    assert.match(ctx.systemExtra!, /current section \[s150\] has 2 earlier message\(s\) outside this context/);
    const sent = JSON.stringify(ctx.messages) + ctx.systemExtra;
    assert.doesNotMatch(sent, /UNRELATED-BODY-3-/, 'old unrelated bodies are absent');
    assert.ok(ctx.report.estimatedTokens < ctx.report.budget);
  });

  test('a fact in an old topic is found by search and fetch, not by preloading', async () => {
    const { dir, tree: t } = tree({ context: { recentExchanges: 3 } });
    const file = path.join(dir, '.sfagents', 'conversation.md');
    let conv = ConversationService.open(file, { configDir: t.configDir });
    addSection(conv.main, { title: 'Database migration' });
    exchange(conv, t.root, 'For the migration, the maintenance window is Sunday 02:00 UTC, ticket OPS-4471.', 'Recorded.');
    addSection(conv.main, { title: 'Holiday planning' });
    for (let i = 0; i < 8; i++) exchange(conv, t.root, `holiday idea ${i}`, `sounds good ${i}`);
    const before = searchConversation(conv.state, 'OPS-4471');
    conv.close();

    conv = ConversationService.open(file, { configDir: t.configDir });
    assert.deepEqual(searchConversation(conv.state, 'OPS-4471'), before, 'search results come from the Markdown alone');
    const script: Script = (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === 'user') return { toolCalls: [{ name: 'search_sections', args: { query: 'migration' } }] };
      const out = lastToolContent(req)!;
      if (out.startsWith('Sections matching')) return { toolCalls: [{ name: 'fetch_section', args: { section: /\[(s\d+)\]/.exec(out)![1] } }] };
      return { text: `The ticket is ${/OPS-\d+/.exec(out)?.[0]}, window ${/Sunday \d\d:\d\d UTC/.exec(out)?.[0]}.` };
    };
    const { factory, providers } = scriptedFactory(script);
    const runtime = new AgentRuntime({ tree: t, providerFactory: factory, conversation: conv });
    const events: RuntimeEvent[] = [];
    const r = await runtime.createSession().run('Which ticket and window did we pick for the migration?', { onEvent: (e) => events.push(e) });
    assert.equal(r.text, 'The ticket is OPS-4471, window Sunday 02:00 UTC.');
    const first = providers.get('main')!.requests[0]!.messages as ChatMessage[];
    const firstText = JSON.stringify(first);
    assert.doesNotMatch(firstText, /OPS-4471/, 'the old fact was not in the initial request');
    assert.match(firstText, /\[s1\] Database migration/, 'but its section title was');
    const ctxEvent = events.find((e) => e.type === 'context') as Extract<RuntimeEvent, { type: 'context' }>;
    assert.equal(ctxEvent.includedExchanges, 3);
    assert.equal(ctxEvent.omittedExchanges, 7);
    await runtime.dispose();
    conv.close();
    assert.equal(readConversation(file).state.messages.filter((m) => m.role === 'user').length, 10);
  });
});
