/**
 * What the browser shows: chat items built from the stored conversation,
 * plus artifact and approval descriptions. Only the main conversation's
 * user and root-assistant messages become bubbles; tool calls become short
 * activity lines.
 */

import path from 'node:path';
import type { ArtifactView, AttachmentRef, ConfirmationRequest, ConversationState, MessageRecord } from '@sfagents/core';

export interface DisplayAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export type DisplayItem =
  | { kind: 'user'; id: string; seq: number; time: string; text: string; attachments: DisplayAttachment[] }
  | { kind: 'assistant'; id: string; seq: number; time: string; text: string; agent: string }
  | { kind: 'activity'; id: string; seq: number; time: string; text: string; status?: string }
  | { kind: 'notice'; id: string; seq: number; time: string; text: string };

export interface DisplayArtifact {
  id: string;
  title: string;
  type: string;
  filename: string;
  mime?: string;
  rev: number;
  pinned: boolean;
  created: string;
  updated: string;
  url: string;
}

export interface DisplayApproval {
  id: string;
  agent: string;
  tool: string;
  title: string;
  detail: string;
}

export function attachmentUrl(a: AttachmentRef): string {
  return `/api/uploads/${encodeURIComponent(a.id)}/${encodeURIComponent(path.posix.basename(a.path))}`;
}

