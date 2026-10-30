/**
 * What the browser shows: chat items built from the stored conversation,
 * plus artifact and approval descriptions. Only the main conversation's
 * user and root-assistant messages become bubbles; tool calls become short
 * activity lines.
 */

import path from 'node:path';
import { ChatToolNames, chatEffects, threadKey, type ArtifactView, type AttachmentRef, type ConfirmationRequest, type ConversationState, type MessageRecord } from '@sfagents/core';

export interface DisplayAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export type DisplayItem =
  | { kind: 'user'; id: string; seq: number; time: string; text: string; attachments: DisplayAttachment[]; /** In a thread: the agent that wrote it. */ agent?: string; /** An inline reply: the first message of its reply thread. */ replyTo?: string }
  | { kind: 'assistant'; id: string; seq: number; time: string; text: string; agent: string; /** The answer to an inline reply: the first message of its reply thread. */ replyTo?: string }
  | { kind: 'activity'; id: string; seq: number; time: string; text: string; status?: string; /** A message to another agent: the thread it went to. */ thread?: string; agent?: string; /** The artifact a call created or updated. */ artifact?: string }
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
  /** The file on disk, for the file manager's Quick Look. */
  file?: string;
  /** Changes whenever the file does (previews and caches key on it). */
  version: number;
  /** The file is gone (moved or deleted). */
  missing?: boolean;
  /** Application artifacts: the app's own address on the computer (opened through `url`). */
  target?: string;
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
    case 'message_agent':
      return `Messaged ${str(args['agent']) ?? 'an agent'}${str(args['message']) ? `: ${clip(String(args['message']), 60)}` : ''}`;
    case 'wait_for_messages':
      return 'Waited for messages';
    case 'message_user':
      return 'Sent a message';
    case 'tool_search': {
      const q = str(args['query']) ?? '';
      return /^select:/i.test(q) ? `Loaded ${clip(q.slice(7).split(',').map((n) => n.trim().replace(/^mcp__[^_]+__/, '')).filter(Boolean).join(', '), 60)}` : `Looked for tools${q ? ` for “${clip(q, 50)}”` : ''}`;
    }
    case 'create_artifact':
      if (str(args['id'])) return `Updated ${str(args['id'])}${str(args['title']) ? ` “${clip(String(args['title']), 50)}”` : ''}`;
      return `Created ${str(args['title']) ? `“${clip(String(args['title']), 60)}”` : 'an artifact'}`;
    case 'create_app_artifact':
      return `Opened ${str(args['title']) ? `“${clip(String(args['title']), 60)}”` : 'an app'}${typeof args['port'] === 'number' ? ` (port ${args['port']})` : ''}`;
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

