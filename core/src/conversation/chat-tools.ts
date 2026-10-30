/**
 * Chat tools for the agent replying in the main conversation:
 * react_to_message (a 👍 or 👎 on one of the person's messages, a quicker
 * answer than a reply) and reply_inline (an answer in one message's reply
 * thread, as the person can write). Both are recorded as the tool calls
 * themselves; the interfaces show them from the record (chatEffects).
 */

import type { ToolInvocation, ToolResult } from '../tools/tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { ConversationService } from './service.js';
import type { ConversationState } from './state.js';

export const ChatToolNames = {
  REACT: 'react_to_message',
  REPLY_INLINE: 'reply_inline',
} as const;

export const AGENT_REACTIONS = ['👍', '👎'] as const;

export const CHAT_GUIDANCE = `<chat>
The person reads this conversation as a chat, in a browser and in a terminal. Their messages start with their id, like [m12].
- To acknowledge something without a whole reply (a thank-you, an "ok", a 👍 of theirs), react with ${ChatToolNames.REACT} (👍 or 👎) and end the turn without text.
- To answer one earlier message in its own reply thread rather than in the main chat, use ${ChatToolNames.REPLY_INLINE}.
- Notes from SF Agents in square brackets tell you when the person reacted to one of your messages and whether they have read your last reply. They are not typed by the person.
- A message the person sends while you work arrives between your steps: take it into account.
</chat>`;

function failed(message: string): ToolResult {
  return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS } };
}

function shown(state: ConversationState, id: unknown): { id: string; role: string; content: string } | undefined {
  if (typeof id !== 'string') return undefined;
  const m = state.messages.find((x) => x.id === id.trim().replace(/^\[|\]$/g, ''));
  if (!m || m.event || (m.role !== 'user' && !(m.role === 'assistant' && m.content.trim()))) return undefined;
  return m;
}

class ChatInvocation<P extends object> extends BaseToolInvocation<P, ToolResult> {
  constructor(
    params: P,
    private readonly describe: (p: P) => string,
    private readonly runFn: (p: P) => ToolResult,
  ) {
    super(params);
  }
  getDescription(): string {
    return this.describe(this.params);
  }
  async execute(): Promise<ToolResult> {
    return this.runFn(this.params);
  }
}

class ChatTool<P extends object> extends BaseDeclarativeTool<P, ToolResult> {
  constructor(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    private readonly describe: (p: P) => string,
    private readonly runFn: (p: P) => ToolResult,
  ) {
    super(name, name, description, Kind.Other, schema);
  }
  protected createInvocation(params: P): ToolInvocation<P, ToolResult> {
    return new ChatInvocation(params, this.describe, this.runFn);
  }
}

export function createChatTools(service: ConversationService) {
  const react = new ChatTool<{ message_id: string; emoji: string | null }>(
    ChatToolNames.REACT,
    'Reacts to one of the person\'s messages with 👍 or 👎 (null removes your reaction). A quick acknowledgement instead of a reply: after it, end the turn without text unless there is more to say.',
    {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message, by its id ("m12").' },
        emoji: { type: ['string', 'null'], enum: [...AGENT_REACTIONS, null], description: '👍 or 👎; null removes your reaction.' },
      },
      required: ['message_id', 'emoji'],
    },
    (p) => `React ${p.emoji ?? '(remove)'} to ${p.message_id}`,
    (p) => {
      const m = shown(service.state, p.message_id);
      if (!m || m.role !== 'user') return failed(`"${String(p.message_id)}" is not one of the person's messages.`);
      if (p.emoji !== null && !(AGENT_REACTIONS as readonly string[]).includes(p.emoji)) return failed('emoji must be 👍, 👎 or null.');
      return { llmContent: p.emoji ? `Reacted ${p.emoji} to ${m.id}.` : `Removed your reaction from ${m.id}.`, returnDisplay: p.emoji ? `Reacted ${p.emoji}` : 'Reaction removed' };
    },
  );
  const reply = new ChatTool<{ message_id: string; text: string }>(
    ChatToolNames.REPLY_INLINE,
    'Answers one earlier message in its reply thread (the person sees it under that message, not in the main chat). Use it for an aside about that message; your normal reply still goes to the main chat.',
    {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message to answer, by its id ("m12"): the person\'s or yours.' },
        text: { type: 'string', description: 'The reply, in Markdown.' },
      },
      required: ['message_id', 'text'],
    },
    (p) => `Reply to ${p.message_id}`,
    (p) => {
      const m = shown(service.state, p.message_id);
      if (!m) return failed(`"${String(p.message_id)}" is not a message in this conversation.`);
      if (typeof p.text !== 'string' || !p.text.trim()) return failed('text must not be empty.');
      return { llmContent: `Replied in ${m.id}'s thread.`, returnDisplay: 'Replied inline' };
    },
  );
  return [react, reply];
}

/**
 * What the chat tools did, from the record: the agent's reaction on each of
 * the person's messages, and its inline replies (by the call's message).
 */
export function chatEffects(state: ConversationState): { reactions: Record<string, string>; replies: Map<string, { messageId: string; text: string }> } {
  const reactions: Record<string, string> = {};
  const replies = new Map<string, { messageId: string; text: string }>();
  for (const m of state.messages) {
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const run = state.runs.get(m.run);
    for (const c of m.toolCalls) {
      if (c.name !== ChatToolNames.REACT && c.name !== ChatToolNames.REPLY_INLINE) continue;
      if (run?.results.get(c.id)?.status !== 'ok') continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(c.arguments) as Record<string, unknown>;
      } catch {
        continue;
      }
      const target = typeof args['message_id'] === 'string' ? args['message_id'].trim().replace(/^\[|\]$/g, '') : '';
      if (c.name === ChatToolNames.REACT) {
        if (typeof args['emoji'] === 'string') reactions[target] = args['emoji'];
        else delete reactions[target];
      } else if (typeof args['text'] === 'string') replies.set(`${m.id}:${c.id}`, { messageId: target, text: args['text'] });
    }
  }
  return { reactions, replies };
}