export function displayAttachment(a: AttachmentRef): DisplayAttachment {
  return { id: a.id, name: a.name, mime: a.mime, size: a.size, url: attachmentUrl(a) };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A short, human description of a tool call, e.g. "Read src/app.ts". */
export function describeCall(name: string, argsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
  } catch {
    // keep empty
  }
  const file = str(args['file_path']) ?? str(args['path']);
  switch (name) {
    case 'read_file':
      return `Read ${file ? clip(file, 60) : 'a file'}`;
    case 'write_file':
      return `Wrote ${file ? clip(file, 60) : 'a file'}`;
    case 'edit':
      return `Edited ${file ? clip(file, 60) : 'a file'}`;
    case 'glob':
      return `Searched for files ${str(args['pattern']) ? `matching ${clip(String(args['pattern']), 50)}` : ''}`.trim();
    case 'grep_search':
    case 'grep':
      return `Searched for ${str(args['pattern']) ? `“${clip(String(args['pattern']), 50)}”` : 'text'}`;
    case 'list_directory':
      return `Listed ${file ? clip(file, 60) : 'a folder'}`;
    case 'run_shell_command':
    case 'shell':
      return `Ran ${str(args['command']) ? `\`${clip(String(args['command']), 60)}\`` : 'a command'}`;
    case 'invoke_child':
      return `Asked ${str(args['agent']) ?? str(args['child']) ?? 'a child agent'}${str(args['task']) ? `: ${clip(String(args['task']), 60)}` : ''}`;
    case 'create_artifact':
      return `Created ${str(args['title']) ? `“${clip(String(args['title']), 60)}”` : 'an artifact'}`;
    case 'update_artifact':
      return `Updated ${str(args['id']) ?? 'an artifact'}${str(args['title']) ? ` “${clip(String(args['title']), 50)}”` : ''}`;
    case 'read_artifact':
      return `Opened ${str(args['id']) ?? 'an artifact'}`;
    case 'list_artifacts':
      return 'Looked at the artifacts';
    case 'add_section':
      return `Started topic ${str(args['title']) ? `“${clip(String(args['title']), 50)}”` : ''}`.trim();
    case 'edit_section':
      return 'Reorganized topics';
    case 'search_conversation':
    case 'search_sections':
      return `Searched the conversation${str(args['query']) ? ` for “${clip(String(args['query']), 50)}”` : ''}`;
    case 'fetch_section':
    case 'list_sections':
      return 'Looked back in the conversation';
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `Used ${tool ?? name} (${server})`;
      }
      return `Used ${name}`;
  }
}

/** Display items for messages with seq > `afterSeq`, at most `limit` from the end. */
export function displayItems(
  state: ConversationState,
  options: { before?: number; limit?: number; /** A run in progress, shown live instead. */ hideRun?: string } = {},
): { items: DisplayItem[]; more: boolean } {
  const items: DisplayItem[] = [];
  const results = new Map<string, string | undefined>();
  for (const m of state.messages) if (m.role === 'tool' && m.callId) results.set(`${m.run}:${m.callId}`, m.status);
  for (const record of state.records) {
    if (options.before !== undefined && record.seq >= options.before) break;
    if (record.kind === 'message') {
      const m = record as MessageRecord;
      if (m.role === 'user') {
        items.push({ kind: 'user', id: m.id, seq: m.seq, time: m.time, text: m.content, attachments: (m.attachments ?? []).map(displayAttachment) });
      } else if (m.role === 'assistant' && m.run !== options.hideRun) {
        if (m.content.trim()) items.push({ kind: 'assistant', id: m.id, seq: m.seq, time: m.time, text: m.content, agent: m.agent });
        for (const c of m.toolCalls ?? []) {
          items.push({ kind: 'activity', id: `${m.id}:${c.id}`, seq: m.seq, time: m.time, text: describeCall(c.name, c.arguments), status: results.get(`${m.run}:${c.id}`) ?? 'unknown' });
        }
      }
    } else if (record.kind === 'context_reset') {
      items.push({ kind: 'notice', id: `n${record.seq}`, seq: record.seq, time: record.time, text: 'Context cleared' });
    } else if (record.kind === 'run_end' && record.status !== 'GOAL' && state.runs.get(record.run)?.start?.parentRun === undefined) {
      const why = record.status === 'CANCELLED' ? 'Stopped' : record.status === 'MAX_TURNS' ? 'Stopped: turn limit reached' : record.status === 'TIMEOUT' ? 'Stopped: time limit reached' : `Error${record.error ? `: ${clip(record.error, 160)}` : ''}`;
      items.push({ kind: 'notice', id: `n${record.seq}`, seq: record.seq, time: record.time, text: why });
    } else if (record.kind === 'interrupted') {
      items.push({ kind: 'notice', id: `n${record.seq}`, seq: record.seq, time: record.time, text: 'A previous run was interrupted; nothing was retried' });
    }
  }
  const limit = options.limit ?? 300;
  const more = items.length > limit;
  return { items: more ? items.slice(items.length - limit) : items, more };
}

export function displayArtifact(v: ArtifactView): DisplayArtifact {
  const filename = v.path ? path.posix.basename(v.path) : v.title;
  return {
    id: v.id,
    title: v.title,
    type: v.type,
    filename,
    mime: v.mime,
    rev: v.rev,
    pinned: v.pinned,
    created: v.createdTime,
    updated: v.updatedTime,
    url: `/api/artifacts/${encodeURIComponent(v.id)}/raw`,
  };
}

export function describeApproval(id: string, request: ConfirmationRequest): DisplayApproval {
  const d = request.details;
  let detail = '';
  switch (d.type) {
    case 'exec':
      detail = `$ ${d.command}\nin ${d.cwd}`;
      break;
    case 'edit':
      detail = `${d.filePath}\n${d.fileDiff.split('\n').slice(0, 80).join('\n')}`;
      break;
    case 'mcp':
      detail = `${d.serverName} · ${d.toolName}\n${JSON.stringify(d.args, null, 2).slice(0, 2000)}`;
      break;
    case 'info':
      detail = d.prompt;
      break;
  }
  return { id, agent: request.agentPath.join(' › '), tool: request.toolName, title: d.title, detail };
}

export interface DisplaySection {
  id: string;
  title: string;
  parent: string | null;
  depth: number;
  /** First message of the section or its subsections: where a jump lands. */
  first: { id: string; seq: number };
  /** Messages in the section and its subsections (excluding tool results). */
  messages: number;
  current: boolean;
}

/**
 * The semantic index for the scroll rail: every section that has messages
 * (directly or through subsections), in the order its first message
 * appears in the thread, so the newest topic is last. Parents come before
 * their subsections when they start at the same message.
 */
export function displaySections(state: ConversationState): DisplaySection[] {
  const own = new Map<string, MessageRecord[]>();
  for (const m of state.messages) {
    if (m.role === 'tool') continue;
    const s = state.sectionOf(m.id);
    if (!s) continue;
    const list = own.get(s) ?? [];
    list.push(m);
    own.set(s, list);
  }
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = state.sections.get(id)?.parent ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      d++;
      cur = state.sections.get(cur)?.parent ?? null;
    }
    return d;
  };
  const out: DisplaySection[] = [];
  for (const s of state.sections.values()) {
    let first: MessageRecord | undefined;
    let count = 0;
    for (const [sid, msgs] of own) {
      // Is sid s itself or below it?
      let cur: string | null = sid;
      const seen = new Set<string>();
      while (cur && cur !== s.id && !seen.has(cur)) {
        seen.add(cur);
        cur = state.sections.get(cur)?.parent ?? null;
      }
      if (cur !== s.id) continue;
      count += msgs.length;
      if (!first || msgs[0]!.seq < first.seq) first = msgs[0];
    }
    if (!first) continue;
    out.push({ id: s.id, title: s.title, parent: s.parent, depth: depthOf(s.id), first: { id: first.id, seq: first.seq }, messages: count, current: state.currentSection === s.id });
  }
  return out.sort((a, b) => a.first.seq - b.first.seq || a.depth - b.depth);
}
