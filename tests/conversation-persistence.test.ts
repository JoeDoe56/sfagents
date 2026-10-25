import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AgentRuntime,
  AgentTerminateMode,
  ConversationService,
  INTERRUPTED_NOT_STARTED,
  INTERRUPTED_UNKNOWN,
  loadAgentTree,
  readConversation,
  ToolErrorType,
  type ChatMessage,
} from '@sfagents/core';
import { baseAgent, CLI_ENTRY, lastToolContent, makeTempDir, runCli, scriptedFactory, startMockOpenAI, writeJson, type MockChatHandler, type Script, writeAgent, catFile, useAnySandbox, writeFileCommand } from './helpers.js';

const realSandbox = await useAnySandbox();

const isWin = process.platform === 'win32';

function project(agent: Record<string, unknown> = {}, extraFiles: Record<string, unknown> = {}) {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  writeAgent(dir, { ...baseAgent('main'), workspace: { roots: ['work'] }, ...agent });
  for (const [f, v] of Object.entries(extraFiles)) writeJson(path.join(dir, f), v);
  return { dir, file: path.join(dir, '.sfagents', 'conversation.md') };
}

function openRuntime(dir: string, script: Script, opts: { approveAll?: boolean; io?: Parameters<typeof ConversationService.open>[1]['io'] } = {}) {
  const tree = loadAgentTree(dir);
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir, io: opts.io });
  const { factory, providers } = scriptedFactory(script);
  const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation, approveAll: opts.approveAll });
  return {
    runtime,
    conversation,
    providers,
    close: async () => {
      await runtime.dispose();
      conversation.close();
    },
  };
}

function roles(messages: readonly ChatMessage[]): string {
  return messages.map((m) => m.role[0]).join('');
}

