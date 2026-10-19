/**
 * sfagents command line.
 *
 *   sfagents start                 interactive conversation with the root agent
 *   sfagents run "<task>"          one request, prints the answer, exits
 *   sfagents agents validate       validate agent JSON and print the tree
 *   sfagents mcp list              connect to configured MCP servers and list tools
 *   sfagents web                   serve the web interface (default http://127.0.0.1:8093)
 */

import readline from 'node:readline';
import { parseArgs } from 'node:util';
import {
  AgentRuntime,
  AgentTerminateMode,
  ConfigError,
  createDefaultProviderFactory,
  describeTree,
  getErrorMessage,
  mcpGrants,
  MissingCredentialError,
  stripAnsiAndControl,
  type AgentTree,
  type ConfirmationHandler,
} from '@sfagents/core';
import { loadConfig, loadEnvFile, locateConfig } from '../config/load.js';
import { EventRenderer } from '../terminal/render.js';
import { createTerminalConfirm } from '../terminal/confirm.js';
import { startRepl } from '../terminal/repl.js';
import { createStyle } from '../terminal/style.js';
import { readStdin } from '../utils/read-stdin.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';
import {
  ConversationSelectionError,
  conversationCommand,
  openConversation,
  selectConversationFile,
  type ConversationFlags,
} from './conversation.js';
import type { ConversationService } from '@sfagents/core';
import { DEFAULT_HOST, DEFAULT_PORT, WebServer } from '@sfagents/web';

export const VERSION = '0.1.0';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CONFIG = 2;
export const EXIT_CANCELLED = 130;

const USAGE = `SF Agents ${VERSION}

Usage:
  sfagents start [options]              Start an interactive conversation with the root agent
  sfagents run [options] "<task>"       Run one request and print the final answer ("-" reads stdin)
  sfagents agents validate [options]    Validate agent definitions and print the agent tree
  sfagents mcp list [options]           Show configured MCP servers, status and tools
  sfagents web [options]                Serve the web interface (default http://127.0.0.1:${DEFAULT_PORT})
  sfagents conversation [info|sections|show <id>|search <words>|artifacts|unlock]
                                        Inspect the stored conversation (or remove a stale lock)

Options:
  -c, --config <dir|file>   Directory containing agent.json, or an agent JSON file (default: .)
      --mcp <file>          MCP server definitions (default: <config dir>/mcp.json)
  -y, --yes                 Approve every tool call that would ask for confirmation
      --show-reasoning      Print model reasoning text when the provider returns it
      --show-context        Print the size and makeup of each turn's working context (estimates)
      --json                (run) Print the structured result as JSON instead of streaming
      --conversation <file> Use this conversation file (default: <config dir>/.sfagents/conversation.md)
      --ephemeral           (start) Keep this session in memory only; nothing is stored
      --persist             (run) Record the request in the persistent conversation
      --port <n>            (web) Port to listen on (default ${DEFAULT_PORT})
      --host <address>      (web) Address to listen on (default ${DEFAULT_HOST}; anything else exposes
                            the agent and its tools to your network)
      --lhm <url|off>       (web) Libre Hardware Monitor's web server for the resource monitor
                            (default http://127.0.0.1:8085; user:password@ for its sign-in)
  -v, --version             Print the version
  -h, --help                Show this help

Environment:
  OPENROUTER_API_KEY        API key for provider "openrouter" (may be set in <config dir>/.env)
  SFAGENTS_LHM_URL          Same as --lhm
  SFAGENTS_DEBUG=1          Debug logging to stderr`;

interface Streams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function printConfigError(error: unknown, streams: Streams): number {
  const style = createStyle(streams.stderr as NodeJS.WriteStream);
  const message = error instanceof ConfigError || error instanceof MissingCredentialError ? error.message : getErrorMessage(error);
  streams.stderr.write(`${style.red('Configuration error:')} ${message}\n`);
  return EXIT_CONFIG;
}

/** Fails early, before any model call, when a provider credential is missing. */
function checkCredentials(tree: AgentTree, env: NodeJS.ProcessEnv): void {
  const factory = createDefaultProviderFactory(env);
  for (const node of tree.byId.values()) factory(node.definition);
}

