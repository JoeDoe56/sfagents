/**
 * Builds the model provider for an agent from its `provider` entries:
 *
 * - a provider added in Settings (looked up by name in the registry; its key
 *   or sign-in comes from the OS keyring), or
 * - "openrouter" / "openai-compatible", whose keys come from environment
 *   variables (or the project's untracked .env), as before.
 *
 * With several entries the agent gets a failover provider: when the current
 * account reports a limit (quota, rate limit, signed out, no credit), the
 * next takes over for the same request, and stays current afterwards.
 */

import type { AgentDefinition, ProviderChoice } from '../agents/definition.js';
import { OPENROUTER_BASE_URL, OpenAICompatibleProvider } from './openai-compatible.js';
import { ProviderError, type ModelProvider, type ModelRequest, type ModelStreamEvent } from './types.js';
import type { AnthropicSecret, CustomSecret, OpenAISecret, OpenRouterSecret, ProviderKind, ProviderRecord, ProviderRegistry } from './registry.js';
import { CodexProvider, isAccountLimitStatus } from './codex.js';
import { ClaudeSubscriptionProvider } from './claude-subscription.js';
import type { PlanUsage, PlanUsageStore } from './usage.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

export const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';

export class MissingCredentialError extends Error {
  constructor(readonly envName: string, agentId: string) {
    super(`Environment variable ${envName} is not set (needed by agent "${agentId}"). Set it in your shell or in the project's .env file, or add a provider in Settings and name it in the agent file.`);
    this.name = 'MissingCredentialError';
  }
}

export class UnknownProviderError extends Error {
  constructor(name: string, agentId: string, known: string[]) {
    super(
      `Agent "${agentId}" uses provider "${name}", which is not set up. ${known.length ? `Providers: ${known.map((k) => `"${k}"`).join(', ')}.` : 'No providers are set up yet.'} Add one in Settings → Providers (or with "sfagents providers add"), or use "openrouter" with OPENROUTER_API_KEY.`,
    );
    this.name = 'UnknownProviderError';
  }
}

export class NoProviderError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" has no provider yet. Add one in Settings → Providers (or with "sfagents providers add"); an agent file that names no provider uses it.`);
    this.name = 'NoProviderError';
  }
}

/**
 * The model asked for when an agent file names neither a provider nor a
 * model. "" lets the provider choose (Codex picks the plan's default); a
 * custom endpoint has no default, so its agent needs "model".
 */
export const DEFAULT_MODELS: Readonly<Record<ProviderKind, string>> = {
  openrouter: 'anthropic/claude-sonnet-5.5',
  openai: '',
  anthropic: 'claude-sonnet-5-5',
  custom: '',
};

/**
 * The providers an agent replies with, in failover order: those its file
 * names, or, when it names none, the account picked for it (else the first
 * added in Settings) with the agent's model or that provider's default.
 */
export function providerChoices(definition: Readonly<AgentDefinition>, registry: ProviderRegistry | undefined, picked?: string): ProviderChoice[] {
  if (definition.providers?.length) return definition.providers;
  if (definition.provider) return [{ provider: definition.provider, model: definition.model }];
  const record = (picked ? registry?.find(picked) : undefined) ?? registry?.list()[0];
  if (!record) return [];
  const model = definition.model || DEFAULT_MODELS[record.kind];
  if (!model && record.kind === 'custom') throw new ProviderError(`Provider "${record.name}" has no default model: set "model" in agent "${definition.id}"'s file.`, 400);
  return [{ provider: record.name, model }];
}

export type ProviderFactory = ((definition: Readonly<AgentDefinition>) => ModelProvider) & {
  /** Reads the plan usage of an added provider now, when its kind can (ChatGPT through Codex). */
  readPlanUsage?: (record: ProviderRecord) => Promise<PlanUsage | undefined>;
};

/** Names of environment variables that hold provider credentials for a set of agents. */
export function credentialEnvNames(definitions: Iterable<Readonly<AgentDefinition>>): string[] {
  const names = new Set<string>([OPENROUTER_API_KEY_ENV]);
  for (const d of definitions) if (d.providerOptions?.apiKeyEnv) names.add(d.providerOptions.apiKeyEnv);
  return [...names];
}

/** Which entry of each agent's provider list is current (shared by the CLI and the web interface's session). */
export class AccountState {
  private readonly current = new Map<string, string>();
  private readonly listeners = new Set<(agent: string, provider: string) => void>();

