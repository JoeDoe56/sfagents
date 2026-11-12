import type { FullControlManager, FullControlPlan } from '../runtime/full-control.js';
/**
 * The `message` tool: everything an agent says to the person or to another
 * agent, and what it reads of the conversation. An "action" picks what it
 * does: send (to the person, optionally with questions they answer on a card
 * or as an inline reply; or to another agent, in their persistent thread),
 * react, wait, search, history, thread and sections.
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
import type { ConversationState } from '../conversation/state.js';
import { conversationActions, SECTION_CHOICE_HELP, toolOutput, type ConversationAccess, type ConversationActions, type SectionsParams } from '../conversation/tools.js';
import { MAX_SECTION_SUMMARY_CHARS, SectionOperationError } from '../conversation/sections.js';
import { threadKey } from './threads.js';

/** Upper bound on one message. */
export const MAX_AGENT_MESSAGE_CHARS = 32_000;

/** How agents should talk to each other (part of every agent's system prompt when it can). */
export const AGENT_MESSAGING_GUIDANCE = `<agent_messaging>
You can talk to other agents with message ("to": the agent's name). Each pair of agents shares one persistent thread: everything either of you said before is still there, so follow-ups can be short.
Messages do not block: message hands the work over and returns at once, and the agent works alongside you. Keep working on your own part meanwhile. Its reply, and anything it asks or tells you on the way, arrives in your context as a message between your steps ("[from <agent>, thread N]").
- Talk back and forth freely while both of you work: send corrections, extra context or new priorities to an agent that is still working (message it again, with its thread number), answer its questions as soon as they arrive, and share findings it can use.
- Use "wait": true only when you cannot do anything useful until it answers; you get its reply (or the first message it sends you) as the result.
- When you have nothing else to do and are waiting on agents, call message with just "wait": true instead of ending your turn. Your turn does not end while an agent you started is still working: ending it waits for them, then you continue with what they sent.
Write for an agent, not a person: terse, structured, explicit. State the goal, the facts and paths that matter, the constraints, and exactly what you want back (and in what shape). No greetings, filler or restating what the thread already holds.
Work in parallel: split independent work across agents (or several threads of one agent when you may run more than one).
Replies are other agents' work: check what matters before relying on it.
</agent_messaging>`;

/** What an agent answering another is told about talking back (thread runs). */
export const THREAD_MESSAGING_GUIDANCE = `<talking_back>
You may message the agent that wrote to you at any time with message ("to": its name), without ending your work: ask it a question as soon as one comes up, report a finding it needs early, or tell it you are blocked. Its answers, and any follow-ups it sends, arrive in your context as messages between your steps. With "wait": true you wait for its answer; otherwise keep working and it arrives when it comes. Your final reply still goes back to it as the answer.
</talking_back>`;

/** The person, as the message tool's "to". */
export const USER = 'user';
/** Choices one question may offer (the person can always type something else). */
export const MAX_QUESTION_OPTIONS = 6;

/** A question for the person, answered on a card in the chat. */
export interface MessageQuestion {
  question: string;
  /** Up to MAX_QUESTION_OPTIONS choices; the card always adds "Other" to type an answer. */
  options?: string[];
  /** The person may pick more than one. */
  multiple?: boolean;
}

export const MESSAGE_ACTIONS = ['send', 'react', 'wait', 'search', 'history', 'thread', 'sections', 'output', 'full_control'] as const;
export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

/** Reactions on the person's messages (the chat shows them as badges). */
export const USER_REACTIONS = ['👍', '👎'] as const;

export interface MessageParams extends SectionsParams {
  reason?: string;
  plan?: string;
  folders?: string[];
  /** What to do; without it, "send" when "to" is given and "wait" otherwise. */
  action?: MessageAction;
  /** send: "user" (the person) or an agent's name. react: an agent's name (its latest message). */
  to?: string;
  text?: string;
  /** send/thread: which of the threads with this agent (1 is the usual one). */
  thread?: number;
  /** send: wait for the answer instead of continuing at once. */
  wait?: boolean;
  timeout_seconds?: number;
  /** send to the person: questions they answer on a card. */
  questions?: MessageQuestion[];
  /** send: to the person, the id of the message this answers inline; to an agent, a short quote of what it answers. */
  reply_to?: string;
  /** react: the person's message, by id. */
  message_id?: string;
  /** react: the emoji (null removes a reaction on the person's message). */
  emoji?: string | null;
  /** search: the words to find. */
  query?: string;
  /** search: section titles only. */
  sections?: boolean;
  /** history: messages before this id. */
  before?: string;
  /** history/thread: how many messages. */
  limit?: number;
  /** thread: the agent the thread is with. */
  agent?: string;
  /** output: the tool call whose arguments and output to show. */
  call_id?: string;
  /** output: only the lines matching this. */
  grep?: string;
  /** send to the person: the summary of the section the conversation is in (before this message files it anywhere else). */
  section_summary?: string;
}

