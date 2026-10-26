/**
 * Anthropic through a Claude plan: the Claude Agent SDK and its bundled
 * native executable, authorized with a long-lived token from
 * `claude setup-token` (kept in the OS keyring and passed to the SDK process
 * only in its environment).
 *
 * Adapted from the project owner's LLM-Proxy (claude-backend.mjs): each
 * request is stateless and carries the whole conversation; the SDK's own
 * tools are off and SF Agents' tools are offered through an in-process MCP
 * server whose calls are captured and returned to SF Agents to execute.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { removeDir } from '../utils/remove-dir.js';
import {
  ProviderError,
  type AssistantMessage,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ParsedToolCall,
} from './types.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { ensureDir } from '../settings/home.js';
import { toEpochMs, toPercent, type PlanUsage, type PlanUsageStore, type UsageWindow } from './usage.js';

const require = createRequire(import.meta.url);
const PREFIX = 'mcp__sfagents__';
const GUARDRAIL =
  'Act as a language model completing the supplied conversation. Answer the last message. Do not inspect this computer or execute tools yourself: call the supplied functions, whose results the client returns in a later message.';
const BLOCKED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'NotebookEdit', 'TodoWrite'];
const AUTH_ORIGINS = ['https://claude.com', 'https://claude.ai', 'https://platform.claude.com', 'https://console.anthropic.com'];

export const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  'claude-opus': 'claude-opus-5-5',
  'claude-sonnet': 'claude-sonnet-5-5',
  'claude-fable': 'claude-fable-5-1',
  'claude-haiku': 'claude-haiku-5-5',
};
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
];

/** The SDK's native executable for this platform. */
export function claudeExecutable(): string {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude');
  } catch {
    throw new ProviderError(`Claude support is not installed for ${process.platform}-${process.arch} (${pkg} is missing). Reinstall SF Agents' dependencies.`, 503);
  }
}

/** The SDK process's environment: no inherited Anthropic keys or other billing, our token only. */
export function claudeEnv(configDir: string, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('ANTHROPIC_') ||
      key.startsWith('CLAUDE_CODE_USE_') ||
      ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'OPENROUTER_API_KEY'].includes(key)
    )
      delete env[key];
  }
  if (token) env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
  return env;
}

// ------------------------------------------------------------------ sign-in

