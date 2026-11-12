import { containerManager } from '../container/containers.js';
import { UiService, ContainerUiAdapter, WindowsUiAdapter } from '../ui/ui.js';
import { FullControlManager, RollbackJournal } from './full-control.js';
import { GitHubPullRequests } from '../git/github.js';
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
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agents/definition.js';
import { artifactAccess, conversationAccess, mcpGrants } from '../agents/definition.js';
import { ORGANIZE_GUIDANCE } from '../conversation/tools.js';
import { ARTIFACT_COMMAND, ARTIFACT_GUIDANCE, artifactCommand, artifactIndex } from '../conversation/artifacts.js';
import { hostCommandSchema, type HostCommands } from '../tools/host-commands.js';
import type { GitWorkspaces } from '../git/workspaces.js';
import { DEFAULT_VIEW_IMAGES } from '../tools/sfa-view.js';
import { toolImagesMessage, type ShownImage } from '../conversation/attachments.js';
import type { AttachmentRef, MessageRecord } from '../conversation/types.js';
import type { ConversationState } from '../conversation/state.js';
import type { AgentNode, AgentTree } from '../agents/loader.js';
import {
  AGENT_MESSAGING_GUIDANCE,
  MESSAGE_USER_GUIDANCE,
  MessageTool,
  messageAction,
  THREAD_MESSAGING_GUIDANCE,
  USER,
  mailText,
  type AgentMessenger,
  type ChildRun,
  type MessageOutcome,
  type RunLink,
} from '../agents/message-agent.js';
import { Mailbox } from '../agents/mailbox.js';
import { ThreadRecorder, ThreadService, threadMessages } from '../agents/threads.js';
import { newRunId, toChatMessages } from '../conversation/service.js';
import { TURN_RESERVE, DEFAULT_MAX_INPUT_TOKENS } from '../conversation/context.js';
import { sectionEntries, summaryDue } from '../conversation/sections.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import { DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_SHELL_TIMEOUT_MS, type ToolContext } from '../tools/tool-context.js';
import { ShellTool } from '../tools/shell.js';
import { DEFAULT_WEB_REQUESTS } from '../tools/host-commands.js';
import { AppSettings } from '../settings/settings.js';
import { sfagentsHome } from '../settings/home.js';
import { BrightDataWeb, type WebAccess } from '../web/brightdata.js';
import { ProviderRegistry } from '../providers/registry.js';
import { patchFormatFor, type PatchFormat } from '../tools/sfa-patch.js';
import { McpManager, type McpToolInfo } from '../mcp/manager.js';
import { mcpApprover, type McpGrant, type McpServerGrant } from '../mcp/sfa-mcp.js';
import type { ChatMessage, ModelProvider, ModelStreamEvent, ParsedToolCall, ReasoningEffort, TokenUsage } from '../providers/types.js';
import { ProviderError, addTokenUsage, usageText } from '../providers/types.js';
import { createDefaultProviderFactory, credentialEnvNames, providerChoices, type ProviderFactory } from '../providers/factory.js';
import { executeToolCall } from './tool-executor.js';
import {
  AgentTerminateMode,
  type AgentRunResult,
  type ConfirmationHandler,
  type RuntimeEvent,
  type ToolActivity,
} from './events.js';
import { PersistenceFailure, type RunRecorder, type ViewSource } from './recorder.js';
import { ConversationService, STATE_DIR_NAME, type ReplayTarget } from '../conversation/service.js';
import { buildWorkingContext, contextBreakdown, type ContextBreakdown, type ContextReport, type ContextTool } from '../conversation/context.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What a model request adds to the stored messages. The system prompt gets
 * only text that rarely changes (the network level), so providers can keep
 * reusing their cached copy of the prompt. Text that changes every step (the
 * full-control countdown) goes on the newest message instead.
 */
export function withStepContext(messages: readonly ChatMessage[], system: string, step?: string): ChatMessage[] {
  const out = messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: `${m.content}\n\n${system}` } : m));
  const last = out.at(-1);
  if (!step || !last || out.length < 2) return out;
  const note = `[SF Agents] ${step}`;
  if (last.role === 'tool') out[out.length - 1] = { ...last, content: `${last.content}\n\n${note}` };
  else if (last.role === 'user') out[out.length - 1] = { ...last, content: typeof last.content === 'string' ? `${last.content}\n\n${note}` : [...last.content, { type: 'text', text: note }] };
  return out;
}

