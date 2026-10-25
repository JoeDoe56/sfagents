/**
 * OpenAI through a ChatGPT plan, by way of OpenAI's own Codex: the `codex`
 * binary (from @openai/codex) runs as `codex app-server`, a JSON-RPC server
 * on stdin/stdout, signed in with "Sign in with ChatGPT".
 *
 * Like the Claude provider, each request is stateless: an ephemeral thread
 * gets the conversation as Responses items, SF Agents' tools as dynamic
 * tools, and one turn. Codex's own tools are switched off (shell, patching
 * aside, web search, images, sub-agents, goals, plans, user questions). The
 * one it always offers, apply_patch, runs in a read-only sandbox with every
 * approval declined, so nothing it writes lands. When the model calls an SF
 * Agents tool, the turn is interrupted once the response is complete and the
 * calls go back to SF Agents to run in its own sandbox.
 *
 * Each provider has its own Codex home (state, caches) under the providers
 * folder; Codex keeps the sign-in itself in the OS keyring. Codex also
 * reports the plan's 5-hour and weekly usage, which goes to the usage store.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
import { toEpochMs, toPercent, type PlanUsage, type PlanUsageStore, type UsageWindow } from './usage.js';
import { ensureDir } from '../settings/home.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

const require = createRequire(import.meta.url);

/** Features of Codex that would act on this computer or add tools; all off. */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'view_image',
  'image_generation',
  'multi_agent',
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'goals',
  'hooks',
  'sleep_tool',
  'skill_search',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'realtime_conversation',
  'workspace_dependencies',
  'worktrees',
];

/** Configuration overrides: no extra instructions, no user questions, sign-in in the keyring. */
export const CODEX_CONFIG = [
  'web_search="disabled"',
  'tools.experimental_request_user_input.enabled=false',
  'tools.update_plan.enabled=false',
  'skills.include_instructions=false',
  'include_environment_context=false',
  'include_permissions_instructions=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'project_doc_max_bytes=0',
  'cli_auth_credentials_store="keyring"',
  'check_for_update_on_startup=false',
  'analytics.enabled=false',
  'feedback.enabled=false',
];

export function codexArgs(): string[] {
  return ['app-server', ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]), ...CODEX_CONFIG.flatMap((c) => ['-c', c])];
}

const TARGETS: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

/** The Codex binary for this platform (from @openai/codex's platform package). */
export function codexExecutable(): string {
  const key = `${process.platform}-${process.arch}`;
  const target = TARGETS[key];
  const missing = () => new ProviderError(`OpenAI support (Codex) is not installed for ${key}. Reinstall SF Agents' dependencies.`, 503);
  if (!target) throw missing();
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const roots: string[] = [];
  try {
    const main = path.dirname(require.resolve('@openai/codex/package.json'));
    const fromMain = createRequire(path.join(main, 'package.json'));
    try {
      roots.push(path.join(path.dirname(fromMain.resolve(`@openai/codex-${key}/package.json`)), 'vendor'));
    } catch {
      // not installed next to the main package
    }
    roots.push(path.join(main, 'vendor'));
  } catch {
    throw missing();
  }
  for (const root of roots) {
    const file = path.join(root, target, 'bin', exe);
    if (fs.existsSync(file)) return file;
  }
  throw missing();
}

/** Codex's environment: its own home, and no inherited API keys (the plan, not API billing). */
export function codexEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  for (const key of Object.keys(env)) if (/^(OPENAI_|CODEX_API_KEY|CODEX_ACCESS_TOKEN|AZURE_OPENAI)/i.test(key)) delete env[key];
  return env;
}

// ------------------------------------------------------------------ the app server

type Json = any;

export interface CodexConnection {
  request(method: string, params?: Json, timeoutMs?: number): Promise<Json>;
  onNotification(listener: (method: string, params: Json) => void): () => void;
  /** Requests from Codex (approvals, tool calls): the handler's value is the answer. */
  onServerRequest(handler: (method: string, params: Json) => Promise<Json> | Json | undefined): () => void;
  readonly closed: boolean;
  close(): void;
}

export interface CodexServerOptions {
  executable?: string;
  /** Tests: another way to start the server (default: spawn the binary). */
  spawn?: (home: string) => ChildProcessWithoutNullStreams;
}

