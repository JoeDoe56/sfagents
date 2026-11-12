/**
 * Anthropic through a Claude plan: the Claude Agent SDK and its bundled
 * native executable, authorized with a long-lived token from
 * `claude setup-token` (kept in the OS keyring and passed to the SDK process
 * only in its environment).
 *
 * Adapted from the project owner's LLM-Proxy (claude-backend.mjs): each
 * request is stateless and carries the whole conversation (laid out so the
 * prompt cache can reuse it: see prepareClaudeRequest); the SDK's own
 * tools are off and SF Agents' tools are offered through an in-process MCP
 * server whose calls are captured and returned to SF Agents to execute.
 */

import { rememberContextWindow } from './context-windows.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import xtermHeadless from '@xterm/headless';
import { removeDir } from '../utils/remove-dir.js';
import {
  ProviderError,
  type AssistantMessage,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ParsedToolCall,
  type TokenUsage,
} from './types.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { ensureDir } from '../settings/home.js';
import { toEpochMs, toPercent, type PlanUsage, type PlanUsageStore, type UsageWindow } from './usage.js';

const require = createRequire(import.meta.url);
const { Terminal } = xtermHeadless;
const PREFIX = 'mcp__sfagents__';
const GUARDRAIL =
  'Act as a language model completing the supplied conversation. Answer the last message. Do not inspect this computer or execute tools yourself: call the supplied functions, whose results the client returns in a later message.';
const BLOCKED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'NotebookEdit', 'TodoWrite'];
const SIGN_IN_COLS = 1000;
const SIGN_IN_ROWS = 60;
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
      // Never inherit a switch that turns prompt caching off.
      key.startsWith('DISABLE_PROMPT_CACHING') ||
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
  private screen: ClaudeScreen | null;
  private exitedAt = 0;
  private finished = false;
  private readonly dir: string;

  private constructor(private readonly pty: Pty, url: string, dir: string, output: string, timeoutMs: number) {
    this.url = url;
    this.dir = dir;
    this.screen = new ClaudeScreen();
    this.screen.write(output);
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
      let checking = false;
      const poll = setInterval(() => {
        if (checking || !this.screen) return;
        checking = true;
        const exitedAt = this.exitedAt;
        void this.screen
          .text()
          .then((text) => {
            const token = findSetupToken(text, exitedAt > 0);
            if (token) finish(null, token);
            else if (/OAuth error|invalid_grant|code (?:has )?expired|Login failed/i.test(text)) finish(new ProviderError(`Claude did not complete the sign-in. Start again.${lastWords(text)}`, 400));
            // A terminal can deliver its last output after the exit (Windows
            // ConPTY does): give it a moment before giving up.
            else if (exitedAt && Date.now() - exitedAt > EXIT_GRACE_MS) finish(new ProviderError(`Claude sign-in ended without a token.${lastWords(text)}`, 400));
          })
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      }, 200);
      this.abort = (e) => finish(e);
    });
    this.done.catch(() => {});
    pty.onData((d) => {
      this.screen?.write(d);
    });
    pty.onExit(() => {
      this.exitedAt = Date.now();
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
    const child = pty.spawn(executable, ['setup-token'], { name: 'xterm-256color', cols: SIGN_IN_COLS, rows: SIGN_IN_ROWS, cwd: dir, env: claudeEnv(dir) as Record<string, string> });
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
    this.screen?.dispose();
    this.screen = null;
    if (!this.exitedAt) {
      try {
        this.pty.kill();
      } catch {
        // already gone
      }
    }
    removeDir(this.dir);
  }
}

const EXIT_GRACE_MS = 1500;
const TOKEN = /sk-ant-oat\d*-[A-Za-z0-9_-]{20,}/;

/**
 * Claude's screen as a terminal would show it. Claude Code draws with cursor
 * moves (words placed by column jumps, the success screen painted over the
 * previous frame, and on Windows ConPTY repaints rows by position), so its
 * raw output is not text: emulate the terminal and read the rows instead.
 */
class ClaudeScreen {
  private readonly term = new Terminal({ cols: SIGN_IN_COLS, rows: SIGN_IN_ROWS, scrollback: 2000, allowProposedApi: true });

