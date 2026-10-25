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
  AccountState,
  AgentRuntime,
  AgentTerminateMode,
  AppSettings,
  checkProviders,
  ConfigError,
  createDefaultProviderFactory,
  ProviderRegistry,
  UnknownProviderError,
  watchProject,
  type ProviderFactory,
  describeTree,
  ensureProject,
  getErrorMessage,
  KeyringUnavailableError,
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
import { DEFAULT_HOST, DEFAULT_PORT, ScreenMirror, WebAuth, WebServer, acquirePrivileges, parsePublicOrigin } from '@sfagents/web';
import { providersCommand, settingsCommand } from './providers.js';

export const VERSION = '0.1.0';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CONFIG = 2;
export const EXIT_CANCELLED = 130;

const USAGE = `SF Agents ${VERSION}

Usage:
  sfagents start [options]              Start an interactive conversation (with --agent, or "main")
  sfagents run [options] "<task>"       Run one request and print the final answer ("-" reads stdin)
  sfagents agents validate [options]    Check the agents folder: every agent, its tools, and skipped files
  sfagents mcp list [options]           Show configured MCP servers, status and tools
  sfagents web [options]                Serve the web interface (default http://127.0.0.1:${DEFAULT_PORT})
  sfagents providers [list|add <openrouter|openai|anthropic|custom>|rename|remove|web-key [remove]]
                                        Model providers: API keys and ChatGPT/Claude sign-ins (kept in
                                        the system keyring); agent files name them in "provider"
  sfagents settings [list|set <key> <value>|reset <key>]
                                        App settings (web port and address, sensors, terminal output)
  sfagents conversation [info|sections|show <id>|search <words>|artifacts|unlock]
                                        Inspect the stored conversation (or remove a stale lock)

Options:
  -c, --config <dir|file>   Project directory (holding the agents folder), or one agent file in it (default: .)
  -a, --agent <name>        The agent that replies (a file in agents/, without ".json"; default: main)
      --mcp <file>          MCP server definitions (default: <config dir>/mcp.json)
  -y, --yes                 Approve every tool call that would ask for confirmation
      --show-reasoning      Print model reasoning text when the provider returns it
      --show-context        Print the size and makeup of each turn's working context (estimates)
      --json                (run) Print the structured result as JSON instead of streaming
      --conversation <file> Use this conversation file (default: <config dir>/.sfagents/conversation.md)
      --ephemeral           (start) Keep this session in memory only; nothing is stored
      --persist             (run) Record the request in the persistent conversation
      --name <name>         (providers add) The new provider's name
      --url <url>           (providers add custom) The endpoint's base URL
      --new-token           (web) Replace the access token for signing in (signs every device out)
      --port <n>            (web) Port to listen on (default: the web.port setting, ${DEFAULT_PORT})
      --public-origin <url> (web) Accept this exact external origin behind a reverse proxy
      --host <address>      (web) Address to listen on (default ${DEFAULT_HOST}; anything else exposes
                            the agent and its tools to your network)
  -v, --version             Print the version
  -h, --help                Show this help

Environment:
  OPENROUTER_API_KEY        API key for provider "openrouter" (may be set in <config dir>/.env)
  SFAGENTS_HOME             Folder for settings.json and providers.json (default: the per-user app folder)
  SFAGENTS_DEBUG=1          Debug logging to stderr`;

interface Streams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function printConfigError(error: unknown, streams: Streams): number {
  const style = createStyle(streams.stderr as NodeJS.WriteStream);
  const message = error instanceof ConfigError || error instanceof MissingCredentialError || error instanceof UnknownProviderError ? error.message : getErrorMessage(error);
  streams.stderr.write(`${style.red('Configuration error:')} ${message}\n`);
  return EXIT_CONFIG;
}

/** The providers added in Settings, and which account each agent is on (shared by every run in this process). */
let providerContext: { registry: ProviderRegistry; accounts: AccountState; factory: ProviderFactory } | null = null;
function providers(env: NodeJS.ProcessEnv = process.env) {
  if (!providerContext) {
    const registry = new ProviderRegistry();
    const accounts = new AccountState();
    providerContext = { registry, accounts, factory: createDefaultProviderFactory({ env, registry, accounts }) };
  }
  return providerContext;
}