interface Pty {
  onData(cb: (d: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(d: string): void;
  kill(): void;
}

/**
 * `claude setup-token` in a pseudo-terminal. Claude opens its sign-in page in
 * this computer's browser by itself, and the page returns to a listener
 * Claude runs here; Claude then prints the long-lived token, which `done`
 * captures (it is never shown). Signing in from another device is not
 * supported: that page ends with a code instead.
 */
export class ClaudeSignIn {
  /** The sign-in address Claude printed (for display only: it ends with a code to paste, which SF Agents does not take). */
  readonly url: string;
  readonly done: Promise<string>;
  private output = '';
  private exited = false;
  private finished = false;
  private readonly dir: string;

  private constructor(private readonly pty: Pty, url: string, dir: string, output: string, timeoutMs: number) {
    this.url = url;
    this.dir = dir;
    this.output = output;
    this.done = new Promise<string>((resolve, reject) => {
      const finish = (error: Error | null, token?: string) => {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(timer);
        clearInterval(poll);
        // Settle first: cleaning up must never lose a token that arrived.
        if (error) reject(error);
        else resolve(token!);
        this.cleanUp();
      };
      const timer = setTimeout(() => finish(new ProviderError('Sign-in timed out after 10 minutes. Start again.', 408)), timeoutMs);
      timer.unref?.();
      const poll = setInterval(() => {
        const text = strip(this.output);
        const token = /sk-ant-oat\d*-[A-Za-z0-9_-]{20,}/.exec(text)?.[0];
        if (token) finish(null, token);
        else if (/OAuth error|invalid_grant|code (?:has )?expired|Login failed/i.test(text)) finish(new ProviderError('Claude did not complete the sign-in. Start again.', 400));
        else if (this.exited) finish(new ProviderError('Claude sign-in ended without a token.', 400));
      }, 200);
      this.abort = (e) => finish(e);
    });
    this.done.catch(() => {});
    pty.onData((d) => {
      this.output = (this.output + d).slice(-65536);
    });
    pty.onExit(() => {
      this.exited = true;
    });
  }

  private abort: (e: Error) => void = () => {};

  static async start(options: { executable?: string; timeoutMs?: number; signInTimeoutMs?: number } = {}): Promise<ClaudeSignIn> {
    let pty: typeof import('node-pty');
    try {
      pty = await import('node-pty');
    } catch (error) {
      throw new ProviderError(`Claude sign-in needs the terminal module (node-pty), which did not load: ${getErrorMessage(error)}`, 503);
    }
    const executable = options.executable ?? claudeExecutable();
    // A throwaway profile: setup-token prints the token and must not keep one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-claude-signin-'));
    const child = pty.spawn(executable, ['setup-token'], { name: 'xterm-256color', cols: 1000, rows: 60, cwd: dir, env: claudeEnv(dir) as Record<string, string> });
    let output = '';
    const sub = child.onData((d) => {
      output = (output + d).slice(-65536);
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ProviderError('Claude sign-in did not start in time. Try again.', 503)), options.timeoutMs ?? 30000);
        const poll = setInterval(() => {
          const found = findAuthUrl(output);
          if (found) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve(found);
          }
        }, 100);
        child.onExit(() => {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new ProviderError('Claude sign-in ended before showing a sign-in address.', 503));
        });
      });
      sub.dispose();
      return new ClaudeSignIn(child, url, dir, output, options.signInTimeoutMs ?? 600_000);
    } catch (error) {
      try {
        child.kill();
      } catch {
        // already gone
      }
      removeDir(dir);
      throw error;
    }
  }

  cancel(): void {
    if (!this.finished) {
      this.abort(new ProviderError('Sign-in cancelled.', 400));
      return;
    }
    this.cleanUp();
  }

  /** Stops Claude and deletes the throwaway profile; never throws (on Windows the folder may stay busy for a moment). */
  private cleanUp(): void {
    this.output = '';
    if (!this.exited) {
      try {
        this.pty.kill();
      } catch {
        // already gone
      }
    }
    removeDir(this.dir);
  }
}

function strip(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[78=>]/g, '')
    .replace(/[\r\n]+/g, '\n');
}

export function findAuthUrl(raw: string): string | null {
  // The address is in an OSC 8 hyperlink and also printed; take the first well-formed one.
  for (const m of raw.matchAll(/https:\/\/[^\s\x07\x1b"']+/g)) {
    try {
      const u = new URL(m[0]);
      if (AUTH_ORIGINS.includes(u.origin) && u.searchParams.has('state') && !u.username) return u.href;
    } catch {
      // incomplete
    }
  }
  return null;
}

// ------------------------------------------------------------------ the provider

interface PreparedClaude {
  model: string;
  systemPrompt: string;
  prompt: string;
  images: string[];
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  effort?: string;
}

export function prepareClaudeRequest(request: ModelRequest): PreparedClaude {
  const system: string[] = [];
  const history: unknown[] = [];
  const images: string[] = [];
  for (const m of request.messages as readonly ChatMessage[]) {
    if (m.role === 'system') {
      system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      history.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) history.push({ role: 'assistant', content: m.content });
      for (const t of m.tool_calls ?? []) history.push({ role: 'assistant', tool_call: { id: t.id, name: t.function.name, arguments: t.function.arguments } });
      continue;
    }
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((p) => {
              if (p.type === 'text') return p.text;
              images.push(p.image_url.url);
              return `[Attached image ${images.length}]`;
            })
            .join('\n');
    history.push({ role: 'user', content });
  }
  system.push(GUARDRAIL);
  return {
    model: CLAUDE_MODEL_ALIASES[request.model] ?? request.model,
    systemPrompt: system.join('\n\n'),
    prompt: `Complete this conversation (JSON transcript; "tool" messages are results the client returned for your function calls):\n${JSON.stringify(history)}`,
    images,
    tools: (request.tools ?? []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> })),
    effort: request.reasoning && ['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoning) ? request.reasoning : undefined,
  };
}

function imageBlock(url: string): Record<string, unknown> {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (!m) throw new ProviderError('Claude accepts attached images only as embedded data.', 400);
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2]!.replace(/\s/g, '') } };
}