describe('persistent conversation (runtime)', () => {
  test('a tool exchange and reasoning blocks survive a restart and replay validly', async () => {
    const { dir, file } = project({ tools: { allow: ['shell'] } });
    fs.writeFileSync(path.join(dir, 'work', 'fact.txt'), 'The launch code is AZURE-7.\n');
    const details = [{ type: 'reasoning.text', format: 'anthropic-claude-v1', index: 0, text: 'read it', signature: 'sig123' }];
    const first = openRuntime(dir, (req, n) =>
      n === 0
        ? { toolCalls: [{ name: 'shell', args: { command: catFile('fact.txt') } }], reasoningDetails: details }
        : { text: `Found: ${/Stdout: (.*)/.exec(lastToolContent(req) ?? '')?.[1]?.trim()}` },
    );
    const r1 = await first.runtime.createSession().run('What is the launch code?');
    assert.equal(r1.text, 'Found: The launch code is AZURE-7.');
    await first.close();
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readFileSync(path.join(dir, '.sfagents', '.gitignore'), 'utf8').includes('*'), true);
    assert.equal(fs.existsSync(path.join(dir, '.sfagents', 'conversation.lock')), false, 'lock released on close');

    const second = openRuntime(dir, () => ({ text: 'ok' }));
    assert.equal(second.conversation.notices[0]!.kind, 'resumed');
    await second.runtime.createSession().run('And again?');
    const sent = second.providers.get('main')!.requests[0]!.messages as ChatMessage[];
    assert.equal(roles(sent), 'suatau', 'system, user, assistant(tool call), tool, assistant, user');
    const assistant = sent[2] as Extract<ChatMessage, { role: 'assistant' }>;
    assert.equal(assistant.tool_calls![0]!.function.arguments, JSON.stringify({ command: catFile('fact.txt') }));
    assert.deepEqual(assistant.reasoning_details, details, 'opaque payload replayed unchanged to the same model');
    assert.equal((sent[3] as { tool_call_id: string }).tool_call_id, assistant.tool_calls![0]!.id);
    assert.match((sent[3] as { content: string }).content, /AZURE-7/);
    await second.close();

    // A different model must not receive another model's reasoning blocks.
    const agent = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'main.json'), 'utf8'));
    writeAgent(dir, { ...agent, model: 'other/model' });
    const third = openRuntime(dir, () => ({ text: 'ok' }));
    await third.runtime.createSession().run('third');
    const sent3 = third.providers.get('main')!.requests[0]!.messages as ChatMessage[];
    assert.equal((sent3[2] as { reasoning_details?: unknown }).reasoning_details, undefined);
    await third.close();
  });

  test('crash before execution: the call is marked never-started and is not repeated', async () => {
    const { dir } = project({ tools: { allow: ['shell'] } });
    const failOn = 'sfa:tool_start';
    const first = openRuntime(
      dir,
      (_req, n) => (n === 0 ? { toolCalls: [{ name: 'shell', args: { command: writeFileCommand('side-effect.txt') } }] } : { text: 'done' }),
      {
        approveAll: true,
        io: {
          write: (fd, data) => {
            if (data.includes(failOn)) throw new Error('simulated crash');
            fs.writeSync(fd, data);
          },
        },
      },
    );
    const r = await first.runtime.createSession().run('write it');
    assert.equal(r.status, AgentTerminateMode.ERROR);
    assert.match(r.error!, /Conversation storage failed: .*simulated crash.*Stopped before any further action/);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'side-effect.txt')), false, 'the tool never ran');
    await first.runtime.dispose();
    first.conversation.close();

    const second = openRuntime(dir, () => ({ text: 'acknowledged' }));
    const notice = second.conversation.notices.find((n) => n.kind === 'interrupted');
    assert.match(notice!.message, /1 never started/);
    await second.runtime.createSession().run('what happened?');
    const sent = second.providers.get('main')!.requests[0]!.messages as ChatMessage[];
    assert.equal((sent[3] as { content: string }).content, INTERRUPTED_NOT_STARTED);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'side-effect.txt')), false, 'still not executed after reopening');
    await second.close();
  });

  test('crash after execution but before the result is stored: outcome is unknown, not repeated', async () => {
    const { dir } = project({ tools: { allow: ['shell'] } });
    const first = openRuntime(
      dir,
      (_req, n) => (n === 0 ? { toolCalls: [{ name: 'shell', args: { command: writeFileCommand('once.txt') } }] } : { text: 'done' }),
      {
        approveAll: true,
        io: {
          write: (fd, data) => {
            if (data.includes('"role":"tool"')) throw new Error('simulated crash');
            fs.writeSync(fd, data);
          },
        },
      },
    );
    await first.runtime.createSession().run('write it');
    assert.equal(fs.existsSync(path.join(dir, 'work', 'once.txt')), true, 'the side effect happened');
    await first.runtime.dispose();
    first.conversation.close();

    const second = openRuntime(dir, () => ({ text: 'I will check before retrying.' }), { approveAll: true });
    assert.match(second.conversation.notices.find((n) => n.kind === 'interrupted')!.message, /unknown outcome \(shell\)/);
    const r = await second.runtime.createSession().run('continue');
    assert.equal(r.toolCalls.length, 0, 'nothing re-executed');
    const sent = second.providers.get('main')!.requests[0]!.messages as ChatMessage[];
    assert.equal((sent[3] as { content: string }).content, INTERRUPTED_UNKNOWN);
    // Synthetic results are context only; they are never stored as observed tool messages.
    const { state } = readConversation(path.join(dir, '.sfagents', 'conversation.md'));
    assert.equal(state.messages.filter((m) => m.role === 'tool').length, 0);
    await second.close();
  });

  test('threads between agents are stored as their own files and linked from the conversation', async () => {
    const { dir } = project({ tools: { allow: ['1-helper.json'] } }, { 'agents/helper.json': baseAgent('helper', { description: 'helps' }) });
    const first = openRuntime(dir, (req, n, agent) =>
      agent === 'main'
        ? n === 0
          ? { toolCalls: [{ name: 'message_agent', args: { agent: 'helper', message: 'Say the password.' } }] }
          : { text: `Helper said: ${JSON.parse(lastToolContent(req)!).reply}` }
        : { text: 'swordfish' },
    );
    const r = await first.runtime.createSession().run('ask the helper');
    assert.equal(r.text, 'Helper said: swordfish');
    await first.close();

    const { state } = readConversation(path.join(dir, '.sfagents', 'conversation.md'));
    const artifact = state.artifacts.find((a) => a.type === 'agent_transcript')!;
    assert.equal(artifact.path, 'threads/helper--main.md');
    const thread = readConversation(path.join(dir, '.sfagents', artifact.path!)).state;
    assert.equal(thread.header!.conversationKind, 'thread');
    assert.deepEqual(thread.messages.map((m) => [m.role, m.content]), [
      ['user', 'Say the password.'],
      ['assistant', 'swordfish'],
    ]);
    // The writer's context holds only the reply, not the thread.
    const second = openRuntime(dir, () => ({ text: 'ok' }));
    await second.runtime.createSession().run('next');
    const sent = JSON.stringify(second.providers.get('main')!.requests[0]!.messages);
    assert.match(sent, /swordfish/);
    assert.doesNotMatch(sent, /<thread>/);
    await second.close();
  });

  test('/clear resets the working context but keeps history', async () => {
    const { dir, file } = project();
    const rt = openRuntime(dir, () => ({ text: 'ok' }));
    const session = rt.runtime.createSession();
    await session.run('remember: blue');
    session.resetContext();
    await session.run('fresh start');
    const sent = rt.providers.get('main')!.requests[1]!.messages as ChatMessage[];
    assert.equal(roles(sent), 'su');
    await rt.close();
    const { state } = readConversation(file);
    assert.equal(state.messages.filter((m) => m.role === 'user').length, 2);
    assert.ok(state.lastResetSeq > 0);
  });

  test('conversation state is invisible to shell commands', { skip: !realSandbox && 'no OS sandbox on this machine' }, async () => {
    const { dir } = project({ workspace: { roots: ['.'] }, tools: { allow: ['shell'] } });
    const rt = openRuntime(dir, (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === 'user' && last.content === 'read the history file') {
        return { toolCalls: [{ name: 'shell', args: { command: 'cat .sfagents/conversation.md; grep -r SECRET-PHRASE . || echo "No matches"' } }] };
      }
      return { text: lastToolContent(req) ?? 'ok' };
    });
    await rt.runtime.createSession().run('SECRET-PHRASE lives in history');
    await rt.runtime.createSession().run('read the history file');
    const sent = rt.providers.get('main')!.requests.at(-1)!.messages as ChatMessage[];
    const output = (sent.at(-1) as { content: string }).content.split('\n').slice(1).join('\n');
    assert.match(output, /No matches/);
    assert.doesNotMatch(output, /SECRET-PHRASE lives/);
    await rt.close();
  });

  test('"always allow" approvals do not survive a restart', async () => {
    const { dir } = project({ tools: { allow: ['shell'], ask: true } });
    let asked = 0;
    for (let round = 0; round < 2; round++) {
      const tree = loadAgentTree(dir);
      const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
      const { factory } = scriptedFactory((_req, n) => (n === 0 ? { toolCalls: [{ name: 'shell', args: { command: writeFileCommand(`f${round}.txt`) } }] } : { text: 'ok' }));
      const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation, confirm: async () => (asked++, 'allow_always') });
      await runtime.createSession().run('write');
      await runtime.dispose();
      conversation.close();
    }
    assert.equal(asked, 2);
  });
});

