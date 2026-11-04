import type { NetworkLevel } from '../container/network.js';
import { UI_COMMAND, UI_USAGE, runUiCommand, type UiGrant } from '../ui/ui.js';
/**
 * SF Agents' own shell commands: `sfa-web` (web access), `sfa-artifact`
 * (artifacts) and `sfa-mcp` (MCP servers). They run in SF Agents, not in
 * the agent's container: a small client in the container sends each call over the agent's proxy socket
 * (see ../container), and this handler answers with the agent's own grants.
 */

import { ArtifactError, ARTIFACT_COMMAND, ARTIFACT_USAGE, type ArtifactCommand, type ArtifactContainer } from '../conversation/artifacts.js';
import { getErrorMessage } from '../utils/errors.js';
import type { WebAccess } from '../web/brightdata.js';
import { MCP_COMMAND, MCP_USAGE, runMcpCommand, type McpGrant } from '../mcp/sfa-mcp.js';
import { runViewCommand, VIEW_COMMAND, VIEW_USAGE, type ViewGrant } from './sfa-view.js';
import type { ToolImage } from './tools.js';
import { CI_COMMAND, CI_USAGE, GIT_COMMAND, GIT_USAGE, runCiCommand, runGitCommand, type GitGrant } from '../git/sfa-git.js';

export const WEB_COMMAND = 'sfa-web';
export const HOST_COMMAND_NAMES: readonly string[] = [WEB_COMMAND, ARTIFACT_COMMAND, MCP_COMMAND, VIEW_COMMAND, GIT_COMMAND, CI_COMMAND, UI_COMMAND];

/** Web requests an agent may make per run, unless limits.webRequests says otherwise. */
export const DEFAULT_WEB_REQUESTS = 25;

/** An agent's web access for one run: shared by its commands, so the quota is per run. */
export interface WebGrant {
  access: WebAccess;
  remaining: number;
}

export const MAX_WEB_RESULT_BYTES = 1024 * 1024;
export const WEB_REQUEST_TIMEOUT_MS = 90_000;

export const WEB_USAGE = 'Usage:\n  sfa-web search <query>   Google results (JSON)\n  sfa-web markdown <url>   a page as Markdown\n  sfa-web html <url>       a page as HTML';

/** What one agent's commands may use in this run. */
export interface HostCommands {
  networkLevel?: () => NetworkLevel;
  /** Web access (network level "on"), with this run's remaining requests. */
  web?: WebGrant;
  /** Artifacts (artifacts.access "create"). */
  artifact?: ArtifactCommand;
  /** MCP servers (tools.mcpServers). */
  mcp?: McpGrant;
  /** sfa-view (every agent has it; the script runs in the container). */
  view?: ViewGrant;
  /** sfa-git and sfa-ci (Git workspaces). */
  git?: GitGrant;
  ui?: UiGrant;
}

/** How a command is described where tools are listed (the agent sheet): what it does, and its usage. */
export function hostCommandSchema(name: string): { name: string; description: string; usage: string } {
  if (name === UI_COMMAND) return { name, description: 'Drives apps in the agent container, or host apps during an approved full-control session. Uses accessibility patterns and StartLux 4B Instant.', usage: UI_USAGE };
  if (name === GIT_COMMAND) return { name, description: 'Git workspaces: clone, task worktrees, update from main, squash, push (no force), undo a run. A command in the shell tool.', usage: GIT_USAGE };
  if (name === CI_COMMAND) return { name, description: 'Pushes the task and reports its GitHub Actions results and artifacts (public repositories). A command in the shell tool.', usage: CI_USAGE };
  if (name === VIEW_COMMAND) return { name, description: 'Shows images, video (contact sheets, frames, crops), image diffs and PDF pages to the model, and transcribes speech. A command in the shell tool.', usage: VIEW_USAGE };
  if (name === MCP_COMMAND) return { name, description: 'The agent\'s MCP servers: lists their tools and calls them. A command in the shell tool.', usage: MCP_USAGE };
  if (name === WEB_COMMAND) return { name, description: 'Web search and pages, fetched by SF Agents (Bright Data). A command in the shell tool, for agents at network level "on".', usage: WEB_USAGE };
  return { name, description: 'Shows a file, a folder or a web app running in the agent\'s container as an artifact, or changes one. A command in the shell tool.', usage: ARTIFACT_USAGE };
}

