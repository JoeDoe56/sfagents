/**
 * SF Agents JSON agent definitions: types and strict field validation.
 *
 * Unknown keys are rejected so a typo ("tool" for "tools") fails at startup
 * instead of silently granting or dropping permissions.
 */

import { BUILTIN_TOOL_IDS, MCP_TOOL_PREFIX, ToolNames } from '../tools/tool-names.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../providers/types.js';

export const SUPPORTED_PROVIDERS = ['openrouter', 'openai-compatible'] as const;
export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export interface McpServerGrant {
  /** Server name from mcp.json. */
  server: string;
  /** Tool names on that server; omitted means every tool the server exposes. */
  tools?: string[];
}

export interface AgentDefinition {
  id: string;
  description?: string;
  provider: ProviderName;
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
  };
  spawn?: {
    maxConcurrentChildren?: number;
    /** Root agent only: maximum depth of the agent tree (root = 0). */
    maxDepth?: number;
    children?: string[];
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

const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'id',
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
  'spawn',
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
export function parseAgentDefinition(raw: unknown, file: string): AgentDefinition {
  const c: FieldChecker = new FieldChecker(file);
  if (!isPlainObject(raw)) c.fail(undefined, 'agent definition must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      c.fail(key, `unknown field. Allowed fields: ${[...TOP_LEVEL_KEYS].filter((k) => k !== '$schema').join(', ')}`);
    }
  }

  const id = c.string(raw['id'], 'id', { nonEmpty: true });
  if (!AGENT_ID_PATTERN.test(id)) {
    c.fail('id', 'must start with a letter and contain only letters, digits, "_" or "-" (max 64 characters)');
  }
  const description = c.optionalString(raw['description'], 'description', { maxLength: 2000 });

  const provider = c.string(raw['provider'], 'provider', { nonEmpty: true });
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    c.fail('provider', `unsupported provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
  let providerOptions: AgentDefinition['providerOptions'];
  if (raw['providerOptions'] !== undefined) {
    if (provider !== 'openai-compatible') {
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
  } else if (provider === 'openai-compatible') {
    c.fail('providerOptions', 'is required for provider "openai-compatible" (baseUrl and apiKeyEnv)');
  }

  const model = c.string(raw['model'], 'model', { nonEmpty: true, maxLength: 200 });
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
    const allow = c.stringArray(t['allow'], 'tools.allow', { unique: true });
    allow?.forEach((name, i) => {
      if (!BUILTIN_TOOL_IDS.includes(name)) {
        c.fail(
          `tools.allow[${i}]`,
          `unknown built-in tool "${name}". Built-in tools: ${BUILTIN_TOOL_IDS.join(', ')}. MCP tools are granted with tools.mcpServers; child agents with spawn.children.`,
        );
      }
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
    tools = { allow, mcpServers, autoApprove };
  }

  let spawn: AgentDefinition['spawn'];
  if (raw['spawn'] !== undefined) {
    const s = c.object(raw['spawn'], 'spawn', ['maxConcurrentChildren', 'maxDepth', 'children']);
    spawn = {
      maxConcurrentChildren: c.integer(s['maxConcurrentChildren'], 'spawn.maxConcurrentChildren', 1, 16),
      maxDepth: c.integer(s['maxDepth'], 'spawn.maxDepth', 0, 16),
      children: c.stringArray(s['children'], 'spawn.children', { unique: true, nonEmptyItems: true }),
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
    description,
    provider: provider as ProviderName,
    providerOptions,
    model,
    systemPrompt,
    reasoning,
    temperature,
    maxOutputTokens,
    workspace,
    tools,
    spawn,
    limits,
  };
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

/** Built-in tools an agent may call, never including the shell for a child. */
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