/** Messages that mean the plan's limit was reached (another account may serve). */
const LIMIT_TEXT = /usage limit|rate limit|limit reached|overloaded|out of extra usage|weekly limit|5-hour limit/i;
const AUTH_TEXT = /invalid api key|oauth token|authenticat|unauthorized|not logged in|please run \/login|401/i;

export class ClaudeSubscriptionProvider implements ModelProvider {
  private readonly configDir: string;

  constructor(
    readonly id: string,
    private readonly token: () => Promise<string>,
    stateDir: string,
    private readonly options: { executable?: string; timeoutMs?: number; sdk?: unknown; usage?: PlanUsageStore; usageKey?: string } = {},
  ) {
    // The SDK keeps settings and caches here; never a credential (the token comes in the environment).
    this.configDir = ensureDir(stateDir);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const prepared = prepareClaudeRequest(request);
    let sdk: any;
    let mcp: any;
    let types: any;
    try {
      [sdk, mcp, types] = await Promise.all([
        this.options.sdk ? Promise.resolve(this.options.sdk) : import('@anthropic-ai/claude-agent-sdk'),
        import('@modelcontextprotocol/sdk/server/mcp.js'),
        import('@modelcontextprotocol/sdk/types.js'),
      ]);
    } catch (error) {
      throw new ProviderError(`Claude support is not installed (${getErrorMessage(error)}). Reinstall SF Agents' dependencies.`, 503);
    }
    const token = await this.token();
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ProviderError('Claude request timed out.', 504, true)), this.options.timeoutMs ?? 10 * 60_000);

    const calls: ParsedToolCall[] = [];
    const capture = (name: string, input: unknown, id?: string) => {
      if (!prepared.tools.some((t) => t.name === name)) return;
      const callId = id || `call_${crypto.randomUUID()}`;
      if (calls.some((c) => c.id === callId)) return;
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      calls.push({ id: callId, name, args, rawArguments: JSON.stringify(args) });
    };
    let servers: Record<string, unknown> | undefined;
    if (prepared.tools.length) {
      const server = new mcp.McpServer({ name: 'sfagents', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
        tools: prepared.tools.map((t) => ({ name: t.name, description: t.description || t.name, inputSchema: t.parameters ?? { type: 'object', properties: {} }, _meta: { 'anthropic/alwaysLoad': true } })),
      }));
      server.server.setRequestHandler(types.CallToolRequestSchema, async (req: any) => {
        capture(req.params.name, req.params.arguments ?? {}, undefined);
        return { isError: true, content: [{ type: 'text', text: 'Captured for client execution. Stop and return the call.' }] };
      });
      servers = { sfagents: { type: 'sdk', name: 'sfagents', instance: server } };
    }
    const blocks: unknown[] = [{ type: 'text', text: prepared.prompt }, ...prepared.images.map(imageBlock)];
    async function* prompt() {
      yield { type: 'user', session_id: '', message: { role: 'user', content: blocks }, parent_tool_use_id: null };
    }
    const sdkOptions = {
      model: prepared.model,
      systemPrompt: prepared.systemPrompt,
      cwd: this.configDir,
      env: claudeEnv(this.configDir, token),
      pathToClaudeCodeExecutable: this.options.executable ?? claudeExecutable(),
      abortController: controller,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      disallowedTools: BLOCKED,
      permissionMode: 'default',
      persistSession: false,
      includePartialMessages: true,
      maxTurns: prepared.tools.length ? 5 : 1,
      ...(servers ? { mcpServers: servers } : {}),
      ...(prepared.effort ? { effort: prepared.effort } : {}),
      canUseTool: async (name: string, input: unknown, context: { toolUseID?: string }) => {
        if (name.startsWith(PREFIX)) capture(name.slice(PREFIX.length), input, context.toolUseID);
        return { behavior: 'deny', message: 'Captured for client execution; nothing runs here.', interrupt: true };
      },
    };

    let query: any;
    let text = '';
    let result: any;
    try {
      query = sdk.query({ prompt: prompt(), options: sdkOptions });
      for await (const message of query) {
        if (controller.signal.aborted) break;
        if (message.type === 'stream_event') {
          const delta = message.event?.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            text += delta.text;
            yield { type: 'text', text: delta.text };
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'reasoning', text: delta.thinking };
          }
        } else if (message.type === 'rate_limit_event') {
          const u = claudePlanUsage(message.rate_limit_info);
          if (u && this.options.usage) this.options.usage.update(this.options.usageKey ?? this.id, u);
        } else if (message.type === 'assistant' && !text) {
          for (const block of message.message?.content ?? []) if (block.type === 'text' && !calls.length) text += block.text;
        } else if (message.type === 'result') {
          result = message;
          break;
        }
      }
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) throw request.signal.reason ?? error;
      if (controller.signal.reason instanceof ProviderError) throw controller.signal.reason;
      throw classify(getErrorMessage(error));
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      try {
        query?.close?.();
      } catch {
        // already closed
      }
    }
    if (request.signal.aborted) throw request.signal.reason;
    if (!result) throw new ProviderError('Claude ended without a result.', 502, true);
    if (result.is_error && !calls.length) throw classify(String(result.result ?? result.subtype ?? 'error'));
    if (!text && !calls.length && typeof result.result === 'string') {
      text = result.result;
      yield { type: 'text', text };
    }
    const usage = tokenUsage(result);
    const message: AssistantMessage = { role: 'assistant', content: text || null };
    if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }));
    yield { type: 'done', message, toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'stop', usage };
  }
}