export interface RuntimeOptions {
  /** Detailed lines about model requests and usage (the Logs tab and log file). */
  log?: (line: string) => void;
  fullControl?: FullControlManager;
  ui?: UiService;
  pullRequests?: () => boolean;
  fullControlMinutes?: () => number;
  onFullControlChange?: (status: import('./full-control.js').FullControlStatus | null) => void;
  tree: AgentTree;
  /** Defaults to OpenRouter / OpenAI-compatible providers keyed from `env`. */
  providerFactory?: ProviderFactory;
  confirm?: ConfirmationHandler;
  /** Approve every tool call that would otherwise ask (CLI --yes). */
  approveAll?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Speech to text for `sfa-view transcript` (the web app's dictation model). */
  transcribe?: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  /** Inject an MCP manager (tests); defaults to one built from tree.mcp. */
  mcpManager?: McpManager;
  /**
   * Persistent conversation for root sessions. Without one, each session
   * keeps an ephemeral in-memory conversation.
   */
  conversation?: ConversationService;
  /** Web access for agents at network level "on" (default: Bright Data, with the key added in Settings). */
  web?: WebAccess;
  /** Git workspaces for sfa-git and sfa-ci, and the checkpoint after each run. */
  git?: GitWorkspaces;
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
  /**
   * Picks the system prompt for this run from the one just built (`full`)
   * and the same without its changing parts (`base`): the session reuses
   * the previous run's prompt while nothing that matters changed, so the
   * provider's prompt cache, which starts with the system prompt, carries
   * over from one reply to the next.
   */
  stableSystem?: (fresh: { base: string; full: string }) => string;
  /** Overrides the agent's configured reasoning effort for this run (the root session's setting). */
  reasoning?: ReasoningEffort;
  /** "main": replying in the main conversation; "thread": answering another agent. */
  role?: 'main' | 'thread';
  /** For a thread: the agent it is talking to. */
  threadWith?: string;
  /**
   * Messages the person sent since the run started, already recorded and
   * converted (root sessions). Read between model requests, so the model
   * sees them at its next step, and before the run would end.
   */
  inbox?: () => ChatMessage[];
  /** Resolves when the person's next message is waiting (root sessions that can answer). */
  waitForPerson?: (signal: AbortSignal) => Promise<void>;
  /** How other agents reach this run while it works (made by messageAgent for thread runs). */
  link?: RunLink;
}

/** Resolves once `p` settles and the bookkeeping after it (a few ticks) is done. */
function settled(p: Promise<unknown>): Promise<void> {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  return p.then(tick, tick).then(tick).then(tick);
}

/** A link for a run nobody can reach (context estimates, one-off tool lists). */
function idleLink(agent: string): RunLink {
  return { agent, mailbox: new Mailbox(), signal: new AbortController().signal, children: new Map() };
}

/** Identity of the provider/model an agent uses, as recorded in run_start. */
export function replayTarget(definition: Readonly<AgentDefinition>): ReplayTarget {
  return {
    provider: definition.provider === 'openai-compatible' ? `openai-compatible:${definition.providerOptions?.baseUrl}` : definition.provider,
    model: definition.model,
  };
}

function addUsage(total: TokenUsage, add?: TokenUsage): void {
  addTokenUsage(total, add);
}

/** Rough tokens a request carries (characters / 4), to compare with what the provider reports. */
export function estimateRequestTokens(messages: readonly ChatMessage[], tools: readonly unknown[]): number {
  let chars = JSON.stringify(tools).length;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.round(chars / 4);
}

/** Whether the agent's shell has `sfa-artifact` (it then gets the artifact guidance). */
/** A message to another agent (these run in parallel). */
function toAgent(call: ParsedToolCall): boolean {
  return call.name === ToolNames.MESSAGE && messageAction(call.args) === 'send' && typeof call.args['to'] === 'string' && call.args['to'] !== USER;
}

/** What the system prompt explains, from the tools an agent has. */
function features(tools: ReadonlyMap<string, AnyDeclarativeTool>): { artifacts: boolean; toUser: boolean; organizes: boolean } {
  const message = tools.get(ToolNames.MESSAGE);
  const m = message instanceof MessageTool ? message : undefined;
  return { artifacts: hasArtifactCommand(tools), toUser: !!m?.canMessageUser, organizes: !!m?.conversationActions?.organizes };
}

function hasArtifactCommand(tools: ReadonlyMap<string, AnyDeclarativeTool>): boolean {
  const shell = tools.get(ToolNames.SHELL);
  return shell instanceof ShellTool && shell.commandNames.includes(ARTIFACT_COMMAND);
}

/** The person's operating system, named for the model. */
function hostOsName(): string {
  if (process.platform === 'win32') return `Windows (${os.release()})`;
  if (process.platform === 'darwin') return `macOS (Darwin ${os.release()})`;
  return `${process.platform === 'linux' ? 'Linux' : process.platform} (${os.release()})`;
}

export function buildSystemPrompt(node: AgentNode, toolNames: readonly string[], extra?: string, link?: RunLink, features: { artifacts?: boolean; toUser?: boolean; organizes?: boolean } = {}): string {
  const d = node.definition;
  const env = [
    `Agent id: ${node.id}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `The person's computer: ${hostOsName()} (your commands do not run there; see the shell tool)`,
    `Shell: your own Linux container. Its folders, network (level "${d.network}") and SF Agents commands are listed in the shell tool's description; those are all you have.`,
    `Tools available to you: ${toolNames.length ? toolNames.join(', ') : '(none)'}`,
  ];
  const partner = link?.partner?.id;
  const agents = [...new Set([...node.grants.keys(), ...(partner ? [partner] : [])])];
  if (toolNames.includes(ToolNames.MESSAGE) && agents.length) env.push(`Agents you can message with ${ToolNames.MESSAGE}: ${agents.join(', ')}`);
  let guidance = features.organizes ? `\n\n${ORGANIZE_GUIDANCE}` : '';
  if (toolNames.includes(ToolNames.MESSAGE) && node.grants.size > 0) guidance += `\n\n${AGENT_MESSAGING_GUIDANCE}`;
  if (partner && toolNames.includes(ToolNames.MESSAGE)) guidance += `\n\n${THREAD_MESSAGING_GUIDANCE}`;
  if (features.toUser && toolNames.includes(ToolNames.MESSAGE)) guidance += `\n\n${MESSAGE_USER_GUIDANCE}`;
  if (features.artifacts) guidance += `\n\n${ARTIFACT_GUIDANCE}`;
  return `${d.systemPrompt.trim()}\n\n<environment>\n${env.join('\n')}\n</environment>${guidance}${extra ? `\n\n${extra}` : ''}`;
}

/** What an agent answering another agent in a thread is told about it. */
function threadNote(node: AgentNode, other: string, omitted: number): string {
  return `<thread>
You are "${node.id}", answering "${other}" in your persistent thread with it. Its messages arrive as user messages; your final reply goes back to it as the answer. Answer what it asked, terse and structured for an agent to use. If you need something from it while you work, message it (it keeps working too, and its answer arrives as a message); it may also send you follow-ups while you work.${omitted ? ` ${omitted} earlier exchange(s) of this thread are not shown.` : ''}
</thread>`;
}

export class AgentRuntime implements AgentMessenger {
  /** The project's agents; replaced by reload() when their files change. */
  tree: AgentTree;
  mcp: McpManager;
  private readonly providerFactory: ProviderFactory;
  private readonly confirm?: ConfirmationHandler;
  private readonly approveAll: boolean;
  private readonly transcribe?: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  private secretEnvNames: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly ownsMcp: boolean;
  /** MCP managers replaced by reload(), closed once no run uses them. */
  private retired: McpManager[] = [];
  private activeRuns = 0;
  /** "Always allow" decisions, per agent id, for the life of the runtime. */
  private readonly sessionApprovals = new Map<string, Set<string>>();
  /** The persistent threads between agents. */
  readonly threads: ThreadService;
  private disposed = false;
  readonly conversation?: ConversationService;
  private readonly web: WebAccess;
  readonly git?: GitWorkspaces;
  readonly fullControl: FullControlManager;
  readonly ui: UiService;
  private readonly pullRequests: () => boolean;

  /** Detailed lines about model requests and usage. */
  readonly log: (line: string) => void;

