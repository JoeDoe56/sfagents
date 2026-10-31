/**
 * SF Agents' own shell commands: `sf-web` (web access) and `sf-artifact`
 * (artifacts). They run on the host, not in the sandbox: inside a sandboxed
 * shell a small client script hands them to the host channel, and an agent
 * without general shell access runs them directly (see ShellTool's helper
 * mode). Either way the same handler answers, with the agent's own grants.
 */

import { ArtifactError, ARTIFACT_COMMAND, ARTIFACT_USAGE, type ArtifactCommand } from '../conversation/artifacts.js';
import { getErrorMessage } from '../utils/errors.js';
import type { WebGrant } from '../sandbox/host-channel.js';

export const WEB_COMMAND = 'sf-web';
export const HOST_COMMAND_NAMES: readonly string[] = [WEB_COMMAND, ARTIFACT_COMMAND];

export const MAX_WEB_RESULT_BYTES = 1024 * 1024;
export const WEB_REQUEST_TIMEOUT_MS = 90_000;

export const WEB_USAGE = 'Usage:\n  sf-web search <query>   Google results (JSON)\n  sf-web markdown <url>   a page as Markdown\n  sf-web html <url>       a page as HTML';

/** What one agent's commands may use in this run. */
export interface HostCommands {
  /** Web access ("web" in tools.allow), with this run's remaining requests. */
  web?: WebGrant;
  /** Artifacts (artifacts.access "create"). */
  artifact?: ArtifactCommand;
}

export type HostCommandReply = { ok: true; text: string; truncated?: boolean } | { ok: false; error: string };

/** The commands this agent has, by name. */
export function availableHostCommands(cmds: HostCommands): string[] {
  return [...(cmds.web ? [WEB_COMMAND] : []), ...(cmds.artifact ? [ARTIFACT_COMMAND] : [])];
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
  o: { cwd?: string; stdin?: string; callId?: string; signal: AbortSignal },
): Promise<HostCommandReply> {
  const [name, ...args] = argv;
  try {
    if (name === WEB_COMMAND) {
      if (!cmds.web) return { ok: false, error: 'This agent has no web access ("web" in tools.allow).' };
      return await web(cmds.web, args, o.signal);
    }
    if (name === ARTIFACT_COMMAND) {
      if (!cmds.artifact) return { ok: false, error: 'This agent may not create artifacts (artifacts.access).' };
      if (args.includes('-h') || args.includes('--help')) return { ok: true, text: ARTIFACT_USAGE };
      return { ok: true, text: cmds.artifact(args, { cwd: o.cwd, callId: o.callId, stdin: o.stdin }) };
    }
    return { ok: false, error: `Unknown command ${name}.` };
  } catch (error) {
    return { ok: false, error: error instanceof ArtifactError ? error.message : getErrorMessage(error) };
  }
}

/**
 * Splits a command line into words the way a POSIX shell would for simple
 * commands: whitespace separates, single and double quotes group (with
 * backslash escapes inside double quotes, and outside quotes except on
 * Windows, where a backslash separates path parts). Returns
 * undefined when the line uses anything a plain command cannot
 * (pipes, redirection, `;`, `&&`, substitution, variables), or is unbalanced.
 */
export function splitCommandLine(line: string, windows = process.platform === 'win32'): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1]!)) word += line[++j];
        else if (line[j] === '$' || line[j] === '`') return undefined;
        else word += line[j];
      }
      if (j >= line.length) return undefined;
      inWord = true;
      i = j;
    } else if (c === '\\' && !windows && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if ('|&;<>()$`'.includes(c)) {
      return undefined;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}
