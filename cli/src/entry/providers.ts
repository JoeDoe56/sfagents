/**
 * `sfagents providers …` and `sfagents settings …`: the same provider list and
 * app settings as the web interface's Settings sheet.
 *
 *   sfagents providers                         list them
 *   sfagents providers add openrouter [--name N]   asks for the key (hidden)
 *   sfagents providers add custom --url URL [--name N]
 *   sfagents providers add openai [--name N]   ChatGPT sign-in (through Codex) in this computer's browser
 *   sfagents providers add anthropic [--name N]  Claude sign-in in this computer's browser
 *   sfagents providers rename <name> <new name>
 *   sfagents providers remove <name>
 *   sfagents providers web-key [remove]        the Bright Data key for agents' web access (asks for it, hidden)
 *   sfagents settings [set <key> <value> | reset <key>]
 */

import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  AppSettings,
  ClaudeSignIn,
  CodexSignIn,
  PROVIDER_KIND_LABELS,
  PROVIDER_KINDS,
  ProviderRegistry,
  SETTINGS,
  getErrorMessage,
  openInBrowser,
  removeDir,
  type ProviderKind,
} from '@sfagents/core';
import { createStyle } from '../terminal/style.js';

interface Streams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const OK = 0;
const FAIL = 1;
const USAGE_ERROR = 2;

/** Reads one line from the terminal; with `hidden`, typed characters are not echoed. */
export function prompt(question: string, streams: Streams, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const rl = readline.createInterface({ input, output: streams.stderr, terminal: input.isTTY === true });
    const out = streams.stderr as NodeJS.WriteStream;
    if (hidden && input.isTTY) {
      const original = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) original(s);
        else if (s === '\r\n' || s === '\n') original(s);
        else original('');
      };
    }
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden && input.isTTY) out.write('\n');
      resolve(answer.trim());
    });
    rl.on('close', () => {
      if (!answered) reject(new Error('No input.'));
    });
  });
}

