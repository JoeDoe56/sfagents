/**
 * Conversation selection for `start` and `run`, and the
 * `sfagents conversation …` inspection commands.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  ConversationFormatError,
  ConversationLockedError,
  ConversationService,
  ConversationStorageError,
  defaultConversationFile,
  forceUnlock,
  getErrorMessage,
  readConversation,
  readLock,
  stripAnsiAndControl,
  type AgentTree,
  type ConversationState,
} from '@sfagents/core';
import { createStyle } from '../terminal/style.js';

export interface ConversationFlags {
  conversation?: string;
  ephemeral?: boolean;
  persist?: boolean;
}

export class ConversationSelectionError extends Error {}

/**
 * `start` uses the project's persistent conversation unless --ephemeral;
 * `run` is ephemeral unless --persist or --conversation is given.
 */
export function selectConversationFile(mode: 'start' | 'run', flags: ConversationFlags, configDir: string, cwd = process.cwd()): string | undefined {
  if (flags.ephemeral && (flags.conversation || flags.persist)) {
    throw new ConversationSelectionError('--ephemeral cannot be combined with --conversation or --persist.');
  }
  if (flags.conversation) return path.resolve(cwd, flags.conversation);
  if (flags.ephemeral) return undefined;
  if (mode === 'start' || flags.persist) return defaultConversationFile(configDir);
  return undefined;
}

/** Opens the selected conversation or returns a printable error. */
export function openConversation(file: string, tree: AgentTree): ConversationService | Error {
  try {
    return ConversationService.open(file, { configDir: tree.configDir });
  } catch (error) {
    if (error instanceof ConversationLockedError || error instanceof ConversationFormatError || error instanceof ConversationStorageError) return error;
    return new Error(`Could not open the conversation ${file}: ${getErrorMessage(error)}`);
  }
}

export function conversationFileFor(flags: ConversationFlags, configDir: string): string {
  return flags.conversation ? path.resolve(flags.conversation) : defaultConversationFile(configDir);
}

function lockPathFor(file: string): string {
  return path.join(path.dirname(file), `${path.basename(file, '.md')}.lock`);
}

/** Effective section tree as indented lines (title, id, message count). */
export function sectionLines(state: ConversationState, limit = 200): string[] {
  const counts = new Map<string, number>();
  let unassigned = 0;
  for (const m of state.messages) {
    if (m.role === 'tool') continue;
    const s = state.sectionOf(m.id);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    else unassigned++;
  }
  const children = new Map<string | null, string[]>();
  for (const s of state.sections.values()) {
    const list = children.get(s.parent) ?? [];
    list.push(s.id);
    children.set(s.parent, list);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const id of children.get(parent) ?? []) {
      if (lines.length >= limit) return;
      const s = state.sections.get(id)!;
      lines.push(`${'  '.repeat(depth)}${s.title}  [${id}, ${counts.get(id) ?? 0} msg${state.currentSection === id ? ', current' : ''}]`);
      walk(id, depth + 1);
    }
  };
  walk(null, 0);
  if (lines.length >= limit) lines.push(`… (${state.sections.size - limit} more sections)`);
  if (unassigned > 0) lines.push(`(unassigned: ${unassigned} msg)`);
  return lines;
}

export async function conversationCommand(
  sub: string | undefined,
  args: string[],
  tree: AgentTree,
  flags: ConversationFlags & { yes?: boolean },
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  const file = conversationFileFor(flags, tree.configDir);
  const style = createStyle(streams.stdout as NodeJS.WriteStream);
  if (sub === 'unlock') {
    const lockPath = lockPathFor(file);
    if (!fs.existsSync(lockPath)) {
      streams.stdout.write(`No lock at ${lockPath}.\n`);
      return 0;
    }
    const holder = readLock(lockPath);
    streams.stdout.write(`Lock ${lockPath}\n  held by: ${holder ? `process ${holder.pid} on ${holder.host} since ${holder.started}` : '(unreadable)'}\n`);
    let confirmed = flags.yes === true;
    if (!confirmed && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: streams.stdout as NodeJS.WritableStream });
      const answer = await new Promise<string>((resolve) => rl.question('Remove it? Only do this if that SF Agents session is no longer running. Type "yes": ', resolve));
      rl.close();
      confirmed = answer.trim().toLowerCase() === 'yes';
    }
    if (!confirmed) {
      streams.stderr.write('Not removed. Re-run with --yes to remove without a prompt.\n');
      return 1;
    }
    forceUnlock(lockPath);
    streams.stdout.write('Lock removed.\n');
    return 0;
  }

  if (!fs.existsSync(file)) {
    streams.stderr.write(`No conversation at ${file} yet. "sfagents start" creates it.\n`);
    return 1;
  }
  let state: ConversationState;
  let damagedTail: string | undefined;
  try {
    ({ state, damagedTail } = readConversation(file));
  } catch (error) {
    streams.stderr.write(`${getErrorMessage(error)}\n`);
    return 2;
  }

  switch (sub) {
    case undefined:
    case 'info': {
      const userMsgs = state.messages.filter((m) => m.role === 'user').length;
      const runs = [...state.runs.values()];
      const missing = state.artifacts.filter((a) => a.path && !fs.existsSync(path.resolve(path.dirname(file), a.path)));
      const holder = readLock(lockPathFor(file));
      const lines = [
        `${style.bold('Conversation')} ${file}`,
        `  id: ${state.header?.id}   records: ${state.records.length}   last activity: ${state.records[state.records.length - 1]?.time ?? '-'}`,
        `  messages: ${state.messages.length} (${userMsgs} from the user)   sections: ${state.sections.size}   artifacts: ${state.artifacts.length}${missing.length ? style.yellow(` (${missing.length} missing)`) : ''}`,
        `  runs: ${runs.length}   interrupted: ${runs.filter((r) => r.interrupted).length}   unfinished: ${runs.filter((r) => r.start && !r.end && !r.interrupted).length}`,
        `  lock: ${holder ? `held by process ${holder.pid} on ${holder.host}` : 'free'}`,
      ];
      if (damagedTail) lines.push(style.yellow(`  damaged ending: ${damagedTail} (recovered automatically when the conversation is next opened)`));
      streams.stdout.write(lines.join('\n') + '\n');
      return 0;
    }
    case 'sections': {
      const lines = sectionLines(state);
      streams.stdout.write(lines.length ? `${lines.join('\n')}\n` : 'No sections yet.\n');
      return 0;
    }
    case 'artifacts': {
      if (state.artifacts.length === 0) {
        streams.stdout.write('No artifacts.\n');
        return 0;
      }
      for (const a of state.artifacts) {
        const exists = a.path ? fs.existsSync(path.resolve(path.dirname(file), a.path)) : true;
        streams.stdout.write(`${a.id}  ${a.type}  ${stripAnsiAndControl(a.title)}${a.path ? `  ${a.path}${exists ? '' : style.yellow(' (missing)')}` : ''}\n`);
      }
      return 0;
    }
    default:
      streams.stderr.write(`Unknown command "conversation ${sub}". Commands: info, sections, artifacts, unlock${args.length ? '' : ''}.\n`);
      return 2;
  }
}
