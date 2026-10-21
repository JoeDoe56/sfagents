/**
 * Builds a model provider from an agent definition. API keys come only from
 * the environment (or an untracked .env file loaded by the CLI), never from
 * agent JSON.
 */

import type { AgentDefinition } from '../agents/definition.js';
import { OPENROUTER_BASE_URL, OpenAICompatibleProvider } from './openai-compatible.js';
import type { ModelProvider } from './types.js';

export const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';

export class MissingCredentialError extends Error {
  constructor(readonly envName: string, agentId: string) {
    super(`Environment variable ${envName} is not set (needed by agent "${agentId}"). Set it in your shell or in the project's .env file.`);
    this.name = 'MissingCredentialError';
  }
}

export type ProviderFactory = (definition: Readonly<AgentDefinition>) => ModelProvider;

/** Names of environment variables that hold provider credentials for a set of agents. */
export function credentialEnvNames(definitions: Iterable<Readonly<AgentDefinition>>): string[] {
  const names = new Set<string>([OPENROUTER_API_KEY_ENV]);
  for (const d of definitions) if (d.providerOptions?.apiKeyEnv) names.add(d.providerOptions.apiKeyEnv);
  return [...names];
}

export function createDefaultProviderFactory(env: NodeJS.ProcessEnv = process.env): ProviderFactory {
  const cache = new Map<string, ModelProvider>();
  return (definition) => {
    let baseUrl: string;
    let envName: string;
    if (definition.provider === 'openrouter') {
      baseUrl = OPENROUTER_BASE_URL;
      envName = OPENROUTER_API_KEY_ENV;
    } else {
      baseUrl = definition.providerOptions!.baseUrl;
      envName = definition.providerOptions!.apiKeyEnv;
    }
    const apiKey = env[envName];
    if (!apiKey) throw new MissingCredentialError(envName, definition.id);
    const key = `${definition.provider}\0${baseUrl}\0${envName}`;
    let provider = cache.get(key);
    if (!provider) {
      provider = new OpenAICompatibleProvider({ id: definition.provider, baseUrl, apiKey });
      cache.set(key, provider);
    }
    return provider;
  };
}
