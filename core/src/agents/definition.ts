/**
 * SF Agents JSON agent definitions: types and strict field validation.
 *
 * Unknown keys are rejected so a typo ("tool" for "tools") fails at startup
 * instead of silently granting or dropping permissions.
 */

import { BUILTIN_TOOL_IDS, MCP_TOOL_PREFIX, ToolNames } from '../tools/tool-names.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../providers/types.js';

/** Providers an agent file can name without adding one in Settings (keys from environment variables). */
export const SUPPORTED_PROVIDERS = ['openrouter', 'openai-compatible'] as const;
/** "openrouter", "openai-compatible", or the name of a provider added in Settings ("OpenRouter 1", "Claude work"). */
export type ProviderName = string;

/** One provider (account) an agent may use, with the model to ask it for. */
export interface ProviderChoice {
  provider: string;
  model: string;
}

export interface McpServerGrant {
  /** Server name from mcp.json. */
  server: string;
  /** Tool names on that server; omitted means every tool the server exposes. */
  tools?: string[];
}

/** Another agent this one may message, from a "N-name.json" entry in tools.allow. */
export interface AgentGrant {
  /** The agent's file name, relative to the agents folder (e.g. "researcher.json"). */
  file: string;
  /** The agent's name (its file name without ".json"). */
  agent: string;
  /** How many instances (parallel threads) of it this agent may run at once. */
  max: number;
}

export interface AgentDefinition {
  /** The agent's name: its file name without ".json" (an "id" in the file is only a label). */
  id: string;
  /** Display name, when it differs from the file name. */
  name?: string;
  description?: string;
  /** The first provider (the one shown); `providers` has them all, in failover order. */
  provider: ProviderName;
  /**
   * Every provider the agent may use, in order. When one reports that its
   * account is out of quota, signed out or rate-limited, the next takes over
   * (and stays current until it, too, runs out).
   */
  providers: ProviderChoice[];
  /** Only for provider "openai-compatible". */
  providerOptions?: {
    baseUrl: string;
    /** Name of the environment variable holding the API key. */
    apiKeyEnv: string;
  };
  model: string;
  systemPrompt: string;
  reasoning?: ReasoningEffort;
  temperature?: number;
  maxOutputTokens?: number;
  workspace?: {
    roots: string[];
  };
  tools?: {
    allow?: string[];
    mcpServers?: Array<string | McpServerGrant>;
    /** Tool IDs that skip the confirmation prompt (e.g. "edit", "mcp__srv__*"). */
    autoApprove?: string[];
    /** Agents this one may message ("N-name.json" entries of tools.allow). */
    agents?: AgentGrant[];
  };
  /**
   * Access to the main persistent conversation's sections and history:
   * "organize" (read + add/edit sections), "read", or "none". Defaults:
   * "organize" while the agent replies in the main conversation, "none"
   * while it works in a thread with another agent.
   */
  conversation?: {
    access?: 'none' | 'read' | 'organize';
  };
  /**
   * Artifacts in the persistent conversation: "create" (list, read, create
   * and update), "read", or "none". Defaults: "create" in the main
   * conversation, "none" in a thread.
   */
  artifacts?: {
    access?: 'none' | 'read' | 'create';
  };
  /** Working-context policy (the main conversation, and its threads with other agents). */
  context?: {
    /** Estimated input-token budget for each request (default 48000). */
    maxInputTokens?: number;
    /** Most recent exchanges kept verbatim when they fit (default 12). */
    recentExchanges?: number;
  };
  limits?: {
    maxTurns?: number;
    timeoutSeconds?: number;
    toolTimeoutSeconds?: number;
    shellTimeoutSeconds?: number;
    maxToolOutputChars?: number;
  };
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly field: string | undefined,
    message: string,
  ) {
    super(`${file}${field ? ` [${field}]` : ''}: ${message}`);
    this.name = 'ConfigError';
  }
}

