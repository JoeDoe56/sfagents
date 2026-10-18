/**
 * The SF Agents runtime: model turns, the tool loop and child execution.
 *
 * Loop structure follows qwen-code agents/runtime/agent-core.ts
 * `runReasoningLoop` (model turn → tool calls → tool responses → next turn,
 * stopping on a final answer, the turn budget, a timeout or cancellation),
 * reduced to what this milestone needs. Core knows nothing about terminals;
 * front ends consume typed RuntimeEvents and supply a ConfirmationHandler.
 */

import os from 'node:os';
import type { AgentDefinition } from '../agents/definition.js';
import { mcpGrants } from '../agents/definition.js';
import type { AgentNode, AgentTree } from '../agents/loader.js';
import { InvokeChildTool, type ChildRunner } from '../agents/invoke-child.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import { DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_SHELL_TIMEOUT_MS, type ToolContext } from '../tools/tool-context.js';
import { ReadFileTool } from '../tools/read-file.js';
import { WriteFileTool } from '../tools/write-file.js';
import { EditTool } from '../tools/edit.js';
import { GlobTool } from '../tools/glob.js';
import { GrepTool } from '../tools/grep.js';
import { LSTool } from '../tools/ls.js';
import { ShellTool } from '../tools/shell.js';
import { WorkspaceContext } from '../permissions/workspace.js';
import { McpManager } from '../mcp/manager.js';
import { DiscoveredMcpTool, mcpFunctionName } from '../mcp/mcp-tool.js';
import type { ChatMessage, ModelProvider, ModelStreamEvent, ParsedToolCall, TokenUsage } from '../providers/types.js';
import { createDefaultProviderFactory, credentialEnvNames, type ProviderFactory } from '../providers/factory.js';
import { executeToolCall } from './tool-executor.js';
import {
  AgentTerminateMode,
  type AgentRunResult,
  type ConfirmationHandler,
  type RuntimeEvent,
  type ToolActivity,
} from './events.js';
import { Semaphore } from '../utils/semaphore.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

export interface RuntimeOptions {
  tree: AgentTree;
  /** Defaults to OpenRouter / OpenAI-compatible providers keyed from `env`. */
  providerFactory?: ProviderFactory;
  confirm?: ConfirmationHandler;
  /** Approve every tool call that would otherwise ask (CLI --yes). */
  approveAll?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Inject an MCP manager (tests); defaults to one built from tree.mcp. */
  mcpManager?: McpManager;
}

interface RunParams {
  node: AgentNode;
  agentPath: readonly string[];
  /** Mutable conversation; the system message is added if missing. */
  messages: ChatMessage[];
  task: string;
  signal: AbortSignal;
  emit: (event: RuntimeEvent) => void;
}

function addUsage(total: TokenUsage, add?: TokenUsage): void {
  if (!add) return;
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cost'] as const) {
    if (add[key] !== undefined) total[key] = (total[key] ?? 0) + add[key]!;
  }
}

export function buildSystemPrompt(node: AgentNode, toolNames: readonly string[]): string {
  const d = node.definition;
  const env = [
    `Agent id: ${node.id}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Platform: ${process.platform} (${os.release()})`,
    node.roots.length
      ? `Workspace roots (file tools are confined to these; relative paths resolve against the first): ${node.roots.join(', ')}`
      : 'Workspace: none (this agent has no filesystem access)',
    `Tools available to you: ${toolNames.length ? toolNames.join(', ') : '(none)'}`,
  ];
  if (node.children.length > 0) {
    env.push(`Child agents you can delegate to with ${ToolNames.INVOKE_CHILD}: ${node.children.map((c) => c.id).join(', ')}`);
  }
  return `${d.systemPrompt.trim()}\n\n<environment>\n${env.join('\n')}\n</environment>`;
}

export class AgentRuntime implements ChildRunner {
  readonly tree: AgentTree;
  readonly mcp: McpManager;
  private readonly providerFactory: ProviderFactory;
  private readonly confirm?: ConfirmationHandler;
  private readonly approveAll: boolean;
  private readonly secretEnvNames: readonly string[];
  /** "Always allow" decisions, per agent id, for the life of the runtime. */
  private readonly sessionApprovals = new Map<string, Set<string>>();
  /** Active-children semaphores, per parent agent id. */
  private readonly childSlots = new Map<string, Semaphore>();
  private disposed = false;

