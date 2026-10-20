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
import path from 'node:path';
import type { AgentDefinition } from '../agents/definition.js';
import { artifactAccess, conversationAccess, mcpGrants } from '../agents/definition.js';
import { createConversationTools, ORGANIZE_GUIDANCE } from '../conversation/tools.js';
import { ARTIFACT_GUIDANCE, ArtifactToolNames, artifactIndex, createArtifactTools } from '../conversation/artifacts.js';
import type { AttachmentRef } from '../conversation/types.js';
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
import type { ChatMessage, ModelProvider, ModelStreamEvent, ParsedToolCall, ReasoningEffort, TokenUsage } from '../providers/types.js';
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
import { PersistenceFailure, type RunRecorder } from './recorder.js';
import { ConversationService, type ReplayTarget } from '../conversation/service.js';
import { buildWorkingContext, contextBreakdown, type ContextBreakdown, type ContextReport, type ContextTool } from '../conversation/context.js';
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
  /**
   * Persistent conversation for root sessions. Without one, each session
   * keeps an ephemeral in-memory conversation.
   */
  conversation?: ConversationService;
}

interface RunParams {
  node: AgentNode;
  agentPath: readonly string[];
  /** Mutable conversation; the system message is added if missing. */
  messages: ChatMessage[];
  task: string;
  signal: AbortSignal;
  emit: (event: RuntimeEvent) => void;
  /** Records the run at its message boundaries (persistent or ephemeral conversation). */
  recorder?: RunRecorder;
  /** The main conversation, for agents granted conversation access. */
  conversation?: ConversationService;
  /**
   * Builds the turn's working context once the system prompt and tools are
   * known (root sessions). Replaces `messages` and adds system-prompt text.
   */
  prepareContext?: (fixedText: string) => { messages: ChatMessage[]; systemExtra?: string; report?: ContextReport };
  /** Overrides the agent's configured reasoning effort for this run (the root session's setting). */
  reasoning?: ReasoningEffort;
}

/** Identity of the provider/model an agent uses, as recorded in run_start. */
export function replayTarget(definition: Readonly<AgentDefinition>): ReplayTarget {
  return {
    provider: definition.provider === 'openai-compatible' ? `openai-compatible:${definition.providerOptions?.baseUrl}` : definition.provider,
    model: definition.model,
  };
}

function addUsage(total: TokenUsage, add?: TokenUsage): void {
  if (!add) return;
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cost'] as const) {
    if (add[key] !== undefined) total[key] = (total[key] ?? 0) + add[key]!;
  }
}

export function buildSystemPrompt(node: AgentNode, toolNames: readonly string[], extra?: string): string {
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
  let guidance = toolNames.includes('add_section') ? `\n\n${ORGANIZE_GUIDANCE}` : '';
  if (toolNames.includes(ArtifactToolNames.CREATE)) guidance += `\n\n${ARTIFACT_GUIDANCE}`;
  return `${d.systemPrompt.trim()}\n\n<environment>\n${env.join('\n')}\n</environment>${guidance}${extra ? `\n\n${extra}` : ''}`;
}

/**
 * Relative paths in a parent's task are relative to the parent's primary
 * root, but a child's file tools resolve against the child's own roots.
 * Spell out the mapping so the child can translate paths.
 */