  /** The provider name in use for `agent`, if one was chosen or failed over to. */
  get(agent: string): string | undefined {
    return this.current.get(agent);
  }

  set(agent: string, provider: string | undefined): void {
    if (provider === undefined) this.current.delete(agent);
    else this.current.set(agent, provider);
    if (provider !== undefined) for (const l of this.listeners) l(agent, provider);
  }

  onChange(listener: (agent: string, provider: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  entries(): Array<[string, string]> {
    return [...this.current];
  }
}

interface FactoryOptions {
  env?: NodeJS.ProcessEnv;
  /** Providers added in Settings; without one, only the environment-variable providers work. */
  registry?: ProviderRegistry;
  accounts?: AccountState;
  fetcher?: typeof fetch;
  /** Where ChatGPT and Claude providers report the plan's 5-hour and weekly usage. */
  usage?: PlanUsageStore;
}

/** Errors after which another account may succeed. */
export function shouldFailOver(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof UnknownProviderError || error instanceof MissingCredentialError) return true;
  if (error instanceof ProviderError) return isAccountLimitStatus(error.status) || /insufficient|quota|credit|usage limit|rate limit/i.test(error.message);
  return false;
}

/** Tries each provider in order, starting with the current one; see the file comment. */
export class FailoverProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly agent: string,
    private readonly choices: readonly ProviderChoice[],
    private readonly build: (choice: ProviderChoice) => ModelProvider,
    private readonly accounts: AccountState,
  ) {
    this.id = choices.map((c) => c.provider).join(' → ');
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const current = this.accounts.get(this.agent);
    const start = Math.max(0, this.choices.findIndex((c) => c.provider.toLowerCase() === current?.toLowerCase()));
    const errors: string[] = [];
    for (let k = 0; k < this.choices.length; k++) {
      const choice = this.choices[(start + k) % this.choices.length]!;
      let yielded = false;
      try {
        const provider = this.build(choice);
        if (k > 0) yield { type: 'notice', text: `Switched to "${choice.provider}"${choice.model !== request.model ? ` (${choice.model})` : ''}: ${errors[errors.length - 1]}` };
        for await (const event of provider.stream({ ...request, model: choice.model })) {
          if (event.type === 'text' || event.type === 'reasoning') yielded = true;
          yield event;
        }
        if (k > 0 || current === undefined) this.accounts.set(this.agent, choice.provider);
        return;
      } catch (error) {
        // Once text was streamed the turn can't be retried silently elsewhere.
        if (yielded || !shouldFailOver(error) || k === this.choices.length - 1) {
          if (errors.length && !yielded) throw new ProviderError(`${getErrorMessage(error)} (also tried: ${errors.join('; ')})`, error instanceof ProviderError ? error.status : undefined);
          throw error;
        }
        errors.push(`"${choice.provider}": ${getErrorMessage(error)}`);
      }
    }
  }
}