  constructor(options: RuntimeOptions) {
    this.tree = options.tree;
    const env = options.env ?? process.env;
    this.secretEnvNames = credentialEnvNames([...this.tree.byId.values()].map((n) => n.definition));
    this.mcp = options.mcpManager ?? new McpManager(this.tree.mcp, { secretEnvNames: this.secretEnvNames, env });
    this.providerFactory = options.providerFactory ?? createDefaultProviderFactory(env);
    this.confirm = options.confirm;
    this.approveAll = options.approveAll ?? false;
  }

  /** Starts an interactive conversation with the root agent. */
  createSession(): AgentSession {
    return new AgentSession(this, this.tree.root);
  }

  /** Builds the tool registry one agent may use, from its definition only. */
  async buildTools(
    node: AgentNode,
    agentPath: readonly string[],
    emit: (event: RuntimeEvent) => void,
  ): Promise<Map<string, AnyDeclarativeTool>> {
    const d = node.definition;
    const tools = new Map<string, AnyDeclarativeTool>();
    const allow = d.tools?.allow ?? [];
    if (allow.length > 0 && node.roots.length > 0) {
      const ctx: ToolContext = {
        workspace: new WorkspaceContext(node.roots, this.tree.protectedFiles),
        maxOutputChars: d.limits?.maxToolOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
        secretEnvNames: this.secretEnvNames,
        shellTimeoutMs: (d.limits?.shellTimeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_MS / 1000) * 1000,
      };
      const factories: Record<string, () => AnyDeclarativeTool> = {
        [ToolNames.READ_FILE]: () => new ReadFileTool(ctx),
        [ToolNames.WRITE_FILE]: () => new WriteFileTool(ctx),
        [ToolNames.EDIT]: () => new EditTool(ctx),
        [ToolNames.GLOB]: () => new GlobTool(ctx),
        [ToolNames.GREP]: () => new GrepTool(ctx),
        [ToolNames.LS]: () => new LSTool(ctx),
        [ToolNames.SHELL]: () => new ShellTool(ctx),
      };
      for (const id of allow) {
        // Defense in depth: the loader already rejects shell on children.
        if (id === ToolNames.SHELL && node.depth > 0) continue;
        const make = factories[id];
        if (make) tools.set(id, make());
      }
    }

    for (const [server, grantedTools] of mcpGrants(d)) {
      const cfg = this.tree.mcp.servers[server];
      if (!cfg) continue;
      let discovered;
      try {
        discovered = await this.mcp.getTools(server);
      } catch (error) {
        emit({ type: 'warning', agentPath, message: `${getErrorMessage(error)}. Its tools are unavailable for this turn.` });
        continue;
      }
      const names = new Set(discovered.map((t) => t.name));
      for (const wanted of grantedTools ?? []) {
        if (!names.has(wanted)) {
          emit({ type: 'warning', agentPath, message: `MCP server "${server}" does not expose granted tool "${wanted}" (or the server's includeTools/excludeTools filters it).` });
        }
      }
      for (const info of discovered) {
        if (grantedTools && !grantedTools.has(info.name)) continue;
        const fnName = mcpFunctionName(server, info.name);
        tools.set(fnName, new DiscoveredMcpTool(this.mcp, server, info.name, info, fnName, cfg.trust === true));
      }
    }

    if (node.children.length > 0) {
      tools.set(ToolNames.INVOKE_CHILD, new InvokeChildTool(this, node, agentPath, emit));
    }
    return tools;
  }

  private provider(definition: Readonly<AgentDefinition>): ModelProvider {
    return this.providerFactory(definition);
  }

