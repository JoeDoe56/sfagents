/**
 * `sfa-mcp`: an agent's MCP servers, as a command in its shell instead of
 * tools in every request. It runs in SF Agents (the servers do too); the
 * container only has the client. Calls that need approval ask the person the
 * same way MCP tools did (autoApprove, a trusted server, "allow always" and
 * --yes still skip the prompt).
 */

import type { ConfirmationHandler } from '../runtime/events.js';
import type { McpManager } from './manager.js';
import { mcpApprovalKey, transformMcpResult } from './mcp-tool.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

export const MCP_COMMAND = 'sfa-mcp';

export const MCP_USAGE = [
  'Usage:',
  '  sfa-mcp list                         your MCP servers and their tools',
  '  sfa-mcp list <server>                the server\'s tools with descriptions and input schemas',
  '  sfa-mcp call <server> <tool> [json]  calls a tool; the arguments are a JSON object',
  '  sfa-mcp call <server> <tool> --stdin reads the JSON arguments from stdin (for long input)',
].join('\n');

/** One MCP server an agent may use in this run. */
export interface McpServerGrant {
  /** Tools the agent may call (undefined = all the server has). */
  tools?: ReadonlySet<string>;
  /** mcp.json `trust: true`: calls never ask. */
  trusted: boolean;
}

/** An agent's MCP access for one run. */
export interface McpGrant {
  manager: McpManager;
  servers: ReadonlyMap<string, McpServerGrant>;
  /**
   * Whether a call may run: "allow" when it needs no approval or the person
   * allowed it, "deny" when they refused, "no-prompt" when nobody can be
   * asked (a non-interactive run).
   */
  approve(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<'allow' | 'deny' | 'no-prompt'>;
}

export type McpReply = { ok: true; text: string } | { ok: false; error: string };

/** Approval for MCP calls from a shell: the same rules MCP tools had. */
export interface McpApprovalContext {
  agentPath: readonly string[];
  autoApprove: readonly string[];
  sessionApprovals: Set<string>;
  approveAll: boolean;
  confirm?: ConfirmationHandler;
}

/** Builds `approve` for a grant. Without a way to ask (a non-interactive run) unapproved calls are refused. */
export function mcpApprover(servers: ReadonlyMap<string, McpServerGrant>, a: McpApprovalContext): McpGrant['approve'] {
  return async (server, tool, args, signal) => {
    const key = mcpApprovalKey(server, tool);
    if (a.approveAll || servers.get(server)?.trusted) return 'allow';
    if (a.sessionApprovals.has(key) || a.autoApprove.includes(key) || a.autoApprove.includes(`mcp__${server}__*`)) return 'allow';
    if (!a.confirm) return 'no-prompt';
    const decision = await a.confirm(
      {
        agentPath: a.agentPath,
        toolName: key,
        details: { type: 'mcp', title: `Confirm MCP tool: ${tool} (server ${server})`, serverName: server, toolName: tool, toolDisplayName: key, args },
      },
      signal,
    );
    if (decision === 'allow_always') a.sessionApprovals.add(key);
    return decision === 'deny' ? 'deny' : 'allow';
  };
}

async function toolsOf(grant: McpGrant, server: string) {
  const all = await grant.manager.getTools(server);
  const allowed = grant.servers.get(server)?.tools;
  return allowed ? all.filter((t) => allowed.has(t.name)) : all;
}

function firstLine(text: string): string {
  const line = (text || '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

async function list(grant: McpGrant, server?: string): Promise<McpReply> {
  if (!grant.servers.size) return { ok: false, error: 'This agent has no MCP servers (tools.mcpServers in its agent file).' };
  if (server) {
    if (!grant.servers.has(server)) return { ok: false, error: `No MCP server "${server}" for this agent. Yours: ${[...grant.servers.keys()].join(', ')}.` };
    const tools = await toolsOf(grant, server);
    if (!tools.length) return { ok: true, text: `${server} has no tools for this agent.` };
    const blocks = tools.map((t) => `## ${t.name}\n${t.description || '(no description)'}\nInput: ${JSON.stringify(t.inputSchema)}`);
    return { ok: true, text: blocks.join('\n\n') };
  }
  const out: string[] = [];
  for (const name of grant.servers.keys()) {
    try {
      const tools = await toolsOf(grant, name);
      out.push(`${name} (${tools.length} tool${tools.length === 1 ? '' : 's'})`);
      for (const t of tools) out.push(`  ${t.name}${firstLine(t.description) ? ` - ${firstLine(t.description)}` : ''}`);
    } catch (error) {
      out.push(`${name}: unavailable (${getErrorMessage(error)})`);
    }
  }
  out.push('', 'Details and input schemas: sfa-mcp list <server>');
  return { ok: true, text: out.join('\n') };
}

async function call(grant: McpGrant, args: readonly string[], stdin: string | undefined, signal: AbortSignal): Promise<McpReply> {
  const [server, tool, ...rest] = args;
  if (!server || !tool) return { ok: false, error: MCP_USAGE };
  if (!grant.servers.has(server)) return { ok: false, error: `No MCP server "${server}" for this agent. Yours: ${[...grant.servers.keys()].join(', ') || 'none'}.` };
  const fromStdin = rest.includes('--stdin');
  const raw = fromStdin ? (stdin ?? '') : rest.join(' ');
  let params: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      params = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      return { ok: false, error: `The arguments are not valid JSON (${getErrorMessage(error)}). Quote them for the shell, e.g. sfa-mcp call ${server} ${tool} '{"key":"value"}', or pipe them with --stdin.` };
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'The arguments must be a JSON object.' };
  }
  const tools = await toolsOf(grant, server);
  if (!tools.some((t) => t.name === tool)) {
    return { ok: false, error: `${server} has no tool "${tool}" for this agent. Its tools: ${tools.map((t) => t.name).join(', ') || 'none'}.` };
  }
  const approval = await grant.approve(server, tool, params, signal);
  if (approval === 'deny') return { ok: false, error: `The person did not allow ${server} ${tool}. Do not retry the same call; continue without it or ask them how to proceed.` };
  if (approval === 'no-prompt') {
    return { ok: false, error: `${server} ${tool} needs approval, and no approval is possible in this non-interactive run. Do not retry; continue without it. (The person can add it to tools.autoApprove or pass --yes.)` };
  }
  try {
    const result = await grant.manager.callTool(server, tool, params, signal);
    const text = transformMcpResult(tool, result);
    if (result.isError) return { ok: false, error: `${tool} reported an error: ${text}` };
    return { ok: true, text: text || '(empty result)' };
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return { ok: false, error: `${tool} was cancelled.` };
    return { ok: false, error: `${tool} on ${server} failed: ${getErrorMessage(error)}` };
  }
}

/** Runs `sfa-mcp <args>` for one agent. */
export async function runMcpCommand(grant: McpGrant | undefined, args: readonly string[], o: { stdin?: string; signal: AbortSignal }): Promise<McpReply> {
  const [op, ...rest] = args;
  if (!op || op === '-h' || op === '--help' || op === 'help') return { ok: true, text: MCP_USAGE };
  if (!grant) return { ok: false, error: 'This agent has no MCP servers (tools.mcpServers in its agent file).' };
  if (op === 'list') return list(grant, rest[0]);
  if (op === 'call') return call(grant, rest, o.stdin, o.signal);
  return { ok: false, error: MCP_USAGE };
}