export const AGENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Agent names come from file names: anything printable without path separators. */
export const AGENT_NAME_PATTERN = /^[^\\/:*?"<>|\x00-\x1f]{1,100}$/;
/** "3-researcher.json" in tools.allow: may run up to 3 instances of agents/researcher.json. */
export const AGENT_GRANT_PATTERN = /^([1-9][0-9]{0,2})-(.+\.json)$/i;

const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'id',
  'name',
  'description',
  'provider',
  'providerOptions',
  'model',
  'systemPrompt',
  'reasoning',
  'temperature',
  'maxOutputTokens',
  'workspace',
  'tools',
  'conversation',
  'artifacts',
  'context',
  'limits',
]);

type Raw = Record<string, unknown>;

function isPlainObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class FieldChecker {
  constructor(readonly file: string) {}

  fail(field: string | undefined, message: string): never {
    throw new ConfigError(this.file, field, message);
  }

  object(value: unknown, field: string, allowed: readonly string[]): Raw {
    if (!isPlainObject(value)) this.fail(field, 'must be an object');
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.fail(`${field}.${key}`, `unknown field. Allowed fields: ${allowed.join(', ')}`);
      }
    }
    return value;
  }

  string(value: unknown, field: string, opts: { nonEmpty?: boolean; maxLength?: number } = {}): string {
    if (typeof value !== 'string') this.fail(field, 'must be a string');
    if (opts.nonEmpty && value.trim() === '') this.fail(field, 'must not be empty');
    if (opts.maxLength !== undefined && value.length > opts.maxLength) {
      this.fail(field, `must be at most ${opts.maxLength} characters`);
    }
    return value;
  }

  optionalString(value: unknown, field: string, opts: { nonEmpty?: boolean; maxLength?: number } = {}): string | undefined {
    return value === undefined ? undefined : this.string(value, field, opts);
  }

  integer(value: unknown, field: string, min: number, max: number): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value)) this.fail(field, 'must be an integer');
    if (value < min || value > max) this.fail(field, `must be between ${min} and ${max}`);
    return value;
  }

  number(value: unknown, field: string, min: number, max: number): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) this.fail(field, 'must be a number');
    if (value < min || value > max) this.fail(field, `must be between ${min} and ${max}`);
    return value;
  }

  stringArray(value: unknown, field: string, opts: { unique?: boolean; nonEmptyItems?: boolean } = {}): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) this.fail(field, 'must be an array of strings');
    const seen = new Set<string>();
    value.forEach((item, i) => {
      if (typeof item !== 'string') this.fail(`${field}[${i}]`, 'must be a string');
      if (opts.nonEmptyItems && item.trim() === '') this.fail(`${field}[${i}]`, 'must not be empty');
      if (opts.unique) {
        if (seen.has(item)) this.fail(`${field}[${i}]`, `duplicate entry "${item}"`);
        seen.add(item);
      }
    });
    return value as string[];
  }
}

/**
 * Validates one parsed agent JSON document. Cross-file rules (children,
 * escalation, MCP server existence, roots on disk) are checked by the loader.
 */
