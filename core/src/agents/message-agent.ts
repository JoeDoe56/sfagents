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
import type { RunRecorder } from '../runtime/recorder.js';
import { delay, type Mailbox } from './mailbox.js';

/** Upper bound on one message. */
export const MAX_AGENT_MESSAGE_CHARS = 32_000;

/** How agents should talk to each other (part of every agent's system prompt when it can). */
export const AGENT_MESSAGING_GUIDANCE = `<agent_messaging>
You can talk to other agents with message_agent. Each pair of agents shares one persistent thread: everything either of you said before is still there, so follow-ups can be short.
Messages do not block: message_agent hands the work over and returns at once, and the agent works alongside you. Keep working on your own part meanwhile. Its reply, and anything it asks or tells you on the way, arrives in your context as a message between your steps ("[from <agent>, thread N]").
- Talk back and forth freely while both of you work: send corrections, extra context or new priorities to an agent that is still working (message_agent again, with its thread number), answer its questions as soon as they arrive, and share findings it can use.
- Use "wait": true only when you cannot do anything useful until it answers; you get its reply (or the first message it sends you) as the result.
- When you have nothing else to do and are waiting on agents, call wait_for_messages instead of ending your turn. Your turn does not end while an agent you started is still working: ending it waits for them, then you continue with what they sent.
Write for an agent, not a person: terse, structured, explicit. State the goal, the facts and paths that matter, the constraints, and exactly what you want back (and in what shape). No greetings, filler or restating what the thread already holds.
Work in parallel: split independent work across agents (or several threads of one agent when you may run more than one).
Replies are other agents' work: check what matters before relying on it.
</agent_messaging>`;

/** What an agent answering another is told about talking back (thread runs). */
export const THREAD_MESSAGING_GUIDANCE = `<talking_back>
You may message the agent that wrote to you at any time with message_agent, without ending your work: ask it a question as soon as one comes up, report a finding it needs early, or tell it you are blocked. Its answers, and any follow-ups it sends, arrive in your context as messages between your steps. With "wait": true you wait for its answer; otherwise keep working and it arrives when it comes. Your final reply still goes back to it as the answer.
</talking_back>`;

export interface MessageAgentParams {
  agent: string;
  message: string;
  /** Which of the threads with this agent to use (1 is the usual one); omit to take the first free one. */
  thread?: number;
  /** Wait for its reply (or its first message back) instead of continuing at once. */
  wait?: boolean;
}

/** What one run can be reached by while it works (see Mailbox). */
export interface RunLink {
  agent: string;
  mailbox: Mailbox;
  /** Stops with the run; agents it started without waiting stop with it. */
  signal: AbortSignal;
  /** Where messages that join the run are recorded. */
  recorder?: RunRecorder;
  /** Agents this run started and that are still working, by thread key. */
  children: Map<string, ChildRun>;
  /** A thread run: the agent that wrote to it, which may be messaged back at any time. */
  partner?: { id: string; thread: string; instance: number; link: RunLink };
  /** The person can answer (the main conversation): resolves when their next message is waiting. */
  waitForPerson?: (signal: AbortSignal) => Promise<void>;
}

export interface ChildRun {
  agent: string;
  thread: string;
  instance: number;
  link: RunLink;
  /** Records a follow-up in the thread when the child takes it. */
  record(content: string): void;
  done: Promise<AgentRunResult>;
  /** Its final reply went back as a waiting call's result (so it is not delivered again). */
  collected?: boolean;
}

export type MessageOutcome =
  | { kind: 'replied'; result: AgentRunResult; thread: string; instance: number }
  | { kind: 'started'; agent: string; thread: string; instance: number }
  | { kind: 'delivered'; agent: string; thread: string; instance: number }
  | { kind: 'message'; agent: string; thread: string; instance: number; message: string };

