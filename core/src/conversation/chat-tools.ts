/**
 * What the agent did in the chat besides plain messages, read from the
 * record: its reactions on the person's messages and its inline replies.
 * Both are message tool calls (action "react", and "send" to the person
 * with "reply_to"); conversations from before the message tool had them as
 * react_to_message and reply_inline, which are still read.
 */

import type { ConversationState } from './state.js';

/** The older tools, still read from stored conversations. */
export const ChatToolNames = {
  REACT: 'react_to_message',
  REPLY_INLINE: 'reply_inline',
} as const;

export { USER_REACTIONS as AGENT_REACTIONS } from '../agents/message-agent.js';

/** A call's effect in the chat: a reaction, an inline reply, or neither. */
export function chatEffectOf(name: string, argsJson: string): { react: { target: string; emoji: string | null } } | { reply: { target: string; text: string } } | undefined {
  if (name !== 'message' && name !== ChatToolNames.REACT && name !== ChatToolNames.REPLY_INLINE) return undefined;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const id = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^\[|\]$/g, '') : '');
  if (name === ChatToolNames.REACT || (name === 'message' && args['action'] === 'react' && typeof args['message_id'] === 'string')) {
    return { react: { target: id(args['message_id']), emoji: typeof args['emoji'] === 'string' ? args['emoji'] : null } };
  }
  if (name === ChatToolNames.REPLY_INLINE && typeof args['text'] === 'string') return { reply: { target: id(args['message_id']), text: args['text'] } };
  if (name === 'message' && args['to'] === 'user' && typeof args['reply_to'] === 'string' && typeof args['text'] === 'string' && (args['action'] ?? 'send') === 'send') {
    return { reply: { target: id(args['reply_to']), text: args['text'] } };
  }
  return undefined;
}

/**
 * What the agent did in the chat, from the record: its reaction on each of
 * the person's messages, and its inline replies (by the call's message).
 */
export function chatEffects(state: ConversationState): { reactions: Record<string, string>; replies: Map<string, { messageId: string; text: string }> } {
  const reactions: Record<string, string> = {};
  const replies = new Map<string, { messageId: string; text: string }>();
  for (const m of state.messages) {
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const run = state.runs.get(m.run);
    for (const c of m.toolCalls) {
      const effect = chatEffectOf(c.name, c.arguments);
      if (!effect || run?.results.get(c.id)?.status !== 'ok') continue;
      if ('react' in effect) {
        if (effect.react.emoji) reactions[effect.react.target] = effect.react.emoji;
        else delete reactions[effect.react.target];
      } else replies.set(`${m.id}:${c.id}`, { messageId: effect.reply.target, text: effect.reply.text });
    }
  }
  return { reactions, replies };
}
