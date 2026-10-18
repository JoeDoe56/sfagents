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
export interface UserMessage {
  role: 'user';
  content: string;
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
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export type ModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
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
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