  /** Runs one agent until it answers, fails, times out, runs out of turns or is cancelled. */
  async run(params: RunParams): Promise<AgentRunResult> {
    const { node, agentPath, messages, emit } = params;
    const d = node.definition;
    const started = Date.now();
    const usage: TokenUsage = {};
    const activity: ToolActivity[] = [];
    let turns = 0;
    let lastText = '';

    const timeoutMs = (d.limits?.timeoutSeconds ?? DEFAULT_AGENT_TIMEOUT_MS / 1000) * 1000;
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort(params.signal.reason);
    params.signal.addEventListener('abort', onParentAbort, { once: true });
    if (params.signal.aborted) controller.abort(params.signal.reason);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('agent timeout'));
    }, timeoutMs);
    const signal = controller.signal;

    const finish = (status: AgentTerminateMode, error?: string): AgentRunResult => {
      clearTimeout(timer);
      params.signal.removeEventListener('abort', onParentAbort);
      const result: AgentRunResult = {
        agentId: node.id,
        status,
        text: lastText,
        ...(error ? { error } : {}),
        turns,
        toolCalls: activity,
        usage,
        durationMs: Date.now() - started,
      };
      emit({ type: 'agent_end', agentPath, result });
      return result;
    };
    const stopReason = (): [AgentTerminateMode, string] =>
      timedOut
        ? [AgentTerminateMode.TIMEOUT, `Agent "${node.id}" exceeded its ${Math.round(timeoutMs / 1000)}s time limit.`]
        : [AgentTerminateMode.CANCELLED, 'Cancelled.'];

    emit({ type: 'agent_start', agentPath, task: params.task });

    let provider: ModelProvider;
    let tools: Map<string, AnyDeclarativeTool>;
    try {
      provider = this.provider(d);
      tools = await this.buildTools(node, agentPath, emit);
    } catch (error) {
      const message = getErrorMessage(error);
      emit({ type: 'error', agentPath, message });
      return finish(AgentTerminateMode.ERROR, message);
    }

    const systemPrompt = buildSystemPrompt(node, [...tools.keys()]);
    if (messages[0]?.role === 'system') messages[0] = { role: 'system', content: systemPrompt };
    else messages.unshift({ role: 'system', content: systemPrompt });
    const declarations = [...tools.values()].map((t) => t.schema);
    const maxTurns = d.limits?.maxTurns ?? DEFAULT_MAX_TURNS;
    const approvals = this.sessionApprovals.get(node.id) ?? new Set<string>();
    this.sessionApprovals.set(node.id, approvals);

    while (turns < maxTurns) {
      if (signal.aborted) return finish(...stopReason());
      turns++;
      let done: Extract<ModelStreamEvent, { type: 'done' }> | undefined;
      let turnText = '';
      try {
        for await (const event of provider.stream({
          model: d.model,
          messages,
          tools: declarations,
          reasoning: d.reasoning,
          temperature: d.temperature,
          maxOutputTokens: d.maxOutputTokens,
          signal,
        })) {
          if (event.type === 'text') {
            turnText += event.text;
            emit({ type: 'text', agentPath, text: event.text });
          } else if (event.type === 'reasoning') {
            emit({ type: 'reasoning', agentPath, text: event.text });
          } else {
            done = event;
          }
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return finish(...stopReason());
        const message = getErrorMessage(error);
        emit({ type: 'error', agentPath, message });
        if (turnText) lastText = turnText;
        return finish(AgentTerminateMode.ERROR, message);
      }
      if (!done) {
        const message = 'Model stream ended without a final message.';
        emit({ type: 'error', agentPath, message });
        return finish(AgentTerminateMode.ERROR, message);
      }
      addUsage(usage, done.usage);
      messages.push(done.message);
      if (done.message.content) lastText = done.message.content;

      if (done.toolCalls.length === 0) {
        if (done.finishReason === 'length') {
          return finish(AgentTerminateMode.GOAL, 'The model hit its output token limit; the answer may be incomplete.');
        }
        return finish(AgentTerminateMode.GOAL);
      }

      const pending: ParsedToolCall[] = [...done.toolCalls];
      while (pending.length > 0) {
        const call = pending.shift()!;
        if (signal.aborted) {
          // Keep the conversation valid: every tool call gets a response.
          for (const c of [call, ...pending]) {
            messages.push({ role: 'tool', tool_call_id: c.id, content: 'Cancelled before execution.' });
          }
          return finish(...stopReason());
        }
        const outcome = await executeToolCall(
          call,
          {
            agentId: node.id,
            agentPath,
            tools,
            autoApprove: d.tools?.autoApprove ?? [],
            sessionApprovals: approvals,
            approveAll: this.approveAll,
            confirm: this.confirm,
            toolTimeoutMs: (d.limits?.toolTimeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_MS / 1000) * 1000,
            maxOutputChars: d.limits?.maxToolOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
            emit,
          },
          signal,
        );
        messages.push(outcome.message);
        activity.push(outcome.activity);
      }
    }
    return finish(AgentTerminateMode.MAX_TURNS, `Agent "${node.id}" reached its limit of ${maxTurns} model turns before finishing.`);
  }

  /** ChildRunner: runs a declared child in a fresh, isolated context. */
  async runChild(params: {
    parent: AgentNode;
    parentPath: readonly string[];
    child: AgentNode;
    task: string;
    context?: string;
    signal: AbortSignal;
    emit: (event: RuntimeEvent) => void;
  }): Promise<AgentRunResult> {
    const { parent, parentPath, child, signal } = params;
    // Runtime guards, independent of the schema enum.
    if (!parent.children.includes(child) || this.tree.byId.get(child.id) !== child) {
      throw new Error(`"${child.id}" is not a declared child of "${parent.id}"`);
    }
    if (parentPath.includes(child.id)) {
      throw new Error(`recursion guard: "${child.id}" is already running in this chain (${parentPath.join(' > ')})`);
    }
    if (parentPath.length > this.tree.maxDepth) {
      throw new Error(`depth guard: maximum agent depth ${this.tree.maxDepth} reached`);
    }
    const emit = params.emit;
    let slots = this.childSlots.get(parent.id);
    if (!slots) {
      slots = new Semaphore(parent.definition.spawn?.maxConcurrentChildren ?? 1);
      this.childSlots.set(parent.id, slots);
    }
    const release = await slots.acquire(signal);
    try {
      const input = [
        `Task from parent agent "${parent.id}":`,
        params.task.trim(),
        ...(params.context?.trim() ? ['', 'Context provided by the parent:', params.context.trim()] : []),
      ].join('\n');
      const messages: ChatMessage[] = [{ role: 'user', content: input }];
      return await this.run({
        node: child,
        agentPath: [...parentPath, child.id],
        messages,
        task: params.task,
        signal,
        emit,
      });
    } finally {
      release();
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.mcp.dispose();
  }
}

