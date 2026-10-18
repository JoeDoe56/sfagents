import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  AgentTerminateMode,
  loadAgentTree,
  ToolErrorType,
  type ChildResultPayload,
  type ModelRequest,
  type RuntimeEvent,
} from '@sfagents/core';
import { baseAgent, collectEvents, lastToolContent, makeTempDir, scriptedFactory, stdioServerConfig, writeJson, type Script } from './helpers.js';

const runtimes: AgentRuntime[] = [];
after(async () => {
  await Promise.all(runtimes.map((r) => r.dispose()));
});
function track(runtime: AgentRuntime): AgentRuntime {
  runtimes.push(runtime);
  return runtime;
}

function tree3() {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'work', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'shared', 'data.txt'), 'shared data: 7\n');
  fs.writeFileSync(path.join(dir, 'work', 'root-only.txt'), 'root secret\n');
  writeJson(
    path.join(dir, 'agent.json'),
    baseAgent('main', {
      workspace: { roots: ['work'] },
      tools: { allow: ['read_file', 'write_file', 'shell'], mcpServers: ['local'] },
      spawn: { children: ['agents/1-Subagent-Worker.json', 'agents/1-Subagent-Other.json'], maxConcurrentChildren: 2 },
    }),
  );
  writeJson(
    path.join(dir, 'agents', '1-Subagent-Worker.json'),
    baseAgent('worker', {
      description: 'Reads shared files and uses the echo tool.',
      workspace: { roots: ['../work/shared'] },
      tools: { allow: ['read_file'], mcpServers: [{ server: 'local', tools: ['echo'] }], autoApprove: [] },
      spawn: { children: ['2-Subagent-Helper.json'] },
    }),
  );
  writeJson(path.join(dir, 'agents', '1-Subagent-Other.json'), baseAgent('other', { description: 'Another child.' }));
  writeJson(path.join(dir, 'agents', '2-Subagent-Helper.json'), baseAgent('helper', { description: 'Answers trivia.' }));
  writeJson(path.join(dir, 'mcp.json'), { mcpServers: { local: stdioServerConfig({ trust: true }) } });
  return { dir, tree: loadAgentTree(path.join(dir, 'agent.json')) };
}

function systemOf(req: ModelRequest): string {
  return (req.messages[0] as { content: string }).content;
}
function userOf(req: ModelRequest): string {
  return (req.messages.find((m) => m.role === 'user') as { content: string }).content;
}