function childPathNote(parent: AgentNode, child: AgentNode): string[] {
  const parentRoot = parent.roots[0];
  if (!parentRoot || child.roots.length === 0 || child.roots[0] === parentRoot) return [];
  const mapped = child.roots.map((r) => {
    const rel = path.relative(parentRoot, r).split(path.sep).join('/');
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `${r} (the parent's "${rel}/")` : r;
  });
  return [
    '',
    `Paths: relative paths in this task are relative to the parent's workspace root ${parentRoot}. Your own relative paths resolve against ${child.roots[0]}. Your workspace roots: ${mapped.join(', ')}. Use absolute paths when unsure.`,
  ];
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
  readonly conversation?: ConversationService;

  constructor(options: RuntimeOptions) {
    this.tree = options.tree;
    const env = options.env ?? process.env;
    this.secretEnvNames = credentialEnvNames([...this.tree.byId.values()].map((n) => n.definition));
    this.mcp = options.mcpManager ?? new McpManager(this.tree.mcp, { secretEnvNames: this.secretEnvNames, env });
    this.providerFactory = options.providerFactory ?? createDefaultProviderFactory(env);
    this.confirm = options.confirm;
    this.approveAll = options.approveAll ?? false;
    this.conversation = options.conversation;
  }

  /**
   * Starts a conversation with the root agent: the runtime's persistent
   * conversation when one was given, otherwise a fresh in-memory one.
   */
  createSession(): AgentSession {
    return new AgentSession(this, this.tree.root, this.conversation ?? ConversationService.memory(this.tree.configDir));
  }

  /** Builds the tool registry one agent may use, from its definition only. */
  async buildTools(
    node: AgentNode,
    agentPath: readonly string[],
    emit: (event: RuntimeEvent) => void,
    recorder?: RunRecorder,
    conversation?: ConversationService,
  ): Promise<Map<string, AnyDeclarativeTool>> {
    const d = node.definition;
    const tools = new Map<string, AnyDeclarativeTool>();
    const allow = d.tools?.allow ?? [];
    if (allow.length > 0 && node.roots.length > 0) {
      const ctx: ToolContext = {
        workspace: new WorkspaceContext(node.roots, this.tree.protectedFiles, [...this.tree.secretFiles, ...(this.conversation?.protectedPaths() ?? [])]),
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
      tools.set(ToolNames.INVOKE_CHILD, new InvokeChildTool(this, node, agentPath, emit, recorder, conversation));
    }
    // Sections only matter for a persistent conversation; one-shot ephemeral runs skip them.
    if (conversation?.file) {
      for (const tool of createConversationTools(conversation, conversationAccess(d, node.depth))) tools.set(tool.name, tool);
      for (const tool of createArtifactTools(conversation, artifactAccess(d, node.depth), recorder?.runId)) tools.set(tool.name, tool);
    }
    return tools;
  }

  private provider(definition: Readonly<AgentDefinition>): ModelProvider {
    return this.providerFactory(definition);
  }

  /** Runs one agent until it answers, fails, times out, runs out of turns or is cancelled. */
  async run(params: RunParams): Promise<AgentRunResult> {
    const { node, agentPath, messages, emit, recorder } = params;
    const record = (write: (r: RunRecorder) => void) => {
      if (!recorder) return;
      try {
        write(recorder);
      } catch (error) {
        throw new PersistenceFailure(getErrorMessage(error));
      }
    };
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
      let result: AgentRunResult = {
        agentId: node.id,
        status,
        text: lastText,
        ...(error ? { error } : {}),
        turns,
        toolCalls: activity,
        usage,
        durationMs: Date.now() - started,
      };
      if (recorder && startRecorded) {
        try {
          recorder.end(result);
        } catch (e) {
          const note = `The end of this run could not be recorded: ${getErrorMessage(e)}`;
          result = { ...result, status: AgentTerminateMode.ERROR, error: result.error ? `${result.error} ${note}` : note };
        }
      }
      emit({ type: 'agent_end', agentPath, result });
      return result;
    };
    let startRecorded = false;
    const storageStop = (e: PersistenceFailure) =>
      finish(AgentTerminateMode.ERROR, `Conversation storage failed: ${e.message}. Stopped before any further action.`);
    const stopReason = (): [AgentTerminateMode, string] =>
      timedOut
        ? [AgentTerminateMode.TIMEOUT, `Agent "${node.id}" exceeded its ${Math.round(timeoutMs / 1000)}s time limit.`]
        : [AgentTerminateMode.CANCELLED, 'Cancelled.'];

    emit({ type: 'agent_start', agentPath, task: params.task });

    let provider: ModelProvider;
    let tools: Map<string, AnyDeclarativeTool>;
    try {
      provider = this.provider(d);
      tools = await this.buildTools(node, agentPath, emit, recorder, params.conversation);
    } catch (error) {
      const message = getErrorMessage(error);
      emit({ type: 'error', agentPath, message });
      return finish(AgentTerminateMode.ERROR, message);
    }

    try {
      record((r) => r.start(node));
      startRecorded = true;
    } catch (e) {
      if (e instanceof PersistenceFailure) return storageStop(e);
      throw e;
    }

    const declarations = [...tools.values()].map((t) => t.schema);
    let systemExtra: string | undefined;
    if (params.prepareContext) {
      try {
        const base = buildSystemPrompt(node, [...tools.keys()]);
        const prepared = params.prepareContext(base + JSON.stringify(declarations));
        messages.splice(0, messages.length, ...prepared.messages);
        systemExtra = prepared.systemExtra;
        if (prepared.report) emit({ type: 'context', agentPath, ...prepared.report });
      } catch (error) {
        const message = getErrorMessage(error);
        emit({ type: 'error', agentPath, message });
        return finish(AgentTerminateMode.ERROR, message);
      }
    }
    if (params.conversation?.file && tools.has(ArtifactToolNames.LIST)) {
      const index = artifactIndex(params.conversation);
      if (index) systemExtra = systemExtra ? `${systemExtra}\n\n${index}` : index;
    }
    const systemPrompt = buildSystemPrompt(node, [...tools.keys()], systemExtra);
    if (messages[0]?.role === 'system') messages[0] = { role: 'system', content: systemPrompt };
    else messages.unshift({ role: 'system', content: systemPrompt });
    const maxTurns = d.limits?.maxTurns ?? DEFAULT_MAX_TURNS;
    const approvals = this.sessionApprovals.get(node.id) ?? new Set<string>();
    this.sessionApprovals.set(node.id, approvals);

    try {
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
          reasoning: params.reasoning ?? d.reasoning,
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
      if (done.usage) emit({ type: 'model_usage', agentPath, usage: done.usage });
      const assistantMessage = done.message;
      const finishReason = done.finishReason;
      record((r) => r.assistant(assistantMessage, finishReason));
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
            const cancelled = { role: 'tool' as const, tool_call_id: c.id, content: 'Cancelled before execution.' };
            record((r) => r.toolResult(cancelled, c.name, 'not_started'));
            messages.push(cancelled);
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
            beforeExecute: (callId, tool) => record((r) => r.toolStart(callId, tool)),
          },
          signal,
        );
        record((r) => r.toolResult(outcome.message, call.name, outcome.status));
        messages.push(outcome.message);
        activity.push(outcome.activity);
      }
    }
    } catch (e) {
      if (e instanceof PersistenceFailure) return storageStop(e);
      throw e;
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
    callId?: string;
    parentRecorder?: RunRecorder;
    conversation?: ConversationService;
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
        ...childPathNote(parent, child),
      ].join('\n');
      const agentPath = [...parentPath, child.id];
      let recorder: RunRecorder | undefined;
      if (params.parentRecorder) {
        // Child transcript and its artifact reference are written before the child runs.
        recorder = params.parentRecorder.child(child, agentPath, params.callId ?? 'unknown', `${child.id}: ${params.task.replace(/\s+/g, ' ').trim()}`);
        recorder.user(input);
      }
      const messages: ChatMessage[] = [{ role: 'user', content: input }];
      return await this.run({
        node: child,
        agentPath,
        messages,
        task: params.task,
        signal,
        emit,
        recorder,
        conversation: params.conversation,
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
 * A conversation with the root agent, backed by a ConversationService
 * (persistent or in-memory). Each turn's provider context is rebuilt from
 * stored history rather than kept in a growing in-memory array.
 */
export class AgentSession {
  private busy = false;
  private lastMessages: ChatMessage[] = [];
  /** Reasoning effort chosen for this session (overrides the root agent's setting). */
  reasoning: ReasoningEffort | undefined;
  /** The root agent's most recent model request, as the provider reported it. */
  lastRequest: { usage: TokenUsage; at: number } | undefined;

  constructor(
    private readonly runtime: AgentRuntime,
    readonly node: AgentNode,
    readonly conversation: ConversationService,
  ) {}

  /** The provider messages of the most recent turn (for inspection and tests). */
  get messages(): ChatMessage[] {
    return this.lastMessages;
  }

  get running(): boolean {
    return this.busy;
  }

  /**
   * What the next request would carry, split by part (system prompt, tool
   * families per tool, section index and notes, messages), against the
   * working-context budget. MCP servers the agent uses are connected if they
   * are not already.
   */
  async contextUsage(): Promise<ContextBreakdown & { lastRequest?: { usage: TokenUsage; at: number } }> {
    const definition = this.node.definition;
    const conversation = this.conversation;
    const tools = await this.runtime.buildTools(this.node, [this.node.id], () => undefined, undefined, conversation);
    const list: ContextTool[] = [...tools.entries()].map(([name, tool]) => ({
      name,
      group: tool instanceof DiscoveredMcpTool ? 'mcp' : name === ToolNames.INVOKE_CHILD ? 'agents' : (Object.values(ToolNames) as string[]).includes(name) ? 'builtin' : 'conversation',
      ...(tool instanceof DiscoveredMcpTool ? { server: tool.serverName } : {}),
      schema: tool.schema,
    }));
    const retrievable = conversation.file !== undefined && conversationAccess(definition, 0) !== 'none';
    const index = conversation.file && tools.has(ArtifactToolNames.LIST) ? artifactIndex(conversation) : undefined;
    const breakdown = contextBreakdown(conversation.state, replayTarget(definition), definition.context ?? {}, buildSystemPrompt(this.node, [...tools.keys()]), list, {
      retrievable,
      resolveAttachment: (ref) => conversation.readAttachment(ref),
      ...(index ? { extraSystem: index } : {}),
    });
    return { ...breakdown, ...(this.lastRequest ? { lastRequest: this.lastRequest } : {}) };
  }

  /** /clear: later turns start from a fresh working context; history is kept. */
  resetContext(): void {
    if (this.busy) throw new Error('Cannot reset the context while a turn is running');
    this.conversation.resetContext();
  }

  /**
   * Sends one user message. The message is stored before the model request
   * starts. Yields events as they happen and returns the structured result
   * of the root agent's turn.
   */
  async *send(input: string, options: { signal?: AbortSignal; attachments?: AttachmentRef[] } = {}): AsyncGenerator<RuntimeEvent, AgentRunResult> {
    if (this.busy) throw new Error('A turn is already running in this session');
    this.busy = true;
    try {
      const recorder = this.conversation.beginRootRun(this.node);
      recorder.user(input, options.attachments);
      const messages: ChatMessage[] = [];
      this.lastMessages = messages;
      const definition = this.node.definition;
      const conversation = this.conversation;
      const retrievable = conversation.file !== undefined && conversationAccess(definition, 0) !== 'none';
      const prepareContext = (fixedText: string) =>
        buildWorkingContext(conversation.state, replayTarget(definition), definition.context ?? {}, fixedText, {
          retrievable,
          resolveAttachment: (ref) => conversation.readAttachment(ref),
        });
      const queue: RuntimeEvent[] = [];
      let wake: (() => void) | undefined;
      const emit = (event: RuntimeEvent) => {
        if (event.type === 'model_usage' && event.agentPath.length === 1) this.lastRequest = { usage: event.usage, at: Date.now() };
        queue.push(event);
        wake?.();
      };
      let result: AgentRunResult | undefined;
      let failure: unknown;
      const running = this.runtime
        .run({
          node: this.node,
          agentPath: [this.node.id],
          messages,
          task: input,
          signal: options.signal ?? new AbortController().signal,
          emit,
          recorder,
          conversation: this.conversation,
          prepareContext,
          ...(this.reasoning ? { reasoning: this.reasoning } : {}),
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
  async run(
    input: string,
    options: { signal?: AbortSignal; attachments?: AttachmentRef[]; onEvent?: (event: RuntimeEvent) => void } = {},
  ): Promise<AgentRunResult> {
    const it = this.send(input, { signal: options.signal, attachments: options.attachments });
    while (true) {
      const next = await it.next();
      if (next.done) return next.value;
      options.onEvent?.(next.value);
    }
  }
}