/**
 * An in-process conversation with the root agent. Keeps ordinary context so
 * follow-up messages work; persistence is a later milestone.
 */
export class AgentSession {
  readonly messages: ChatMessage[] = [];
  private busy = false;

  constructor(
    private readonly runtime: AgentRuntime,
    readonly node: AgentNode,
  ) {}

  /**
   * Sends one user message. Yields events as they happen and returns the
   * structured result of the root agent's turn.
   */
  async *send(input: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<RuntimeEvent, AgentRunResult> {
    if (this.busy) throw new Error('A turn is already running in this session');
    this.busy = true;
    const queue: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    const emit = (event: RuntimeEvent) => {
      queue.push(event);
      wake?.();
    };
    this.messages.push({ role: 'user', content: input });
    let result: AgentRunResult | undefined;
    let failure: unknown;
    const running = this.runtime
      .run({
        node: this.node,
        agentPath: [this.node.id],
        messages: this.messages,
        task: input,
        signal: options.signal ?? new AbortController().signal,
        emit,
      })
      .then(
        (r) => {
          result = r;
        },
        (e) => {
          failure = e;
        },
      )
      .finally(() => wake?.());
    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (result || failure) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length > 0 || result || failure) resolve();
        });
        wake = undefined;
      }
      await running;
      while (queue.length > 0) yield queue.shift()!;
      if (failure) throw failure;
      return result!;
    } finally {
      this.busy = false;
    }
  }

  /** Runs one message to completion, forwarding events to `onEvent`. */
  async run(input: string, options: { signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void } = {}): Promise<AgentRunResult> {
    const it = this.send(input, { signal: options.signal });
    while (true) {
      const next = await it.next();
      if (next.done) return next.value;
      options.onEvent?.(next.value);
    }
  }
}
