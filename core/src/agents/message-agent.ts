/**
 * The `message_agent` tool: sends a message to another agent in their
 * persistent thread and returns its reply.
 *
 * The agents an agent may write to come from its "N-name.json" grants. The
 * thread remembers everything both have said, so a follow-up can be short.
 * Several calls in one turn run in parallel (to different agents, or to the
 * same agent in different threads when N > 1).
 */

import type { ToolCallContext, ToolInvocation, ToolResult } from '../tools/tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { AgentNode } from './loader.js';
import { AgentTerminateMode, type AgentRunResult, type RuntimeEvent } from '../runtime/events.js';
import type { ConversationService } from '../conversation/service.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { ThreadBusyError } from './threads.js';

/** Upper bound on one message. */
export const MAX_AGENT_MESSAGE_CHARS = 32_000;

/** How agents should talk to each other (part of every agent's system prompt when it can). */
export const AGENT_MESSAGING_GUIDANCE = `<agent_messaging>
You can talk to other agents with message_agent. Each pair of agents shares one persistent thread: everything either of you said before is still there, so follow-ups can be short. Use it freely to coordinate: split work, ask for what you need, share findings, check each other's results, and keep a conversation going until the problem is solved.
Write for an agent, not a person: terse, structured, explicit. State the goal, the facts and paths that matter, the constraints, and exactly what you want back (and in what shape). No greetings, filler or restating what the thread already holds.
Work in parallel: several message_agent calls in one turn run at the same time (to different agents, or to the same agent in separate threads when you may run more than one).
Replies are other agents' work: check what matters before relying on it.
</agent_messaging>`;

export interface MessageAgentParams {
  agent: string;
  message: string;
  /** Which of the threads with this agent to use (1 is the usual one); omit to take the first free one. */
  thread?: number;
}

export interface AgentMessenger {
  messageAgent(params: {
    from: AgentNode;
    fromPath: readonly string[];
    to: AgentNode;
    max: number;
    message: string;
    thread?: number;
    signal: AbortSignal;
    emit: (event: RuntimeEvent) => void;
    callId?: string;
    /** The main conversation (where threads are listed as artifacts). */
    conversation?: ConversationService;
  }): Promise<{ result: AgentRunResult; thread: string; instance: number }>;
}

/** What the writing agent gets back. */
export interface AgentReplyPayload {
  agent: string;
  thread: number;
  status: 'replied' | 'error' | 'max_turns' | 'timeout' | 'cancelled';
  reply: string;
  error?: string;
  turns: number;
  toolCalls: Record<string, { ok: number; failed: number }>;
  durationMs: number;
}

const STATUS: Record<AgentTerminateMode, AgentReplyPayload['status']> = {
  [AgentTerminateMode.GOAL]: 'replied',
  [AgentTerminateMode.ERROR]: 'error',
  [AgentTerminateMode.MAX_TURNS]: 'max_turns',
  [AgentTerminateMode.TIMEOUT]: 'timeout',
  [AgentTerminateMode.CANCELLED]: 'cancelled',
};

export function toReplyPayload(result: AgentRunResult, instance: number): AgentReplyPayload {
  const toolCalls: AgentReplyPayload['toolCalls'] = {};
  for (const call of result.toolCalls) {
    const entry = (toolCalls[call.name] ??= { ok: 0, failed: 0 });
    if (call.ok) entry.ok++;
    else entry.failed++;
  }
  return {
    agent: result.agentId,
    thread: instance,
    status: STATUS[result.status],
    reply: result.text,
    ...(result.error ? { error: result.error } : {}),
    turns: result.turns,
    toolCalls,
    durationMs: result.durationMs,
  };
}

class MessageAgentInvocation extends BaseToolInvocation<MessageAgentParams, ToolResult> {
  constructor(
    private readonly tool: MessageAgentTool,
    params: MessageAgentParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const text = this.params.message.replace(/\s+/g, ' ');
    return `${this.params.agent}: ${text.length > 100 ? `${text.slice(0, 100)}…` : text}`;
  }