  constructor(options: RuntimeOptions) {
    this.log = options.log ?? (() => {});
    this.tree = options.tree;
    this.ui = options.ui ?? new UiService();
    this.pullRequests = options.pullRequests ?? (() => new AppSettings().get<boolean>('agents.pullRequests'));
    let warmControl: AbortController | undefined;
    let releaseWarm: (() => void) | undefined;
    this.fullControl = options.fullControl ?? new FullControlManager({ ...(options.confirm ? { confirm: options.confirm } : {}), minutes: options.fullControlMinutes ?? (() => new AppSettings().get<number>('agents.fullControlMinutes')), journal: new RollbackJournal(undefined, [options.tree.agentsDir, options.tree.promptsDir, path.join(options.tree.dataDir, STATE_DIR_NAME), ...options.tree.secretFiles, ...options.tree.protectedFiles, ...(options.conversation?.protectedPaths() ?? []), sfagentsHome()]), onChange: (status) => {
      options.onFullControlChange?.(status);
      if (status) {
        const controller = new AbortController(); warmControl = controller;
        void this.ui.warm(controller.signal).then((release) => { if (controller.signal.aborted) release(); else releaseWarm = release; }).catch(() => undefined);
      } else { warmControl?.abort(); warmControl = undefined; releaseWarm?.(); releaseWarm = undefined; }
    } });
    const env = options.env ?? process.env;
    this.env = env;
    this.secretEnvNames = credentialEnvNames([...this.tree.byId.values()].map((n) => n.definition));
    this.ownsMcp = !options.mcpManager;
    this.mcp = options.mcpManager ?? new McpManager(this.tree.mcp, { secretEnvNames: this.secretEnvNames, env });
    this.providerFactory = options.providerFactory ?? createDefaultProviderFactory(env);
    this.confirm = options.confirm;
    this.approveAll = options.approveAll ?? false;
    this.transcribe = options.transcribe;
    this.conversation = options.conversation;
    this.threads = new ThreadService(options.conversation?.dir);
    this.web = options.web ?? new BrightDataWeb(() => new ProviderRegistry().webKey());
    if (options.git) this.git = options.git;
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
    role: 'main' | 'thread' = 'main',
    link: RunLink = idleLink(node.id),
  ): Promise<Map<string, AnyDeclarativeTool>> {
    const d = node.definition;
    const current = () => this.tree.byId.get(node.id)?.definition;
    const level = () => current()?.network ?? 'off';
    const runtime = this;
    // Access defaults depend on where the agent works (see conversationAccess).
    const depth = role === 'main' ? 0 : 1;
    const tools = new Map<string, AnyDeclarativeTool>();
    // SF Agents' own commands: sfa-web (network "on") and sfa-artifact (artifacts.access "create").
    const commands: HostCommands = {
      networkLevel: level,
      web: { access: this.web, remaining: d.limits?.webRequests ?? DEFAULT_WEB_REQUESTS, ready: (await this.web.ready?.().catch(() => false)) ?? true },
      ...(conversation?.file ? { artifact: artifactCommand(conversation, artifactAccess(d, depth), role === 'main' ? recorder?.runId : undefined) } : {}),
    };
    if (!commands.artifact) delete commands.artifact;
    commands.view = { maxImages: d.limits?.viewImages ?? DEFAULT_VIEW_IMAGES, ...(this.transcribe ? { transcribe: this.transcribe } : {}) };
    const mcp = await this.mcpGrant(node, agentPath, emit);
    if (mcp) commands.mcp = mcp;
    if (this.git) {
      const confirm = this.confirm;
      const approveAll = this.approveAll;
      commands.git = {
        ...(role === 'main' && agentPath.length === 1 ? { pullInto: async (repo: string, task: string, folder: string) => {
          const lease = this.fullControl.require(link);
          if (!this.projectFolders(node.id).includes(folder)) throw new Error('Pick one of this agent’s Project Folders.');
          return this.git!.pullInto(repo, task, folder, async (q) => this.fullControl.approveAction(link, node.id, q, link.signal), AbortSignal.any([link.signal, lease]));
        } } : {}),
        workspaces: this.git,
        pullRequests: new GitHubPullRequests(this.git, this.pullRequests),
        agentId: node.id,
        get level() { return level(); },
        approve: async (question) => {
          if (approveAll) return true;
          if (!confirm) return false;
          const answer = await confirm({ agentPath: [...agentPath], toolName: 'sfa-git', details: { type: 'info', title: 'Git', prompt: question } }, new AbortController().signal);
          return answer !== 'deny';
        },
      };
    }
    const ctx: ToolContext = {
      agentId: node.id,
      ...(role === 'main' && agentPath.length === 1 ? { fullControl: { manager: this.fullControl, owner: link } } : {}),
      maxOutputChars: d.limits?.maxToolOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      secretEnvNames: this.secretEnvNames,
      shellTimeoutMs: (d.limits?.shellTimeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_MS / 1000) * 1000,
      get container() { return { level: level(), roots: runtime.projectFolders(node.id), hidden: runtime.hiddenPaths(), ...current()?.container }; },
      patchFormat: this.patchFormat(d),
      commands,
    };
    const hostGrant = role === 'main' && agentPath.length === 1 ? { manager: this.fullControl, owner: link } : undefined;
    commands.ui = {
      container: new ContainerUiAdapter(() => ({ agentId: node.id, ...ctx.container })),
      ...(hostGrant ? { host: new WindowsUiAdapter(), fullControl: hostGrant } : {}), service: this.ui,
    };
    tools.set(ToolNames.SHELL, new ShellTool(ctx));

    // The agent replying to the person can talk with them mid-turn (and ask them questions).
    const toUser = role === 'main' && !!conversation && conversation === this.conversation;
    // Every agent has message: talking with the person and agents, and (in the persistent conversation) searching and filing it.
    tools.set(ToolNames.MESSAGE, new MessageTool(this, node, this.tree.byId, agentPath, emit, conversation, link, toUser, conversation?.file ? conversationAccess(d, depth) : 'none', role === 'main' && agentPath.length === 1 ? { manager: this.fullControl, owner: link } : undefined));
    return tools;
  }

