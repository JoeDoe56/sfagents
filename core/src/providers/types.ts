/**
 * Model provider abstraction. Messages use the OpenAI chat-completions shape
 * end to end (upstream converted to and from @google/genai `Content`; that
 * conversion layer is not needed for an OpenAI-compatible-only runtime).
 */

import type { FunctionDeclaration } from '../tools/tools.js';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ToolCallMessagePart {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface SystemMessage {
  role: 'system';
  content: string;
}
/** OpenAI-compatible user content parts (text plus images). */
export type UserContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface UserMessage {
  role: 'user';
  content: string | UserContentPart[];
}
export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCallMessagePart[];
  /** Plain reasoning text, when the provider returns it. */
  reasoning?: string;
  /**
   * Provider reasoning blocks (OpenRouter `reasoning_details`). Passed back
   * unmodified on later turns so reasoning models can continue across tool
   * calls.
   */
  reasoning_details?: Array<Record<string, unknown>>;
}
export interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ModelRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly FunctionDeclaration[];
  reasoning?: ReasoningEffort;
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Raw argument text, kept for the assistant message replayed to the model. */
  rawArguments: string;
}

export interface TokenUsage {
  /** Every input token the request carried, cached or not: the real size of the context sent. */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  /** Input tokens processed fresh (not read from or written to the cache). */
  inputTokens?: number;
  /** Input tokens read from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written to the prompt cache (Anthropic bills these above plain input). */
  cacheWriteTokens?: number;
  /** Output tokens spent on reasoning (part of completionTokens). */
  reasoningTokens?: number;
  /** Model API calls behind this usage (one SF Agents turn should be one). */
  requests?: number;
}

/** Usage fields that add up across requests. */
export const TOKEN_USAGE_KEYS = ['promptTokens', 'completionTokens', 'totalTokens', 'cost', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'requests'] as const;

export function addTokenUsage(total: TokenUsage, add?: TokenUsage): TokenUsage {
  if (!add) return total;
  for (const key of TOKEN_USAGE_KEYS) {
    const v = add[key];
    if (typeof v === 'number' && Number.isFinite(v)) total[key] = (total[key] ?? 0) + v;
  }
  return total;
}

/** One line for logs: "120.4k in (98.0k cached, 2.1k cache write, 20.3k fresh) · 1.2k out (300 reasoning) · 1 API call · $0.0123". */
export function usageText(u: TokenUsage | undefined): string {
  if (!u) return 'no usage reported';
  const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
  const parts: string[] = [];
  if (u.promptTokens !== undefined) {
    const split: string[] = [];
    if (u.cacheReadTokens) split.push(`${k(u.cacheReadTokens)} cached`);
    if (u.cacheWriteTokens) split.push(`${k(u.cacheWriteTokens)} cache write`);
    if (u.inputTokens !== undefined && (u.cacheReadTokens || u.cacheWriteTokens)) split.push(`${k(u.inputTokens)} fresh`);
    parts.push(`${k(u.promptTokens)} in${split.length ? ` (${split.join(', ')})` : ''}`);
  }
  if (u.completionTokens !== undefined) parts.push(`${k(u.completionTokens)} out${u.reasoningTokens ? ` (${k(u.reasoningTokens)} reasoning)` : ''}`);
  if (u.requests !== undefined) parts.push(`${u.requests} API call${u.requests === 1 ? '' : 's'}`);
  if (typeof u.cost === 'number' && Number.isFinite(u.cost)) parts.push(`$${u.cost.toFixed(4)}`);
  return parts.join(' · ') || 'no usage reported';
}

export type ModelStreamEvent =
  | { type: 'text'; text: string }
  /** Something the user should know, e.g. another account took over. */
  | { type: 'notice'; text: string }
  | { type: 'reasoning'; text: string }
  /** Provider detail for the logs (cache counters, stop reasons, API calls); never shown in the chat. */
  | { type: 'log'; text: string }
  | {
      type: 'done';
      message: AssistantMessage;
      toolCalls: ParsedToolCall[];
      finishReason: string | null;
      usage?: TokenUsage;
    };

export interface ModelProvider {
  readonly id: string;
  /** Streams one model turn. Must honour `request.signal`. */
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

/** Error raised for provider failures, with an HTTP status when known. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    /** What the failed request still consumed, when the provider reported it. */
    readonly usage?: TokenUsage,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