  write(data: string): void {
    this.term.write(data);
  }

  /** The rows on screen and in scrollback, once everything written so far is drawn. */
  text(): Promise<string> {
    return new Promise((resolve) => {
      this.term.write('', () => {
        const buffer = this.term.buffer.active;
        const rows: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          if (!line) continue;
          const text = line.translateToString(true);
          if (line.isWrapped && rows.length) rows[rows.length - 1] += text;
          else rows.push(text);
        }
        resolve(rows.join('\n'));
      });
    });
  }

  dispose(): void {
    this.term.dispose();
  }
}

/**
 * The setup token on Claude's screen. While Claude runs, a token counts only
 * once the screen shows more after it (the line below it), so a token still
 * arriving in pieces is never taken short; after Claude exits, any token.
 */
export function findSetupToken(screen: string, exited: boolean): string | null {
  const rows = screen.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const m = TOKEN.exec(rows[i]!);
    if (!m) continue;
    const after = rows[i]!.slice(m.index + m[0].length);
    // Something else glued to the token on its row: not a token we trust.
    if (after && !/^\s/.test(after)) continue;
    if (exited || after.trim() || rows.slice(i + 1).some((r) => r.trim())) return m[0];
  }
  return null;
}

/** The end of what Claude showed, for an error (any token hidden). */
function lastWords(screen: string): string {
  const lines = screen
    .split('\n')
    .map((l) => l.replace(new RegExp(TOKEN.source, 'g'), '[token]').trim())
    .filter(Boolean)
    .slice(-4);
  const text = lines.join(' / ').slice(-400);
  return text ? ` Claude showed: "${text}"` : '';
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
  /** The user message's content blocks: a fixed header, then the conversation, one block per message (images after their message). */
  blocks: Array<Record<string, unknown>>;
  /** The text blocks joined (tests and logs). */
  prompt: string;
  images: string[];
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  effort?: string;
}

/** Marks where each message starts; never appears inside a message (see plain()). */
const MARK = '⟦';
const END = '⟧';
const TRANSCRIPT_HEADER = `Complete this conversation. Each following block is one message of it, in order, starting with a line that names it: ${MARK}user${END}, ${MARK}assistant${END}, ${MARK}assistant calls NAME id=ID${END} (followed by the call's arguments as JSON), or ${MARK}tool result id=ID${END} (followed by what the client returned for that call). Only these lines start messages. Answer the last message.`;

/** Message text with the start markers made harmless, so no text inside a message can pose as another message. */
function plain(text: string): string {
  return text.replaceAll(MARK, '⟨').replaceAll(END, '⟩');
}

/**
 * The conversation as one user message for the SDK, laid out for Anthropic's
 * prompt cache: the cache matches prefixes block by block, so every message
 * is its own block that never changes once sent, and each request only adds
 * blocks at the end. (One block holding the whole transcript changed on
 * every request, so nothing past the system prompt and tools was ever read
 * back from the cache, and the whole history was written to it again each
 * time.) The results of one turn's tool calls share a block. Messages are
 * plain text, not JSON: escaped JSON (code and command output above all)
 * costs noticeably more tokens.
 */