  /**
   * The agent's MCP servers for `sfa-mcp`: the servers in mcp.json it was
   * granted. A server that does not start shows up in `sfa-mcp list` as
   * unavailable; a granted tool the server lacks is a warning.
   */
  private async mcpGrant(node: AgentNode, agentPath: readonly string[], emit: (event: RuntimeEvent) => void): Promise<McpGrant | undefined> {
    const d = node.definition;
    const servers = new Map<string, McpServerGrant>();
    for (const [server, grantedTools] of mcpGrants(d)) {
      const cfg = this.tree.mcp.servers[server];
      if (!cfg) continue;
      servers.set(server, { ...(grantedTools ? { tools: grantedTools } : {}), trusted: cfg.trust === true });
      if (!grantedTools?.size || !this.mcp.isStarted(server)) continue;
      try {
        const names = new Set((await this.mcp.getTools(server)).map((t) => t.name));
        for (const wanted of grantedTools) {
          if (!names.has(wanted)) emit({ type: 'warning', agentPath, message: `MCP server "${server}" does not expose granted tool "${wanted}" (or the server's includeTools/excludeTools filters it).` });
        }
      } catch {
        // sfa-mcp reports it when the agent uses the server
      }
    }
    if (!servers.size) return undefined;
    const sessionApprovals = this.sessionApprovals.get(node.id) ?? new Set<string>();
    this.sessionApprovals.set(node.id, sessionApprovals);
    return {
      manager: this.mcp,
      servers,
      approve: mcpApprover(servers, { agentPath, autoApprove: d.tools?.autoApprove ?? [], sessionApprovals, approveAll: this.approveAll, ...(this.confirm ? { confirm: this.confirm } : {}) }),
    };
  }