/** One `codex app-server` process, spoken to with newline-delimited JSON-RPC. */
export class CodexAppServer implements CodexConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private readonly notificationListeners = new Set<(method: string, params: Json) => void>();
  private readonly requestHandlers = new Set<(method: string, params: Json) => Promise<Json> | Json | undefined>();
  private exitError: Error | null = null;
  private stderr = '';

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        if (line.trim()) this.receive(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    child.on('error', (e) => this.fail(new ProviderError(`Codex could not start: ${getErrorMessage(e)}`, 503)));
    child.on('exit', (code, signal) => this.fail(new ProviderError(`Codex stopped (${signal ?? `exit code ${code}`}).${this.lastError()}`, 503, true)));
    child.stdin.on('error', () => {});
  }

  static async start(home: string, options: CodexServerOptions = {}): Promise<CodexAppServer> {
    ensureDir(home);
    const child = options.spawn
      ? options.spawn(home)
      : spawn(options.executable ?? codexExecutable(), codexArgs(), { cwd: home, env: codexEnv(home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const server = new CodexAppServer(child);
    try {
      await server.request('initialize', { clientInfo: { name: 'sfagents', title: 'SF Agents', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
      server.notify('initialized');
    } catch (error) {
      server.close();
      throw error;
    }
    return server;
  }

  get closed(): boolean {
    return this.exitError !== null;
  }

  private lastError(): string {
    const line = this.stderr
      .split('\n')
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter((l) => /error/i.test(l) && !/bubblewrap|PATH aliases/i.test(l))
      .pop();
    return line ? ` ${line.slice(0, 300)}` : '';
  }

  private fail(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const l of this.notificationListeners) l('sfagents/closed', { error: error.message });
  }

  private write(message: Json): void {
    if (this.exitError) throw this.exitError;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params?: Json): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  request(method: string, params?: Json, timeoutMs = 60_000): Promise<Json> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError(`Codex did not answer ${method} in time.`, 504, true));
      }, timeoutMs) : undefined;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params: params ?? null });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  onNotification(listener: (method: string, params: Json) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(handler: (method: string, params: Json) => Promise<Json> | Json | undefined): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  private receive(line: string): void {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.id !== undefined && m.id !== null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new CodexRpcError(String(m.error.message ?? 'Codex error'), m.error.code));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method !== 'string') return;
    if (m.id !== undefined && m.id !== null) {
      void this.answer(m.id, m.method, m.params);
      return;
    }
    for (const l of this.notificationListeners) {
      try {
        l(m.method, m.params);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private async answer(id: Json, method: string, params: Json): Promise<void> {
    for (const h of this.requestHandlers) {
      let result: Json;
      try {
        result = await h(method, params);
      } catch (error) {
        this.safeWrite({ id, error: { code: -32000, message: getErrorMessage(error) } });
        return;
      }
      if (result !== undefined) {
        this.safeWrite({ id, result });
        return;
      }
    }
    const fallback = defaultAnswer(method);
    if (fallback !== undefined) this.safeWrite({ id, result: fallback });
    else this.safeWrite({ id, error: { code: -32601, message: 'Not supported by SF Agents.' } });
  }

  private safeWrite(message: Json): void {
    try {
      this.write(message);
    } catch {
      // the server has gone
    }
  }

  close(): void {
    this.fail(new ProviderError('Codex was closed.', 503, true));
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

export class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

/** Answers to Codex's requests nobody else took: every approval is declined, nothing runs here. */
export function defaultAnswer(method: string): Json | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: { denied: { rejection: 'Not available in SF Agents. Use the tools SF Agents supplies.' } } };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------ sign-in

export interface CodexSignInResult {
  email?: string;
  plan?: string;
}

/**
 * One "Sign in with ChatGPT" through Codex. Open `url` in a browser on this
 * computer: OpenAI sends it back to Codex's listener here (port 1455), and
 * `done` resolves once Codex has the sign-in in the keyring.
 */
export class CodexSignIn {
  readonly done: Promise<CodexSignInResult>;
  private finished = false;

  private constructor(
    private readonly server: CodexConnection,
    readonly url: string,
    loginId: string,
    private readonly home: string,
    timeoutMs: number,
  ) {
    this.done = new Promise<CodexSignInResult>((resolve, reject) => {
      const timer = setTimeout(() => finish(new ProviderError('Sign-in timed out after 10 minutes. Start again.', 408)), timeoutMs);
      timer.unref?.();
      const off = server.onNotification((method, params) => {
        if (method === 'sfagents/closed') finish(new ProviderError('Codex stopped during the sign-in. Start again.', 503));
        if (method !== 'account/login/completed' || (params?.loginId && params.loginId !== loginId)) return;
        if (!params?.success) finish(new ProviderError(params?.error ? `Sign-in failed: ${params.error}` : 'Sign-in was cancelled or failed.', 400));
        else void this.account().then((r) => finish(null, r), (e) => finish(e));
      });
      const finish = (error: Error | null, result?: CodexSignInResult) => {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(timer);
        off();
        server.close();
        if (error) reject(error);
        else resolve(result!);
      };
      this.cancelImpl = () => {
        if (this.finished) return;
        void server.request('account/login/cancel', { loginId }, 5000).catch(() => {});
        setTimeout(() => finish(new ProviderError('Sign-in cancelled.', 400)), 300).unref?.();
      };
    });
    this.done.catch(() => {});
  }

  private cancelImpl: () => void = () => {};

  static async start(options: { home: string; timeoutMs?: number } & CodexServerOptions & { connect?: (home: string) => Promise<CodexConnection> }): Promise<CodexSignIn> {
    const server = options.connect ? await options.connect(options.home) : await CodexAppServer.start(options.home, options);
    try {
      const r = await server.request('account/login/start', { type: 'chatgpt' }, 30_000);
      if (r?.type !== 'chatgpt' || typeof r.authUrl !== 'string') throw new ProviderError('Codex did not start a ChatGPT sign-in.', 502);
      const u = new URL(r.authUrl);
      if (u.origin !== 'https://auth.openai.com' || u.username || u.password) throw new ProviderError('Codex returned an unexpected sign-in address.', 502);
      return new CodexSignIn(server, u.href, String(r.loginId), options.home, options.timeoutMs ?? 600_000);
    } catch (error) {
      server.close();
      if (error instanceof CodexRpcError && /already|in progress|address in use|1455/i.test(error.message))
        throw new ProviderError('Another ChatGPT sign-in is already running on this computer (Codex or SF Agents). Finish or close it, then try again.', 409);
      throw error;
    }
  }

  /** Who signed in; refuses a sign-in that Codex wrote to a file instead of the keyring. */
  private async account(): Promise<CodexSignInResult> {
    const file = path.join(this.home, 'auth.json');
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      throw new ProviderError('Codex could not keep the sign-in in the system keyring and wrote it to a file instead, so it was deleted. Check that the keyring is unlocked, then sign in again.', 503);
    }
    const r = await this.server.request('account/read', { refreshToken: false }, 15_000);
    const a = r?.account;
    if (a?.type !== 'chatgpt') throw new ProviderError('Codex did not report a ChatGPT account after the sign-in.', 502);
    return { email: typeof a.email === 'string' ? a.email : undefined, plan: typeof a.planType === 'string' ? a.planType : undefined };
  }

  cancel(): void {
    this.cancelImpl();
  }
}

/** Signs a Codex home out (removes its keyring entry). */
export async function codexSignOut(home: string, options: CodexServerOptions = {}): Promise<void> {
  if (!fs.existsSync(home)) return;
  const server = await CodexAppServer.start(home, options);
  try {
    await server.request('account/logout', undefined, 15_000);
  } finally {
    server.close();
  }
}

// ------------------------------------------------------------------ usage

function usageWindow(w: Json): UsageWindow | undefined {
  if (!w || typeof w.usedPercent !== 'number') return undefined;
  return { usedPercent: toPercent(w.usedPercent, false), resetsAt: toEpochMs(w.resetsAt), ...(typeof w.windowDurationMins === 'number' ? { windowMinutes: w.windowDurationMins } : {}) };
}

/** Codex's rate-limit snapshot to plan usage: the window of about five hours, and the weekly one. */
export function codexPlanUsage(snapshot: Json): Partial<PlanUsage> | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const windows = [usageWindow(snapshot.primary), usageWindow(snapshot.secondary)].filter((w): w is UsageWindow => !!w);
  if (!windows.length && !snapshot.rateLimitReachedType && !snapshot.planType) return null;
  const out: Partial<PlanUsage> = {};
  for (const w of windows) {
    const minutes = w.windowMinutes;
    if (minutes !== undefined ? minutes <= 24 * 60 : w === windows[0]) out.fiveHour = w;
    else out.weekly = w;
  }
  if (typeof snapshot.planType === 'string') out.plan = snapshot.planType;
  out.limitReached = !!snapshot.rateLimitReachedType;
  return out;
}