export async function main(argv: string[], streams: Streams = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        mcp: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        'show-reasoning': { type: 'boolean', default: false },
        'show-context': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        conversation: { type: 'string' },
        ephemeral: { type: 'boolean', default: false },
        persist: { type: 'boolean', default: false },
        page: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        lhm: { type: 'string' },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    streams.stderr.write(`${getErrorMessage(error)}\n\n${USAGE}\n`);
    return EXIT_CONFIG;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    streams.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }
  const [command, sub, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    streams.stdout.write(`${USAGE}\n`);
    return command || values.help ? EXIT_OK : EXIT_CONFIG;
  }

  const location = locateConfig(values.config, values.mcp);
  loadEnvFile(location.configDir);
  let tree: AgentTree;
  try {
    tree = loadConfig(location);
  } catch (error) {
    return printConfigError(error, streams);
  }

  switch (command) {
    case 'agents': {
      if (sub !== 'validate') {
        streams.stderr.write(`Unknown command "agents ${sub ?? ''}". Did you mean "agents validate"?\n`);
        return EXIT_CONFIG;
      }
      const style = createStyle(streams.stdout as NodeJS.WriteStream);
      streams.stdout.write(`${describeTree(tree)}\n\n${style.green('✓')} ${tree.byId.size} agent definition${tree.byId.size === 1 ? '' : 's'} valid (config: ${tree.configDir})\n`);
      try {
        checkCredentials(tree, process.env);
      } catch (error) {
        streams.stdout.write(`${style.yellow('note:')} ${getErrorMessage(error)}\n`);
      }
      return EXIT_OK;
    }
    case 'mcp': {
      if (sub !== 'list') {
        streams.stderr.write(`Unknown command "mcp ${sub ?? ''}". Did you mean "mcp list"?\n`);
        return EXIT_CONFIG;
      }
      return listMcp(tree, streams);
    }
    case 'conversation':
      return conversationCommand(sub, rest, tree, values, streams);
    case 'run': {
      const taskWords = [sub, ...rest].filter((w): w is string => w !== undefined);
      let task = taskWords.join(' ');
      if (task === '-' || (task === '' && !process.stdin.isTTY)) task = await readStdin();
      if (!task.trim()) {
        streams.stderr.write('Usage: sfagents run "<task>"\n');
        return EXIT_CONFIG;
      }
      try {
        checkCredentials(tree, process.env);
      } catch (error) {
        return printConfigError(error, streams);
      }
      const conv = openSelected('run', values, tree, streams);
      if (conv instanceof Error) return EXIT_CONFIG;
      return runOnce(tree, task, { yes: values.yes, json: values.json, showReasoning: values['show-reasoning'], showContext: values['show-context'], conversation: conv }, streams);
    }
    case 'start': {
      if (sub !== undefined) {
        streams.stderr.write('"sfagents start" takes no arguments. Use "sfagents run <task>" for a single request.\n');
        return EXIT_CONFIG;
      }
      try {
        checkCredentials(tree, process.env);
      } catch (error) {
        return printConfigError(error, streams);
      }
      const conversation = openSelected('start', values, tree, streams);
      if (conversation instanceof Error) return EXIT_CONFIG;
      let bound: ConfirmationHandler | undefined;
      const runtime = new AgentRuntime({
        tree,
        approveAll: values.yes,
        confirm: (request, signal) => (bound ? bound(request, signal) : Promise.resolve('deny')),
        conversation,
      });
      registerCleanup(() => runtime.dispose());
      if (conversation) registerCleanup(() => conversation.close());
      try {
        return await startRepl({
          runtime,
          showReasoning: values['show-reasoning'],
          showContext: values['show-context'],
          notices: conversation ? conversation.notices.map((n) => n.message) : ['Ephemeral session: nothing is stored.'],
          bindConfirm: (handler) => {
            bound = handler;
          },
        });
      } finally {
        await runExitCleanup();
      }
    }
    case 'web': {
      if (sub !== undefined) {
        streams.stderr.write('"sfagents web" takes no arguments.\n');
        return EXIT_CONFIG;
      }
      if (values.ephemeral) {
        streams.stderr.write('The web interface always uses a persistent conversation; --ephemeral is not available.\n');
        return EXIT_CONFIG;
      }
      const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        streams.stderr.write(`--port must be a number from 0 to 65535, got "${values.port}".\n`);
        return EXIT_CONFIG;
      }
      const lhmSetting = values.lhm ?? process.env.SFAGENTS_LHM_URL;
      let lhmUrl: string | null | undefined;
      if (lhmSetting !== undefined && lhmSetting !== '') {
        if (lhmSetting === 'off') lhmUrl = null;
        else {
          let parsed: URL | undefined;
          try {
            parsed = new URL(lhmSetting);
          } catch {
            parsed = undefined;
          }
          if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
            streams.stderr.write(`--lhm must be an http:// address or "off", got "${lhmSetting}".\n`);
            return EXIT_CONFIG;
          }
          lhmUrl = parsed.href;
        }
      }
      try {
        checkCredentials(tree, process.env);
      } catch (error) {
        return printConfigError(error, streams);
      }
      const conversation = openSelected('start', values, tree, streams);
      if (conversation instanceof Error || !conversation) return EXIT_CONFIG;
      return serveWeb(tree, conversation, { port, host: values.host ?? DEFAULT_HOST, yes: values.yes, lhmUrl }, streams);
    }
    default:
      streams.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
      return EXIT_CONFIG;
  }
}

