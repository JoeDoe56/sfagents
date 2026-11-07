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
import { MAX_WEB_BATCH, SEARCH_ENGINES, TIME_RANGES, WEB_FORMATS, type SearchEngine, type TimeRange, type WebAccess, type WebFormat, type WebRequest, type WebSearch } from '../web/brightdata.js';
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
  /** False when web access is not set up (no Bright Data key), so the prompt says so. */
  ready?: boolean;
}

export const MAX_WEB_RESULT_BYTES = 1024 * 1024;
export const WEB_REQUEST_TIMEOUT_MS = 90_000;

export const WEB_USAGE = [
  'Usage:',
  '  sfa-web search [options] <query>              search results (JSON: organic link, title, description)',
  '  sfa-web search [options] --each <q1> <q2>...  up to 5 searches at once, each query quoted (JSON array)',
  '    --engine google|bing   default google',
  '    --country <cc>         two-letter country code, e.g. us, de',
  '    --time hour|day|week|month|year   recent results only (bing: day, week, year)',
  '    --page <n>             results page from 0, 10 per page',
  '  sfa-web markdown <url> [url...]   a page as Markdown',
  '  sfa-web html <url> [url...]       a page as raw HTML',
  '  sfa-web text <url> [url...]       a page as plain text (smallest)',
  '  sfa-web ld_json <url> [url...]    a page\'s schema.org data (price, rating, author...)',
  'One page prints as its content; up to 5 pages print as a JSON array of {url, title, format, content} or {url, error}.',
  'Pages are fetched without running JavaScript: if one comes back empty or thin, load it with Playwright (headless Chromium) instead.',
  'Each search and each page counts as one web request.',
].join('\n');

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
  if (name === WEB_COMMAND) return { name, description: 'Web search (Google or Bing) and pages (Markdown, HTML, text or schema.org data), fetched by SF Agents (Bright Data). A command in the shell tool, for agents at network level "on".', usage: WEB_USAGE };
  return { name, description: 'Shows a file, a folder or a web app running in the agent\'s container as an artifact, or changes one. A command in the shell tool.', usage: ARTIFACT_USAGE };
}

export type HostCommandReply = { ok: true; text: string; truncated?: boolean; notes?: string[] } | { ok: false; error: string };

/** The commands this agent has, by name. */
export function availableHostCommands(cmds: HostCommands): string[] {
  return [...(cmds.web && (!cmds.networkLevel || cmds.networkLevel() === 'on') ? [WEB_COMMAND] : []), ...(cmds.artifact ? [ARTIFACT_COMMAND] : []), ...(cmds.mcp ? [MCP_COMMAND] : []), ...(cmds.view ? [VIEW_COMMAND] : []), ...(cmds.git ? [GIT_COMMAND, CI_COMMAND] : []), ...(cmds.ui ? [UI_COMMAND] : [])];
}

type ParsedWeb = { ok: true; req: WebRequest } | { ok: false; error: string };

function parseUrls(args: readonly string[], format: WebFormat): ParsedWeb {
  if (!args.length) return { ok: false, error: WEB_USAGE };
  if (args.length > MAX_WEB_BATCH) return { ok: false, error: `At most ${MAX_WEB_BATCH} pages at once.` };
  for (const arg of args) {
    let url: URL;
    try {
      url = new URL(arg);
    } catch {
      return { ok: false, error: `Not an address: ${arg}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'Only http and https addresses can be fetched.' };
    if (arg.length > 4000) return { ok: false, error: 'Address too long.' };
  }
  return { ok: true, req: { op: 'fetch', format, urls: [...args] } };
}

function parseSearch(args: readonly string[]): ParsedWeb {
  let engine: SearchEngine = 'google';
  let country: string | undefined;
  let timeRange: TimeRange | undefined;
  let page: number | undefined;
  let each = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string | undefined => args[++i];
    if (a === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (a === '--each') each = true;
    else if (a === '--engine') {
      const v = value();
      if (!SEARCH_ENGINES.includes(v as SearchEngine)) return { ok: false, error: `--engine must be ${SEARCH_ENGINES.join(' or ')}.` };
      engine = v as SearchEngine;
    } else if (a === '--country') {
      const v = value();
      if (!v || !/^[a-zA-Z]{2}$/.test(v)) return { ok: false, error: '--country takes a two-letter country code, e.g. us.' };
      country = v.toLowerCase();
    } else if (a === '--time') {
      const v = value();
      if (!TIME_RANGES.includes(v as TimeRange)) return { ok: false, error: `--time must be one of ${TIME_RANGES.join(', ')}.` };
      timeRange = v as TimeRange;
    } else if (a === '--page') {
      const v = Number(value());
      if (!Number.isInteger(v) || v < 0 || v > 100) return { ok: false, error: '--page takes a number from 0.' };
      page = v;
    } else if (a.startsWith('--')) return { ok: false, error: `Unknown option ${a}.\n${WEB_USAGE}` };
    else words.push(a);
  }
  if (engine === 'bing' && timeRange && !['day', 'week', 'year'].includes(timeRange)) return { ok: false, error: 'Bing supports --time day, week or year; use --engine google for hour or month.' };
  const queries = (each ? words : [words.join(' ')]).map((q) => q.trim());
  if (!queries.length || queries.some((q) => !q)) return { ok: false, error: WEB_USAGE };
  if (queries.some((q) => q.length > 2000)) return { ok: false, error: 'Query too long.' };
  if (queries.length > MAX_WEB_BATCH) return { ok: false, error: `At most ${MAX_WEB_BATCH} searches at once.` };
  const searches: WebSearch[] = queries.map((query) => ({ query, engine, ...(country ? { country } : {}), ...(page ? { page } : {}), ...(timeRange ? { timeRange } : {}) }));
  return { ok: true, req: { op: 'search', searches } };
}

/** Reads an sfa-web command line into a request. */
export function parseWebCommand(args: readonly string[]): ParsedWeb {
  const [op, ...rest] = args;
  if (op === 'search') return parseSearch(rest);
  if (WEB_FORMATS.includes(op as WebFormat)) return parseUrls(rest, op as WebFormat);
  return { ok: false, error: WEB_USAGE };
}

async function web(grant: WebGrant, args: readonly string[], signal: AbortSignal): Promise<HostCommandReply> {
  if (args.includes('--help') || args.includes('-h') || !args.length) return args.length ? { ok: true, text: WEB_USAGE } : { ok: false, error: WEB_USAGE };
  const parsed = parseWebCommand(args);
  if (!parsed.ok) return parsed;
  const count = parsed.req.op === 'search' ? parsed.req.searches.length : parsed.req.urls.length;
  if (grant.remaining <= 0) return { ok: false, error: 'This run has used all of its web requests (limits.webRequests in the agent file).' };
  if (grant.remaining < count) return { ok: false, error: `This run has ${grant.remaining} web request${grant.remaining === 1 ? '' : 's'} left (limits.webRequests in the agent file); each search or page is one.` };
  grant.remaining -= count;
  const { text, notes } = await grant.access.request(parsed.req, AbortSignal.any([signal, AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS)]));
  const extra = notes?.length ? { notes } : {};
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_WEB_RESULT_BYTES) return { ok: true, text, ...extra };
  return { ok: true, text: bytes.subarray(0, MAX_WEB_RESULT_BYTES).toString('utf8'), truncated: true, ...extra };
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
