/**
 * OpenAI-compatible chat-completions provider (OpenRouter by default).
 *
 * Design follows qwen-code core/openaiContentGenerator: the OpenAI SDK
 * client, streamed tool-call assembly through StreamingToolCallParser, and
 * OpenRouter's gateway-level `reasoning` parameter sent only to an
 * `openrouter.ai` hostname (provider/openrouter.ts). Reasoning blocks are
 * accumulated from stream deltas and returned on the assistant message.
 */

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { StreamingToolCallParser } from './streaming-tool-call-parser.js';
import {
  ProviderError,
  type AssistantMessage,
  type ModelProvider,
  type ChatMessage,
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

/**
 * Chat-completions usage with the cache and reasoning detail OpenAI and
 * OpenRouter add. Cached tokens are counted inside prompt_tokens.
 */
export function chatUsage(raw: unknown): TokenUsage {
  const u = raw as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  const prompt = u.prompt_tokens;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  return {
    promptTokens: prompt,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
    ...(typeof u.cost === 'number' ? { cost: u.cost } : {}),
    ...(typeof prompt === 'number' ? { inputTokens: Math.max(0, prompt - cached - written), cacheReadTokens: cached, cacheWriteTokens: written } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
    requests: 1,
  };
}

/**
 * OpenAI's prompt cache routes requests by a hash of their first part; a
 * prompt_cache_key keeps the requests of one agent on the same cache even
 * when that first part is shared with other agents or changes a little. One
 * key per model and system prompt: the requests that share a prefix.
 * Only where OpenAI models answer (api.openai.com, or openai/ on OpenRouter).
 */
export function promptCacheKey(baseUrl: string, model: string, messages: readonly ChatMessage[]): string | undefined {
  const openai = isOpenRouterHostname(baseUrl) ? /^openai\//i.test(model) : /(^|\.)api\.openai\.com$/i.test(hostOf(baseUrl));
  if (!openai) return undefined;
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  return `sfagents-${createHash('sha256').update(`${model}\u0000${typeof system === 'string' ? system : JSON.stringify(system)}`).digest('hex').slice(0, 32)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Anthropic and Gemini models on OpenRouter cache only up to explicit
 * cache_control breakpoints (OpenAI, DeepSeek, Grok and others cache by
 * themselves). Without them every request is billed as fresh input. Marks
 * the system prompt (stable for a whole run) and the last message (the next
 * request repeats everything up to it); Anthropic allows four breakpoints.
 */
export function withCacheBreakpoints(model: string, messages: readonly ChatMessage[]): readonly ChatMessage[] {
  if (!/^(anthropic|google)\//i.test(model)) return messages;
  const out = [...messages] as unknown as Array<Record<string, unknown>>;
  const mark = (i: number) => {
    const m = out[i];
    if (!m) return;
    const content = m['content'];
    if (typeof content === 'string') {
      if (!content) return;
      out[i] = { ...m, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] };
    } else if (Array.isArray(content) && content.length) {
      const parts = [...content] as Array<Record<string, unknown>>;
      const lastText = parts.map((p) => p['type']).lastIndexOf('text');
      if (lastText < 0) return;
      parts[lastText] = { ...parts[lastText], cache_control: { type: 'ephemeral' } };
      out[i] = { ...m, content: parts };
    }
  };
  const system = out.findIndex((m) => m['role'] === 'system');
  if (system >= 0) mark(system);
  // The last message that can carry a breakpoint (assistant messages with only tool calls cannot).
  for (let i = out.length - 1; i > system; i--) {
    const c = out[i]!['content'];
    if ((typeof c === 'string' && c) || (Array.isArray(c) && c.length)) {
      mark(i);
      break;
    }
  }
  return out as unknown as ChatMessage[];
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly isOpenRouter: boolean;
  private readonly baseUrl: string;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl;
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
      messages: (this.isOpenRouter ? withCacheBreakpoints(request.model, request.messages) : request.messages) as unknown as ChatCompletionMessageParam[],
      stream: true,
      stream_options: { include_usage: true },
    };
    // OpenRouter: report cost and cache counters with the usage.
    if (this.isOpenRouter) body['usage'] = { include: true };
    const cacheKey = promptCacheKey(this.baseUrl, request.model, request.messages);
    if (cacheKey) body['prompt_cache_key'] = cacheKey;
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

  /**
   * Streams one model turn. A request that fails before anything arrived
   * with a retryable error (rate limit, overload, network) is retried a few
   * times with growing pauses.
   */
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const event of this.streamOnce(request)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (yielded || delay === undefined || !(error instanceof ProviderError) || !error.retryable || request.signal?.aborted) throw error;
        await sleep(delay, request.signal);
      }
    }
  }

  private async *streamOnce(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
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
        const errorPayload = (chunk as unknown as { error?: ErrorBody }).error;
        if (errorPayload) {
          const code = typeof errorPayload.code === 'number' ? errorPayload.code : undefined;
          throw new ProviderError(`Provider stream error: ${describeErrorBody(errorPayload)}`, code, isRetryableStatus(code));
        }
        if (chunk.usage) usage = chatUsage(chunk.usage);
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

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

interface ErrorBody {
  message?: unknown;
  code?: unknown;
  metadata?: { raw?: unknown; provider_name?: unknown };
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/**
 * The message of an error body, with what OpenRouter adds: the upstream
 * provider and its own error text ("Provider returned error" alone says
 * nothing).
 */
function describeErrorBody(body: ErrorBody): string {
  let text = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? body);
  const raw = body.metadata?.raw;
  const provider = typeof body.metadata?.provider_name === 'string' ? body.metadata.provider_name : undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    const rawText = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 500);
    text += ` (${provider ? `${provider}: ` : ''}${rawText})`;
  } else if (provider) {
    text += ` (${provider})`;
  }
  if (typeof body.code === 'number' || typeof body.code === 'string') text += ` [code ${body.code}]`;
  return text;
}

function toProviderError(error: unknown): Error {
  if (isAbortError(error)) return error as Error;
  if (error instanceof OpenAI.APIError) {
    const body = error.error as ErrorBody | undefined;
    // A stream error has no HTTP status; OpenRouter puts it in the body's code.
    const status = error.status ?? (typeof body?.code === 'number' ? body.code : undefined);
    const detail = body && typeof body === 'object' ? describeErrorBody(body) : error.message;
    return new ProviderError(`Model request failed${status ? ` (HTTP ${status})` : ''}: ${detail}`, status, isRetryableStatus(status));
  }
  return new ProviderError(`Model request failed: ${getErrorMessage(error)}`, undefined, true);
}