export function prepareClaudeRequest(request: ModelRequest): PreparedClaude {
  const system: string[] = [];
  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: TRANSCRIPT_HEADER }];
  const images: string[] = [];
  let toolBlock: { type: 'text'; text: string } | null = null;
  const text = (value: string) => {
    toolBlock = null;
    blocks.push({ type: 'text', text: value });
  };
  for (const m of request.messages as readonly ChatMessage[]) {
    if (m.role === 'system') {
      system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      const entry = `${MARK}tool result id=${plain(m.tool_call_id)}${END}\n${plain(m.content)}`;
      if (toolBlock) (toolBlock as { text: string }).text += `\n\n${entry}`;
      else {
        toolBlock = { type: 'text', text: entry };
        blocks.push(toolBlock);
      }
      continue;
    }
    if (m.role === 'assistant') {
      const calls = m.tool_calls ?? [];
      if (!m.content && !calls.length) continue;
      const parts = [...(m.content ? [`${MARK}assistant${END}\n${plain(m.content)}`] : []), ...calls.map((t) => `${MARK}assistant calls ${plain(t.function.name)} id=${plain(t.id)}${END}\n${plain(t.function.arguments || '{}')}`)];
      text(parts.join('\n\n'));
      continue;
    }
    if (typeof m.content === 'string') {
      text(`${MARK}user${END}\n${plain(m.content)}`);
      continue;
    }
    const mine: string[] = [];
    const content = m.content
      .map((p) => {
        if (p.type === 'text') return p.text;
        images.push(p.image_url.url);
        mine.push(p.image_url.url);
        return `[Attached image ${images.length}]`;
      })
      .join('\n');
    text(`${MARK}user${END}\n${plain(content)}`);
    for (const url of mine) blocks.push(imageBlock(url));
  }
  system.push(GUARDRAIL);
  return {
    model: CLAUDE_MODEL_ALIASES[request.model] ?? request.model,
    systemPrompt: system.join('\n\n'),
    blocks,
    prompt: blocks.filter((b) => b['type'] === 'text').map((b) => String(b['text'])).join('\n'),
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
const LIMIT_TEXT = /usage limit|rate limit|limit reached|overloaded|out of extra usage|weekly limit|5-hour limit|session limit|opus limit|hit your (?:\w+ )?limit/i;
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

  /** A limit error marks the plan as at its limit in the usage bar. */
  private limited(error: ProviderError): ProviderError {
    if (error.status === 429 && this.options.usage) this.options.usage.update(this.options.usageKey ?? this.id, { limitReached: true });
    return error;
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
    // Calls for tools SF Agents does not have (a Claude Code tool name, or a
    // made-up one). Claude Code would answer them with an error and ask the
    // model again, a second API call that rereads the whole context; instead
    // the turn ends with them, and SF Agents answers them like any unknown tool.
    const unknown: ParsedToolCall[] = [];
    const capture = (rawName: string, input: unknown, id?: string) => {
      const name = rawName.startsWith(PREFIX) ? rawName.slice(PREFIX.length) : rawName;
      const callId = id || `call_${crypto.randomUUID()}`;
      if (calls.some((c) => c.id === callId) || unknown.some((c) => c.id === callId)) return;
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const call = { id: callId, name, args, rawArguments: JSON.stringify(args) };
      if (rawName.startsWith(PREFIX) && prepared.tools.some((t) => t.name === name)) calls.push(call);
      else unknown.push(call);
    };
    let servers: Record<string, unknown> | undefined;
    if (prepared.tools.length) {
      const server = new mcp.McpServer({ name: 'sfagents', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
        tools: prepared.tools.map((t) => ({ name: t.name, description: t.description || t.name, inputSchema: t.parameters ?? { type: 'object', properties: {} }, _meta: { 'anthropic/alwaysLoad': true } })),
      }));
      server.server.setRequestHandler(types.CallToolRequestSchema, async (req: any) => {
        capture(PREFIX + String(req.params.name), req.params.arguments ?? {}, undefined);
        return { isError: true, content: [{ type: 'text', text: 'Captured for client execution. Stop and return the call.' }] };
      });
      servers = { sfagents: { type: 'sdk', name: 'sfagents', instance: server } };
    }
    const blocks = prepared.blocks;
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
      // One API call per SF Agents turn: the loop below stops as soon as the
      // model's response ends; this is only a backstop.
      maxTurns: prepared.tools.length ? 4 : 2,
      ...(servers ? { mcpServers: servers } : {}),
      ...(prepared.effort ? { effort: prepared.effort } : {}),
      canUseTool: async (name: string, input: unknown, context: { toolUseID?: string }) => {
        capture(name, input, context.toolUseID);
        return { behavior: 'deny', message: 'Captured for client execution; nothing runs here.', interrupt: true };
      },
    };

    let query: any;
    let text = '';
    let result: any;
    // Usage per API call, from the stream (it is there even when the call fails or the loop stops early).
    const meter = new ClaudeMeter();
    // Tool calls as the stream builds them, by content block index.
    const building = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: string | null = null;
    let apiCalls = 0;
    const seenCalls = new Set<string>();
    const started = Date.now();
    yield { type: 'log', text: `Claude request: model ${prepared.model}, ${blocks.length} content blocks, ${prepared.tools.length} tools, system prompt ${prepared.systemPrompt.length} chars, transcript ${prepared.prompt.length} chars${prepared.effort ? `, effort ${prepared.effort}` : ''}` };
    try {
      query = sdk.query({ prompt: prompt(), options: sdkOptions });
      for await (const message of query) {
        if (controller.signal.aborted) break;
        if (message.type === 'stream_event') {
          const event = message.event ?? {};
          if (event.type === 'message_start') {
            // The same API call can be reported twice (seen in logs right after
            // a rate-limit update): count each message id once.
            const id = String(event.message?.id ?? '');
            if (id && seenCalls.has(id)) {
              yield { type: 'log', text: `Claude: message_start for ${id} again; counted once` };
              continue;
            }
            if (id) seenCalls.add(id);
            apiCalls++;
            if (apiCalls > 1) yield { type: 'log', text: `Claude: another API call (${id || 'no id'}) in the same turn: ${JSON.stringify(event.message?.usage ?? {})}` };
          }
          meter.event(event);
          const delta = event.delta;
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            building.set(event.index, { id: String(event.content_block.id ?? ''), name: String(event.content_block.name ?? ''), json: '' });
          } else if (event.type === 'content_block_stop' && building.has(event.index)) {
            const b = building.get(event.index)!;
            building.delete(event.index);
            let input: unknown = {};
            try {
              input = b.json ? JSON.parse(b.json) : {};
            } catch {
              input = undefined;
            }
            // Arguments that did not parse wait for the SDK's own message (or canUseTool).
            if (input !== undefined && b.name) capture(b.name, input, b.id);
          } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
            yield { type: 'log', text: `Claude: API call ${apiCalls} ended: ${stopReason}, ${calls.length} SF Agents tool call(s) so far${unknown.length ? `, unknown tool(s): ${unknown.map((c) => c.name).join(', ')}` : ''}, output ${JSON.stringify(event.usage ?? {})}` };
          } else if (event.type === 'message_stop') {
            // The response is complete. With tool calls, stop here: the SDK
            // would otherwise run its own tool round and ask the model again.
            if (calls.length || unknown.length) break;
          } else if (delta?.type === 'input_json_delta' && building.has(event.index)) {
            building.get(event.index)!.json += delta.partial_json ?? '';
          } else if (delta?.type === 'text_delta' && delta.text) {
            text += delta.text;
            yield { type: 'text', text: delta.text };
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'reasoning', text: delta.thinking };
          }
        } else if (message.type === 'rate_limit_event') {
          const u = claudePlanUsage(message.rate_limit_info);
          if (u && this.options.usage) this.options.usage.update(this.options.usageKey ?? this.id, u);
          yield { type: 'log', text: `Claude rate limit event: ${JSON.stringify(message.rate_limit_info ?? {})}` };
        } else if (message.type === 'assistant') {
          for (const block of message.message?.content ?? []) {
            if (block.type === 'tool_use' && typeof block.name === 'string') capture(block.name, block.input, block.id);
            else if (block.type === 'text' && !text && !calls.length) text += block.text;
          }
          if (!meter.seen && message.message?.usage) meter.add(message.message.usage);
        } else if (message.type === 'result') {
          result = message;
          break;
        }
      }
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) throw request.signal.reason ?? error;
      const usage = meter.usage(apiCalls);
      if (controller.signal.reason instanceof ProviderError) throw withUsage(controller.signal.reason, usage);
      throw this.limited(classify(getErrorMessage(error), usage));
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
    if (!meter.seen && result) meter.fromResult(result);
    // The model's window, as Claude Code reports it, for the context bar.
    for (const u of Object.values((result?.modelUsage ?? {}) as Record<string, { contextWindow?: number }>)) {
      if (typeof u?.contextWindow === 'number') rememberContextWindow('anthropic', request.model, u.contextWindow);
    }
    if (unknown.length) yield { type: 'log', text: `Claude asked for tool(s) SF Agents does not have: ${unknown.map((c) => `${c.name} ${c.rawArguments.slice(0, 200)}`).join('; ')}` };
    // They go back as calls, so SF Agents answers them with its list of tools.
    calls.push(...unknown);
    const usage = meter.usage(apiCalls || result?.num_turns);
    yield {
      type: 'log',
      text: `Claude response: ${Date.now() - started} ms, stop ${stopReason ?? result?.stop_reason ?? result?.subtype ?? 'unknown'}, ${calls.length} tool call(s)${result ? `, SDK turns ${result.num_turns ?? '?'}` : ', stopped after the response'}${result?.modelUsage ? `, by model ${JSON.stringify(result.modelUsage)}` : ''}`,
    };
    if (!result && !calls.length && !text) throw new ProviderError('Claude ended without a result.', 502, true, usage);
    if (result?.is_error && !calls.length) throw this.limited(classify(String(result.result ?? result.subtype ?? 'error'), usage));
    if (!text && !calls.length && typeof result?.result === 'string') {
      text = result.result;
      yield { type: 'text', text };
    }
    // A reply came back: the plan is not at its limit (any more).
    const key = this.options.usageKey ?? this.id;
    if (this.options.usage?.get(key)?.limitReached) this.options.usage.update(key, { limitReached: false });
    const message: AssistantMessage = { role: 'assistant', content: text || null };
    if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }));
    yield { type: 'done', message, toolCalls: calls, finishReason: calls.length ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop', usage };
  }
}