// ------------------------------------------------------------------ the provider

const GUARDRAIL =
  'You are the model behind SF Agents. Use only the functions supplied by SF Agents; their results come back in later messages. Do not use apply_patch or any other built-in tool: they are not available here.';

/** Chat messages to Responses items for thread/inject_items, and the system text for the thread's instructions. */
export function toCodexItems(messages: readonly ChatMessage[]): { instructions: string; items: Json[] } {
  const system: string[] = [];
  const items: Json[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (!items.length) system.push(m.content);
      else items.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: m.content }] });
      continue;
    }
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      for (const t of m.tool_calls ?? []) items.push({ type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments || '{}' });
      continue;
    }
    const content =
      typeof m.content === 'string'
        ? [{ type: 'input_text', text: m.content }]
        : m.content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url }));
    items.push({ type: 'message', role: 'user', content });
  }
  system.push(GUARDRAIL);
  return { instructions: system.join('\n\n'), items };
}

function codexEffort(effort: ModelRequest['reasoning']): string | undefined {
  if (!effort) return undefined;
  if (effort === 'max') return 'xhigh';
  return effort;
}

/** A failed turn's error to a ProviderError: limits and sign-in problems let another account take over. */
export function codexError(error: Json): ProviderError {
  const message = String(error?.message ?? 'The request failed.');
  const info = error?.codexErrorInfo;
  const name = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  const status = info && typeof info === 'object' ? Object.values(info as Record<string, Json>)[0]?.httpStatusCode : undefined;
  if (name === 'usageLimitExceeded' || name === 'rateLimitExceeded') return new ProviderError(`OpenAI: ${message}`, 429);
  if (name === 'unauthorized' || status === 401) return new ProviderError(`The ChatGPT sign-in was rejected (${message}). Sign in again in Settings → Providers.`, 401);
  if (name === 'contextWindowExceeded') return new ProviderError(`OpenAI: ${message}`, 400);
  if (name === 'badRequest') return new ProviderError(`OpenAI: ${message}`, 400);
  if (typeof status === 'number' && status >= 400 && status < 500) return new ProviderError(`OpenAI: ${message}`, status);
  return new ProviderError(`OpenAI: ${message}`, 502, true);
}