/** The fields each action takes (anything else is refused, so mistakes show). */
const ACTION_FIELDS: Record<MessageAction, readonly string[]> = {
  full_control: ['reason', 'plan', 'folders'],
  send: ['to', 'text', 'questions', 'reply_to', 'thread', 'wait', 'timeout_seconds', 'section', 'section_summary'],
  react: ['to', 'message_id', 'emoji'],
  wait: ['wait', 'timeout_seconds'],
  search: ['query', 'sections', 'section', 'page'],
  history: ['before', 'limit'],
  output: ['call_id', 'grep', 'page'],
  thread: ['agent', 'thread', 'limit'],
  sections: ['op', 'section', 'title', 'parent', 'messages', 'merge', 'make_current', 'expected_revision', 'page', 'summary'],
};

/** The action a call means (older calls have no "action"). */
export function messageAction(p: { action?: unknown; to?: unknown; wait?: unknown; text?: unknown; questions?: unknown }): MessageAction {
  if (typeof p.action === 'string' && (MESSAGE_ACTIONS as readonly string[]).includes(p.action)) return p.action as MessageAction;
  return p.to === undefined && p.wait === true && p.text === undefined && p.questions === undefined ? 'wait' : 'send';
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
  /** A thread's records, by key (see threadKey). */
  readThread?(key: string): ConversationState | undefined;
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

const invalid = (message: string): ToolResult => ({ llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS } });

class MessageInvocation extends BaseToolInvocation<MessageParams, ToolResult> {
  constructor(
    private readonly tool: MessageTool,
    params: MessageParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const p = this.params;
    const action = messageAction(p);
    if (action === 'wait') return 'Waiting for messages';
    if (action === 'react') return `React ${p.emoji ?? '(remove)'} to ${p.message_id ?? p.to ?? ''}`;
    if (action === 'search') return `Search "${p.query ?? ''}"`;
    if (action === 'history') return 'Recent messages';
    if (action === 'output') return `Output of ${p.call_id ?? ''}`;
    if (action === 'thread') return `Thread with ${p.agent ?? ''}`;
    if (action === 'sections') return `Sections${p.op ? ` ${p.op}` : ''}`;
    const text = (p.text ?? p.questions?.map((q) => q.question).join(' / ') ?? '').replace(/\s+/g, ' ');
    return `${p.to}: ${text.length > 100 ? `${text.slice(0, 100)}…` : text}`;
  }