export type HostCommandReply = { ok: true; text: string; truncated?: boolean } | { ok: false; error: string };

/** The commands this agent has, by name. */
export function availableHostCommands(cmds: HostCommands): string[] {
  return [...(cmds.web && (!cmds.networkLevel || cmds.networkLevel() === 'on') ? [WEB_COMMAND] : []), ...(cmds.artifact ? [ARTIFACT_COMMAND] : []), ...(cmds.mcp ? [MCP_COMMAND] : []), ...(cmds.view ? [VIEW_COMMAND] : []), ...(cmds.git ? [GIT_COMMAND, CI_COMMAND] : []), ...(cmds.ui ? [UI_COMMAND] : [])];
}

async function web(grant: WebGrant, args: readonly string[], signal: AbortSignal): Promise<HostCommandReply> {
  const [op, ...rest] = args;
  if ((op !== 'search' && op !== 'markdown' && op !== 'html') || !rest.length) return { ok: false, error: WEB_USAGE };
  const arg = rest.join(' ').trim();
  if (!arg || arg.length > 4000) return { ok: false, error: 'Missing or too long argument.' };
  if (op !== 'search') {
    let url: URL;
    try {
      url = new URL(arg);
    } catch {
      return { ok: false, error: `Not an address: ${arg}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'Only http and https addresses can be fetched.' };
  }
  if (grant.remaining <= 0) return { ok: false, error: 'This run has used all of its web requests (limits.webRequests in the agent file).' };
  grant.remaining--;
  const text = await grant.access.request(op, arg, AbortSignal.any([signal, AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS)]));
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_WEB_RESULT_BYTES) return { ok: true, text };
  return { ok: true, text: bytes.subarray(0, MAX_WEB_RESULT_BYTES).toString('utf8'), truncated: true };
}

/**
 * Runs one command (`argv[0]` is its name). `callId` is the shell call it
 * belongs to (an artifact's provenance); `cwd` resolves relative paths.
 */
export async function runHostCommand(
  argv: readonly string[],
  cmds: HostCommands,
  o: { cwd?: string; stdin?: string; callId?: string; signal: AbortSignal; container?: ArtifactContainer; images?: ToolImage[]; containerCwd?: string },
): Promise<HostCommandReply> {
  const [name, ...args] = argv;
  try {
    if (name === UI_COMMAND) return await runUiCommand(cmds.ui, args, { signal: o.signal, ...(o.images ? { images: o.images } : {}) });
    if (name === WEB_COMMAND) {
      if (cmds.networkLevel && cmds.networkLevel() !== 'on') return { ok: false, error: 'This agent needs network level on for sfa-web.' };
      if (!cmds.web) return { ok: false, error: 'This agent has no web access (it needs network level "on").' };
      return await web(cmds.web, args, o.signal);
    }
    if (name === ARTIFACT_COMMAND) {
      if (!cmds.artifact) return { ok: false, error: 'This agent may not create artifacts (artifacts.access).' };
      if (args.includes('-h') || args.includes('--help')) return { ok: true, text: ARTIFACT_USAGE };
      return { ok: true, text: cmds.artifact(args, { cwd: o.cwd, callId: o.callId, stdin: o.stdin, ...(o.container ? { container: o.container } : {}) }) };
    }
    if (name === VIEW_COMMAND) {
      if (!cmds.view) return { ok: false, error: 'This agent cannot show images.' };
      return await runViewCommand(cmds.view, args, { ...(o.stdin !== undefined ? { stdin: o.stdin } : {}), ...(o.images ? { images: o.images } : {}), signal: o.signal });
    }
    if (name === GIT_COMMAND) return await runGitCommand(cmds.git, args, { ...(o.containerCwd ? { cwd: o.containerCwd } : {}) });
    if (name === CI_COMMAND) return await runCiCommand(cmds.git, args, { ...(o.containerCwd ? { cwd: o.containerCwd } : {}), signal: o.signal });
    if (name === MCP_COMMAND) return await runMcpCommand(cmds.mcp, args, { ...(o.stdin !== undefined ? { stdin: o.stdin } : {}), signal: o.signal });
    return { ok: false, error: `Unknown command ${name}.` };
  } catch (error) {
    return { ok: false, error: error instanceof ArtifactError ? error.message : getErrorMessage(error) };
  }
}
