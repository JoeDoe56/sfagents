/**
 * The web interface's per-conversation agent settings (the reasoning effort
 * picked on the send button's sheet), kept in the conversation's state
 * directory, and a best-effort lookup of a model's context window.
 */

import fs from 'node:fs';
import path from 'node:path';
import { OPENROUTER_BASE_URL, REASONING_EFFORTS, type AgentDefinition, type ReasoningEffort } from '@sfagents/core';

/** The levels the slider offers, lowest first. */
export const EFFORT_LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface AgentSettings {
  reasoning?: ReasoningEffort;
}

export class AgentSettingsStore {
  private readonly file: string;
  private value: AgentSettings = {};

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'web-agent.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      if (typeof raw.reasoning === 'string' && (REASONING_EFFORTS as readonly string[]).includes(raw.reasoning)) this.value.reasoning = raw.reasoning as ReasoningEffort;
    } catch {
      // none saved yet
    }
  }

  get(): AgentSettings {
    return { ...this.value };
  }

  set(next: AgentSettings): AgentSettings {
    this.value = { ...next };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

export function parseEffort(value: unknown): ReasoningEffort | null {
  if (value === null) return null;
  if (typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)) return value as ReasoningEffort;
  throw new Error(`Reasoning effort must be one of: ${EFFORT_LEVELS.join(', ')}.`);
}

interface WindowEntry {
  at: number;
  window: number | null;
}

/**
 * Context windows from the provider's model list (`GET <base>/models`:
 * OpenRouter's `context_length`, or `context_window` / `max_context_length`
 * on other OpenAI-compatible servers). Cached; null when unknown.
 */
export class ModelWindows {
  private readonly cache = new Map<string, WindowEntry>();
  private readonly pending = new Map<string, Promise<number | null>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async lookup(definition: Readonly<AgentDefinition>, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
    const base = definition.provider === 'openrouter' ? OPENROUTER_BASE_URL : definition.providerOptions?.baseUrl;
    if (!base) return null;
    const key = `${base}\0${definition.model}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (hit.window === null ? 10 * 60_000 : 24 * 3600_000)) return hit.window;
    let job = this.pending.get(key);
    if (!job) {
      job = this.fetchWindow(base, definition, env).then(
        (window) => {
          this.cache.set(key, { at: Date.now(), window });
          return window;
        },
        () => {
          this.cache.set(key, { at: Date.now(), window: null });
          return null;
        },
      );
      job.finally(() => this.pending.delete(key)).catch(() => undefined);
      this.pending.set(key, job);
    }
    return job;
  }

  private async fetchWindow(base: string, definition: Readonly<AgentDefinition>, env: NodeJS.ProcessEnv): Promise<number | null> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // OpenRouter's model list is public; other servers may want their key.
    const keyEnv = definition.provider === 'openrouter' ? undefined : definition.providerOptions?.apiKeyEnv;
    if (keyEnv && env[keyEnv]) headers.Authorization = `Bearer ${env[keyEnv]}`;
    const res = await this.fetchImpl(`${base.replace(/\/+$/, '')}/models`, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const entry = body.data?.find((m) => m.id === definition.model || m.canonical_slug === definition.model);
    if (!entry) return null;
    for (const k of ['context_length', 'context_window', 'max_context_length', 'max_model_len']) {
      const v = entry[k];
      if (typeof v === 'number' && v > 0) return v;
    }
    const top = entry.top_provider as Record<string, unknown> | undefined;
    return typeof top?.context_length === 'number' ? top.context_length : null;
  }
}