describe('parent and child agents', () => {
  test('parent invokes a declared child that uses its own tools and gets a structured result', async () => {
    const { tree } = tree3();
    const script: Script = (req, n, agent) => {
      if (agent === 'main') {
        if (n === 0) {
          return {
            toolCalls: [{ name: 'invoke_child', args: { agent: 'worker', task: 'Read data.txt and echo the number.', context: 'The file is in your root.' } }],
          };
        }
        const payload = JSON.parse(lastToolContent(req)!) as ChildResultPayload;
        return { text: `Worker reported (${payload.status}): ${payload.response}` };
      }
      if (agent === 'worker') {
        if (n === 0) return { toolCalls: [{ name: 'read_file', args: { file_path: 'data.txt' } }] };
        if (n === 1) return { toolCalls: [{ name: 'mcp__local__echo', args: { text: '7' } }] };
        return { text: `number is ${lastToolContent(req)}` };
      }
      return { text: 'unexpected' };
    };
    const { factory, providers } = scriptedFactory(script);
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('Ask the worker.', { onEvent });

    assert.equal(result.status, AgentTerminateMode.GOAL);
    assert.equal(result.text, 'Worker reported (completed): number is echo:7');
    // The parent saw the structured payload.
    const toolMsg = lastToolContent(providers.get('main')!.requests[1]!.request)!;
    const payload = JSON.parse(toolMsg) as ChildResultPayload;
    assert.deepEqual(
      { agent: payload.agent, status: payload.status, turns: payload.turns, toolCalls: payload.toolCalls },
      { agent: 'worker', status: 'completed', turns: 3, toolCalls: { read_file: { ok: 1, failed: 0 }, mcp__local__echo: { ok: 1, failed: 0 } } },
    );
    // The child got a fresh context: its own system prompt, only the task + context, no parent history.
    const childRecord = providers.get('worker')!.requests[0]!;
    const childReq = { ...childRecord.request, messages: childRecord.messages } as ModelRequest;
    assert.match(systemOf(childReq), /^You are worker\./);
    assert.equal(childReq.messages.length, 2);
    assert.match(userOf(childReq), /Task from parent agent "main":\nRead data.txt and echo the number.\n\nContext provided by the parent:\nThe file is in your root./);
    assert.doesNotMatch(JSON.stringify(childReq.messages), /Ask the worker/);
    // The child only sees its own tools.
    assert.deepEqual(childReq.tools!.map((t) => t.name).sort(), ['invoke_child', 'mcp__local__echo', 'read_file']);
    // invoke_child advertises only direct children.
    const parentInvoke = providers.get('main')!.requests[0]!.request.tools!.find((t) => t.name === 'invoke_child')!;
    assert.deepEqual((parentInvoke.parameters as { properties: { agent: { enum: string[] } } }).properties.agent.enum, ['worker', 'other']);
    // Events show child activity with agent paths.
    const starts = events.filter((e) => e.type === 'agent_start').map((e) => e.agentPath.join('/'));
    assert.deepEqual(starts, ['main', 'main/worker']);
    assert.ok(events.some((e) => e.type === 'tool_result' && e.agentPath.join('/') === 'main/worker' && e.name === 'read_file'));
  });

  test('a grandchild runs through the same mechanism', async () => {
    const { tree } = tree3();
    const script: Script = (req, n, agent) => {
      if (agent === 'main') return n === 0 ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'worker', task: 'ask helper' } }] } : { text: JSON.parse(lastToolContent(req)!).response };
      if (agent === 'worker') return n === 0 ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'helper', task: 'capital of France?' } }] } : { text: `helper says ${JSON.parse(lastToolContent(req)!).response}` };
      return { text: 'Paris' };
    };
    const { factory } = scriptedFactory(script);
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    const { events, onEvent } = collectEvents();
    const result = await runtime.createSession().run('go', { onEvent });
    assert.equal(result.text, 'helper says Paris');
    assert.deepEqual(events.filter((e) => e.type === 'agent_end').map((e) => e.agentPath.join('/')), ['main/worker/helper', 'main/worker', 'main']);
  });

  test('undeclared agents (siblings, grandchildren, unknown ids) cannot be invoked', async () => {
    const { tree } = tree3();
    const script: Script = (req, n, agent) => {
      if (agent === 'main') {
        return n === 0
          ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'helper', task: 'skip a level' } }, { name: 'invoke_child', args: { agent: 'ghost', task: 'x' } }] }
          : { text: 'done' };
      }
      if (agent === 'worker') return n === 0 ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'other', task: 'sibling' } }] } : { text: lastToolContent(req)! };
      return { text: 'should not run' };
    };
    const { factory, providers } = scriptedFactory(script);
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    const result = await runtime.createSession().run('go');
    assert.deepEqual(result.toolCalls.map((c) => c.errorType), [ToolErrorType.INVALID_TOOL_PARAMS, ToolErrorType.INVALID_TOOL_PARAMS]);
    assert.equal(providers.get('helper'), undefined, 'helper never ran');

    // Bypass the schema enum: the runtime guard still refuses a non-child.
    const worker = tree.byId.get('worker')!;
    const other = tree.byId.get('other')!;
    await assert.rejects(
      runtime.runChild({ parent: worker, parentPath: ['main', 'worker'], child: other, task: 'x', signal: new AbortController().signal, emit: () => {} }),
      /not a declared child of "worker"/,
    );
  });

  test('a child cannot use tools, files or MCP servers outside its own policy', async () => {
    const { tree, dir } = tree3();
    const script: Script = (req, n, agent) => {
      if (agent === 'main') return n === 0 ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'worker', task: 'misbehave' } }] } : { text: lastToolContent(req)! };
      if (agent === 'worker') {
        if (n === 0) {
          return {
            toolCalls: [
              { name: 'shell', args: { command: 'echo pwned > pwned.txt' } },
              { name: 'write_file', args: { file_path: 'x.txt', content: 'x' } },
              { name: 'read_file', args: { file_path: path.join(dir, 'work', 'root-only.txt') } },
              { name: 'read_file', args: { file_path: '../root-only.txt' } },
              { name: 'mcp__local__counter', args: {} },
            ],
          };
        }
        return { text: 'tried' };
      }
      return { text: '' };
    };
    const { factory } = scriptedFactory(script);
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory, approveAll: true }));
    const result = await runtime.createSession().run('go');
    const payload = JSON.parse(result.text) as ChildResultPayload;
    assert.deepEqual(payload.toolCalls, {
      shell: { ok: 0, failed: 1 },
      write_file: { ok: 0, failed: 1 },
      read_file: { ok: 0, failed: 2 },
      mcp__local__counter: { ok: 0, failed: 1 },
    });
    assert.equal(fs.existsSync(path.join(dir, 'work', 'shared', 'pwned.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'work', 'shared', 'x.txt')), false);
  });

  test('the tree is frozen: runtime code cannot widen a child', () => {
    const { tree } = tree3();
    const worker = tree.byId.get('worker')!;
    assert.throws(() => {
      (worker.definition.tools!.allow as string[]).push('write_file');
    }, TypeError);
    assert.throws(() => {
      (tree.root.children as unknown as unknown[]).push(worker);
    }, TypeError);
  });

  test('recursion guard refuses an agent already in the chain', async () => {
    const { tree } = tree3();
    const { factory } = scriptedFactory(() => ({ text: 'x' }));
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    const worker = tree.byId.get('worker')!;
    const helper = tree.byId.get('helper')!;
    await assert.rejects(
      runtime.runChild({ parent: worker, parentPath: ['main', 'helper', 'worker'], child: helper, task: 'x', signal: new AbortController().signal, emit: () => {} }),
      /recursion guard/,
    );
  });

  test('child failures are returned to the parent as structured errors', async () => {
    const { tree } = tree3();
    const script: Script = (req, n, agent) => {
      if (agent === 'main') return n === 0 ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'other', task: 'fail' } }] } : { text: lastToolContent(req)! };
      return { error: new Error('provider exploded') };
    };
    const { factory } = scriptedFactory(script);
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    const result = await runtime.createSession().run('go');
    assert.equal(result.status, AgentTerminateMode.GOAL, 'the parent keeps going');
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.CHILD_AGENT_ERROR);
    const payload = JSON.parse(result.text) as ChildResultPayload;
    assert.equal(payload.status, 'error');
    assert.match(payload.error!, /provider exploded/);
  });

  test('cancellation propagates into a running child', async () => {
    const { tree } = tree3();
    const script: Script = (_req, n, agent) =>
      agent === 'main' ? (n === 0 ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'other', task: 'slow' } }] } : { text: 'x' }) : { text: 'slow', delayMs: 10_000 };
    const { factory } = scriptedFactory(script);
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const started = Date.now();
    const result = await runtime.createSession().run('go', {
      signal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'agent_start' && e.agentPath.length === 2) setTimeout(() => controller.abort(), 100);
      },
    });
    assert.equal(result.status, AgentTerminateMode.CANCELLED);
    assert.ok(Date.now() - started < 5000);
    const childEnd = events.find((e) => e.type === 'agent_end' && e.agentPath.length === 2) as { result: { status: string } };
    assert.equal(childEnd.result.status, AgentTerminateMode.CANCELLED);
  });

  test('maxConcurrentChildren limits simultaneous child runs', async () => {
    const dir = makeTempDir();
    writeJson(path.join(dir, 'agent.json'), baseAgent('main', { spawn: { children: ['a.json', 'b.json', 'c.json'], maxConcurrentChildren: 2 } }));
    for (const id of ['a', 'b', 'c']) writeJson(path.join(dir, `${id}.json`), baseAgent(id));
    const tree = loadAgentTree(path.join(dir, 'agent.json'));
    let active = 0;
    let peak = 0;
    const { factory } = scriptedFactory(() => ({ text: 'ok' }));
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    // Wrap run to observe concurrency when children are started in parallel.
    const originalRun = runtime.run.bind(runtime);
    runtime.run = async (params) => {
      if (params.agentPath.length > 1) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        return await originalRun(params);
      } finally {
        if (params.agentPath.length > 1) active--;
      }
    };
    const signal = new AbortController().signal;
    const results = await Promise.all(
      tree.root.children.map((child) => runtime.runChild({ parent: tree.root, parentPath: ['main'], child, task: 't', signal, emit: () => {} })),
    );
    assert.ok(results.every((r) => r.status === AgentTerminateMode.GOAL));
    assert.equal(peak, 2);
  });

  test('task and context size is bounded', async () => {
    const { tree } = tree3();
    const { factory } = scriptedFactory((req, n, agent) =>
      agent === 'main' && n === 0 ? { toolCalls: [{ name: 'invoke_child', args: { agent: 'other', task: 'x'.repeat(40_000) } }] } : { text: lastToolContent(req) ?? '' },
    );
    const runtime = track(new AgentRuntime({ tree, providerFactory: factory }));
    const result = await runtime.createSession().run('go');
    assert.equal(result.toolCalls[0]!.errorType, ToolErrorType.INVALID_TOOL_PARAMS);
    assert.match(result.text, /at most 32000 characters/);
  });
});
