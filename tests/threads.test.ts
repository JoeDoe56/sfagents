import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  AgentTerminateMode,
  ConversationService,
  loadAgentTree,
  readConversation,
  threadKey,
  type AgentReplyPayload,
  type ModelRequest,
} from '@sfagents/core';
import { baseAgent, catFile, collectEvents, lastToolContent, makeTempDir, scriptedFactory, stdioServerConfig, useAnySandbox, writeJson, type Script } from './helpers.js';

await useAnySandbox();

const runtimes: AgentRuntime[] = [];
const conversations: ConversationService[] = [];
after(async () => {
  await Promise.all(runtimes.map((r) => r.dispose()));
  conversations.forEach((c) => c.close());
});

function project(agents: Record<string, Record<string, unknown>>) {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'work', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'shared', 'data.txt'), 'shared data: 7\n');
  for (const [name, def] of Object.entries(agents)) writeJson(path.join(dir, 'agents', `${name}.json`), baseAgent(name, def));
  writeJson(path.join(dir, 'mcp.json'), { mcpServers: { local: stdioServerConfig({ trust: true }) } });
  const tree = loadAgentTree(dir);
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
  conversations.push(conversation);
  return { dir, tree, conversation };
}

function start(tree: ReturnType<typeof loadAgentTree>, script: Script, conversation?: ConversationService) {
  const { factory, providers } = scriptedFactory(script);
  const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
  runtimes.push(runtime);
  return { runtime, providers };
}

const lastUser = (req: ModelRequest) => {
  const users = req.messages.filter((m) => m.role === 'user');
  return (users[users.length - 1] as { content: string } | undefined)?.content ?? '';
};
const systemOf = (req: ModelRequest) => (req.messages[0] as { content: string }).content;
const hasToolResult = (req: ModelRequest) => req.messages[req.messages.length - 1]?.role === 'tool';
const inThread = (req: ModelRequest) => /<thread>/.test(systemOf(req));