/** The text of a message_user call. */
export function messageUserText(argsJson: string): string | undefined {
  try {
    const text = (JSON.parse(argsJson) as { text?: unknown }).text;
    return typeof text === 'string' && text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The thread a mid-run message from another agent came through: the one the receiving agent shares with it. */
function agentThread(content: string, from: string, run: string, state: ConversationState): { thread?: string } {
  const to = state.runs.get(run)?.start?.agent;
  if (!to) return {};
  const instance = Number(/^\[from [^,\]]*, thread (\d+)/.exec(content)?.[1] ?? 1);
  return { thread: threadKey(to, from, instance) };
}

/** Display items for messages with seq > `afterSeq`, at most `limit` from the end. */
/** A message_agent call: which agent, and the key of their thread 1 (the usual one). */
function threadOf(name: string, argsJson: string, from: string): { thread?: string; agent?: string } {
  if (name !== 'message_agent') return {};
  try {
    const args = JSON.parse(argsJson) as { agent?: unknown; thread?: unknown };
    if (typeof args.agent !== 'string') return {};
    return { agent: args.agent, thread: threadKey(from, args.agent, typeof args.thread === 'number' ? args.thread : 1) };
  } catch {
    return {};
  }
}

/** The artifact a create_artifact (or older update_artifact) call made or changed. */
function artifactOf(name: string, argsJson: string, created: string | undefined): { artifact?: string } {
  if (name === 'create_app_artifact' || (name === 'create_artifact' && created)) return created ? { artifact: created } : {};
  // update_artifact is from older conversations; create_artifact with "id" replaced it.
  if (name !== 'update_artifact' && name !== 'create_artifact') return {};
  try {
    const id = (JSON.parse(argsJson) as { id?: unknown }).id;
    return typeof id === 'string' ? { artifact: id } : {};
  } catch {
    return {};
  }
}

/**
 * Inline replies: every reply, and the answer to it, belongs to the thread
 * of the first message replied to (a reply to a reply joins the same
 * thread, as in Messages).
 */
export function replyRoots(state: ConversationState): { messages: Map<string, string>; runs: Map<string, string> } {
  const messages = new Map<string, string>(); // message id → thread root
  const runs = new Map<string, string>(); // run id → thread root
  for (const m of state.messages) {
    if (m.role === 'user' && m.event) continue;
    if (m.role === 'user' && m.replyTo) {
      const root = messages.get(m.replyTo) ?? m.replyTo;
      messages.set(m.id, root);
      runs.set(m.run, root);
    } else if (m.role === 'user') {
      // A message that joined a run while it worked: what follows answers it, in the main chat.
      runs.delete(m.run);
    } else if (m.role === 'assistant') {
      const root = runs.get(m.run);
      if (root) messages.set(m.id, root);
    }
  }
  return { messages, runs };
}

export function displayItems(
  state: ConversationState,
  options: { before?: number; limit?: number; /** A run in progress, shown live instead. */ hideRun?: string; /** A thread between agents: user messages carry who wrote them. */ thread?: boolean } = {},
): { items: DisplayItem[]; more: boolean } {
  const items: DisplayItem[] = [];
  const results = new Map<string, string | undefined>();
  for (const m of state.messages) if (m.role === 'tool' && m.callId) results.set(`${m.run}:${m.callId}`, m.status);
  // The artifact each call made or changed, by run and call id.
  const created = new Map<string, string>();
  for (const r of state.records) {
    if (r.kind === 'artifact' && r.run && r.callId && r.type !== 'agent_transcript') created.set(`${r.run}:${r.callId}`, r.id);
    else if (r.kind === 'artifact_update' && r.run && r.callId) created.set(`${r.run}:${r.callId}`, r.artifact);
  }
  const roots = replyRoots(state);
  const chat = chatEffects(state);
  for (const record of state.records) {
    if (options.before !== undefined && record.seq >= options.before) break;
    if (record.kind === 'message') {
      const m = record as MessageRecord;
      if (m.role === 'user' && m.event === 'agent') {
        // Another agent's message that reached the agent while it worked.
        const text = m.content.replace(/^\[from [^\]]*\]\s*/, '');
        items.push({ kind: 'activity', id: m.id, seq: m.seq, time: m.time, text: `${m.agent}: ${clip(text, 80)}`, status: 'ok', agent: m.agent, ...agentThread(m.content, m.agent, m.run, state) });
      } else if (m.role === 'user' && m.event) {
        // A note SF Agents wrote for the person (a reaction): the badge shows it.
      } else if (m.role === 'user') {
        const replyTo = roots.messages.get(m.id);
        items.push({ kind: 'user', id: m.id, seq: m.seq, time: m.time, text: m.content, attachments: (m.attachments ?? []).map(displayAttachment), ...(options.thread ? { agent: m.agent } : {}), ...(replyTo ? { replyTo } : {}) });
      } else if (m.role === 'assistant' && m.run !== options.hideRun) {
        const replyTo = roots.runs.get(m.run);
        if (m.content.trim()) items.push({ kind: 'assistant', id: m.id, seq: m.seq, time: m.time, text: m.content, agent: m.agent, ...(replyTo ? { replyTo } : {}) });
        for (const c of m.toolCalls ?? []) {
          if (c.name === 'keep_section' || c.name === ChatToolNames.REACT) continue; // the topic; a reaction shows as its badge
          const inline = chat.replies.get(`${m.id}:${c.id}`);
          if (inline) {
            items.push({ kind: 'assistant', id: `${m.id}:${c.id}`, seq: m.seq, time: m.time, text: inline.text, agent: m.agent, replyTo: roots.messages.get(inline.messageId) ?? inline.messageId });
            continue;
          }
          if (c.name === ChatToolNames.REPLY_INLINE) continue;
          // A message to the person mid-turn: a bubble like any reply.
          const said = c.name === 'message_user' ? messageUserText(c.arguments) : undefined;
          if (said !== undefined) {
            items.push({ kind: 'assistant', id: `${m.id}:${c.id}`, seq: m.seq, time: m.time, text: said, agent: m.agent, ...(replyTo ? { replyTo } : {}) });
            continue;
          }
          items.push({ kind: 'activity', id: `${m.id}:${c.id}`, seq: m.seq, time: m.time, text: describeCall(c.name, c.arguments), status: results.get(`${m.run}:${c.id}`) ?? 'unknown', ...threadOf(c.name, c.arguments, m.agent), ...artifactOf(c.name, c.arguments, created.get(`${m.run}:${c.id}`)) });
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

export function displayArtifact(v: ArtifactView, file?: string, stat?: { mtimeMs: number; size: number } | null): DisplayArtifact {
  if (v.url) {
    return {
      id: v.id,
      title: v.title,
      type: 'app',
      filename: v.url.replace(/^https?:\/\//, ''),
      rev: v.rev,
      pinned: v.pinned,
      created: v.createdTime,
      updated: v.updatedTime,
      url: `/apps/${encodeURIComponent(v.id)}/`,
      target: v.url,
      version: v.rev,
    };
  }
  const filename = file ? path.basename(file) : v.path ? path.posix.basename(v.path) : v.title;
  return {
    id: v.id,
    title: v.title,
    type: v.type,
    filename,
    mime: v.mime,
    rev: v.rev,
    pinned: v.pinned,
    created: v.createdTime,
    updated: stat ? new Date(stat.mtimeMs).toISOString() : v.updatedTime,
    url: `/api/artifacts/${encodeURIComponent(v.id)}/raw`,
    ...(file ? { file } : {}),
    version: stat ? Math.round(stat.mtimeMs) * 1000 + v.rev : v.rev,
    ...(v.file && !stat ? { missing: true } : {}),
  };
}

export function describeApproval(id: string, request: ConfirmationRequest): DisplayApproval {
  const d = request.details;
  let detail = '';
  switch (d.type) {
    case 'exec':
      detail = `$ ${d.command}\nin ${d.cwd}`;
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