export async function providersCommand(
  positional: string[],
  streams: Streams,
  options: { name?: string; url?: string } = {},
  registry = new ProviderRegistry(),
): Promise<number> {
  const style = createStyle(streams.stdout as NodeJS.WriteStream);
  const flags: Record<string, string | undefined> = { name: options.name, url: options.url };
  const [sub, ...rest] = positional;
  try {
    switch (sub ?? 'list') {
      case 'list': {
        const list = registry.list();
        if (!list.length) {
          streams.stdout.write(`No providers yet. Add one with "sfagents providers add <${PROVIDER_KINDS.join('|')}>" or in the web interface's Settings.\n`);
          return OK;
        }
        for (const p of list) {
          streams.stdout.write(`${style.bold(p.name)}  ${style.dim(PROVIDER_KIND_LABELS[p.kind])}${p.baseUrl ? `  ${p.baseUrl}` : ''}${p.account ? `  ${p.account}` : ''}\n`);
        }
        streams.stdout.write(style.dim(`\nKeys and sign-ins are in the ${registry.secrets.label}. Use a provider by its name in an agent file: "provider": "${list[0]!.name}".\n`));
        streams.stdout.write(style.dim(`Web access (Bright Data): ${(await registry.webKey()) ? 'key added' : 'no key ("sfagents providers web-key" adds one)'}.\n`));
        return OK;
      }
      case 'add': {
        const kind = rest[0] as ProviderKind | undefined;
        if (!kind || !(PROVIDER_KINDS as readonly string[]).includes(kind)) {
          streams.stderr.write(`Usage: sfagents providers add <${PROVIDER_KINDS.join('|')}> [--name <name>] [--url <url>]\n`);
          return USAGE_ERROR;
        }
        await registry.secrets.check();
        const name = flags['name'] || (await prompt(`Name [${registry.suggestName(kind)}]: `, streams)) || registry.suggestName(kind);
        if (registry.find(name)) throw new Error(`A provider named "${name}" already exists.`);
        if (kind === 'openrouter' || kind === 'custom') {
          let baseUrl: string | undefined;
          if (kind === 'custom') {
            baseUrl = flags['url'] || (await prompt('Endpoint (OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1): ', streams));
          }
          const apiKey = await prompt(kind === 'custom' ? 'API key (Enter for none): ' : 'OpenRouter API key: ', streams, true);
          if (kind === 'openrouter' && !apiKey) throw new Error('An API key is required.');
          const record = await registry.add({ name, kind, baseUrl, secret: { apiKey } });
          streams.stdout.write(`${style.green('✓')} Added "${record.name}". The key is in the ${registry.secrets.label}.\n`);
          return OK;
        }
        if (kind === 'openai') {
          const id = randomUUID();
          const home = registry.stateDir({ id, kind });
          let signIn: CodexSignIn;
          try {
            signIn = await CodexSignIn.start({ home });
          } catch (error) {
            removeDir(home);
            throw error;
          }
          const opened = await openInBrowser(signIn.url);
          streams.stderr.write(
            `${opened ? 'A ChatGPT sign-in page opened in your browser.' : 'Open this address in a browser on this computer:'}\n\n  ${signIn.url}\n\nSign in there and close the tab; this finishes by itself. (It must be this computer's browser.)\n`,
          );
          try {
            const result = await signIn.done;
            const record = await registry.add({ id, name, kind, account: result.email, secret: { codex: true } });
            streams.stdout.write(`${style.green('✓')} Signed in${result.email ? ` as ${result.email}` : ''}. Added "${record.name}".\n`);
          } catch (error) {
            removeDir(home);
            throw error;
          }
          return OK;
        }
        const signIn = await ClaudeSignIn.start();
        streams.stderr.write(`A Claude sign-in page opened in your browser. Sign in there and close the tab; this finishes by itself. (It must be this computer's browser.)\n`);
        const token = await signIn.done;
        const record = await registry.add({ name, kind, account: 'Claude plan', secret: { token } });
        streams.stdout.write(`${style.green('✓')} Signed in. Added "${record.name}".\n`);
        return OK;
      }
      case 'rename': {
        const [from, to] = rest;
        const record = from ? registry.find(from) : undefined;
        if (!record || !to) {
          streams.stderr.write(record ? 'Usage: sfagents providers rename <name> <new name>\n' : `No provider named "${from ?? ''}".\n`);
          return USAGE_ERROR;
        }
        registry.update(record.id, { name: to });
        streams.stdout.write(`${style.green('✓')} Renamed "${record.name}" to "${to}". Agent files that use the old name need updating.\n`);
        return OK;
      }
      case 'remove': {
        const record = rest[0] ? registry.find(rest[0]) : undefined;
        if (!record) {
          streams.stderr.write(`No provider named "${rest[0] ?? ''}".\n`);
          return USAGE_ERROR;
        }
        await registry.remove(record.id);
        streams.stdout.write(`${style.green('✓')} Removed "${record.name}" and its key or sign-in.\n`);
        return OK;
      }
      case 'web-key': {
        if (rest[0] === 'remove') {
          await registry.setWebKey(null);
          streams.stdout.write(`${style.green('✓')} Removed the Bright Data key. Agents have no web access until you add one again.\n`);
          return OK;
        }
        await registry.secrets.check();
        const key = await prompt('Bright Data API key: ', streams, true);
        await registry.setWebKey(key);
        streams.stdout.write(`${style.green('✓')} Saved. Agents with "web" in tools.allow can now use sf-web. The key is in the ${registry.secrets.label}.\n`);
        return OK;
      }
      default:
        streams.stderr.write(`Unknown command "providers ${sub}". Use list, add, rename, remove or web-key.\n`);
        return USAGE_ERROR;
    }
  } catch (error) {
    streams.stderr.write(`${createStyle(streams.stderr as NodeJS.WriteStream).red('error:')} ${getErrorMessage(error)}\n`);
    return FAIL;
  } finally {
    registry.close();
  }
}

export function settingsCommand(args: string[], streams: Streams, settings = new AppSettings()): number {
  const style = createStyle(streams.stdout as NodeJS.WriteStream);
  const [sub, key, ...value] = args;
  try {
    if (!sub || sub === 'list') {
      let group = '';
      for (const s of settings.all()) {
        if (s.platform && s.platform !== process.platform) continue;
        if (s.group !== group) {
          group = s.group;
          streams.stdout.write(`${style.bold(group)}\n`);
        }
        streams.stdout.write(`  ${s.key.padEnd(20)} ${String(s.value)}${s.isDefault ? style.dim(' (default)') : ''}${s.restart ? style.dim('  · on next start') : ''}\n`);
      }
      streams.stdout.write(style.dim(`\n${settings.file}\n`));
      return OK;
    }
    if (sub === 'set' && key && value.length) {
      settings.set({ [key]: value.join(' ') });
      const spec = SETTINGS.find((s) => s.key === key)!;
      streams.stdout.write(`${style.green('✓')} ${key} = ${String(settings.get(key))}${spec.restart ? ' (takes effect on the next start)' : ''}\n`);
      return OK;
    }
    if (sub === 'reset' && key) {
      settings.set({ [key]: null });
      streams.stdout.write(`${style.green('✓')} ${key} reset to ${String(settings.get(key))}\n`);
      return OK;
    }
    streams.stderr.write('Usage: sfagents settings [list | set <key> <value> | reset <key>]\n');
    return USAGE_ERROR;
  } catch (error) {
    streams.stderr.write(`${createStyle(streams.stderr as NodeJS.WriteStream).red('error:')} ${getErrorMessage(error)}\n`);
    return USAGE_ERROR;
  }
}
