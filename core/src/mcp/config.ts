/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Named MCP server definitions loaded from `mcp.json`.
 *
 * The server shape is adapted from qwen-code
 * packages/core/src/config/mcp-server-config.ts (command/args/env/cwd for
 * stdio, httpUrl for Streamable HTTP, headers, timeout, trust,
 * includeTools/excludeTools). OAuth, Google credential and service-account
 * auth, legacy SSE (`url`), TCP and extension fields are removed. Environment
 * expansion is adapted from utils/envVarResolver.ts; unlike upstream, an
 * undefined `${VAR}` is an error instead of being sent literally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../agents/definition.js';

export interface McpServerConfig {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable HTTP transport */
  httpUrl?: string;
  headers?: Record<string, string>;
  /** Connection and per-request timeout in milliseconds. */
  timeout?: number;
  /** When true, this server's tools run without confirmation prompts. */
  trust?: boolean;
  description?: string;
  /** Server-wide tool filters applied before any agent grant. */
  includeTools?: string[];
  excludeTools?: string[];
}

export type McpTransportKind = 'stdio' | 'http';

export interface McpConfigFile {
  file: string | undefined;
  servers: Readonly<Record<string, Readonly<McpServerConfig>>>;
  /** Servers left out because their definition is invalid, and why. */
  skipped?: readonly { server: string; error: string }[];
  /** Why the whole file could not be used (bad JSON, not an object); no server is loaded then. */
  error?: string;
}

export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

const SERVER_KEYS = [
  'command',
  'args',
  'env',
  'cwd',
  'httpUrl',
  'headers',
  'timeout',
  'trust',
  'description',
  'includeTools',
  'excludeTools',
];

export function transportKind(cfg: McpServerConfig): McpTransportKind {
  return cfg.httpUrl ? 'http' : 'stdio';
}

function fail(file: string, field: string | undefined, message: string): never {
  throw new ConfigError(file, field, message);
}

function stringRecord(value: unknown, file: string, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, field, 'must be an object of strings');
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') fail(file, `${field}.${k}`, 'must be a string');
  }
  return value as Record<string, string>;
}

function stringList(value: unknown, file: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) fail(file, field, 'must be an array of strings');
  return value as string[];
}

export function parseMcpConfig(raw: unknown, file: string): McpConfigFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(file, undefined, 'must be a JSON object');
  const top = raw as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== 'mcpServers' && key !== '$schema') fail(file, key, 'unknown field. Expected "mcpServers"');
  }
  const serversRaw = top['mcpServers'] ?? {};
  if (typeof serversRaw !== 'object' || serversRaw === null || Array.isArray(serversRaw)) {
    fail(file, 'mcpServers', 'must be an object mapping server names to definitions');
  }
  const baseDir = path.dirname(file);
  const servers: Record<string, McpServerConfig> = {};
  const skipped: { server: string; error: string }[] = [];
  // One invalid server is left out; the others still load.
  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    try {
      servers[name] = parseServer(name, value, file, baseDir);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      skipped.push({ server: name, error: error.message.replace(`${file}: `, '').replace(`${file} `, '') });
    }
  }
  return { file, servers: Object.freeze(servers), ...(skipped.length ? { skipped: Object.freeze(skipped) } : {}) };
}