function tokenUsage(u: Json): TokenUsage | undefined {
  if (!u) return undefined;
  const input = Number(u.inputTokens ?? u.input_tokens ?? 0);
  const output = Number(u.outputTokens ?? u.output_tokens ?? 0);
  return { promptTokens: input, completionTokens: output, totalTokens: Number(u.totalTokens ?? u.total_tokens ?? input + output) };
}

export interface CodexProviderOptions extends CodexServerOptions {
  /** Tests: the connection to use (default: a `codex app-server` per provider). */
  connect?: (home: string) => Promise<CodexConnection>;
  usage?: PlanUsageStore;
  timeoutMs?: number;
}

export class CodexProvider implements ModelProvider {
  private connection: Promise<CodexConnection> | null = null;
  private readonly workDir: string;

  constructor(
    readonly id: string,
    /** The provider record's id, for the usage store. */
    private readonly key: string,
    private readonly home: string,
    private readonly options: CodexProviderOptions = {},
  ) {
    // An empty folder as the thread's working directory: Codex has nothing here to look at.
    this.workDir = path.join(home, 'work');
  }

  private server(): Promise<CodexConnection> {
    const existing = this.connection;
    if (existing) {
      return existing.then(
        (c) => (c.closed ? this.reconnect() : c),
        () => this.reconnect(),
      );
    }
    return this.reconnect();
  }