export function parseAgentDefinition(raw: unknown, file: string, agentName?: string): AgentDefinition {
  const c: FieldChecker = new FieldChecker(file);
  if (!isPlainObject(raw)) c.fail(undefined, 'agent definition must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (key === 'spawn') {
      c.fail('spawn', 'is no longer used: let an agent message another by adding "N-name.json" to tools.allow (N = how many it may run at once)');
    }
    if (!TOP_LEVEL_KEYS.has(key)) {
      c.fail(key, `unknown field. Allowed fields: ${[...TOP_LEVEL_KEYS].filter((k) => k !== '$schema').join(', ')}`);
    }
  }

  // The agent is known by its file name; an "id" in the file is a label.
  const label = c.optionalString(raw['id'], 'id', { nonEmpty: true, maxLength: 100 });
  const name = c.optionalString(raw['name'], 'name', { nonEmpty: true, maxLength: 100 }) ?? (label && label !== agentName ? label : undefined);
  const id = agentName ?? label;
  if (!id) c.fail('id', 'is required when the definition is not loaded from a file');
  if (!AGENT_NAME_PATTERN.test(id)) c.fail('id', 'must not contain path separators or control characters (max 100 characters)');
  const description = c.optionalString(raw['description'], 'description', { maxLength: 2000 });

  const model = c.string(raw['model'], 'model', { nonEmpty: true, maxLength: 200 });
  // "provider": a name, a list of names (failover order), or objects with their own model.
  const rawProvider = raw['provider'];
  const providers: ProviderChoice[] = [];
  const providerName = (v: unknown, field: string): string => {
    const n = c.string(v, field, { nonEmpty: true, maxLength: 60 });
    if (/[\x00-\x1f]/.test(n)) c.fail(field, 'must not contain control characters');
    return n.trim();
  };
  if (Array.isArray(rawProvider)) {
    if (!rawProvider.length) c.fail('provider', 'must name at least one provider');
    if (rawProvider.length > 20) c.fail('provider', 'lists at most 20 providers');
    rawProvider.forEach((entry, i) => {
      const field = `provider[${i}]`;
      if (typeof entry === 'string') providers.push({ provider: providerName(entry, field), model });
      else {
        const o = c.object(entry, field, ['provider', 'model']);
        providers.push({ provider: providerName(o['provider'], `${field}.provider`), model: o['model'] === undefined ? model : c.string(o['model'], `${field}.model`, { nonEmpty: true, maxLength: 200 }) });
      }
    });
    const seen = new Set<string>();
    providers.forEach((p, i) => {
      const k = `${p.provider.toLowerCase()}\0${p.model}`;
      if (seen.has(k)) c.fail(`provider[${i}]`, 'duplicate entry');
      seen.add(k);
    });
  } else {
    providers.push({ provider: providerName(rawProvider, 'provider'), model });
  }
  const provider = providers[0]!.provider;
  const usesCompatible = providers.some((p) => p.provider === 'openai-compatible');
  let providerOptions: AgentDefinition['providerOptions'];
  if (raw['providerOptions'] !== undefined) {
    if (!usesCompatible) {
      c.fail('providerOptions', 'is only supported with provider "openai-compatible"');
    }
    const po = c.object(raw['providerOptions'], 'providerOptions', ['baseUrl', 'apiKeyEnv']);
    const baseUrl = c.string(po['baseUrl'], 'providerOptions.baseUrl', { nonEmpty: true });
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    } catch {
      c.fail('providerOptions.baseUrl', 'must be an http(s) URL');
    }
    const apiKeyEnv = c.string(po['apiKeyEnv'], 'providerOptions.apiKeyEnv', { nonEmpty: true });
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      c.fail('providerOptions.apiKeyEnv', 'must be an environment variable name (the key itself never goes in agent JSON)');
    }
    providerOptions = { baseUrl, apiKeyEnv };
  } else if (usesCompatible) {
    c.fail('providerOptions', 'is required for provider "openai-compatible" (baseUrl and apiKeyEnv)');
  }

  const systemPrompt = c.string(raw['systemPrompt'], 'systemPrompt', { nonEmpty: true, maxLength: 200_000 });

  let reasoning: ReasoningEffort | undefined;
  if (raw['reasoning'] !== undefined) {
    const r = c.string(raw['reasoning'], 'reasoning');
    if (!(REASONING_EFFORTS as readonly string[]).includes(r)) {
      c.fail('reasoning', `must be one of: ${REASONING_EFFORTS.join(', ')}`);
    }
    reasoning = r as ReasoningEffort;
  }
  const temperature = c.number(raw['temperature'], 'temperature', 0, 2);
  const maxOutputTokens = c.integer(raw['maxOutputTokens'], 'maxOutputTokens', 1, 1_000_000);

  let workspace: AgentDefinition['workspace'];
  if (raw['workspace'] !== undefined) {
    const ws = c.object(raw['workspace'], 'workspace', ['roots']);
    const roots = c.stringArray(ws['roots'], 'workspace.roots', { unique: true, nonEmptyItems: true });
    if (!roots) c.fail('workspace.roots', 'is required when workspace is given');
    if (roots.length === 0) c.fail('workspace.roots', 'must list at least one directory');
    workspace = { roots };
  }

  let tools: AgentDefinition['tools'];
  if (raw['tools'] !== undefined) {
    const t = c.object(raw['tools'], 'tools', ['allow', 'mcpServers', 'autoApprove']);
    const allowAll = c.stringArray(t['allow'], 'tools.allow', { unique: true });
    const allow: string[] = [];
    const agents: AgentGrant[] = [];
    allowAll?.forEach((entry, i) => {
      const grant = AGENT_GRANT_PATTERN.exec(entry);
      if (grant) {
        const target = grant[2]!;
        if (target.includes('/') || target.includes('\\')) c.fail(`tools.allow[${i}]`, 'agent grants name a file in the agents folder, without a path');
        const agent = target.replace(/\.json$/i, '');
        if (agents.some((a) => a.agent === agent)) c.fail(`tools.allow[${i}]`, `"${agent}" is granted twice`);
        agents.push({ file: target, agent, max: Number(grant[1]) });
        return;
      }
      if (!BUILTIN_TOOL_IDS.includes(entry)) {
        c.fail(
          `tools.allow[${i}]`,
          `unknown tool "${entry}". Built-in tools: ${BUILTIN_TOOL_IDS.join(', ')}. Other agents are granted as "N-name.json" (N = how many may run at once); MCP tools with tools.mcpServers.`,
        );
      }
      allow.push(entry);
    });
    let mcpServers: Array<string | McpServerGrant> | undefined;
    if (t['mcpServers'] !== undefined) {
      if (!Array.isArray(t['mcpServers'])) c.fail('tools.mcpServers', 'must be an array');
      const seen = new Set<string>();
      mcpServers = (t['mcpServers'] as unknown[]).map((entry, i) => {
        const field = `tools.mcpServers[${i}]`;
        let grant: string | McpServerGrant;
        let server: string;
        if (typeof entry === 'string') {
          server = c.string(entry, field, { nonEmpty: true });
          grant = server;
        } else {
          const o = c.object(entry, field, ['server', 'tools']);
          server = c.string(o['server'], `${field}.server`, { nonEmpty: true });
          const toolList = c.stringArray(o['tools'], `${field}.tools`, { unique: true, nonEmptyItems: true });
          if (toolList !== undefined && toolList.length === 0) {
            c.fail(`${field}.tools`, 'must list at least one tool (omit the field to allow every tool on the server)');
          }
          grant = toolList ? { server, tools: toolList } : { server };
        }
        if (seen.has(server)) c.fail(field, `duplicate MCP server "${server}"`);
        seen.add(server);
        return grant;
      });
    }
    const autoApprove = c.stringArray(t['autoApprove'], 'tools.autoApprove', { unique: true, nonEmptyItems: true });
    autoApprove?.forEach((entry, i) => {
      const field = `tools.autoApprove[${i}]`;
      if (entry.startsWith(MCP_TOOL_PREFIX)) {
        const parts = entry.slice(MCP_TOOL_PREFIX.length).split('__');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          c.fail(field, 'MCP entries must look like "mcp__<server>__<tool>" or "mcp__<server>__*"');
        }
        const serverNames = (mcpServers ?? []).map((g) => (typeof g === 'string' ? g : g.server));
        if (!serverNames.includes(parts[0]!)) {
          c.fail(field, `refers to MCP server "${parts[0]}", which is not in tools.mcpServers`);
        }
      } else if (!BUILTIN_TOOL_IDS.includes(entry)) {
        c.fail(field, `unknown tool "${entry}"`);
      } else if (!(allow ?? []).includes(entry)) {
        c.fail(field, `"${entry}" is not in tools.allow, so it cannot be auto-approved`);
      }
    });
    tools = { allow: allowAll === undefined ? undefined : allow, mcpServers, autoApprove, ...(agents.length ? { agents } : {}) };
  }

  let conversation: AgentDefinition['conversation'];
  if (raw['conversation'] !== undefined) {
    const cv = c.object(raw['conversation'], 'conversation', ['access']);
    if (cv['access'] !== undefined) {
      const a = c.string(cv['access'], 'conversation.access');
      if (!['none', 'read', 'organize'].includes(a)) c.fail('conversation.access', 'must be "none", "read" or "organize"');
      conversation = { access: a as 'none' | 'read' | 'organize' };
    } else {
      conversation = {};
    }
  }

  let artifacts: AgentDefinition['artifacts'];
  if (raw['artifacts'] !== undefined) {
    const av = c.object(raw['artifacts'], 'artifacts', ['access']);
    if (av['access'] !== undefined) {
      const a = c.string(av['access'], 'artifacts.access');
      if (!['none', 'read', 'create'].includes(a)) c.fail('artifacts.access', 'must be "none", "read" or "create"');
      artifacts = { access: a as 'none' | 'read' | 'create' };
    } else {
      artifacts = {};
    }
  }

  let context: AgentDefinition['context'];
  if (raw['context'] !== undefined) {
    const cx = c.object(raw['context'], 'context', ['maxInputTokens', 'recentExchanges']);
    context = {
      maxInputTokens: c.integer(cx['maxInputTokens'], 'context.maxInputTokens', 2000, 10_000_000),
      recentExchanges: c.integer(cx['recentExchanges'], 'context.recentExchanges', 1, 1000),
    };
  }

  let limits: AgentDefinition['limits'];
  if (raw['limits'] !== undefined) {
    const l = c.object(raw['limits'], 'limits', [
      'maxTurns',
      'timeoutSeconds',
      'toolTimeoutSeconds',
      'shellTimeoutSeconds',
      'maxToolOutputChars',
    ]);
    limits = {
      maxTurns: c.integer(l['maxTurns'], 'limits.maxTurns', 1, 500),
      timeoutSeconds: c.integer(l['timeoutSeconds'], 'limits.timeoutSeconds', 1, 24 * 3600),
      toolTimeoutSeconds: c.integer(l['toolTimeoutSeconds'], 'limits.toolTimeoutSeconds', 1, 24 * 3600),
      shellTimeoutSeconds: c.integer(l['shellTimeoutSeconds'], 'limits.shellTimeoutSeconds', 1, 24 * 3600),
      maxToolOutputChars: c.integer(l['maxToolOutputChars'], 'limits.maxToolOutputChars', 1000, 2_000_000),
    };
  }

  return {
    id,
    ...(name ? { name } : {}),
    description,
    provider,
    providers,
    providerOptions,
    model,
    systemPrompt,
    reasoning,
    temperature,
    maxOutputTokens,
    workspace,
    tools,
    conversation,
    artifacts,
    context,
    limits,
  };
}

