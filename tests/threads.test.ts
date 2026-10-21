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
import { baseAgent, collectEvents, lastToolContent, makeTempDir, scriptedFactory, stdioServerConfig, writeJson, type Script } from './helpers.js';

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
      main: { workspace: { roots: ['work'] }, tools: { allow: ['read_file', '1-worker.json'] } },
      worker: { description: 'Reads shared files.', workspace: { roots: ['work/shared'] }, tools: { allow: ['read_file', 'shell'], mcpServers: [{ server: 'local', tools: ['echo'] }] } },
    });
    const script: Script = (req, _n, agent) => {
      if (agent === 'main') {
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'worker', message: 'Read data.txt; echo the number.' } }] };
        const payload = JSON.parse(lastToolContent(req)!) as AgentReplyPayload;
        return { text: `Worker (${payload.status}): ${payload.reply}` };
      }
      const toolCount = req.messages.filter((m) => m.role === 'tool').length;
      if (toolCount === 0) return { toolCalls: [{ name: 'read_file', args: { file_path: 'data.txt' } }] };
      if (toolCount === 1) return { toolCalls: [{ name: 'mcp__local__echo', args: { text: '7' } }] };
      return { text: `number is ${lastToolContent(req)}` };
    };
    const { runtime, providers } = start(tree, script, conversation);
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('Ask the worker.', { onEvent });
    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.text, 'Worker (replied): number is echo:7');
    const payload = JSON.parse(lastToolContent(providers.get('main')!.requests[1]!.request)!) as AgentReplyPayload;
    assert.deepEqual({ agent: payload.agent, thread: payload.thread, turns: payload.turns }, { agent: 'worker', thread: 1, turns: 3 });
    // The worker answers in its thread: its own prompt and tools (wider than main's: it has the shell).
    const first = providers.get('worker')!.requests[0]!;
    const req = { ...first.request, messages: first.messages } as ModelRequest;
    assert.match(systemOf(req), /^You are worker\.[\s\S]*<thread>[\s\S]*answering "main"/);
    assert.equal(lastUser(req), 'Read data.txt; echo the number.');
    assert.doesNotMatch(JSON.stringify(req.messages), /Ask the worker/);
    assert.deepEqual(req.tools!.map((t) => t.name).sort(), ['mcp__local__echo', 'read_file', 'shell']);
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
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'worker', message: mainTurn++ === 0 ? 'Remember 42.' : 'What number?' } }] };
        return { text: JSON.parse(lastToolContent(req)!).reply };
      }
      if (agent === 'worker' && !inThread(req)) {
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'main', message: 'Which number did you give me?' } }] };
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
              { name: 'message_agent', args: { agent: 'worker', message: 'a' } },
              { name: 'message_agent', args: { agent: 'worker', message: 'b' } },
              { name: 'message_agent', args: { agent: 'other', message: 'c' } },
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

  test('a reply cannot wait on its writer, and ungranted agents cannot be messaged', async () => {
    const { tree, conversation } = project({ main: { tools: { allow: ['1-worker.json'] } }, worker: { tools: { allow: ['1-main.json'] } }, other: {} });
    const script: Script = (req, _n, agent) => {
      if (agent === 'main' && !inThread(req)) {
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'worker', message: 'go' } }, { name: 'message_agent', args: { agent: 'other', message: 'x' } }] };
        return { text: req.messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content).join(' | ') };
      }
      if (agent === 'worker') {
        if (!hasToolResult(req)) return { toolCalls: [{ name: 'message_agent', args: { agent: 'main', message: 'question' } }] };
        return { text: `worker saw: ${lastToolContent(req)}` };
      }
      return { text: 'should not run' };
    };
    const { runtime } = start(tree, script, conversation);
    const result = await runtime.createSession().run('go');
    assert.match(result.text, /\\"main\\" is waiting for your reply|"main" is waiting for your reply/);
    assert.match(result.text, /params\/agent must be equal to one of the allowed values/);
    assert.doesNotMatch(result.text, /should not run/);
  });
});