/**
 * Adds up what each API call used, from the stream's message_start (input
 * and cache counters) and message_delta (output) events. Usage is per call,
 * so a request that runs into a limit still reports what it spent.
 */
class ClaudeMeter {
  private input = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private output = 0;
  seen = false;

  event(event: any): void {
    if (event?.type === 'message_start' && event.message?.usage) this.add(event.message.usage, true);
    else if (event?.type === 'message_delta' && event.usage) {
      // message_delta carries the final output count (cumulative for that call).
      const out = Number(event.usage.output_tokens);
      if (Number.isFinite(out)) this.output += Math.max(0, out - this.lastStartOutput);
      this.lastStartOutput = Number.isFinite(out) ? out : this.lastStartOutput;
    }
  }

  private lastStartOutput = 0;

  add(u: any, start = false): void {
    this.seen = true;
    this.input += num(u.input_tokens);
    this.cacheRead += num(u.cache_read_input_tokens);
    this.cacheWrite += num(u.cache_creation_input_tokens);
    const out = num(u.output_tokens);
    this.output += out;
    if (start) this.lastStartOutput = out;
  }

  /** Without stream events (an older SDK, tests): the result's totals. */
  fromResult(result: any): void {
    const values = Object.values(result.modelUsage ?? {}) as any[];
    if (values.length) {
      this.seen = true;
      for (const x of values) {
        this.input += num(x.inputTokens);
        this.cacheRead += num(x.cacheReadInputTokens);
        this.cacheWrite += num(x.cacheCreationInputTokens);
        this.output += num(x.outputTokens);
      }
    } else if (result.usage) this.add(result.usage);
  }

  usage(requests?: number): TokenUsage | undefined {
    if (!this.seen) return undefined;
    const prompt = this.input + this.cacheRead + this.cacheWrite;
    return {
      promptTokens: prompt,
      completionTokens: this.output,
      totalTokens: prompt + this.output,
      inputTokens: this.input,
      cacheReadTokens: this.cacheRead,
      cacheWriteTokens: this.cacheWrite,
      ...(requests ? { requests } : {}),
    };
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function withUsage(error: ProviderError, usage: TokenUsage | undefined): ProviderError {
  return usage && !error.usage ? new ProviderError(error.message, error.status, error.retryable, usage) : error;
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

function classify(detail: string, usage?: TokenUsage): ProviderError {
  if (LIMIT_TEXT.test(detail)) return new ProviderError(`Claude: ${detail}`, 429, false, usage);
  if (AUTH_TEXT.test(detail)) return new ProviderError(`Claude sign-in was rejected (${detail}). Sign in again in Settings → Providers.`, 401, false, usage);
  return new ProviderError(`Claude request failed: ${detail}`, 502, true, usage);
}