const ACCESS_RANK = { none: 0, read: 1, organize: 2 } as const;

/** Effective conversation access: explicit, else "organize" in the main conversation (depth 0) and "none" in a thread. */
export function conversationAccess(def: AgentDefinition, depth: number): 'none' | 'read' | 'organize' {
  return def.conversation?.access ?? (depth === 0 ? 'organize' : 'none');
}

export function accessRank(access: 'none' | 'read' | 'organize'): number {
  return ACCESS_RANK[access];
}

const ARTIFACT_RANK = { none: 0, read: 1, create: 2 } as const;

/** Effective artifact access: explicit, else "create" in the main conversation (depth 0) and "none" in a thread. */
export function artifactAccess(def: AgentDefinition, depth: number): 'none' | 'read' | 'create' {
  return def.artifacts?.access ?? (depth === 0 ? 'create' : 'none');
}

export function artifactAccessRank(access: 'none' | 'read' | 'create'): number {
  return ARTIFACT_RANK[access];
}

/** Normalized MCP grant list: server → allowed tool names (undefined = all). */
export function mcpGrants(def: AgentDefinition): Map<string, ReadonlySet<string> | undefined> {
  const grants = new Map<string, ReadonlySet<string> | undefined>();
  for (const g of def.tools?.mcpServers ?? []) {
    if (typeof g === 'string') grants.set(g, undefined);
    else grants.set(g.server, g.tools ? new Set(g.tools) : undefined);
  }
  return grants;
}

/** Built-in tools an agent may call. */
export function builtinAllow(def: AgentDefinition): readonly string[] {
  return def.tools?.allow ?? [];
}

export const FILE_TOOL_IDS: readonly string[] = [
  ToolNames.READ_FILE,
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.GLOB,
  ToolNames.GREP,
  ToolNames.LS,
];