function claudeWindow(utilization: unknown, resetsAt: unknown): UsageWindow | undefined {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  // Claude reports a fraction (0.42); the /usage data uses percentages.
  return { usedPercent: toPercent(utilization, utilization <= 1), resetsAt: toEpochMs(typeof resetsAt === 'string' ? Date.parse(resetsAt) : (resetsAt as number)) };
}

/** The SDK's rate-limit event to plan usage: the overall 5-hour and weekly windows (not the per-model ones). */
export function claudePlanUsage(info: any): Partial<PlanUsage> | null {
  if (!info || typeof info !== 'object') return null;
  const out: Partial<PlanUsage> = {};
  const windows = info.unifiedWindows;
  if (windows && typeof windows === 'object') {
    out.fiveHour = claudeWindow(windows.five_hour?.utilization, windows.five_hour?.resets_at);
    out.weekly = claudeWindow(windows.seven_day?.utilization, windows.seven_day?.resets_at);
  }
  if (info.rateLimitType === 'five_hour') out.fiveHour ??= claudeWindow(info.utilization, info.resetsAt);
  if (info.rateLimitType === 'seven_day') out.weekly ??= claudeWindow(info.utilization, info.resetsAt);
  const limited = info.status === 'rejected';
  // A rejection names the window that ran out, even without a figure.
  if (limited && info.rateLimitType === 'five_hour') out.fiveHour ??= { usedPercent: 100, resetsAt: toEpochMs(info.resetsAt) };
  if (limited && info.rateLimitType === 'seven_day') out.weekly ??= { usedPercent: 100, resetsAt: toEpochMs(info.resetsAt) };
  if (!out.fiveHour) delete out.fiveHour;
  if (!out.weekly) delete out.weekly;
  out.limitReached = limited;
  return out.fiveHour || out.weekly || limited ? out : null;
}

function classify(detail: string): ProviderError {
  if (LIMIT_TEXT.test(detail)) return new ProviderError(`Claude: ${detail}`, 429);
  if (AUTH_TEXT.test(detail)) return new ProviderError(`Claude sign-in was rejected (${detail}). Sign in again in Settings → Providers.`, 401);
  return new ProviderError(`Claude request failed: ${detail}`, 502, true);
}

function tokenUsage(result: any) {
  const values = Object.values(result.modelUsage ?? {}) as any[];
  const u = result.usage ?? {};
  const input = values.length
    ? values.reduce((s, x) => s + (x.inputTokens ?? 0) + (x.cacheReadInputTokens ?? 0) + (x.cacheCreationInputTokens ?? 0), 0)
    : (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const output = values.length ? values.reduce((s, x) => s + (x.outputTokens ?? 0), 0) : (u.output_tokens ?? 0);
  return { promptTokens: input, completionTokens: output, totalTokens: input + output, ...(Number.isFinite(result.total_cost_usd) ? {} : {}) };
}