/** Opens the conversation a command should use; prints and returns an Error on failure. */
function openSelected(mode: 'start' | 'run', flags: ConversationFlags, tree: AgentTree, streams: Streams): ConversationService | undefined | Error {
  let file: string | undefined;
  try {
    file = selectConversationFile(mode, flags, tree.configDir);
  } catch (error) {
    if (error instanceof ConversationSelectionError) {
      streams.stderr.write(`${error.message}\n`);
      return error;
    }
    throw error;
  }
  if (!file) return undefined;
  const opened = openConversation(file, tree);
  if (opened instanceof Error) {
    const style = createStyle(streams.stderr as NodeJS.WriteStream);
    streams.stderr.write(`${style.red('Conversation error:')} ${opened.message}\n`);
  }
  return opened;
}

async function runOnce(
  tree: AgentTree,
  task: string,
  opts: { yes: boolean; json: boolean; showReasoning: boolean; showContext?: boolean; conversation?: ConversationService },
  streams: Streams,
): Promise<number> {
  const interactive = process.stdin.isTTY === true && (streams.stderr as NodeJS.WriteStream).isTTY === true;
  const rl = interactive && !opts.yes ? readline.createInterface({ input: process.stdin, output: streams.stderr, terminal: true }) : undefined;
  const renderer = new EventRenderer({
    out: opts.json ? (new NullStream() as unknown as NodeJS.WritableStream) : streams.stdout,
    activity: streams.stderr,
    showReasoning: opts.showReasoning,
    showContext: opts.showContext,
  });
  const runtime = new AgentRuntime({
    tree,
    approveAll: opts.yes,
    confirm: rl ? createTerminalConfirm(rl, streams.stderr, renderer) : undefined,
    conversation: opts.conversation,
  });
  registerCleanup(() => runtime.dispose());
  if (opts.conversation) {
    const conversation = opts.conversation;
    registerCleanup(() => conversation.close());
    for (const n of conversation.notices) if (n.kind !== 'resumed' && n.kind !== 'created') streams.stderr.write(`${n.message}\n`);
  }
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts > 1) process.exit(EXIT_CANCELLED);
    streams.stderr.write('\nCancelling… (Ctrl+C again to force quit)\n');
    controller.abort(new Error('cancelled by user'));
  };
  process.on('SIGINT', onSigint);
  rl?.on('SIGINT', onSigint);
  try {
    const result = await runtime.createSession().run(task, { signal: controller.signal, onEvent: (e) => renderer.handle(e) });
    renderer.breakLine();
    if (opts.json) {
      streams.stdout.write(`${JSON.stringify({ ...result, text: stripAnsiAndControl(result.text) }, null, 2)}\n`);
    } else if (result.status !== AgentTerminateMode.GOAL || result.error) {
      const style = createStyle(streams.stderr as NodeJS.WriteStream);
      streams.stderr.write(`${result.status === AgentTerminateMode.GOAL ? style.yellow('[note]') : style.red(`[${result.status.toLowerCase()}]`)} ${result.error ?? ''}\n`);
    }
    if (result.status === AgentTerminateMode.GOAL) return EXIT_OK;
    if (result.status === AgentTerminateMode.CANCELLED) return EXIT_CANCELLED;
    return EXIT_FAILURE;
  } catch (error) {
    renderer.breakLine();
    streams.stderr.write(`error: ${getErrorMessage(error)}\n`);
    return EXIT_FAILURE;
  } finally {
    process.off('SIGINT', onSigint);
    rl?.close();
    await runExitCleanup();
  }
}