describe('persistent conversation (CLI)', () => {
  let mock: Awaited<ReturnType<typeof startMockOpenAI>>;
  let handler: MockChatHandler = () => ({ text: 'unset' });
  before(async () => {
    mock = await startMockOpenAI((body) => handler(body));
  });
  after(async () => {
    await mock.stop();
  });

  function cliProject(agent: Record<string, unknown> = {}) {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'work'));
    writeAgent(dir, {
      id: 'main',
      provider: 'openai-compatible',
      providerOptions: { baseUrl: mock.baseUrl, apiKeyEnv: 'MOCK_API_KEY' },
      model: 'mock/model',
      systemPrompt: 'You are main.',
      workspace: { roots: ['work'] },
      ...agent,
    });
    fs.writeFileSync(path.join(dir, '.env'), 'MOCK_API_KEY=test-key\n');
    return dir;
  }

  test('two separate processes share one conversation', async () => {
    handler = (body) => {
      const users = body.messages.filter((m) => m['role'] === 'user').map((m) => String(m['content']));
      const fact = users.find((u) => u.startsWith('My favourite colour is'));
      return { text: users.length === 1 ? 'Noted.' : `You told me: ${fact}` };
    };
    const dir = cliProject();
    const one = await runCli(['start'], { cwd: dir, input: 'My favourite colour is teal.\n/exit\n' });
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /Started a new conversation at .*conversation\.md/);
    const two = await runCli(['start'], { cwd: dir, input: 'What is my favourite colour?\n/exit\n' });
    assert.equal(two.code, 0, two.stderr);
    assert.match(two.stdout, /Resumed .*conversation\.md \(2 messages\)/);
    assert.match(two.stdout, /You told me: My favourite colour is teal\./);
    const info = await runCli(['conversation', 'info'], { cwd: dir });
    assert.match(info.stdout, /messages: 4 \(2 from the user\)/);
    assert.match(info.stdout, /lock: free/);
  });

  test('run is ephemeral unless --persist; start --ephemeral stores nothing', async () => {
    handler = () => ({ text: 'fine' });
    const dir = cliProject();
    assert.equal((await runCli(['run', 'hello'], { cwd: dir })).code, 0);
    assert.equal(fs.existsSync(path.join(dir, '.sfagents')), false);
    assert.equal((await runCli(['start', '--ephemeral'], { cwd: dir, input: 'hi\n/exit\n' })).code, 0);
    assert.equal(fs.existsSync(path.join(dir, '.sfagents')), false);
    assert.equal((await runCli(['run', '--persist', 'remember this'], { cwd: dir })).code, 0);
    assert.equal(readConversation(path.join(dir, '.sfagents', 'conversation.md')).state.messages.length, 2);
    const custom = path.join(dir, 'elsewhere', 'chat.md');
    assert.equal((await runCli(['run', '--conversation', custom, 'x'], { cwd: dir })).code, 0);
    assert.ok(fs.existsSync(custom));
    const bad = await runCli(['run', '--ephemeral', '--persist', 'x'], { cwd: dir });
    assert.equal(bad.code, 2);
  });

  test('a second writer is refused while the first is running', async () => {
    handler = () => ({ text: 'ok' });
    const dir = cliProject();
    const first = spawn(process.execPath, [CLI_ENTRY, 'start'], { cwd: dir, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    first.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (/conversation/.test(out)) {
          clearInterval(t);
          resolve();
        }
      }, 50);
    });
    const second = await runCli(['start'], { cwd: dir, input: '/exit\n' });
    assert.equal(second.code, 2);
    assert.match(second.stderr, /in use by process \d+ on this computer/);
    first.stdin.end('/exit\n');
    await new Promise((r) => first.on('exit', r));
    const third = await runCli(['start'], { cwd: dir, input: '/exit\n' });
    assert.equal(third.code, 0, third.stderr);
  });

  test('a process killed mid-tool leaves an interrupted run that is reported, not repeated', { skip: !realSandbox && 'no OS sandbox on this machine' }, async () => {
    const sleepCmd = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30';
    let calls = 0;
    handler = (body) => {
      calls++;
      const last = body.messages[body.messages.length - 1]!;
      if (last['role'] === 'user' && String(last['content']).startsWith('run the slow command')) {
        return { toolCalls: [{ name: 'shell', args: { command: sleepCmd } }] };
      }
      if (last['role'] === 'tool') return { text: 'tool finished' };
      const tools = body.messages.filter((m) => m['role'] === 'tool').map((m) => String(m['content']));
      return { text: `I see: ${tools.join(' | ')}` };
    };
    const dir = cliProject({ tools: { allow: ['shell'] } });
    const file = path.join(dir, '.sfagents', 'conversation.md');
    const child = spawn(process.execPath, [CLI_ENTRY, 'start', '--yes'], { cwd: dir, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write('run the slow command\n');
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const t = setInterval(() => {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('sfa:tool_start')) {
          clearInterval(t);
          resolve();
        } else if (Date.now() - started > 15_000) {
          clearInterval(t);
          reject(new Error('tool never started'));
        }
      }, 50);
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const callsBefore = calls;

    const reopened = await runCli(['start'], { cwd: dir, input: 'what happened to the command?\n/exit\n' });
    assert.equal(reopened.code, 0, reopened.stderr);
    assert.match(reopened.stdout, /interrupted: 1 tool call with unknown outcome \(shell\)\. Nothing was retried automatically\./);
    assert.match(reopened.stdout, /I see: \[SF Agents: interrupted\] This tool call was started/);
    assert.equal(calls, callsBefore + 1, 'one model call for the new message; no tool re-run');
  });
});