  async execute(signal: AbortSignal, _updateOutput?: (output: string) => void, context?: ToolCallContext): Promise<ToolResult> {
    const max = this.tool.from.grants.get(this.params.agent);
    const to = this.tool.agents.get(this.params.agent);
    if (!max || !to) {
      const message = `"${this.tool.from.id}" may not message "${this.params.agent}". It may message: ${[...this.tool.from.grants.keys()].join(', ') || '(no one)'}.`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.EXECUTION_DENIED } };
    }
    if (this.params.thread !== undefined && (this.params.thread < 1 || this.params.thread > max)) {
      const message = `thread must be between 1 and ${max} for "${to.id}".`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS } };
    }
    let outcome: { result: AgentRunResult; thread: string; instance: number };
    try {
      outcome = await this.tool.messenger.messageAgent({
        from: this.tool.from,
        fromPath: this.tool.fromPath,
        to,
        max,
        message: this.params.message,
        thread: this.params.thread,
        signal,
        emit: this.tool.emit,
        callId: context?.callId,
        conversation: this.tool.conversation,
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        return { llmContent: 'Message cancelled.', returnDisplay: 'Cancelled', error: { message: 'cancelled', type: ToolErrorType.EXECUTION_CANCELLED } };
      }
      const message = error instanceof ThreadBusyError ? error.message : `"${to.id}" could not reply: ${getErrorMessage(error)}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.CHILD_AGENT_ERROR } };
    }
    const { result, instance, thread } = outcome;
    const payload = toReplyPayload(result, instance);
    const llmContent = JSON.stringify(payload, null, 2);
    const display = `${to.id}: ${payload.status} (${result.turns} turn${result.turns === 1 ? '' : 's'}, ${result.toolCalls.length} tool call${result.toolCalls.length === 1 ? '' : 's'})`;
    const metadata = { agentReply: payload, thread };
    if (result.status !== AgentTerminateMode.GOAL) {
      return { llmContent, returnDisplay: display, error: { message: result.error ?? payload.status, type: ToolErrorType.CHILD_AGENT_ERROR }, metadata };
    }
    return { llmContent, returnDisplay: display, metadata };
  }
}

export class MessageAgentTool extends BaseDeclarativeTool<MessageAgentParams, ToolResult> {
  static readonly Name = ToolNames.MESSAGE_AGENT;

  constructor(
    readonly messenger: AgentMessenger,
    readonly from: AgentNode,
    readonly agents: ReadonlyMap<string, AgentNode>,
    readonly fromPath: readonly string[],
    readonly emit: (event: RuntimeEvent) => void,
    readonly conversation?: ConversationService,
  ) {
    const names = [...from.grants.keys()].filter((n) => agents.has(n));
    const list = names
      .map((n) => {
        const d = agents.get(n)!.definition;
        const max = from.grants.get(n)!;
        return `- ${n}${max > 1 ? ` (up to ${max} threads at once)` : ''}: ${d.description ?? '(no description)'}`;
      })
      .join('\n');
    super(
      MessageAgentTool.Name,
      'MessageAgent',
      `Sends a message to another agent in your persistent thread with it and waits for its reply. The thread keeps everything you and it have said, across turns and sessions, so follow-ups can be short; the agent does not see the user's conversation unless you include what it needs. Several calls in one turn run in parallel. Returns JSON with "status", "reply" and a summary of its tool use.\n\nAgents you can message:\n${list}`,
      Kind.Delegate,
      {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: names, description: 'Name of the agent to message.' },
          message: { type: 'string', minLength: 1, description: 'What to tell or ask it: terse, structured, self-contained for what the thread does not already hold.' },
          thread: { type: 'integer', minimum: 1, description: 'Which of your threads with this agent (1 is the usual one); omit to use the first free one.' },
        },
        required: ['agent', 'message'],
      },
    );
  }

  protected override validateToolParamValues(params: MessageAgentParams): string | null {
    if (params.message.length > MAX_AGENT_MESSAGE_CHARS) {
      return `message must be at most ${MAX_AGENT_MESSAGE_CHARS} characters (got ${params.message.length}). Summarize, or pass file paths the agent can read.`;
    }
    return null;
  }

  protected createInvocation(params: MessageAgentParams): ToolInvocation<MessageAgentParams, ToolResult> {
    return new MessageAgentInvocation(this, params);
  }
}