/** Fails early, before any model call, when the replying agent has no usable provider. */
function checkCredentials(tree: AgentTree, env: NodeJS.ProcessEnv): void {
  const problems = checkProviders(tree.root.definition, providers(env).registry, env);
  if (problems.length) throw new ConfigError(tree.root.file, 'provider', problems[0]!.replace(/^Agent "[^"]+" (uses|has) /, '$1 '));
}

export async function main(argv: string[], streams: Streams = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        agent: { type: 'string', short: 'a' },
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
        'public-origin': { type: 'string' },
        host: { type: 'string' },
        'new-token': { type: 'boolean', default: false },
        name: { type: 'string' },
        url: { type: 'string' },
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
  // Provider and settings commands don't need a project.
  if (command === 'providers') return providersCommand(positionals.slice(1), streams, { name: values.name, url: values.url });
  if (command === 'settings') return settingsCommand(positionals.slice(1), streams);
  const appSettings = new AppSettings();
  let stored: ReturnType<AppSettings['stored']> = {};
  try {
    stored = appSettings.stored();
  } catch (error) {
    streams.stderr.write(`warning: ${getErrorMessage(error)}\n`);
  }
  const setting = <T,>(key: string, fallback: T): T => (key in stored ? (stored[key] as unknown as T) : fallback);
  const showReasoning = values['show-reasoning'] || setting('cli.showReasoning', false);
  const showContext = values['show-context'] || setting('cli.showContext', false);

  let location;
  let tree: AgentTree;
  try {
    location = locateConfig(values.config, values.mcp, process.cwd(), values.agent);
    loadEnvFile(location.configDir);
    // The app starts even when its folders are missing or its files are broken.
    const starting = command === 'web' || command === 'start';
    if (starting) for (const created of ensureProject(location.configDir)) streams.stderr.write(`Created ${created}\n`);
    tree = loadConfig(location, { fallback: starting });
    if (starting) {
      const style = createStyle(streams.stderr as NodeJS.WriteStream);
      for (const s of tree.skipped) streams.stderr.write(`${style.yellow('skipped')} ${s.file}: ${s.error}\n`);
      for (const w of tree.warnings) streams.stderr.write(`${style.yellow('note:')} ${w}\n`);
    }
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
      streams.stdout.write(
        `${describeTree(tree)}\n\n${style.green('✓')} ${tree.byId.size} agent${tree.byId.size === 1 ? '' : 's'} loaded${tree.skipped.length ? `, ${tree.skipped.length} file${tree.skipped.length === 1 ? '' : 's'} skipped` : ''} (project: ${tree.configDir}; * replies by default)\n`,
      );
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
      return runOnce(tree, task, { yes: values.yes, json: values.json, showReasoning, showContext, conversation: conv }, streams);
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
        providerFactory: providers().factory,
      });
      registerCleanup(() => runtime.dispose());
      if (conversation) registerCleanup(() => conversation.close());
      // Edits to agent files or mcp.json apply from the next turn.
      const watcher = watchProject({
        configDir: tree.configDir,
        mcpFile: location.mcpFile,
        onChange: () => {
          try {
            const next = loadConfig(location!);
            const { mcpChanged } = runtime.reload(next);
            streams.stderr.write(`\n${createStyle(streams.stderr as NodeJS.WriteStream).dim(`Agents reloaded (${next.byId.size}${next.skipped.length ? `, ${next.skipped.length} skipped` : ''}${mcpChanged ? ', MCP servers restarted' : ''}).`)}\n`);
          } catch (error) {
            streams.stderr.write(`\n${createStyle(streams.stderr as NodeJS.WriteStream).yellow('note:')} the agent files could not be reloaded (${getErrorMessage(error)}); the previous agents stay in use.\n`);
          }
        },
      });
      registerCleanup(() => watcher.close());
      try {
        return await startRepl({
          runtime,
          showReasoning,
          showContext,
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
      const port = values.port === undefined ? setting('web.port', DEFAULT_PORT) : Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        streams.stderr.write(`--port must be a number from 0 to 65535, got "${values.port}".\n`);
        return EXIT_CONFIG;
      }
      let publicOrigin: string | undefined;
      try {
        publicOrigin = values['public-origin'] === undefined ? undefined : parsePublicOrigin(values['public-origin']);
      } catch (error) {
        return printConfigError(error, streams);
      }
      // Providers can be added in Settings once the app runs.
      try {
        checkCredentials(tree, process.env);
      } catch (error) {
        streams.stderr.write(`${createStyle(streams.stderr as NodeJS.WriteStream).yellow('note:')} ${getErrorMessage(error)}\n`);
      }
      const conversation = openSelected('start', values, tree, streams);
      if (conversation instanceof Error || !conversation) return EXIT_CONFIG;
      return serveWeb(
        tree,
        conversation,
        { port, host: values.host ?? setting('web.host', DEFAULT_HOST), publicOrigin, yes: values.yes, settings: appSettings, newToken: values['new-token'] },
        streams,
      );
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
    providerFactory: providers().factory,
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
  opts: { port: number; host: string; publicOrigin?: string; yes: boolean; settings: AppSettings; newToken?: boolean },
  streams: Streams,
): Promise<number> {
  const style = createStyle(streams.stderr as NodeJS.WriteStream);
  // The login gate: an access token whose hash is kept in the OS keyring.
  let auth: WebAuth | false = false;
  if (process.env['SFAGENTS_WEB_NO_LOGIN'] === '1') {
    streams.stderr.write(`${style.yellow('warning:')} SFAGENTS_WEB_NO_LOGIN=1: the web interface has no login (for automated tests only).\n`);
  } else {
    auth = new WebAuth();
    try {
      if (opts.newToken || !(await auth.hasToken())) {
        const replacing = opts.newToken && (await auth.hasToken());
        const token = await auth.createToken();
        const out = createStyle(streams.stdout as NodeJS.WriteStream);
        streams.stdout.write(
          [
            '',
            out.bold(replacing ? 'New access token for the web interface' : 'Access token for the web interface'),
            '',
            `    ${out.bold(token)}`,
            '',
            "Copy it and keep it somewhere safe (a password manager). It is shown only this once:",
            'SF Agents keeps just a fingerprint of it in the keyring. Paste it on the sign-in page of',
            'each device you use; after signing in you can add a passkey so you need not paste it again.',
            replacing ? 'Every device was signed out and the passkeys were removed.' : 'Lost it? Run `sfagents web --new-token` for a new one (this signs every device out).',
            '',
          ].join('\n'),
        );
      }
    } catch (error) {
      const message = error instanceof KeyringUnavailableError ? error.message : getErrorMessage(error);
      streams.stderr.write(
        `${style.red('The web interface needs the OS keyring to keep its access token, and the keyring is not available.')}\n${message}\n`,
      );
      await runExitCleanup();
      return EXIT_FAILURE;
    }
  }
  // One administrator approval for everything SF Agents does with administrator
  // rights, asked for now rather than when a feature is first used.
  // Screen mirroring's setup (its helper, the virtual display) is part of it.
  const screen = new ScreenMirror({ log: (line) => streams.stderr.write(`${line}\n`) });
  const privileges = process.env['SFAGENTS_NO_SETUP'] === '1' ? undefined : await acquirePrivileges({ screen, log: (line) => streams.stderr.write(`${line}\n`) });
  const server = new WebServer({
    auth,
    screen,
    tree,
    conversation,
    privileges,
    port: opts.port,
    host: opts.host,
    publicOrigin: opts.publicOrigin,
    approveAll: opts.yes,
    registry: providers().registry,
    accounts: providers().accounts,
    settings: opts.settings,
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
  // What the features need beyond the package (the screen mirroring helper, the
  // dictation model), set up in the background.
  if (process.env['SFAGENTS_NO_SETUP'] !== '1') void server.setupFeatures();
  streams.stdout.write(`SF Agents web interface: ${url}\n`);
  if (opts.publicOrigin) streams.stdout.write(`Reverse proxy origin: ${opts.publicOrigin}\n`);
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