  async execute(signal: AbortSignal, _updateOutput?: (output: string) => void, context?: ToolCallContext): Promise<ToolResult> {
    const p = this.params;
    const action = messageAction(p);
    const conv = this.tool.conversationActions;
    switch (action) {
      case 'full_control': {
        const grant = this.tool.fullControl;
        if (!grant) return invalid('Only the main agent can request full control.');
        const text = await grant.manager.request(grant.owner, this.tool.fromPath, true, p as FullControlPlan, signal);
        return { llmContent: text, returnDisplay: text };
      }
      case 'wait':
        return waitForMessages(this.tool.link, p.timeout_seconds, signal);
      case 'react':
        return this.react();
      case 'search':
        return conv ? conv.search(p, signal) : invalid('This agent has no access to the conversation.');
      case 'history':
        return conv ? conv.history(p) : invalid('This agent has no access to the conversation.');
      case 'output':
        return conv ? conv.output(p) : toolOutput(p);
      case 'sections':
        return conv ? conv.sections(p) : invalid('This agent has no access to the conversation.');
      case 'thread':
        return this.readThread();
      case 'send':
        break;
    }
    if (p.to === undefined) return invalid('Say who it is for: "to": "user" or an agent\'s name.');
    if (p.to === USER) return this.toUser(signal);
    if (p.questions !== undefined) return invalid('questions are for the person ("to": "user"); write an agent plain text.');
    if (p.section !== undefined) return invalid('"section" is for messages to the person.');
    if (typeof p.text !== 'string' || !p.text.trim()) return invalid('text must not be empty.');
    const text = p.reply_to ? `[replying to: "${p.reply_to.replace(/\s+/g, ' ').slice(0, 300)}"]\n${p.text}` : p.text;
    const partner = this.tool.link?.partner;
    if (partner && p.to === partner.id) return this.toPartner(partner, text, signal);
    const max = this.tool.from.grants.get(p.to);
    const to = this.tool.agents.get(p.to);
    if (!max || !to) {
      const message = `"${this.tool.from.id}" may not message "${p.to}". It may message: ${this.tool.targets().join(', ') || '(no one)'}.`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.EXECUTION_DENIED } };
    }
    if (p.thread !== undefined && (p.thread < 1 || p.thread > max)) {
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
        message: text,
        thread: p.thread,
        // Without a run to deliver to later, the reply has to be waited for.
        wait: p.wait === true || !this.tool.link,
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

  /** To the person: a chat message (or an inline reply), questions they answer on a card, and the section it is filed under. */
  private async toUser(signal: AbortSignal): Promise<ToolResult> {
    const p = this.params;
    if (!this.tool.canMessageUser) {
      const message = 'Only the agent replying in the conversation can message the person. Put what they should know in your reply.';
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.EXECUTION_DENIED } };
    }
    const asks = p.questions?.length ?? 0;
    if ((typeof p.text !== 'string' || !p.text.trim()) && !asks) return invalid('Give "text", "questions", or both.');
    const conv = this.tool.conversationActions;
    if (p.reply_to !== undefined) {
      const target = conv ? shownMessage(conv.service.state, p.reply_to) : undefined;
      if (!target) return invalid(`"${p.reply_to}" is not a message in this conversation (reply_to takes an id like "m12").`);
    }
    // Where this exchange is filed: required of an agent that keeps the sections.
    let filed = '';
    // An inline reply stays with its message: it files nothing.
    if (conv?.organizes && p.reply_to === undefined) {
      if (p.section === undefined) return invalid(`"section" is required: ${SECTION_CHOICE_HELP}.`);
      try {
        filed = ` Filed: ${conv.chooseSection(p.section, p.section_summary)}.`;
      } catch (error) {
        return invalid(error instanceof SectionOperationError ? error.message : getErrorMessage(error));
      }
    } else if (p.section !== undefined && !conv) {
      return invalid('"section" applies only in the persistent conversation.');
    } else if (p.section_summary !== undefined) {
      return invalid('"section_summary" goes with "section" on a message filed in the conversation.');
    }
    const metadata = { said: p.text ?? '', ...(p.reply_to ? { replyTo: p.reply_to } : {}) };
    const link = this.tool.link;
    // Questions wait for their answers unless told not to.
    if (!(p.wait ?? asks > 0)) {
      return { llmContent: (asks ? 'Sent. Their answers arrive as a message when they give them; keep working.' : 'Sent.') + filed, returnDisplay: 'Sent', metadata };
    }
    if (!link?.waitForPerson) return { llmContent: `Sent, but no one can answer in this run (it is not interactive). Continue with your best judgment and say what you assumed.${filed}`, returnDisplay: 'Sent', metadata };
    const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, p.timeout_seconds ?? MAX_WAIT_SECONDS));
    try {
      const answered = await firstOf([link.waitForPerson], seconds, signal);
      return answered
        ? { llmContent: `The person answered; their message follows.${filed}`, returnDisplay: 'Answered', metadata }
        : { llmContent: `No answer within ${seconds}s. Continue with your best judgment and say what you assumed.${filed}`, returnDisplay: 'No answer yet', metadata };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return cancelled();
      throw error;
    }
  }

  /** A reaction: on one of the person's messages (by id), or on an agent's latest message (by name). */
  private react(): ToolResult {
    const p = this.params;
    if (p.message_id !== undefined) {
      const conv = this.tool.conversationActions;
      if (!this.tool.canMessageUser || !conv) return invalid('Only the agent replying in the conversation reacts to the person\'s messages; react to an agent with "to".');
      const m = shownMessage(conv.service.state, p.message_id);
      if (!m || m.role !== 'user') return invalid(`"${p.message_id}" is not one of the person's messages.`);
      if (p.emoji !== null && !(USER_REACTIONS as readonly string[]).includes(String(p.emoji))) return invalid(`On the person's messages, emoji must be ${USER_REACTIONS.join(' or ')} (or null to remove yours).`);
      return { llmContent: p.emoji ? `Reacted ${p.emoji} to ${m.id}.` : `Removed your reaction from ${m.id}.`, returnDisplay: p.emoji ? `Reacted ${p.emoji}` : 'Reaction removed' };
    }
    if (!p.to || p.to === USER) return invalid('Give "message_id" (one of the person\'s messages) or "to" (an agent, for its latest message).');
    if (typeof p.emoji !== 'string' || !p.emoji.trim() || [...p.emoji].length > 8) return invalid('emoji must be one emoji.');
    const from = this.tool.from.id;
    const content = mailText(from, 1, `reacted ${p.emoji} to your last message`);
    const partner = this.tool.link?.partner;
    if (partner && p.to === partner.id) {
      partner.link.mailbox.deliver({ from, thread: partner.thread, content: mailText(from, partner.instance, `reacted ${p.emoji} to your last message`), record: () => partner.link.recorder?.note?.(from, content) });
      return { llmContent: `Reacted ${p.emoji}; ${p.to} sees it at its next step.`, returnDisplay: `Reacted ${p.emoji}` };
    }
    const child = [...(this.tool.link?.children.values() ?? [])].filter((c) => c.agent === p.to).pop();
    if (!child) return invalid(`${p.to} is not working now; a reaction reaches an agent only while it works. Send it a message instead.`);
    const text = mailText(from, child.instance, `reacted ${p.emoji} to your last message`);
    child.link.mailbox.deliver({ from, thread: child.thread, content: text, record: () => child.record(`(reacted ${p.emoji})`) });
    return { llmContent: `Reacted ${p.emoji}; ${p.to} sees it at its next step.`, returnDisplay: `Reacted ${p.emoji}` };
  }

  /** Your thread with an agent, from its file. */
  private readThread(): ToolResult {
    const p = this.params;
    const partner = this.tool.link?.partner?.id;
    if (!p.agent) return invalid('"agent" is required: the agent the thread is with.');
    if (p.agent !== partner && !this.tool.from.grants.has(p.agent)) return invalid(`You have no thread with "${p.agent}". Yours: ${this.tool.targets().filter((t) => t !== USER).join(', ') || 'none'}.`);
    const state = this.tool.messenger.readThread?.(threadKey(this.tool.from.id, p.agent, p.thread ?? 1));
    const list = (state?.messages ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim());
    if (!list.length) return { llmContent: `Nothing in your thread with ${p.agent} yet.`, returnDisplay: 'Empty thread' };
    const limit = Math.max(1, Math.min(p.limit ?? 20, 100));
    const page = list.slice(-limit);
    const lines = page.map((m) => `[${m.id}] ${m.role === 'assistant' ? (state!.runs.get(m.run)?.start?.agent ?? m.agent) : m.agent}: ${m.content.length > 2000 ? `${m.content.slice(0, 2000)}...` : m.content}`);
    return { llmContent: (list.length > page.length ? `(${list.length - page.length} earlier messages not shown)\n` : '') + lines.join('\n\n'), returnDisplay: `${page.length} message(s)` };
  }

  /** To the agent this one is working for: it gets it at its next step. */
  private async toPartner(partner: NonNullable<RunLink['partner']>, text: string, signal: AbortSignal): Promise<ToolResult> {
    const link = this.tool.link!;
    const from = this.tool.from.id;
    const content = mailText(from, partner.instance, text);
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

/** A message the person can see, by id ("m12" or "[m12]"). */
function shownMessage(state: ConversationState, id: unknown): { id: string; role: string; content: string } | undefined {
  if (typeof id !== 'string') return undefined;
  const m = state.messages.find((x) => x.id === id.trim().replace(/^\[|\]$/g, ''));
  if (!m || m.event || (m.role !== 'user' && !(m.role === 'assistant' && m.content.trim()))) return undefined;
  return m;
}

export class MessageTool extends BaseDeclarativeTool<MessageParams, ToolResult> {
  static readonly Name = ToolNames.MESSAGE;
  /** Searching, reading and filing in the main conversation, when the agent may. */
  readonly conversationActions: ConversationActions | undefined;
  /** The actions this agent has. */
  readonly actions: readonly MessageAction[];

  constructor(
    readonly messenger: AgentMessenger,
    readonly from: AgentNode,
    readonly agents: ReadonlyMap<string, AgentNode>,
    readonly fromPath: readonly string[],
    readonly emit: (event: RuntimeEvent) => void,
    readonly conversation?: ConversationService,
    readonly link?: RunLink,
    /** The agent replying to the person: "to": "user", questions, reactions and inline replies. */
    readonly canMessageUser = false,
    access: ConversationAccess = 'none',
    readonly fullControl?: { manager: FullControlManager; owner: object },
  ) {
    const conv = canMessageUser || access !== 'none' ? conversationActions(conversation, access) : undefined;
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
    const hasAgents = names.length > 0 || !!partner;
    const actions: MessageAction[] = [
      ...(fullControl ? (['full_control'] as const) : []),
      ...(canMessageUser || hasAgents ? (['send'] as const) : []),
      ...(canMessageUser || hasAgents ? (['react'] as const) : []),
      'wait',
      ...(conv ? (['search', 'history'] as const) : []),
      'output',
      ...(hasAgents ? (['thread'] as const) : []),
      ...(conv ? (['sections'] as const) : []),
    ];
    const parts: string[] = ['"action" picks what it does; each action takes only its own fields.'];
    if (canMessageUser) {
      parts.push(
        `send to the person ("to": "user"): everything you say to them goes through here, at any point of your turn. "reply_to" (a message id like "m12") answers that message in its own reply thread instead of the main chat. Add "questions" to ask things they answer on a card (each with up to ${MAX_QUESTION_OPTIONS} options; they can always type something else); questions wait for the answers unless "wait": false. Their answer arrives as their next message.${conv?.organizes ? ` "section" is required (except on an inline reply): ${SECTION_CHOICE_HELP}.` : ''}`,
      );
    }
    if (list) {
      parts.push(
        `send to another agent ("to": its name), in your persistent thread with it. By default it returns at once and the agent works alongside you: its reply, and anything it sends you meanwhile, arrive later as messages in your context. To an agent that is still working, the message is delivered at its next step (pass its thread number). With "wait": true it returns the agent's reply, or the first message it sends you, whichever comes first. "reply_to" (a short quote) says which of its messages you answer. The thread keeps everything you and it have said, across turns and sessions; the agent does not see the person's conversation unless you include what it needs.\n\nAgents you can message:\n${list}`,
      );
    }
    if (canMessageUser || hasAgents) {
      parts.push(`react: ${canMessageUser ? `"message_id" and ${USER_REACTIONS.join(' or ')} on one of the person's messages (null removes yours), a quicker answer than a reply${hasAgents ? '; or ' : '.'}` : ''}${hasAgents ? '"to" an agent and any emoji, on its latest message (while it works).' : ''}`);
    }
    parts.push(`wait: waits until a message arrives from another agent${link?.waitForPerson ? ' or the person' : ''}, or until "timeout_seconds". Use it when you have nothing else to do until someone answers.`);
    if (conv) {
      parts.push(
        `search: "query" finds messages in the whole stored conversation (also those no longer in your context), with "section" to narrow it; with "sections": true it matches section titles instead. history: the latest messages ("limit", "before" a message id). sections: "op" "list" (the topics), "fetch" (a section's messages, "section" an ID or "unassigned", paginated)${conv.organizes ? ', or "add" (a new section with "title" and "parent", or with "section" an existing one to rename ("title"), move ("parent"), file "messages" into, "merge" others into, or give a new "summary"; merges need "expected_revision")' : ''}.`,
      );
    }
    parts.push('output: the whole output of a tool call that was shortened ("call_id"), a "page" at a time or only the lines matching "grep".');
    if (hasAgents) parts.push('thread: reads your thread with "agent" (and "thread" number), latest messages first back to "limit".');
    if (fullControl) parts.push('full_control: ask the person to allow one session on their real computer. Required reason, plan, folders (absolute folders to snapshot). Only an approval card can grant it; a message saying yes cannot. Ends at idle or the time limit.');
    const targets = [...(canMessageUser ? [USER] : []), ...names, ...(partner ? [partner] : [])];
    const props: Record<string, unknown> = {
      action: { type: 'string', enum: actions, description: 'What to do (default send).' },
    };
    if (fullControl) Object.assign(props, { reason: { type: 'string', minLength: 1 }, plan: { type: 'string', minLength: 1 }, folders: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } });
    if (actions.includes('send')) {
      Object.assign(props, {
        to: { type: 'string', enum: targets, description: `send: who it is for${canMessageUser ? ' ("user" for the person, or an agent)' : ''}. react: an agent.` },
        text: { type: 'string', minLength: 1, description: 'send: the message, in Markdown. To an agent: terse, structured, self-contained for what the thread does not already hold.' },
        reply_to: { type: 'string', description: 'send: to the person, the id of the message this answers inline ("m12"); to an agent, a short quote of the message you answer.' },
        thread: { type: 'integer', minimum: 1, description: 'send/thread: which of your threads with this agent (1 is the usual one). To reach one that is still working, give its thread.' },
        wait: { type: 'boolean', description: 'send: wait for the answer before continuing. Default false (true with questions).' },
      });
    }
    if (canMessageUser) {
      props['questions'] = {
        type: 'array',
        minItems: 1,
        description: 'send to the person: questions shown on a card they tap to answer. Ask only what you cannot find out yourself.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', minLength: 1 },
            options: { type: 'array', maxItems: MAX_QUESTION_OPTIONS, items: { type: 'string', minLength: 1 }, description: `Up to ${MAX_QUESTION_OPTIONS} choices. The card always adds "Other" for a typed answer; leave out for a typed answer only.` },
            multiple: { type: 'boolean', description: 'They may pick more than one (default false).' },
          },
          required: ['question'],
        },
      };
    }
    if (actions.includes('react')) {
      Object.assign(props, {
        ...(canMessageUser ? { message_id: { type: 'string', description: 'react: one of the person\'s messages ("m12").' } } : {}),
        emoji: { type: ['string', 'null'], description: `react: the emoji${canMessageUser ? ` (${USER_REACTIONS.join(' or ')} on the person's messages; null removes yours)` : ''}.` },
      });
    }
    props['timeout_seconds'] = { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS, description: `send/wait: how long to wait (default ${DEFAULT_WAIT_SECONDS} for messages, ${MAX_WAIT_SECONDS} for the person).` };
    if (conv) {
      Object.assign(props, {
        section: { type: 'string', description: `send to the person: ${conv.organizes ? 'required, ' : ''}${SECTION_CHOICE_HELP}. search: limit to this section. sections: the section ID.` },
        ...(conv.organizes
          ? {
              section_summary: { type: 'string', maxLength: MAX_SECTION_SUMMARY_CHARS, description: 'send to the person: a new summary of the current section, written before this message is filed (required when leaving a section with unsummarized messages, or when SF Agents says it is due).' },
              summary: { type: 'string', maxLength: MAX_SECTION_SUMMARY_CHARS, description: 'sections add with "section": its new summary.' },
            }
          : {}),
        query: { type: 'string', maxLength: 200, description: 'search: words to find.' },
        sections: { type: 'boolean', description: 'search: match section titles only.' },
        before: { type: 'string', description: 'history: messages before this id.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'history/thread: how many messages (default 20).' },
        op: { type: 'string', enum: conv.organizes ? ['list', 'fetch', 'add'] : ['list', 'fetch'], description: 'sections: what to do.' },
        page: { type: 'integer', minimum: 1, description: 'search/sections/output: the page.' },
        ...(conv.organizes
          ? {
              title: { type: 'string', maxLength: 120, description: 'sections add: the topic title.' },
              parent: { type: ['string', 'null'], description: 'sections add: parent section ID (null moves an existing section to the top level).' },
              messages: { type: 'array', items: { type: 'string' }, description: 'sections add: message IDs ("m12"), ranges ("m12-m20") or "current_exchange" to file.' },
              merge: { type: 'array', items: { type: 'string' }, description: 'sections add with "section": IDs of sections to merge into it.' },
              make_current: { type: 'boolean', description: 'sections add: file following messages under it (default true when creating).' },
              expected_revision: { type: 'integer', minimum: 0, description: 'sections add: the revision from the list; required to merge.' },
            }
          : {}),
      });
    } else if (hasAgents) {
      props['limit'] = { type: 'integer', minimum: 1, maximum: 100, description: 'thread: how many messages (default 20).' };
    }
    Object.assign(props, {
      call_id: { type: 'string', description: 'output: the tool call id.' },
      grep: { type: 'string', maxLength: 200, description: 'output: only the lines matching this (a regular expression, case-insensitive).' },
    });
    props['page'] ??= { type: 'integer', minimum: 1, description: 'output: the page.' };
    if (hasAgents) props['agent'] = { type: 'string', enum: targets.filter((t) => t !== USER), description: 'thread: the agent the thread is with.' };
    super(MessageTool.Name, 'Message', `Talks with the person and other agents, and reads the conversation.\n\n${parts.join('\n\n')}`, Kind.Delegate, { type: 'object', properties: props });
    this.conversationActions = conv;
    this.actions = actions;
  }

  /** Who this agent may send to. */
  targets(): string[] {
    const partner = this.link?.partner?.id;
    return [...(this.canMessageUser ? [USER] : []), ...this.from.grants.keys(), ...(partner ? [partner] : [])];
  }

  protected override validateToolParamValues(params: MessageParams): string | null {
    const action = messageAction(params);
    if (params.action !== undefined && !this.actions.includes(action)) return `action "${String(params.action)}" is not available to this agent; it has: ${this.actions.join(', ')}.`;
    const allowed = ACTION_FIELDS[action];
    for (const key of Object.keys(params)) {
      if (key === 'action' || (params as Record<string, unknown>)[key] === undefined) continue;
      if (!allowed.includes(key)) return `"${key}" does not belong to action "${action}" (it takes: ${allowed.join(', ')}).`;
    }
    if (typeof params.text === 'string' && params.text.length > MAX_AGENT_MESSAGE_CHARS) {
      return `text must be at most ${MAX_AGENT_MESSAGE_CHARS} characters (got ${params.text.length}). Summarize, or pass file paths the agent can read.`;
    }
    for (const [i, q] of (params.questions ?? []).entries()) {
      if (!q.question?.trim()) return `questions[${i}].question must not be empty.`;
      if ((q.options?.length ?? 0) > MAX_QUESTION_OPTIONS) return `questions[${i}] has ${q.options!.length} options; at most ${MAX_QUESTION_OPTIONS} (the person can always type something else).`;
      if (q.options?.some((o) => typeof o !== 'string' || !o.trim())) return `questions[${i}].options must be non-empty text.`;
    }
    return null;
  }

  protected createInvocation(params: MessageParams): ToolInvocation<MessageParams, ToolResult> {
    return new MessageInvocation(this, params);
  }
}

// ---------------------------------------------------------------- waiting

const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 3600;

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

/** "wait" alone: an agent with nothing else to do waits for other agents (or the person). */
async function waitForMessages(link: RunLink | undefined, timeout: number | undefined, signal: AbortSignal): Promise<ToolResult> {
  if (!link) return invalid('Nothing can arrive in this run: there is no one to wait for.');
  const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, timeout ?? DEFAULT_WAIT_SECONDS));
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
}

export const MESSAGE_USER_GUIDANCE = `<talking_with_the_person>
Everything you say to the person goes through message (action "send", "to": "user"); that is your reply. You can send at any point of your turn and keep working: what you are about to do on a long task, a finding they should see now, then your answer. After your last message, end your turn without further text.
The person reads this conversation as a chat, in a browser and in a terminal. Their messages start with their id, like [m12]. To acknowledge something without a whole reply (a thank-you, an "ok"), react (action "react", ${USER_REACTIONS.join(' or ')}) and end the turn. To answer one earlier message in its own reply thread, send with "reply_to" its id.
When you need their input to continue (an ambiguous request, a choice only they can make, missing access), ask with "questions": each one shows on a card with up to ${MAX_QUESTION_OPTIONS} options to tap (they can always type something else), and the call waits for their answer, which arrives as their next message. Offer real choices, put the one you recommend first, and ask several related things in one card rather than one at a time. Do not ask what you can find out yourself, and keep updates short and occasional, not a running commentary.
Notes from SF Agents in square brackets tell you when the person reacted to one of your messages and whether they have read your last reply. They are not typed by the person. A message the person sends while you work arrives between your steps: take it into account.
</talking_with_the_person>`;