describe('agents messaging each other in threads', () => {
  test('an agent messages another, which works with its own tools and replies', async () => {
    const { tree, dir, conversation } = project({
      main: { workspace: { roots: ['work'] }, tools: { allow: ['1-worker.json'] } },
      worker: { description: 'Reads shared files.', workspace: { roots: ['work/shared'] }, tools: { allow: ['shell'], mcpServers: [{ server: 'local', tools: ['echo'] }] } },
    });
    const script: Script = (req, _n, agent) => {
      if (agent === 'main') {
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'worker', message: 'Read data.txt; echo the number.', wait: true } }] };
        const payload = JSON.parse(lastToolContent(req)!) as AgentReplyPayload;
        return { text: `Worker (${payload.status}): ${payload.reply}` };
      }
      const toolCount = req.messages.filter((m) => m.role === 'tool').length;
      if (toolCount === 0) return { toolCalls: [{ name: 'shell', args: { command: catFile('data.txt') } }] };
      if (toolCount === 1) return { toolCalls: [{ name: 'mcp__local__echo', args: { text: '7' } }] };
      return { text: `number is ${lastToolContent(req)}` };
    };
    const { runtime, providers } = start(tree, script, conversation);
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('Ask the worker.', { onEvent });
    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.text, 'Worker (replied): number is echo:7');
    const second = providers.get('main')!.requests[1]!;
    const payload = JSON.parse(lastToolContent({ ...second.request, messages: second.messages } as ModelRequest)!) as AgentReplyPayload;
    assert.deepEqual({ agent: payload.agent, thread: payload.thread, turns: payload.turns }, { agent: 'worker', thread: 1, turns: 3 });
    // The worker answers in its thread: its own prompt and tools (wider than main's: it has the shell).
    const first = providers.get('worker')!.requests[0]!;
    const req = { ...first.request, messages: first.messages } as ModelRequest;
    assert.match(systemOf(req), /^You are worker\.[\s\S]*<thread>[\s\S]*answering "main"/);
    assert.equal(lastUser(req), 'Read data.txt; echo the number.');
    assert.doesNotMatch(JSON.stringify(req.messages), /Ask the worker/);
    // It can talk back to main while it works.
    assert.deepEqual(req.tools!.map((t) => t.name).sort(), ['mcp__local__echo', 'message_agent', 'shell', 'wait_for_messages']);
    // The writer's prompt says how to talk to agents.
    assert.match(systemOf(providers.get('main')!.requests[0]!.request), /<agent_messaging>[\s\S]*terse, structured/);
    assert.deepEqual(events.filter((e) => e.type === 'agent_start').map((e) => e.agentPath.join('/')), ['main', 'main/worker']);
    // The thread is a file, listed as an artifact of the conversation.
    const file = path.join(dir, '.sfagents', 'threads', `${threadKey('main', 'worker')}.md`);
    const thread = readConversation(file).state;
    assert.equal(thread.header?.conversationKind, 'thread');
    assert.deepEqual(thread.messages.filter((m) => m.role === 'user').map((m) => m.agent), ['main']);
    assert.ok(conversation.state.artifacts.some((a) => a.type === 'agent_transcript' && a.path === 'threads/main--worker.md'));
    assert.equal(runtime.threads.list()[0]!.messages, 2, 'one message, one reply');
  });

  test('a thread persists: both agents see it, whoever writes and whoever replies in the conversation', async () => {
    const { tree, conversation } = project({ main: { tools: { allow: ['1-worker.json'] } }, worker: { tools: { allow: ['1-main.json'] } } });
    let mainTurn = 0;
    const script: Script = (req, _n, agent) => {
      if (agent === 'main' && !inThread(req)) {
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'worker', message: mainTurn++ === 0 ? 'Remember 42.' : 'What number?', wait: true } }] };
        return { text: JSON.parse(lastToolContent(req)!).reply };
      }
      if (agent === 'worker' && !inThread(req)) {
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'main', message: 'Which number did you give me?', wait: true } }] };
        return { text: JSON.parse(lastToolContent(req)!).reply };
      }
      // Replies in the thread use what the thread holds.
      const seen = JSON.stringify(req.messages);
      if (agent === 'worker') return { text: /Remember 42/.test(seen) ? (/What number/.test(seen) ? 'It was 42.' : 'Noted.') : 'No number.' };
      return { text: /Remember 42/.test(seen) ? 'I gave you 42.' : 'none' };
    };
    const { runtime, providers } = start(tree, script, conversation);
    const session = runtime.createSession();
    assert.equal((await session.run('one')).text, 'Noted.');
    assert.equal((await session.run('two')).text, 'It was 42.');
    // The user hands the conversation to the worker; it writes to main in the same thread.
    session.setAgent('worker');
    assert.equal((await session.run('three')).text, 'I gave you 42.');
    assert.equal(runtime.threads.list().length, 1, 'one thread for the pair, whoever writes');
    // Main, replying in the thread, sees its own earlier messages as its words and the worker's replies as user messages.
    const mainInThread = providers.get('main')!.requests.find((r) => inThread(r.request))!;
    const turns = (mainInThread.messages as Array<{ role: string; content: string }>).slice(1).map((m) => `${m.role}:${m.content}`);
    assert.deepEqual(turns, ['user:(Your thread so far. You wrote first.)', 'assistant:Remember 42.', 'user:Noted.', 'assistant:What number?', 'user:It was 42.\n\nWhich number did you give me?']);
  });

  test('several messages in one turn run in parallel, across agents and threads', async () => {
    const { tree, conversation } = project({ main: { tools: { allow: ['2-worker.json', '1-other.json'] } }, worker: {}, other: {} });
    let running = 0;
    let peak = 0;
    const script: Script = (req, _n, agent) => {
      if (agent === 'main') {
        if (!hasToolResult(req)) {
          return {
            toolCalls: [
              { name: 'message_agent', args: { agent: 'worker', message: 'a', wait: true } },
              { name: 'message_agent', args: { agent: 'worker', message: 'b', wait: true } },
              { name: 'message_agent', args: { agent: 'other', message: 'c', wait: true } },
            ],
          };
        }
        const replies = req.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse((m as { content: string }).content) as AgentReplyPayload);
        return { text: replies.map((r) => `${r.agent}#${r.thread}:${r.reply}`).join(' ') };
      }
      running++;
      peak = Math.max(peak, running);
      setTimeout(() => running--, 120);
      return { text: lastUser(req).toUpperCase(), delayMs: 150 };
    };
    const { runtime } = start(tree, script, conversation);
    const t0 = Date.now();
    const result = await runtime.createSession().run('fan out');
    assert.equal(result.text, 'worker#1:A worker#2:B other#1:C');
    assert.equal(peak, 3, 'all three replied at the same time');
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(runtime.threads.list().map((t) => t.key).sort(), ['main--other', 'main--worker', 'main--worker--2']);
  });

  test('agents talk back and forth while both work, and ungranted agents cannot be messaged', async () => {
    const { tree, dir, conversation } = project({ main: { tools: { allow: ['1-worker.json'] } }, worker: {}, other: {} });
    const content = (m: unknown) => String((m as { content?: unknown }).content ?? '');
    const script: Script = (req, _n, agent) => {
      const last = req.messages[req.messages.length - 1]!;
      if (agent === 'main') {
        if (last.role === 'user' && /^\[from worker, replied\]/.test(content(last))) return { text: `final: ${content(last)}` };
        if (last.role === 'user' && /^\[from worker\] which number/.test(content(last))) return { toolCalls: [{ name: 'message_agent', args: { agent: 'worker', message: 'use 5' } }] };
        if (last.role === 'tool') {
          if (/"status":"delivered"/.test(content(last))) return { text: 'answered the worker' };
          return { toolCalls: [{ name: 'wait_for_messages', args: { timeout_seconds: 5 } }] };
        }
        return { toolCalls: [{ name: 'message_agent', args: { agent: 'worker', message: 'compute' } }, { name: 'message_agent', args: { agent: 'other', message: 'x' } }] };
      }
      // The worker asks the agent it works for and waits for the answer, mid-run.
      if (last.role !== 'tool') return { toolCalls: [{ name: 'message_agent', args: { agent: 'main', message: 'which number?', wait: true } }] };
      return { text: `doubled: ${/use (\d+)/.exec(content(last))?.[1] ?? '?'}0` };
    };
    const { runtime, providers } = start(tree, script, conversation);
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('go', { onEvent });
    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.text, 'final: [from worker, replied] doubled: 50');
    // The worker could message main without a grant (it works for main), and main was told how to talk back.
    const workerReq = providers.get('worker')!.requests[0]!.request;
    assert.match(systemOf(workerReq), /<talking_back>/);
    assert.ok(workerReq.tools!.some((t) => t.name === 'message_agent'));
    // Ungranted agents still cannot be messaged.
    const mainTools = providers.get('main')!.requests.flatMap((r) => r.messages.filter((m: unknown) => (m as { role: string }).role === 'tool').map(content));
    assert.ok(mainTools.some((t) => /params\/agent must be equal to one of the allowed values/.test(t)), mainTools.join(' | '));
    assert.deepEqual(events.filter((e) => e.type === 'agent_message').map((e) => (e as { from: string }).from), ['worker', 'worker']);
    // Both messages from the worker are in the conversation, as the agent's (not the person's) messages.
    const notes = conversation.state.messages.filter((m) => m.event === 'agent');
    assert.deepEqual(notes.map((m) => m.agent), ['worker', 'worker']);
    // Main's answer joined the worker's run and is in the thread, as main's message.
    const thread = readConversation(path.join(dir, '.sfagents', 'threads', `${threadKey('main', 'worker')}.md`)).state;
    assert.deepEqual(thread.messages.filter((m) => m.role === 'user').map((m) => `${m.agent}:${m.content}`), ['main:compute']);
    assert.match(JSON.stringify(thread.messages.filter((m) => m.role === 'tool').map((m) => m.content)), /use 5/);
  });

  test('message_user tells the person something mid-turn and can wait for their answer', async () => {
    const { tree, conversation } = project({ main: {} });
    const pending: string[] = [];
    let wake: (() => void) | undefined;
    const script: Script = (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === 'user' && /blue/.test(String((last as { content: string }).content))) return { text: 'Painting it blue.' };
      if (last.role === 'tool') return { text: 'no answer' };
      return { toolCalls: [{ name: 'message_user', args: { text: 'Which color?', wait_for_reply: true, timeout_seconds: 5 } }] };
    };
    const { runtime } = start(tree, script, conversation);
    const session = runtime.createSession();
    const it = session.send('paint the fence', {
      inbox: () => pending.splice(0).map((content) => ({ content })),
      waitForInput: () => new Promise<void>((resolve) => (pending.length ? resolve() : (wake = resolve))),
    });
    let result;
    for (;;) {
      const next = await it.next();
      if (next.done) {
        result = next.value;
        break;
      }
      if (next.value.type === 'tool_request' && next.value.name === 'message_user') {
        setTimeout(() => {
          pending.push('blue');
          wake?.();
        }, 20);
      }
    }
    assert.equal(result.text, 'Painting it blue.');
    const users = conversation.state.messages.filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepEqual(users, ['paint the fence', 'blue']);
    assert.ok(conversation.state.messages.some((m) => m.toolCalls?.some((c) => c.name === 'message_user')));
  });
});