  private reconnect(): Promise<CodexConnection> {
    ensureDir(this.workDir);
    this.connection = (this.options.connect ? this.options.connect(this.home) : CodexAppServer.start(this.home, this.options)).then((c) => {
      c.onNotification((method, params) => {
        if (method === 'account/rateLimits/updated') this.report(params?.rateLimits);
      });
      return c;
    });
    this.connection.catch(() => (this.connection = null));
    return this.connection;
  }

  private report(snapshot: Json): void {
    const u = codexPlanUsage(snapshot);
    if (u && this.options.usage) this.options.usage.update(this.key, u);
  }

  /** Reads the plan's usage now (and records it). */
  async readPlanUsage(): Promise<PlanUsage | undefined> {
    const c = await this.server();
    const r = await c.request('account/rateLimits/read', undefined, 20_000);
    const snapshot = r?.rateLimitsByLimitId?.codex ?? r?.rateLimits;
    this.report(snapshot);
    return this.options.usage?.get(this.key) ?? (codexPlanUsage(snapshot) as PlanUsage | undefined);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let conn: CodexConnection;
    try {
      conn = await this.server();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`Codex could not start: ${getErrorMessage(error)}`, 503, true);
    }
    const { instructions, items } = toCodexItems(request.messages);
    const tools = (request.tools ?? []).map((t) => ({ type: 'function', name: t.name, description: t.description || t.name, inputSchema: t.parameters ?? { type: 'object', properties: {} } }));
    const names = new Set(tools.map((t) => t.name));