function parseServer(name: string, value: unknown, file: string, baseDir: string): Readonly<McpServerConfig> {
  const f = `mcpServers.${name}`;
  if (!MCP_SERVER_NAME_PATTERN.test(name) || name.includes('__')) {
    fail(file, f, 'server names must use letters, digits, "-" or "_", start with a letter or digit, be at most 24 characters and must not contain "__"');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, f, 'must be an object');
  const v = value as Record<string, unknown>;
  if (v['url'] !== undefined) {
    fail(file, `${f}.url`, 'legacy SSE servers are not supported; use "httpUrl" for a Streamable HTTP endpoint');
  }
  for (const key of Object.keys(v)) {
    if (!SERVER_KEYS.includes(key)) fail(file, `${f}.${key}`, `unknown field. Allowed fields: ${SERVER_KEYS.join(', ')}`);
  }
  const transports = ['command', 'httpUrl'].filter((k) => v[k] !== undefined);
  if (transports.length !== 1) {
    fail(file, f, 'must define exactly one of "command" (stdio) or "httpUrl" (Streamable HTTP)');
  }
  const cfg: McpServerConfig = {};
  if (v['command'] !== undefined) {
    if (typeof v['command'] !== 'string' || !v['command'].trim()) fail(file, `${f}.command`, 'must be a non-empty string');
    cfg.command = v['command'];
    cfg.args = stringList(v['args'], file, `${f}.args`);
    cfg.env = stringRecord(v['env'], file, `${f}.env`);
    if (v['cwd'] !== undefined) {
      if (typeof v['cwd'] !== 'string') fail(file, `${f}.cwd`, 'must be a string');
      cfg.cwd = path.resolve(baseDir, v['cwd']);
    }
  } else {
    for (const k of ['args', 'env', 'cwd']) {
      if (v[k] !== undefined) fail(file, `${f}.${k}`, 'is only valid for stdio servers ("command")');
    }
    const urlValue = v['httpUrl'];
    if (typeof urlValue !== 'string') fail(file, `${f}.httpUrl`, 'must be a string');
    // ${VAR} placeholders are resolved at connect time; validate the shape otherwise.
    if (!urlValue.includes('${')) {
      try {
        const u = new URL(urlValue);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      } catch {
        fail(file, `${f}.httpUrl`, 'must be an http(s) URL');
      }
    }
    cfg.httpUrl = urlValue;
  }
  cfg.headers = stringRecord(v['headers'], file, `${f}.headers`);
  if (cfg.headers && cfg.command) fail(file, `${f}.headers`, 'is only valid for HTTP servers');
  if (v['timeout'] !== undefined) {
    if (typeof v['timeout'] !== 'number' || !Number.isInteger(v['timeout']) || v['timeout'] < 100 || v['timeout'] > 3_600_000) {
      fail(file, `${f}.timeout`, 'must be an integer number of milliseconds between 100 and 3600000');
    }
    cfg.timeout = v['timeout'];
  }
  if (v['trust'] !== undefined) {
    if (typeof v['trust'] !== 'boolean') fail(file, `${f}.trust`, 'must be true or false');
    cfg.trust = v['trust'];
  }
  if (v['description'] !== undefined) {
    if (typeof v['description'] !== 'string') fail(file, `${f}.description`, 'must be a string');
    cfg.description = v['description'];
  }
  cfg.includeTools = stringList(v['includeTools'], file, `${f}.includeTools`);
  cfg.excludeTools = stringList(v['excludeTools'], file, `${f}.excludeTools`);
  return Object.freeze(cfg);
}

/**
 * Loads `mcp.json`; a missing file yields an empty server set. A file that
 * cannot be used at all yields no servers and says why in `error`, so a
 * broken mcp.json never stops the agents from loading.
 */
export function loadMcpConfig(file: string): McpConfigFile {
  if (!fs.existsSync(file)) return { file: undefined, servers: Object.freeze({}) };
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new ConfigError(file, undefined, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseMcpConfig(raw, file);
  } catch (error) {
    return { file, servers: Object.freeze({}), error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Expands `${VAR}` and `$VAR` from the environment. An undefined `${VAR}`
 * throws so a missing secret is reported instead of sent literally; an
 * undefined bare `$VAR` is left as written (as upstream does).
 */
export function resolveEnvVarsInString(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$(?:(\w+)|{([^}]+)})/g, (match, bare: string | undefined, braced: string | undefined) => {
    const name = (bare ?? braced)!;
    const resolved = env[name];
    if (typeof resolved === 'string') return resolved;
    if (braced !== undefined) {
      throw new Error(`environment variable "${name}" is not set`);
    }
    return match;
  });
}

/** Returns a copy of the server config with environment variables expanded. */
export function resolveServerConfig(cfg: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const mapRecord = (r?: Record<string, string>) =>
    r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, resolveEnvVarsInString(v, env)])) : undefined;
  return {
    ...cfg,
    command: cfg.command !== undefined ? resolveEnvVarsInString(cfg.command, env) : undefined,
    args: cfg.args?.map((a) => resolveEnvVarsInString(a, env)),
    env: mapRecord(cfg.env),
    httpUrl: cfg.httpUrl !== undefined ? resolveEnvVarsInString(cfg.httpUrl, env) : undefined,
    headers: mapRecord(cfg.headers),
  };
}