export interface AgentMessenger {
  messageAgent(params: {
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
    /** The main conversation (where threads are listed as artifacts). */
    conversation?: ConversationService;
    /** The writer's run, when it can be reached while it works. */
    link?: RunLink;
  }): Promise<MessageOutcome>;
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

/** A message another agent sent mid-run, as the model reads it. */
export function mailText(from: string, instance: number, text: string, status?: string): string {
  return `[from ${from}${instance > 1 ? `, thread ${instance}` : ''}${status ? `, ${status}` : ''}] ${text}`;
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
    const partner = this.tool.link?.partner;
    if (partner && this.params.agent === partner.id) return this.toPartner(partner, signal);
    const max = this.tool.from.grants.get(this.params.agent);
    const to = this.tool.agents.get(this.params.agent);
    if (!max || !to) {
      const allowed = [...this.tool.from.grants.keys(), ...(partner ? [partner.id] : [])];
      const message = `"${this.tool.from.id}" may not message "${this.params.agent}". It may message: ${allowed.join(', ') || '(no one)'}.`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.EXECUTION_DENIED } };
    }
    if (this.params.thread !== undefined && (this.params.thread < 1 || this.params.thread > max)) {
      const message = `thread must be between 1 and ${max} for "${to.id}".`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS } };
    }
    let outcome: MessageOutcome;
    try {
      outcome = await this.tool.messenger.messageAgent({
        from: this.tool.from,
        fromPath: this.tool.fromPath,
        to,
        max,
        message: this.params.message,
        thread: this.params.thread,
        // Without a run to deliver to later, the reply has to be waited for.
        wait: this.params.wait === true || !this.tool.link,
        signal,
        emit: this.tool.emit,
        callId: context?.callId,
        conversation: this.tool.conversation,
        ...(this.tool.link ? { link: this.tool.link } : {}),
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        return { llmContent: 'Message cancelled.', returnDisplay: 'Cancelled', error: { message: 'cancelled', type: ToolErrorType.EXECUTION_CANCELLED } };
      }
      const message = error instanceof ThreadBusyError ? error.message : `"${to.id}" could not reply: ${getErrorMessage(error)}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.CHILD_AGENT_ERROR } };
    }
    if (outcome.kind === 'started' || outcome.kind === 'delivered') {
      const llmContent = JSON.stringify({
        agent: outcome.agent,
        thread: outcome.instance,
        status: outcome.kind,
        note:
          outcome.kind === 'started'
            ? `${outcome.agent} is working on it. Keep working; its reply and anything it sends you arrive as messages. Message it again with thread ${outcome.instance} to add or change something while it works.`
            : `${outcome.agent} is still working and gets this at its next step.`,
      });
      return { llmContent, returnDisplay: `${outcome.agent}: ${outcome.kind}`, metadata: { thread: outcome.thread } };
    }
    if (outcome.kind === 'message') {
      const llmContent = JSON.stringify({ agent: outcome.agent, thread: outcome.instance, status: 'message', message: outcome.message, note: `${outcome.agent} is still working; this is a message it sent you on the way.` });
      return { llmContent, returnDisplay: `${outcome.agent}: message`, metadata: { thread: outcome.thread } };
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

  /** To the agent this one is working for: it gets it at its next step. */
  private async toPartner(partner: NonNullable<RunLink['partner']>, signal: AbortSignal): Promise<ToolResult> {
    const link = this.tool.link!;
    const from = this.tool.from.id;
    const content = mailText(from, partner.instance, this.params.message);
    partner.link.mailbox.deliver({ from, thread: partner.thread, content, record: () => partner.link.recorder?.note?.(from, content) });
    if (!this.params.wait) {
      return { llmContent: JSON.stringify({ agent: partner.id, status: 'delivered', note: `${partner.id} gets it at its next step; its answer arrives as a message. Keep working meanwhile.` }), returnDisplay: `${partner.id}: delivered` };
    }
    try {
      const answer = await link.mailbox.next((m) => m.from === partner.id, signal);
      return { llmContent: JSON.stringify({ agent: partner.id, status: 'answered', message: answer.content }), returnDisplay: `${partner.id}: answered` };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return { llmContent: 'Cancelled while waiting.', returnDisplay: 'Cancelled', error: { message: 'cancelled', type: ToolErrorType.EXECUTION_CANCELLED } };
      throw error;
    }
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
    readonly link?: RunLink,
  ) {
    const partner = link?.partner?.id;
    const names = [...from.grants.keys()].filter((n) => agents.has(n) && n !== partner);
    const list = names
      .map((n) => {
        const d = agents.get(n)!.definition;
        const max = from.grants.get(n)!;
        return `- ${n}${max > 1 ? ` (up to ${max} threads at once)` : ''}: ${d.description ?? '(no description)'}`;
      })
      .concat(partner ? [`- ${partner}: the agent you are working for (it wrote to you); message it any time`] : [])
      .join('\n');
    super(
      MessageAgentTool.Name,
      'MessageAgent',
      `Sends a message to another agent in your persistent thread with it. By default it returns at once and the agent works alongside you: its reply, and anything it sends you meanwhile, arrive later as messages in your context. To an agent that is still working, the message is delivered at its next step (pass its thread number). With "wait": true it returns the agent's reply, or the first message it sends you, whichever comes first. The thread keeps everything you and it have said, across turns and sessions; the agent does not see the user's conversation unless you include what it needs.\n\nAgents you can message:\n${list}`,
      Kind.Delegate,
      {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: partner ? [...names, partner] : names, description: 'Name of the agent to message.' },
          message: { type: 'string', minLength: 1, description: 'What to tell or ask it: terse, structured, self-contained for what the thread does not already hold.' },
          thread: { type: 'integer', minimum: 1, description: 'Which of your threads with this agent (1 is the usual one). To reach one that is still working, give its thread; omit to use the first free one.' },
          wait: { type: 'boolean', description: 'Wait for its reply (or first message back) before continuing. Default false: keep working.' },
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

// ---------------------------------------------------------------- waiting

export const WAIT_FOR_MESSAGES = ToolNames.WAIT_FOR_MESSAGES;
export const MESSAGE_USER = ToolNames.MESSAGE_USER;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 3600;

class SimpleInvocation<P extends object> extends BaseToolInvocation<P, ToolResult> {
  constructor(
    params: P,
    private readonly describe: (p: P) => string,
    private readonly runFn: (p: P, signal: AbortSignal) => Promise<ToolResult>,
  ) {
    super(params);
  }
  getDescription(): string {
    return this.describe(this.params);
  }
  execute(signal: AbortSignal): Promise<ToolResult> {
    return this.runFn(this.params, signal);
  }
}

class SimpleTool<P extends object> extends BaseDeclarativeTool<P, ToolResult> {
  constructor(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    private readonly describe: (p: P) => string,
    private readonly runFn: (p: P, signal: AbortSignal) => Promise<ToolResult>,
  ) {
    super(name, name, description, Kind.Other, schema);
  }
  protected createInvocation(params: P): ToolInvocation<P, ToolResult> {
    return new SimpleInvocation(params, this.describe, this.runFn);
  }
}

const cancelled = (): ToolResult => ({ llmContent: 'Cancelled while waiting.', returnDisplay: 'Cancelled', error: { message: 'cancelled', type: ToolErrorType.EXECUTION_CANCELLED } });

/** Waits for the first of `waits`, or `seconds`; true when one of them resolved first. */
async function firstOf(waits: Array<(signal: AbortSignal) => Promise<void>>, seconds: number, signal: AbortSignal): Promise<boolean> {
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([...waits.map((w) => w(inner.signal).then(() => true)), delay(seconds * 1000, inner.signal).then(() => false)]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    inner.abort();
  }
}

/** wait_for_messages: an agent with nothing else to do waits for other agents (or the person). */
export function createWaitTool(link: RunLink): SimpleTool<{ timeout_seconds?: number }> {
  return new SimpleTool<{ timeout_seconds?: number }>(
    WAIT_FOR_MESSAGES,
    `Waits until a message arrives from another agent${link.waitForPerson ? ' or the person' : ''}, or until the timeout. Use it when you have nothing else to do until someone answers. The messages themselves arrive right after this call.`,
    {
      type: 'object',
      properties: { timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS, description: `How long to wait (default ${DEFAULT_WAIT_SECONDS}).` } },
    },
    () => 'Waiting for messages',
    async (p, signal) => {
      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, p.timeout_seconds ?? DEFAULT_WAIT_SECONDS));
      const waits = [(s: AbortSignal) => link.mailbox.changed(s), ...(link.waitForPerson ? [link.waitForPerson] : [])];
      try {
        const arrived = await firstOf(waits, seconds, signal);
        const working = [...link.children.values()].map((c) => `${c.agent}${c.instance > 1 ? ` (thread ${c.instance})` : ''}`);
        return arrived
          ? { llmContent: 'New messages arrived; they follow.', returnDisplay: 'Messages arrived' }
          : { llmContent: `Nothing arrived within ${seconds}s.${working.length ? ` Still working: ${working.join(', ')}.` : ''}`, returnDisplay: 'Nothing yet' };
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return cancelled();
        throw error;
      }
    },
  );
}

export const MESSAGE_USER_GUIDANCE = `<talking_with_the_person>
Your turn is not limited to one final answer. With ${MESSAGE_USER} you can tell the person something at any point and keep working: what you are about to do on a long task, a finding they should see now, a decision you made. When you need their input to continue (an ambiguous request, a choice only they can make, missing access), ask with ${MESSAGE_USER} and "wait_for_reply": true; their answer arrives as the next message. Do not ask what you can find out yourself, and keep updates short and occasional, not a running commentary.
</talking_with_the_person>`;

/** message_user: the agent tells or asks the person something mid-turn. */
export function createMessageUserTool(link: RunLink): SimpleTool<{ text: string; wait_for_reply?: boolean; timeout_seconds?: number }> {
  return new SimpleTool<{ text: string; wait_for_reply?: boolean; timeout_seconds?: number }>(
    MESSAGE_USER,
    'Sends the person a chat message now, without ending your turn: progress on a long task, a finding, or a question. With "wait_for_reply": true it waits for their answer (it arrives as the next message); otherwise you continue at once.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'The message, in Markdown.' },
        wait_for_reply: { type: 'boolean', description: 'Wait for the person to answer before continuing (default false).' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS, description: `How long to wait for an answer (default ${MAX_WAIT_SECONDS}).` },
      },
      required: ['text'],
    },
    () => 'Message',
    async (p, signal) => {
      if (typeof p.text !== 'string' || !p.text.trim()) return { llmContent: 'text must not be empty.', returnDisplay: 'Empty message', error: { message: 'empty', type: ToolErrorType.INVALID_TOOL_PARAMS } };
      if (!p.wait_for_reply) return { llmContent: 'Sent. Keep working.', returnDisplay: 'Sent' };
      if (!link.waitForPerson) return { llmContent: 'Sent, but no one can answer in this run (it is not interactive). Continue with your best judgment and say what you assumed.', returnDisplay: 'Sent' };
      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, p.timeout_seconds ?? MAX_WAIT_SECONDS));
      try {
        const answered = await firstOf([link.waitForPerson], seconds, signal);
        return answered
          ? { llmContent: 'The person answered; their message follows.', returnDisplay: 'Answered' }
          : { llmContent: `No answer within ${seconds}s. Continue with your best judgment and say what you assumed.`, returnDisplay: 'No answer yet' };
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return cancelled();
        throw error;
      }
    },
  );
}
