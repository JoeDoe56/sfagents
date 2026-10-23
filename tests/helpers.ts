/**
 * Test helpers: a scripted model provider, temporary configuration
 * directories, the local MCP test server over HTTP, and a mock
 * OpenAI-compatible HTTP endpoint for end-to-end CLI tests.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  AgentDefinition,
  AssistantMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ParsedToolCall,
  RuntimeEvent,
} from '@sfagents/core';

// Tests never touch the user's settings, provider list or keyring entries.
if (!process.env['SFAGENTS_TEST_HOME_SET']) {
  process.env['SFAGENTS_HOME'] = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-home-')));
  process.env['SFAGENTS_KEYRING_SERVICE'] = 'SF Agents test';
  process.env['SFAGENTS_TEST_HOME_SET'] = '1';
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MCP_SERVER_SCRIPT = path.join(REPO_ROOT, 'tests', 'fixtures', 'test-mcp-server.mjs');
export const CLI_ENTRY = path.join(REPO_ROOT, 'cli', 'bin', 'sfagents.js');

export interface ScriptStep {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args?: Record<string, unknown>; id?: string }>;
  error?: Error;
  /** Opaque reasoning continuation blocks returned with the message. */
  reasoningDetails?: Array<Record<string, unknown>>;
  /** Wait before responding (honours abort). */
  delayMs?: number;
  finishReason?: string;
}

export type Script = (request: ModelRequest, call: number, agentId: string) => ScriptStep;

/** A ModelProvider that answers from a script and records every request. */
export class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly requests: Array<{ agentId: string; request: ModelRequest; messages: unknown[] }> = [];
  private calls = new Map<string, number>();

  constructor(
    private readonly script: Script,
    private readonly agentId: string,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const n = this.calls.get(this.agentId) ?? 0;
    this.calls.set(this.agentId, n + 1);
    this.requests.push({ agentId: this.agentId, request, messages: structuredClone(request.messages) as unknown[] });
    const step = this.script(request, n, this.agentId);
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, step.delayMs);
        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          },
          { once: true },
        );
      });
    }
    if (step.error) throw step.error;
    if (step.reasoning) yield { type: 'reasoning', text: step.reasoning };
    if (step.text) {
      // Stream in two pieces to exercise concatenation.
      const mid = Math.floor(step.text.length / 2);
      yield { type: 'text', text: step.text.slice(0, mid) };
      yield { type: 'text', text: step.text.slice(mid) };
    }
    const toolCalls: ParsedToolCall[] = (step.toolCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${this.agentId}_${n}_${i}`,
      name: c.name,
      args: c.args ?? {},
      rawArguments: JSON.stringify(c.args ?? {}),
    }));
    const message: AssistantMessage = { role: 'assistant', content: step.text ?? null };
    if (step.reasoningDetails) message.reasoning_details = step.reasoningDetails;
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }));
    }
    yield { type: 'done', message, toolCalls, finishReason: step.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'), usage: { totalTokens: 10 } };
  }
}

/** Provider factory handing each agent its own ScriptedProvider sharing one script. */
export function scriptedFactory(script: Script) {
  const providers = new Map<string, ScriptedProvider>();
  const factory = (def: Readonly<AgentDefinition>) => {
    let p = providers.get(def.id);
    if (!p) {
      p = new ScriptedProvider(script, def.id);
      providers.set(def.id, p);
    }
    return p;
  };
  return { factory, providers };
}

/** Last tool message content in a request, if any. */
export function lastToolContent(request: ModelRequest): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    if (m.role === 'tool') return m.content;
  }
  return undefined;
}

export function toolContents(request: ModelRequest): string[] {
  return request.messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
}

export function makeTempDir(prefix = 'sfagents-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Writes an agent definition to <project>/agents/<id>.json (the id defaults to "main"). */
export function writeAgent(projectDir: string, definition: Record<string, unknown>): string {
  const file = path.join(projectDir, 'agents', `${String(definition['id'] ?? 'main')}.json`);
  writeJson(file, definition);
  return file;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function baseAgent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    provider: 'openrouter',
    model: 'test/model',
    systemPrompt: `You are ${id}.`,
    ...extra,
  };
}

export function collectEvents(): { events: RuntimeEvent[]; onEvent: (e: RuntimeEvent) => void } {
  const events: RuntimeEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

export function stdioServerConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [MCP_SERVER_SCRIPT], ...extra };
}

/** Starts the test MCP server in Streamable HTTP mode. */
export async function startHttpMcpServer(env: NodeJS.ProcessEnv = {}): Promise<{ url: string; stop: () => Promise<void>; child: ChildProcess }> {
  const child = spawn(process.execPath, [MCP_SERVER_SCRIPT, '--http', '0'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('HTTP MCP server did not start')), 10_000);
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`HTTP MCP server exited with ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

export type MockChatHandler = (body: { model: string; messages: Array<Record<string, unknown>>; tools?: unknown[] }) => ScriptStep;

/**
 * A minimal OpenAI-compatible /v1/chat/completions endpoint that streams
 * SSE chunks the way providers do (content deltas, tool_call deltas split
 * across chunks, finish_reason, usage).
 */
export async function startMockOpenAI(handler: MockChatHandler): Promise<{ baseUrl: string; requests: unknown[]; stop: () => Promise<void> }> {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const step = handler(body);
      if (step.error) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: step.error.message } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      if (step.text) {
        for (const piece of step.text.match(/.{1,7}/gs) ?? []) send({ content: piece });
      }
      (step.toolCalls ?? []).forEach((call, i) => {
        const args = JSON.stringify(call.args ?? {});
        const half = Math.floor(args.length / 2);
        send({ tool_calls: [{ index: i, id: call.id ?? `call_${i}_${requests.length}`, type: 'function', function: { name: call.name, arguments: '' } }] });
        send({ tool_calls: [{ index: i, function: { arguments: args.slice(0, half) } }] });
        send({ tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] });
      });
      send({}, step.finishReason ?? (step.toolCalls?.length ? 'tool_calls' : 'stop'));
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...options.env };
    delete env['OPENROUTER_API_KEY'];
    if (options.env?.['OPENROUTER_API_KEY']) env['OPENROUTER_API_KEY'] = options.env['OPENROUTER_API_KEY'];
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out. stdout=${stdout} stderr=${stderr}`));
    }, options.timeoutMs ?? 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}