  /** One agent's mounted folders; without an id, the union for the person's file/review UI. */
  projectFolders(agentId?: string): string[] {
    const folders = agentId === undefined
      ? [...new Set([...this.tree.byId.values()].flatMap((n) => n.definition.folders ?? []))]
      : this.tree.byId.get(agentId)?.definition.folders ?? [];
    return folders.filter((f) => {
      try {
        return fs.statSync(f).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /**
   * What agents never see inside the project folders: SF Agents' own data
   * (the project's data folder with agents, prompts, mcp.json, .env and the
   * conversation, and the per-user folder). Secret files such as .env and
   * keys are hidden too, wherever they are (see findSecretFiles).
   */
  hiddenPaths(): string[] {
    return [...new Set([
      this.tree.dataDir,
      this.tree.agentsDir,
      this.tree.promptsDir,
      ...this.tree.secretFiles,
      ...this.tree.protectedFiles,
      ...(this.conversation?.dir ? [this.conversation.dir] : []),
      ...(this.conversation?.protectedPaths() ?? []),
      sfagentsHome(),
    ].map((p) => path.resolve(p)))];
  }

  /** The edit format for the model an agent replies with: apply_patch for GPT and Codex, search/replace for the rest. */
  private patchFormat(d: Readonly<AgentDefinition>): PatchFormat {
    try {
      const registry = new ProviderRegistry();
      const choice = providerChoices(d, registry)[0];
      const record = choice ? registry.find(choice.provider) : undefined;
      return patchFormatFor(choice?.model ?? d.model, record?.kind === 'openai' ? 'codex' : undefined);
    } catch {
      return patchFormatFor(d.model);
    }
  }

  private provider(definition: Readonly<AgentDefinition>): ModelProvider {
    return this.providerFactory(definition);
  }

  /** Runs one agent until it answers, fails, times out, runs out of turns or is cancelled. */
  /**
   * Takes newly loaded agents (their files or mcp.json changed). Runs in
   * progress keep their definitions, except network levels take effect on the
   * next request and revoke existing tunnels. The next turn uses all new
   * definitions. MCP servers restart only when mcp.json
   * changed, and the old connections close once no run uses them.
   */
  reload(tree: AgentTree): { mcpChanged: boolean } {
    const mcpChanged = JSON.stringify(tree.mcp.servers) !== JSON.stringify(this.tree.mcp.servers);
    for (const id of this.tree.byId.keys()) containerManager().setNetworkLevel(id, tree.byId.get(id)?.definition.network ?? 'off');
    this.tree = tree;
    this.secretEnvNames = credentialEnvNames([...tree.byId.values()].map((n) => n.definition));
    if (mcpChanged && this.ownsMcp) {
      this.retired.push(this.mcp);
      this.mcp = new McpManager(tree.mcp, { secretEnvNames: this.secretEnvNames, env: this.env });
      this.closeRetired();
    }
    return { mcpChanged };
  }

  private closeRetired(): void {
    if (this.activeRuns > 0 || !this.retired.length) return;
    const old = this.retired;
    this.retired = [];
    for (const m of old) void m.dispose();
  }

  async run(params: RunParams): Promise<AgentRunResult> {
    this.activeRuns++;
    params.link ??= idleLink(params.node.id);
    try {
      return await this.runAgent(params);
    } finally {
      this.activeRuns--;
      if (params.link) this.fullControl.endRun(params.link);
      // Every task this agent touched gets a checkpoint commit, so the run can be undone and reviewed.
      if (this.git) await this.git.checkpointAgent(params.node.id, params.task.replace(/\s+/g, ' ').slice(0, 72)).catch(() => undefined);
      this.closeRetired();
    }
  }

  private async runAgent(params: RunParams): Promise<AgentRunResult> {
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
    // Agents this run starts without waiting stop when it does.
    const children = new AbortController();
    signal.addEventListener('abort', () => children.abort(signal.reason), { once: true });
    const link: RunLink = params.link ?? { agent: node.id, mailbox: new Mailbox(), signal, children: new Map() };
    link.signal = children.signal;
    if (recorder) link.recorder = recorder;
    if (params.waitForPerson) link.waitForPerson = params.waitForPerson;

    const finish = (status: AgentTerminateMode, error?: string): AgentRunResult => {
      clearTimeout(timer);
      this.log(`model: ${agentPath.join(' > ')} run ended (${status}${error ? `: ${error}` : ''}) after ${turns} turn(s), ${Math.round((Date.now() - started) / 1000)} s; ${usageText(usage)}`);
      this.fullControl.endRun(link);
      params.signal.removeEventListener('abort', onParentAbort);
      if (link.children.size) children.abort(new Error('The agent that started this one stopped.'));
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
      tools = await this.buildTools(node, agentPath, emit, recorder, params.conversation, params.role ?? 'main', link);
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

    const activeNames = () => [...tools.keys()];
    const declarations = () => activeNames().map((name) => tools.get(name)!.schema);
    let systemExtra: string | undefined;
    if (params.prepareContext) {
      try {
        const base = buildSystemPrompt(node, activeNames(), undefined, link, features(tools));
        const prepared = params.prepareContext(base + JSON.stringify(declarations()));
        messages.splice(0, messages.length, ...prepared.messages);
        systemExtra = prepared.systemExtra || undefined;
        if (prepared.report) emit({ type: 'context', agentPath, ...prepared.report });
      } catch (error) {
        const message = getErrorMessage(error);
        emit({ type: 'error', agentPath, message });
        return finish(AgentTerminateMode.ERROR, message);
      }
    }
    if (params.conversation?.file && artifactAccess(node.definition, (params.role ?? 'main') === 'main' ? 0 : 1) !== 'none') {
      const index = artifactIndex(params.conversation);
      if (index) systemExtra = systemExtra ? `${systemExtra}\n\n${index}` : index;
    }
    const fullSystem = buildSystemPrompt(node, activeNames(), systemExtra, link, features(tools));
    const systemPrompt = params.stableSystem ? params.stableSystem({ base: buildSystemPrompt(node, activeNames(), undefined, link, features(tools)), full: fullSystem }) : fullSystem;
    if (messages[0]?.role === 'system') messages[0] = { role: 'system', content: systemPrompt };
    else messages.unshift({ role: 'system', content: systemPrompt });
    const maxTurns = d.limits?.maxTurns ?? DEFAULT_MAX_TURNS;
    const approvals = this.sessionApprovals.get(node.id) ?? new Set<string>();
    this.sessionApprovals.set(node.id, approvals);

    try {
    const recordTurn = record;
    // Messages the person sent meanwhile join the run before the next request.
    // So do messages from other agents (replies, questions, follow-ups).
    const takeInbox = (): boolean => {
      const arrived = params.inbox?.() ?? [];
      for (const item of link.mailbox.take()) {
        recordTurn(() => item.record?.());
        emit({ type: 'agent_message', agentPath, from: item.from, ...(item.thread ? { thread: item.thread } : {}), text: item.content });
        arrived.push({ role: 'user', content: item.content });
      }
      if (!arrived.length) return false;
      messages.push(...arrived);
      return true;
    };
    while (turns < maxTurns) {
      if (signal.aborted) return finish(...stopReason());
      takeInbox();
      turns++;
      let done: Extract<ModelStreamEvent, { type: 'done' }> | undefined;
      let turnText = '';
      const who = agentPath.join(' > ');
      const step = this.fullControl.holds(link) ? this.fullControl.context(link) : undefined;
      const requestMessages = withStepContext(messages, `Network level now: ${this.tree.byId.get(node.id)?.definition.network ?? 'off'} (the current editor setting overrides earlier network descriptions).`, step);
      // The step note stays in the run's history as sent: a message that
      // changed after it was sent would break the provider's prompt cache
      // from that message on, for every later request of the run.
      if (step && messages.length > 1) messages[messages.length - 1] = requestMessages[requestMessages.length - 1]!;
      const requestTools = declarations();
      const estimate = estimateRequestTokens(requestMessages, requestTools);
      const requestStarted = Date.now();
      this.log(`model: ${who} turn ${turns}: request to ${provider.id} (${d.model || 'default model'}${(params.reasoning ?? d.reasoning) ? `, effort ${params.reasoning ?? d.reasoning}` : ''}): ${requestMessages.length} messages, ${requestTools.length} tools, about ${estimate} tokens by estimate`);
      try {
        for await (const event of provider.stream({
          model: d.model,
          messages: requestMessages,
          tools: requestTools,
          reasoning: params.reasoning ?? d.reasoning,
          temperature: d.temperature,
          maxOutputTokens: d.maxOutputTokens,
          signal,
        })) {
          if (event.type === 'log') {
            this.log(`model: ${who}: ${event.text}`);
          } else if (event.type === 'text') {
            turnText += event.text;
            emit({ type: 'text', agentPath, text: event.text });
          } else if (event.type === 'reasoning') {
            emit({ type: 'reasoning', agentPath, text: event.text });
          } else if (event.type === 'notice') {
            emit({ type: 'warning', agentPath, message: event.text });
          } else {
            done = event;
          }
        }
      } catch (error) {
        // A failed request can still have used tokens (a limit hit mid-run).
        const spent = error instanceof ProviderError ? error.usage : undefined;
        if (spent) {
          addUsage(usage, spent);
          emit({ type: 'model_usage', agentPath, usage: spent, estimatedTokens: estimate });
        }
        this.log(`model: ${who} turn ${turns}: ${signal.aborted || isAbortError(error) ? 'stopped' : 'failed'} after ${Date.now() - requestStarted} ms: ${getErrorMessage(error)}${spent ? ` (used ${usageText(spent)})` : ''}`);
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
      if (done.usage) emit({ type: 'model_usage', agentPath, usage: done.usage, estimatedTokens: estimate });
      this.log(`model: ${who} turn ${turns}: ${done.finishReason ?? 'done'} in ${Date.now() - requestStarted} ms, ${done.toolCalls.length ? `tool calls ${done.toolCalls.map((c) => c.name).join(', ')}` : 'no tool calls'}; ${usageText(done.usage)}; run so far ${usageText(usage)}`);
      const assistantMessage = done.message;
      const finishReason = done.finishReason;
      recordTurn((r) => r.assistant(assistantMessage, finishReason));
      messages.push(done.message);
      if (done.message.content) lastText = done.message.content;

      if (done.toolCalls.length === 0) {
        // A message that arrived while the model answered gets its own answer in this run.
        if (done.finishReason !== 'length' && takeInbox()) continue;
        if (done.finishReason === 'length') {
          return finish(AgentTerminateMode.GOAL, 'The model hit its output token limit; the answer may be incomplete.');
        }
        // Agents it started are still working: the turn waits for what they send, then goes on.
        if (link.children.size > 0) {
          let arrived = false;
          while (link.children.size > 0 && !(arrived = takeInbox())) {
            try {
              await Promise.race([
                link.mailbox.changed(signal),
                ...(params.waitForPerson ? [params.waitForPerson(signal)] : []),
                // A reply already taken by a waiting call ends that agent's work without a message.
                ...[...link.children.values()].map((c) => settled(c.done)),
              ]);
            } catch {
              return finish(...stopReason());
            }
          }
          if (arrived || takeInbox()) continue;
        }
        return finish(AgentTerminateMode.GOAL);
      }

      const execContext = {
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
        beforeExecute: (callId: string, tool: string) => recordTurn((r) => r.toolStart(callId, tool)),
      };
      const pending: ParsedToolCall[] = [...done.toolCalls];
      // Images the calls show (sfa-view) follow all of this step's results.
      const shown: Array<{ callId: string; images: ShownImage[] }> = [];
      while (pending.length > 0) {
        if (signal.aborted) {
          // Keep the conversation valid: every tool call gets a response.
          for (const c of pending) {
            const cancelled = { role: 'tool' as const, tool_call_id: c.id, content: 'Cancelled before execution.' };
            recordTurn((r) => r.toolResult(cancelled, c.name, 'not_started'));
            messages.push(cancelled);
          }
          return finish(...stopReason());
        }
        // Consecutive messages to other agents run in parallel; everything
        // else runs one at a time, in order. Results are recorded in order.
        const batch = [pending.shift()!];
        if (toAgent(batch[0]!)) {
          while (pending[0] && toAgent(pending[0])) batch.push(pending.shift()!);
        }
        const outcomes = await Promise.all(
          batch.map((call) => executeToolCall(call, execContext, signal)),
        );
        batch.forEach((call, i) => {
          const outcome = outcomes[i]!;
          recordTurn((r) => r.toolResult(outcome.message, call.name, outcome.status, outcome.images));
          messages.push(outcome.message);
          if (outcome.images?.length) shown.push({ callId: call.id, images: outcome.images.map((i) => ({ label: i.label ?? 'image', mime: i.mime, data: i.data })) });
          activity.push(outcome.activity);
          // What the agent said to the person is the run's answer.
          const said = outcome.metadata?.['said'];
          if (outcome.status === 'ok' && typeof said === 'string' && said.trim() && !outcome.metadata?.['replyTo']) lastText = said;
        });
      }
      if (shown.length) messages.push(toolImagesMessage(shown));
    }
    } catch (e) {
      if (e instanceof PersistenceFailure) return storageStop(e);
      throw e;
    }
    return finish(AgentTerminateMode.MAX_TURNS, `Agent "${node.id}" reached its limit of ${maxTurns} model turns before finishing.`);
  }

  /**
   * AgentMessenger: `from` writes to `to` in their thread. When `to` is
   * already working in that thread for `from`, the message joins its run
   * at its next step. Otherwise `to` starts answering with the thread as its
   * context: with `wait`, its reply (or the first message it sends `from`)
   * is returned; without, this returns at once and the reply arrives in the
   * writer's mailbox. The exchange is recorded in the thread's file, and the
   * thread is listed as an artifact of the main conversation the first time
   * it is used there.
   */
  /** A thread's records (the message tool's "thread" action). */
  readThread(key: string): ConversationState | undefined {
    return this.threads.read(key);
  }

  async messageAgent(params: {
    from: AgentNode;
    fromPath: readonly string[];
    to: AgentNode;
    max: number;
    message: string;
    thread?: number;
    wait?: boolean;
    signal: AbortSignal;
    emit: (event: RuntimeEvent) => void;
    callId?: string;
    conversation?: ConversationService;
    link?: RunLink;
  }): Promise<MessageOutcome> {
    const { from, signal } = params;
    // The newest definition of the agent written to (its file may have changed since the writer started).
    const to = this.tree.byId.get(params.to.id);
    if (from.grants.get(params.to.id) === undefined || !to) {
      throw new Error(`"${from.id}" may not message "${params.to.id}"${to ? '' : ' (it is no longer in the agents folder)'}`);
    }
    const writer = params.link;
    const wait = params.wait !== false || !writer;

    // Still working for this writer: the message joins its run.
    const running = writer ? [...writer.children.values()].filter((c) => c.agent === to.id) : [];
    let child = params.thread !== undefined ? running.find((c) => c.instance === params.thread) : undefined;
    // No thread given and every thread it may use is busy with its own work: the newest one.
    if (!child && params.thread === undefined && running.length >= params.max) child = running[running.length - 1];
    if (child && writer) {
      const content = mailText(from.id, child.instance, params.message);
      const c = child;
      c.link.mailbox.deliver({ from: from.id, thread: c.thread, content, record: () => c.record(params.message) });
      if (!wait) return { kind: 'delivered', agent: to.id, thread: c.thread, instance: c.instance };
      return this.awaitChild(c, writer, signal);
    }

    const lease = await this.threads.acquire(from.id, to.id, params.max, signal, params.thread);
    let started: ChildRun | undefined;
    try {
      const run = newRunId();
      const store = lease.store;
      store.append({ kind: 'message', id: `m${store.state.nextSeq}`, run, role: 'user', agent: from.id, content: params.message });
      params.conversation?.noteThread?.(lease.relPath, `${from.id} ↔ ${to.id}${lease.instance > 1 ? ` (${lease.instance})` : ''}`);
      const recorder = new ThreadRecorder(store, run, to.id, this.tree.configDir);
      const d = to.definition;
      const budget = d.context?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
      const target = replayTarget(d);
      const prepareContext = (fixedText: string) => {
        const usable = Math.floor(budget * (1 - TURN_RESERVE)) - Math.ceil(fixedText.length / 4) - 200;
        const oldBudget = d.context?.oldMessagesPercent === undefined ? undefined : Math.floor(budget * d.context.oldMessagesPercent / 100);
        const { messages, omitted } = threadMessages(store.state, to.id, target, Math.max(1000, usable), oldBudget);
        return { messages, systemExtra: threadNote(to, from.id, omitted) };
      };
      // How the writer and this run reach each other while both work.
      const childLink: RunLink = {
        agent: to.id,
        mailbox: new Mailbox(),
        signal,
        children: new Map(),
        ...(writer ? { partner: { id: from.id, thread: lease.key, instance: lease.instance, link: writer } } : {}),
      };
      const runSignal = writer ? writer.signal : signal;
      const done = this.run({
        node: to,
        agentPath: [...params.fromPath, to.id],
        messages: [],
        task: params.message,
        signal: runSignal,
        emit: params.emit,
        recorder,
        conversation: params.conversation,
        prepareContext,
        role: 'thread',
        threadWith: from.id,
        link: childLink,
      });
      started = {
        agent: to.id,
        thread: lease.key,
        instance: lease.instance,
        link: childLink,
        record: (text) => store.append({ kind: 'message', id: `m${store.state.nextSeq}`, run, role: 'user', agent: from.id, content: text }),
        done,
      };
      const c = started;
      if (writer) writer.children.set(lease.key, c);
      void done
        .then(
          async (result) => {
            if (!writer) return;
            // A writer waiting for this reply gets it as its call's result instead.
            await new Promise((resolve) => setImmediate(resolve));
            if (c.collected) return;
            const status = result.status === AgentTerminateMode.GOAL ? 'replied' : `${result.status.toLowerCase()}${result.error ? `: ${result.error}` : ''}`;
            const content = mailText(to.id, c.instance, result.text || '(no reply text)', status);
            writer.mailbox.deliver({ from: to.id, thread: c.thread, content, record: () => writer.recorder?.note?.(to.id, content) });
          },
          () => undefined,
        )
        .finally(() => {
          writer?.children.delete(c.thread);
          lease.release();
        });
      if (!wait) return { kind: 'started', agent: to.id, thread: lease.key, instance: lease.instance };
      return await this.awaitChild(c, writer, signal);
    } catch (error) {
      if (!started) lease.release();
      throw error;
    }
  }

  /** The child's final reply, or the first message it sends the writer meanwhile. */
  private async awaitChild(child: ChildRun, writer: RunLink | undefined, signal: AbortSignal): Promise<MessageOutcome> {
    if (!writer) return { kind: 'replied', result: await child.done, thread: child.thread, instance: child.instance };
    const inner = new AbortController();
    const onAbort = () => inner.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const first = await Promise.race([
        child.done.then((result) => ({ result })),
        writer.mailbox.next((m) => m.from === child.agent && m.thread === child.thread, inner.signal).then((mail) => ({ mail })),
      ]);
      if ('result' in first) {
        child.collected = true;
        return { kind: 'replied', result: first.result, thread: child.thread, instance: child.instance };
      }
      return { kind: 'message', agent: child.agent, thread: child.thread, instance: child.instance, message: first.mail.content };
    } finally {
      signal.removeEventListener('abort', onAbort);
      inner.abort();
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async dispose(): Promise<void> {
    this.fullControl.stop('runtime closed');
    this.ui.stop();
    if (this.disposed) return;
    this.disposed = true;
    this.threads.close();
    await Promise.all([this.mcp.dispose(), ...this.retired.map((m) => m.dispose()), this.web.close()]);
  }
}

/** A message for the replying agent (the person's, or a note SF Agents writes for them). */
export interface InboxItem {
  content: string;
  attachments?: AttachmentRef[];
  replyTo?: string;
  event?: 'reaction';
  /** Sent from a GenUI view. */
  from?: ViewSource;
}

export interface SendOptions {
  signal?: AbortSignal;
  attachments?: AttachmentRef[];
  replyTo?: string;
  /** The input is a note SF Agents wrote (a reaction), not the person's typing. */
  event?: 'reaction';
  /** The input was sent from a GenUI view. */
  from?: ViewSource;
  /** Messages that arrived since; the model takes them between its steps. */
  inbox?: () => InboxItem[];
  /** Resolves when the person's next message is waiting in the inbox (so the agent can wait for an answer). */
  waitForInput?: (signal: AbortSignal) => Promise<void>;
  /** Called when a message from the inbox is recorded (the model is about to read it). */
  onInput?: (record: MessageRecord) => void;
  /** Extra system text for this run (read receipts), read when the context is built. */
  note?: () => string | undefined;
}

/** A context breakdown with its token figures scaled to the provider's own counts. */
function scaleBreakdown(b: ContextBreakdown, ratio: number): ContextBreakdown {
  const t = (n: number) => Math.round(n * ratio);
  const used = t(b.used);
  return {
    ...b,
    used,
    free: Math.max(0, b.budget - b.reserve - used),
    categories: b.categories.map((c) => ({ ...c, tokens: t(c.tokens), ...(c.items ? { items: c.items.map((i) => ({ ...i, tokens: t(i.tokens) })) } : {}) })),
  };
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
  lastRequest: { usage: TokenUsage; at: number; estimatedTokens?: number } | undefined;
  /** Provider-reported input tokens per estimated token, from recent requests (calibrates the context figures), for one agent and model. */
  tokenRatio: { key: string; value: number } | undefined;
  /** What the current or last run of this session used, all requests together. */
  runUsage: { usage: TokenUsage; started: number; requests: number } | undefined;

  private agentId: string;
  /** Where the working context starts (older exchanges are dropped in batches, see buildWorkingContext). */
  private contextFloor: number | undefined;
  /** Where stubbed tool output ends, and what came before the messages when it was set. */
  private contextStub: { seq: number | undefined; fixed: string } | undefined;
  /** The system prompt reused while its parts stay the same (see RunParams.stableSystem). */
  private systemEpoch: { key: string; prompt: string } | undefined;

  constructor(
    private readonly runtime: AgentRuntime,
    node: AgentNode,
    readonly conversation: ConversationService,
  ) {
    this.agentId = node.id;
  }

  /**
   * The agent replying in the conversation (any of the project's agents; see
   * setAgent), in its newest definition. If its file was removed, the
   * project's default agent takes over.
   */
  get node(): AgentNode {
    return this.runtime.tree.byId.get(this.agentId) ?? this.runtime.tree.root;
  }

  /**
   * Hands the conversation to another agent: later turns are its, with the
   * same history. Not while a turn is running.
   */
  setAgent(name: string): AgentNode {
    const node = this.runtime.tree.byId.get(name);
    if (!node) throw new Error(`no agent named "${name}"`);
    if (this.busy && node.id !== this.node.id) throw new Error('Cannot change the agent while a turn is running');
    this.agentId = node.id;
    return node;
  }

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
  /** Records one root request's usage: the last request, the run's total, and how estimates compare with real counts. */
  private noteUsage(usage: TokenUsage, estimated?: number): void {
    const at = Date.now();
    this.lastRequest = { usage, at, ...(estimated ? { estimatedTokens: estimated } : {}) };
    if (this.runUsage) {
      addTokenUsage(this.runUsage.usage, usage);
      this.runUsage.requests++;
    }
    const real = usage.promptTokens;
    if (estimated && estimated > 500 && real && real > 0) {
      const ratio = Math.min(4, Math.max(0.25, real / estimated));
      const key = this.ratioKey();
      // Smoothed, so one odd request does not swing the figures.
      this.tokenRatio = this.tokenRatio?.key === key ? { key, value: this.tokenRatio.value * 0.5 + ratio * 0.5 } : { key, value: ratio };
    }
  }

  private ratioKey(): string {
    return `${this.node.id}\u0000${this.node.definition.model}`;
  }

  async contextUsage(): Promise<ContextBreakdown & { lastRequest?: { usage: TokenUsage; at: number; estimatedTokens?: number }; run?: { usage: TokenUsage; started: number; requests: number; running: boolean }; calibration?: number }> {
    const definition = this.node.definition;
    const conversation = this.conversation;
    const tools = await this.runtime.buildTools(this.node, [this.node.id], () => undefined, undefined, conversation);
    const list: ContextTool[] = [...tools.entries()].map(([name, tool]) => ({
      name,
      group: name === ToolNames.MESSAGE ? 'agents' : (Object.values(ToolNames) as string[]).includes(name) ? 'builtin' : 'conversation',
      schema: tool.schema,
    }));
    // SF Agents' commands are part of the shell tool; listed so they can be found.
    const shell = tools.get(ToolNames.SHELL);
    if (shell instanceof ShellTool) {
      for (const name of shell.commandNames) list.push({ name, group: 'builtin', partOf: ToolNames.SHELL, schema: hostCommandSchema(name) });
      // MCP tools are reached through sfa-mcp: listed by server, costing nothing until used.
      for (const [server, granted] of mcpGrants(definition)) {
        if (!this.runtime.tree.mcp.servers[server]) continue;
        let tools: McpToolInfo[] = [];
        try {
          tools = await this.runtime.mcp.getTools(server);
        } catch {
          continue;
        }
        for (const t of tools) if (!granted || granted.has(t.name)) list.push({ name: `${server}.${t.name}`, group: 'mcp', server, partOf: ToolNames.SHELL, schema: { name: t.name, description: t.description, parameters: t.inputSchema } });
      }
    }
    const retrievable = conversation.file !== undefined && conversationAccess(definition, 0) !== 'none';
    const index = conversation.file && artifactAccess(definition, 0) !== 'none' ? artifactIndex(conversation) : undefined;
    const breakdown = contextBreakdown(conversation.state, replayTarget(definition), definition.context ?? {}, buildSystemPrompt(this.node, [...tools.keys()], undefined, undefined, features(tools)), list, {
      retrievable,
      resolveAttachment: (ref) => conversation.readAttachment(ref),
      ...(index ? { extraSystem: index } : {}),
    });
    // The estimates (characters / 4) scaled by how the provider actually counted recent requests.
    const ratio = this.tokenRatio?.key === this.ratioKey() ? this.tokenRatio.value : undefined;
    const scaled = ratio ? scaleBreakdown(breakdown, ratio) : breakdown;
    return {
      ...scaled,
      ...(ratio ? { calibration: Math.round(ratio * 1000) / 1000 } : {}),
      ...(this.lastRequest ? { lastRequest: this.lastRequest } : {}),
      ...(this.runUsage ? { run: { ...this.runUsage, running: this.busy } } : {}),
    };
  }

  /** /clear: later turns start from a fresh working context; history is kept. */
  resetContext(): void {
    if (this.busy) throw new Error('Cannot reset the context while a turn is running');
    this.conversation.resetContext();
    this.contextFloor = undefined;
    this.contextStub = undefined;
    this.systemEpoch = undefined;
  }

  /**
   * Sends one user message. The message is stored before the model request
   * starts. Yields events as they happen and returns the structured result
   * of the root agent's turn.
   */
  async *send(input: string, options: SendOptions = {}): AsyncGenerator<RuntimeEvent, AgentRunResult> {
    if (this.busy) throw new Error('A turn is already running in this session');
    this.busy = true;
    try {
      // One definition for the whole turn, even if the agent's file changes meanwhile.
      const node = this.node;
      const recorder = this.conversation.beginRootRun(node);
      this.runUsage = { usage: {}, started: Date.now(), requests: 0 };
      // Read receipts and the like are stored with the message they came with,
      // so later replies show that message exactly as the model first saw it.
      const st = this.conversation.state;
      // A summary that is due is asked for here, so the agent writes it with its reply rather than after a refusal.
      const due = st.currentSection && conversationAccess(node.definition, 0) === 'organize' && summaryDue(st, false) ? `\nThe summary of ${st.currentSection} is due: include "section_summary" in your next message to the person.` : '';
      const note = [options.note?.(), st.currentSection ? `<current_section>${st.currentSection}${due}</current_section>` : ''].filter(Boolean).join('\n') || undefined;
      recorder.user(input, options.attachments, options.replyTo, options.event, options.from, note);
      const messages: ChatMessage[] = [];
      this.lastMessages = messages;
      const definition = node.definition;
      const conversation = this.conversation;
      const retrievable = conversation.file !== undefined && conversationAccess(definition, 0) !== 'none';
      const prepareContext = (fixedText: string) => {
        const state = conversation.state;
        // Whatever sits before the messages: when it changes, the provider rereads everything anyway.
        const fixed = [fixedText, state.lastResetSeq, sectionEntries(state).map((e) => `${e.id}:${e.title}`).join('|'), [...state.artifactViews.keys()].join(',')].join('\u0000');
        const prepared = buildWorkingContext(state, replayTarget(definition), definition.context ?? {}, fixedText, {
          retrievable,
          resolveAttachment: (ref) => conversation.readAttachment(ref),
          ...(this.contextFloor !== undefined ? { floorSeq: this.contextFloor } : {}),
          ...(this.contextStub?.seq !== undefined ? { stubBefore: this.contextStub.seq } : {}),
          rebuild: this.contextStub !== undefined && this.contextStub.fixed !== fixed,
        });
        this.contextFloor = prepared.floorSeq;
        this.contextStub = { seq: prepared.stubBefore, fixed };
        return prepared;
      };
      const stableSystem = ({ base, full }: { base: string; full: string }): string => {
        const state = conversation.state;
        const key = [base, this.contextFloor ?? '', this.contextStub?.seq ?? '', state.lastResetSeq, sectionEntries(state).map((e) => `${e.id}:${e.title}`).join('|'), [...state.artifactViews.keys()].join(',')].join('\u0000');
        if (this.systemEpoch?.key === key) return this.systemEpoch.prompt;
        this.systemEpoch = { key, prompt: full };
        return full;
      };
      // Messages sent while the run works: recorded when the model takes them, then shown to it.
      const inbox = options.inbox
        ? () =>
            options.inbox!().flatMap((item) => {
              const id = recorder.user(item.content, item.attachments, item.replyTo, item.event, item.from);
              const record = id ? conversation.state.messages.find((m) => m.id === id) : undefined;
              if (!record) return [];
              options.onInput?.(record);
              return toChatMessages(conversation.state, replayTarget(definition), 0, [record], (ref) => conversation.readAttachment(ref));
            })
        : undefined;
      const queue: RuntimeEvent[] = [];
      let wake: (() => void) | undefined;
      const emit = (event: RuntimeEvent) => {
        if (event.type === 'model_usage' && event.agentPath.length === 1) this.noteUsage(event.usage, event.estimatedTokens);
        queue.push(event);
        wake?.();
      };
      let result: AgentRunResult | undefined;
      let failure: unknown;
      const running = this.runtime
        .run({
          node,
          agentPath: [node.id],
          messages,
          task: input,
          signal: options.signal ?? new AbortController().signal,
          emit,
          recorder,
          conversation: this.conversation,
          prepareContext,
          stableSystem,
          role: 'main',
          ...(inbox ? { inbox } : {}),
          ...(inbox && options.waitForInput ? { waitForPerson: options.waitForInput } : {}),
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