async function serveWeb(
  tree: AgentTree,
  conversation: ConversationService,
  opts: { port: number; host: string; yes: boolean; lhmUrl?: string | null },
  streams: Streams,
): Promise<number> {
  const style = createStyle(streams.stderr as NodeJS.WriteStream);
  const server = new WebServer({
    tree,
    conversation,
    port: opts.port,
    host: opts.host,
    approveAll: opts.yes,
    lhmUrl: opts.lhmUrl,
    log: (line) => streams.stderr.write(`${line}\n`),
  });
  // Cleanups run in reverse: stop the server (and any run) before closing the conversation.
  registerCleanup(() => conversation.close());
  registerCleanup(() => server.close());
  let url: string;
  try {
    url = await server.start();
  } catch (error) {
    streams.stderr.write(`${style.red('Could not start the web interface:')} ${getErrorMessage(error)}\n`);
    await runExitCleanup();
    return EXIT_FAILURE;
  }
  for (const n of conversation.notices) streams.stderr.write(`${n.message}\n`);
  streams.stdout.write(`SF Agents web interface: ${url}\n`);
  if (opts.host !== DEFAULT_HOST && opts.host !== 'localhost' && opts.host !== '::1') {
    streams.stderr.write(
      `${style.yellow('warning:')} listening on ${opts.host}. Anyone who can reach this address can talk to the agent and run its tools with your permissions.\n`,
    );
  }
  if (opts.yes) streams.stderr.write(`${style.yellow('note:')} --yes: tool calls that would ask for approval run without asking.\n`);
  streams.stderr.write(style.dim('Press Ctrl+C to stop.\n'));
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  streams.stderr.write('\nStopping…\n');
  await runExitCleanup();
  return EXIT_OK;
}

async function listMcp(tree: AgentTree, streams: Streams): Promise<number> {
  const style = createStyle(streams.stdout as NodeJS.WriteStream);
  const names = Object.keys(tree.mcp.servers);
  if (names.length === 0) {
    streams.stdout.write(`No MCP servers configured${tree.mcp.file ? ` in ${tree.mcp.file}` : ' (no mcp.json found)'}.\n`);
    return EXIT_OK;
  }
  const runtime = new AgentRuntime({ tree, providerFactory: () => {
    throw new Error('not used');
  } });
  registerCleanup(() => runtime.dispose());
  try {
    const states = await runtime.mcp.statusAll();
    let failures = 0;
    for (const state of states) {
      const grantedTo = [...tree.byId.values()]
        .filter((n) => mcpGrants(n.definition).has(state.name))
        .map((n) => n.id);
      const cfg = tree.mcp.servers[state.name]!;
      const status =
        state.status === 'connected' ? style.green(`connected, ${state.tools.length} tool${state.tools.length === 1 ? '' : 's'}`) : style.red('error');
      streams.stdout.write(`${style.bold(state.name)}  ${style.dim(`[${state.transport}${cfg.trust ? ', trusted' : ''}]`)}  ${status}\n`);
      if (state.error) {
        failures++;
        streams.stdout.write(`  ${style.red(stripAnsiAndControl(state.error))}\n`);
      }
      if (state.tools.length) streams.stdout.write(`  tools: ${state.tools.map((t) => t.name).join(', ')}\n`);
      streams.stdout.write(`  granted to: ${grantedTo.length ? grantedTo.join(', ') : style.dim('(no agent)')}\n`);
    }
    return failures > 0 ? EXIT_FAILURE : EXIT_OK;
  } finally {
    await runExitCleanup();
  }
}

class NullStream {
  write(): boolean {
    return true;
  }
}
