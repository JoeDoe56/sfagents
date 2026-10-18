/**
 * OpenAI-compatible chat-completions provider (OpenRouter by default).
 *
 * Design follows qwen-code core/openaiContentGenerator: the OpenAI SDK
 * client, streamed tool-call assembly through StreamingToolCallParser, and
 * OpenRouter's gateway-level `reasoning` parameter sent only to an
 * `openrouter.ai` hostname (provider/openrouter.ts). Reasoning blocks are
 * accumulated from stream deltas and returned on the assistant message.
 */

import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { StreamingToolCallParser } from './streaming-tool-call-parser.js';
import {
  ProviderError,
  type AssistantMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ParsedToolCall,
  type TokenUsage,
} from './types.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Hostname-only check, mirroring upstream `isOpenRouterHostname`. */
export function isOpenRouterHostname(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

type ReasoningDetail = Record<string, unknown>;

/** Merges streamed reasoning_details fragments by `index`, concatenating text fields. */
export function mergeReasoningDetails(target: ReasoningDetail[], incoming: unknown): void {
  if (!Array.isArray(incoming)) return;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const detail = raw as ReasoningDetail;
    const index = typeof detail['index'] === 'number' ? (detail['index'] as number) : undefined;
    const existing =
      index === undefined
        ? undefined
        : target.find((d) => d['index'] === index && (detail['type'] === undefined || d['type'] === detail['type']));
    if (!existing) {
      target.push({ ...detail });
      continue;
    }
    for (const [key, value] of Object.entries(detail)) {
      if ((key === 'text' || key === 'summary' || key === 'data') && typeof value === 'string') {
        existing[key] = (typeof existing[key] === 'string' ? (existing[key] as string) : '') + value;
      } else if (value !== undefined && value !== null) {
        existing[key] = value;
      }
    }
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly isOpenRouter: boolean;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.isOpenRouter = isOpenRouterHostname(options.baseUrl);
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: options.timeoutMs ?? 10 * 60 * 1000,
      maxRetries: options.maxRetries ?? 2,
      defaultHeaders: {
        ...(this.isOpenRouter ? { 'HTTP-Referer': 'https://github.com/JoeDoe56/sfagents', 'X-Title': 'SF Agents' } : {}),
        ...options.headers,
      },
    });
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages as unknown as ChatCompletionMessageParam[],
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }
    if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.reasoning !== undefined) {
      if (this.isOpenRouter) {
        body['reasoning'] = { effort: request.reasoning };
      } else if (request.reasoning !== 'none') {
        body['reasoning_effort'] = request.reasoning;
      }
    }
    return body;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = (await this.client.chat.completions.create(
        this.buildBody(request) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: request.signal },
      )) as AsyncIterable<ChatCompletionChunk>;
    } catch (error) {
      throw toProviderError(error);
    }

    const parser = new StreamingToolCallParser();
    let text = '';
    let reasoning = '';
    const reasoningDetails: ReasoningDetail[] = [];
    let finishReason: string | null = null;
    let usage: TokenUsage | undefined;

    try {
      for await (const chunk of stream) {
        const errorPayload = (chunk as unknown as { error?: { message?: string; code?: number } }).error;
        if (errorPayload) {
          throw new ProviderError(`Provider stream error: ${errorPayload.message ?? JSON.stringify(errorPayload)}`, errorPayload.code);
        }
        if (chunk.usage) {
          const u = chunk.usage as typeof chunk.usage & { cost?: number };
          usage = {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
            cost: u.cost,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as typeof choice.delta & {
          reasoning?: string | null;
          reasoning_content?: string | null;
          reasoning_details?: unknown;
        };
        const reasoningText = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoningText) {
          reasoning += reasoningText;
          yield { type: 'reasoning', text: reasoningText };
        }
        if (delta?.reasoning_details) mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
        if (delta?.content) {
          text += delta.content;
          yield { type: 'text', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          parser.addChunk(tc.index ?? 0, tc.function?.arguments ?? '', tc.id ?? undefined, tc.function?.name ?? undefined);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw toProviderError(error);
    }

    const toolCalls: ParsedToolCall[] = parser.getCompletedToolCalls().map((call, i) => ({
      id: call.id || `call_sfagents_${Date.now().toString(36)}_${i}`,
      name: call.name ?? '',
      args: call.args,
      rawArguments: JSON.stringify(call.args),
    }));
    if (parser.hasIncompleteToolCalls() && finishReason !== 'length') {
      finishReason = 'length';
    }

    const message: AssistantMessage = { role: 'assistant', content: text.length > 0 ? text : null };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.rawArguments },
      }));
    }
    if (reasoningDetails.length > 0) message.reasoning_details = reasoningDetails;
    else if (reasoning) message.reasoning = reasoning;

    yield { type: 'done', message, toolCalls, finishReason, usage };
  }
}

function toProviderError(error: unknown): Error {
  if (isAbortError(error)) return error as Error;
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
    let detail = error.message;
    const body = error.error as { message?: string; metadata?: { raw?: string } } | undefined;
    if (body?.metadata?.raw) detail += ` (${body.metadata.raw})`;
    return new ProviderError(`Model request failed${status ? ` (HTTP ${status})` : ''}: ${detail}`, status, retryable);
  }
  return new ProviderError(`Model request failed: ${getErrorMessage(error)}`, undefined, true);
}
