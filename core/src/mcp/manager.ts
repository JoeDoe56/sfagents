/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * MCP connections for one SF Agents runtime.
 *
 * Transport creation is adapted from qwen-code
 * packages/core/src/tools/mcp-client.ts `createTransport` (stdio with a
 * sanitized inherited environment, Streamable HTTP via `httpUrl`, legacy SSE
 * via `url`, configured headers) and `isEnabled` (server-level
 * includeTools/excludeTools). OAuth, Google credentials, SDK control
 * transports, prompts, resources and MCP apps are removed. The connection
 * pool (`mcp-client-manager.ts`) is replaced by this small manager:
 * lazy connect with a bounded timeout, cached discovery, reconnect on the
 * next use after a transport closes, and no automatic replay of tool calls.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import fs from 'node:fs';
import {
  resolveServerConfig,
  transportKind,
  type McpConfigFile,
  type McpServerConfig,
  type McpTransportKind,
} from './config.js';
import { sanitizeChildEnv } from '../utils/child-env.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debug.js';

const debugLogger = createDebugLogger('MCP');

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export interface McpToolInfo {
  /** Tool name as the server knows it. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type McpServerStatus = 'not_connected' | 'connecting' | 'connected' | 'error' | 'closed';

export interface McpServerState {
  name: string;
  transport: McpTransportKind;
  status: McpServerStatus;
  tools: McpToolInfo[];
  error?: string;
}

export interface McpCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface Connection {
  client: Client;
  transport: Transport;
  tools: McpToolInfo[];
  closed: boolean;
  onClosed?: () => void;
}

export interface McpManagerOptions {
  /** Extra environment variable names withheld from stdio servers. */
  secretEnvNames?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** True when a server-level includeTools/excludeTools filter keeps the tool. */
export function isToolEnabledByServer(toolName: string, cfg: McpServerConfig): boolean {
  if (cfg.excludeTools?.includes(toolName)) return false;
  return !cfg.includeTools || cfg.includeTools.some((t) => t === toolName || t.startsWith(`${toolName}(`));
}

export class McpManager {
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly errors = new Map<string, string>();
  private readonly stderrTails = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly config: McpConfigFile,
    private readonly options: McpManagerOptions = {},
  ) {}

  serverNames(): string[] {
    return Object.keys(this.config.servers);
  }

  serverConfig(name: string): Readonly<McpServerConfig> | undefined {
    return this.config.servers[name];
  }

  private async createTransport(name: string, raw: McpServerConfig): Promise<Transport> {
    const cfg = resolveServerConfig(raw, this.options.env ?? process.env);
    if (cfg.httpUrl) {
      return new StreamableHTTPClientTransport(new URL(cfg.httpUrl), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
    }
    if (cfg.url) {
      return new SSEClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        eventSourceInit: cfg.headers
          ? {
              fetch: (url, init) =>
                fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...cfg.headers } }),
            }
          : undefined,
      });
    }
    if (cfg.command) {
      if (cfg.cwd && !fs.existsSync(cfg.cwd)) {
        throw new Error(`configured cwd does not exist: ${cfg.cwd}`);
      }
      const inherited = sanitizeChildEnv(this.options.env ?? process.env, this.options.secretEnvNames ?? []);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...inherited, ...(cfg.env ?? {}) })) {
        if (typeof v === 'string') env[k] = v;
      }
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env,
        cwd: cfg.cwd,
        stderr: 'pipe',
      });
      // Drain stderr so a chatty server cannot block; keep a tail for errors.
      transport.stderr?.on('data', (data: Buffer) => {
        const tail = ((this.stderrTails.get(name) ?? '') + data.toString()).slice(-2000);
        this.stderrTails.set(name, tail);
        debugLogger.debug(`MCP STDERR (${name}):`, data.toString().trim());
      });
      return transport;
    }
    throw new Error('missing httpUrl (Streamable HTTP), url (SSE) or command (stdio)');
  }

  private async open(name: string): Promise<Connection> {
    const cfg = this.config.servers[name];
    if (!cfg) throw new Error(`Unknown MCP server "${name}"`);
    const timeoutMs = cfg.timeout ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    const client = new Client({ name: 'sfagents', version: '0.1.0' }, { capabilities: {} });
    let transport: Transport | undefined;
    try {
      transport = await this.createTransport(name, cfg);
      await withTimeout(client.connect(transport, { timeout: timeoutMs }), timeoutMs, `connecting to MCP server "${name}"`);
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
        for (const tool of page.tools) {
          if (!isToolEnabledByServer(tool.name, cfg)) continue;
          tools.push({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            annotations: tool.annotations as Record<string, unknown> | undefined,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      const connection: Connection = { client, transport, tools, closed: false };
      client.onclose = () => {
        connection.closed = true;
        // Next use reconnects; in-flight calls fail and are never replayed.
        connection.onClosed?.();
      };
      this.errors.delete(name);
      return connection;
    } catch (error) {
      await client.close().catch(() => {});
      const tail = this.stderrTails.get(name)?.trim();
      const message = `${getErrorMessage(error)}${tail ? ` (server stderr: ${tail.slice(-500)})` : ''}`;
      this.errors.set(name, message);
      throw new Error(`MCP server "${name}" (${transportKind(cfg)}) failed: ${message}`);
    }
  }

  /** Connects (once) and returns the server's enabled tools. */
  async getTools(name: string): Promise<McpToolInfo[]> {
    return (await this.connection(name)).tools;
  }

  private connection(name: string): Promise<Connection> {
    if (this.disposed) return Promise.reject(new Error('MCP manager has been disposed'));
    let pending = this.connections.get(name);
    if (!pending) {
      const created = this.open(name);
      pending = created;
      this.connections.set(name, created);
      const forget = () => {
        if (this.connections.get(name) === created) this.connections.delete(name);
      };
      created.then((conn) => {
        conn.onClosed = forget;
        if (conn.closed) forget();
      }, forget);
    }
    return pending;
  }

  /**
   * Calls a tool once. Failures are reported to the caller and never retried,
   * because MCP tools may have side effects.
   */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult> {
    const cfg = this.config.servers[server];
    const conn = await this.connection(server);
    if (conn.closed) throw new Error(`MCP server "${server}" connection is closed`);
    const result = await conn.client.callTool({ name: tool, arguments: args }, undefined, {
      signal,
      timeout: cfg?.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    });
    return result as McpCallResult;
  }

  /** Connects to every configured server and reports its status. */
  async statusAll(): Promise<McpServerState[]> {
    return Promise.all(this.serverNames().map((name) => this.status(name)));
  }

  async status(name: string): Promise<McpServerState> {
    const cfg = this.config.servers[name]!;
    try {
      const tools = await this.getTools(name);
      return { name, transport: transportKind(cfg), status: 'connected', tools };
    } catch (error) {
      return { name, transport: transportKind(cfg), status: 'error', tools: [], error: this.errors.get(name) ?? getErrorMessage(error) };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(
      pending.map(async (p) => {
        try {
          const conn = await p;
          await withTimeout(conn.client.close(), 3000, 'closing MCP connection');
        } catch {
          // best effort
        }
      }),
    );
  }
}