    // Everything Codex says about this thread, in order, for the generator below.
    type Event = { kind: 'notification'; method: string; params: Json } | { kind: 'call'; params: Json };
    const queue: Event[] = [];
    let wake: (() => void) | null = null;
    const push = (e: Event) => {
      queue.push(e);
      wake?.();
    };
    let threadId: string | null = null;
    const early: Event[] = [];
    const offNote = conn.onNotification((method, params) => {
      if (method === 'sfagents/closed') return push({ kind: 'notification', method, params });
      const t = params?.threadId ?? params?.thread?.id;
      if (!t) return;
      if (threadId === null) early.push({ kind: 'notification', method, params });
      else if (t === threadId) push({ kind: 'notification', method, params });
    });
    // Tool calls are not answered: the turn is interrupted once the response is complete, which cancels them.
    let release: () => void = () => {};
    const released = new Promise<void>((r) => (release = r));
    const offReq = conn.onServerRequest((method, params) => {
      if (method !== 'item/tool/call' || !threadId || params?.threadId !== threadId) return undefined;
      push({ kind: 'call', params });
      return released.then(() => ({ contentItems: [{ type: 'inputText', text: 'Cancelled.' }], success: false }));
    });

    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new ProviderError('OpenAI request timed out.', 504, true)), this.options.timeoutMs ?? 10 * 60_000);
      t.unref?.();
      request.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
    });
    timeout.catch(() => {});

    let turnId: string | null = null;
    const interrupt = () => {
      if (threadId && turnId) void conn.request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => {});
    };
    const onAbort = () => {
      interrupt();
      wake?.();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    let text = '';
    let reasoning = '';
    const calls = new Map<string, ParsedToolCall>();
    const order: string[] = [];
    let usage: TokenUsage | undefined;
    let failure: ProviderError | null = null;
    let interrupted = false;
    try {
      const started = await Promise.race([
        conn.request(
          'thread/start',
          {
            // "" leaves the model to Codex (the plan's default).
            model: request.model || null,
            cwd: this.workDir,
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            ephemeral: true,
            experimentalRawEvents: true,
            baseInstructions: instructions,
            developerInstructions: null,
            dynamicTools: tools,
          },
          60_000,
        ),
        timeout,
      ]);
      threadId = String(started?.thread?.id);
      for (const e of early.splice(0)) if ((e as Json).params?.threadId === threadId || (e as Json).params?.thread?.id === threadId) push(e);
      if (items.length) await Promise.race([conn.request('thread/inject_items', { threadId, items }, 60_000), timeout]);
      const effort = codexEffort(request.reasoning);
      const turn = await Promise.race([
        conn.request('turn/start', { threadId, input: [], ...(effort && effort !== 'none' ? { effort, summary: 'auto' } : effort === 'none' ? { effort: 'none' } : {}) }, 60_000),
        timeout,
      ]);
      turnId = String(turn?.turn?.id);

      let done = false;
      while (!done) {
        if (request.signal.aborted) throw request.signal.reason ?? new Error('aborted');
        const e = queue.shift();
        if (!e) {
          await Promise.race([new Promise<void>((r) => (wake = r)), timeout]);
          wake = null;
          continue;
        }
        if (e.kind === 'call') {
          const p = e.params;
          if (!names.has(p.tool)) continue;
          const id = String(p.callId);
          if (!calls.has(id)) order.push(id);
          const args = p.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, unknown>) : {};
          calls.set(id, { id, name: p.tool, args, rawArguments: calls.get(id)?.rawArguments ?? JSON.stringify(args) });
          continue;
        }
        const { method, params } = e;
        switch (method) {
          case 'sfagents/closed':
            throw new ProviderError(`OpenAI: ${params?.error ?? 'Codex stopped.'}`, 503, true);
          case 'item/agentMessage/delta':
            if (params.turnId !== turnId) break;
            text += params.delta ?? '';
            if (params.delta) yield { type: 'text', text: params.delta };
            break;
          case 'item/reasoning/summaryTextDelta':
          case 'item/reasoning/textDelta':
            if (params.turnId !== turnId) break;
            reasoning += params.delta ?? '';
            if (params.delta) yield { type: 'reasoning', text: params.delta };
            break;
          case 'rawResponseItem/completed': {
            const item = params.item;
            if (params.turnId !== turnId || item?.type !== 'function_call' || !names.has(item.name)) break;
            // The exact argument text the model wrote.
            const id = String(item.call_id);
            let args: Record<string, unknown> = {};
            try {
              args = item.arguments ? JSON.parse(item.arguments) : {};
            } catch {
              args = {};
            }
            if (!calls.has(id)) order.push(id);
            calls.set(id, { id, name: item.name, args, rawArguments: item.arguments || '{}' });
            break;
          }
          case 'rawResponse/completed':
            if (params.turnId !== turnId) break;
            usage = tokenUsage(params.usage);
            if (calls.size && !interrupted) {
              interrupted = true;
              interrupt();
            }
            break;
          case 'error':
            if (params?.willRetry) break;
            failure = codexError(params?.error);
            break;
          case 'turn/completed': {
            const t = params.turn;
            if (t?.id !== turnId) break;
            if (t.status === 'failed' && !calls.size) failure ??= codexError(t.error);
            done = true;
            break;
          }
        }
      }
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) throw request.signal.reason ?? error;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`OpenAI request failed: ${getErrorMessage(error)}`, 502, true);
    } finally {
      offNote();
      offReq();
      release();
      request.signal.removeEventListener('abort', onAbort);
      if (threadId) {
        if (!interrupted && turnId && request.signal.aborted) interrupt();
        void conn.request('thread/unsubscribe', { threadId }, 10_000).catch(() => {});
      }
    }
    if (request.signal.aborted) throw request.signal.reason;
    if (failure && !text && !calls.size) throw failure;
    const toolCalls = order.map((id) => calls.get(id)!).filter(Boolean);
    const message: AssistantMessage = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }));
    if (reasoning) message.reasoning = reasoning;
    yield { type: 'done', message, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage };
  }

  /** The models the plan offers. */
  async models(): Promise<Array<{ id: string; name?: string }>> {
    const c = await this.server();
    const r = await c.request('model/list', { includeHidden: false }, 20_000);
    return ((r?.data ?? []) as Json[]).filter((m) => !m.hidden).map((m) => ({ id: String(m.model ?? m.id), name: m.displayName }));
  }

  close(): void {
    void this.connection?.then((c) => c.close(), () => {});
    this.connection = null;
  }
}

/** Errors that mean "this account can't serve now": another account may. */
export function isAccountLimitStatus(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}