export function createDefaultProviderFactory(envOrOptions: NodeJS.ProcessEnv | FactoryOptions = process.env): ProviderFactory {
  const options: FactoryOptions =
    'registry' in envOrOptions || 'accounts' in envOrOptions || 'env' in envOrOptions || 'fetcher' in envOrOptions || 'usage' in envOrOptions
      ? (envOrOptions as FactoryOptions)
      : { env: envOrOptions as NodeJS.ProcessEnv };
  const env = options.env ?? process.env;
  const accounts = options.accounts ?? new AccountState();
  const cache = new Map<string, ModelProvider>();

  const lazySecret = <T>(record: ProviderRecord): (() => Promise<T>) => {
    return async () => {
      const s = await options.registry!.secret<T & object>(record.id);
      if (!s) throw new ProviderError(`The key or sign-in for provider "${record.name}" is missing from the keyring. Remove and add the provider again.`, 401);
      return s as T;
    };
  };

  const fromRecord = (record: ProviderRecord): ModelProvider => {
    const key = `rec\0${record.id}\0${record.kind}\0${record.baseUrl ?? ''}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let provider: ModelProvider;
    switch (record.kind) {
      case 'openrouter':
      case 'custom': {
        const secret = lazySecret<OpenRouterSecret | CustomSecret>(record);
        const baseUrl = record.kind === 'openrouter' ? OPENROUTER_BASE_URL : record.baseUrl!;
        let inner: OpenAICompatibleProvider | null = null;
        provider = {
          id: record.name,
          async *stream(request) {
            if (!inner) {
              const s = await secret();
              inner = new OpenAICompatibleProvider({ id: record.name, baseUrl, apiKey: s.apiKey || 'sk-no-key' });
            }
            yield* inner.stream(request);
          },
        };
        break;
      }
      case 'openai': {
        const secret = lazySecret<OpenAISecret | { refreshToken?: string }>(record);
        const codex = new CodexProvider(record.name, record.id, options.registry!.stateDir(record), { usage: options.usage });
        let checked = false;
        provider = {
          id: record.name,
          async *stream(request) {
            if (!checked) {
              // Added before SF Agents used Codex: that sign-in can't be carried over.
              if (!('codex' in (await secret()))) throw new ProviderError(`Provider "${record.name}" was signed in the old way. Remove it and add it again in Settings → Providers.`, 401);
              checked = true;
            }
            yield* codex.stream(request);
          },
          readPlanUsage: () => codex.readPlanUsage(),
        } as ModelProvider & { readPlanUsage(): Promise<PlanUsage | undefined> };
        break;
      }
      case 'anthropic': {
        const secret = lazySecret<AnthropicSecret>(record);
        provider = new ClaudeSubscriptionProvider(record.name, async () => (await secret()).token, options.registry!.stateDir(record), { usage: options.usage, usageKey: record.id });
        break;
      }
    }
    cache.set(key, provider);
    return provider;
  };

  const single = (choice: ProviderChoice, definition: Readonly<AgentDefinition>): ModelProvider => {
    const record = options.registry?.find(choice.provider);
    if (record) return fromRecord(record);
    let baseUrl: string;
    let envName: string;
    if (choice.provider === 'openrouter') {
      baseUrl = OPENROUTER_BASE_URL;
      envName = OPENROUTER_API_KEY_ENV;
    } else if (choice.provider === 'openai-compatible' && definition.providerOptions) {
      baseUrl = definition.providerOptions.baseUrl;
      envName = definition.providerOptions.apiKeyEnv;
    } else {
      throw new UnknownProviderError(choice.provider, definition.id, options.registry?.list().map((r) => r.name) ?? []);
    }
    const apiKey = env[envName];
    if (!apiKey) throw new MissingCredentialError(envName, definition.id);
    const key = `env\0${choice.provider}\0${baseUrl}\0${envName}`;
    let provider = cache.get(key);
    if (!provider) {
      provider = new OpenAICompatibleProvider({ id: choice.provider, baseUrl, apiKey });
      cache.set(key, provider);
    }
    return provider;
  };

  const factory: ProviderFactory = (definition) => {
    const picked = accounts.get(definition.id);
    let choices = providerChoices(definition, options.registry, picked);
    if (!choices.length) throw new NoProviderError(definition.id);
    // An account picked by hand that the agent file doesn't list goes first, with the agent's model.
    if (picked && !choices.some((c) => c.provider.toLowerCase() === picked.toLowerCase()) && options.registry?.find(picked)) {
      choices = [{ provider: picked, model: choices[0]!.model }, ...choices];
    }
    if (choices.length === 1) return single(choices[0]!, definition);
    return new FailoverProvider(definition.id, choices, (c) => single(c, definition), accounts);
  };
  factory.readPlanUsage = async (record) => {
    const p = fromRecord(record) as ModelProvider & { readPlanUsage?: () => Promise<PlanUsage | undefined> };
    return p.readPlanUsage ? p.readPlanUsage() : options.usage?.get(record.id);
  };
  return factory;
}

/** Whether an agent's providers can be built now (for early "not set up" errors). Returns the problems. */
export function checkProviders(definition: Readonly<AgentDefinition>, registry: ProviderRegistry | undefined, env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const choices = providerChoices(definition, registry);
  if (!choices.length) return [new NoProviderError(definition.id).message];
  for (const c of choices) {
    if (registry?.find(c.provider)) continue;
    if (c.provider === 'openrouter') {
      if (!env[OPENROUTER_API_KEY_ENV]) problems.push(new MissingCredentialError(OPENROUTER_API_KEY_ENV, definition.id).message);
    } else if (c.provider === 'openai-compatible' && definition.providerOptions) {
      if (!env[definition.providerOptions.apiKeyEnv]) problems.push(new MissingCredentialError(definition.providerOptions.apiKeyEnv, definition.id).message);
    } else problems.push(new UnknownProviderError(c.provider, definition.id, registry?.list().map((r) => r.name) ?? []).message);
  }
  // One usable provider is enough to start.
  return problems.length === choices.length ? problems : [];
}

