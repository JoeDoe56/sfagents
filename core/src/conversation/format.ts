/**
 * Parser and serializer for the conversation format (version 1).
 * Pure: no filesystem access. See docs/CONVERSATION-FORMAT.md.
 */

import { randomBytes } from 'node:crypto';
import {
  type AttachmentRef,
  ConversationFormatError,
  FORMAT_VERSION,
  type ConversationRecord,
  type Diagnostic,
  type MessageRecord,
  type ParsedConversation,
  type RecordKind,
} from './types.js';

const HEADER_PREFIX = '<!-- sfa:';
const HEADER_RE = /^<!-- sfa:([a-z_]+) (\{.*?\}) -->(.*)$/;
const BODY_KINDS: ReadonlySet<RecordKind> = new Set(['message']);
const KINDS: ReadonlySet<string> = new Set([
  'conversation',
  'message',
  'run_start',
  'tool_start',
  'run_end',
  'section',
  'artifact',
  'artifact_update',
  'artifact_pin',
  'context_reset',
  'interrupted',
  'recovery',
]);

/** Fields each kind maps explicitly; anything else round-trips via `extra`. */
const KNOWN_FIELDS: Record<string, readonly string[]> = {
  conversation: ['seq', 'time', 'v', 'id', 'kind', 'run', 'parentRun', 'agent'],
  message: ['seq', 'time', 'id', 'run', 'role', 'agent', 'section', 'toolCalls', 'reasoning', 'reasoningDetails', 'finish', 'callId', 'tool', 'status', 'attachments', 'b', 'fence'],
  run_start: ['seq', 'time', 'run', 'agent', 'parentRun', 'callId', 'provider', 'model', 'reasoning', 'config', 'configHash'],
  tool_start: ['seq', 'time', 'run', 'callId', 'tool'],
  run_end: ['seq', 'time', 'run', 'status', 'error', 'turns', 'usage'],
  section: ['seq', 'time', 'op', 'section', 'rev', 'expected', 'title', 'parent', 'assign', 'unassign', 'current'],
  artifact: ['seq', 'time', 'id', 'type', 'title', 'path', 'run', 'message', 'callId', 'mime', 'file', 'url'],
  artifact_update: ['seq', 'time', 'artifact', 'rev', 'path', 'title', 'mime', 'run', 'callId', 'file', 'url'],
  artifact_pin: ['seq', 'time', 'artifact', 'pinned'],
  context_reset: ['seq', 'time'],
  interrupted: ['seq', 'time', 'run', 'notStarted', 'unknown'],
  recovery: ['seq', 'time', 'reason', 'savedTo', 'bytes'],
};

/** JSON for a header: one line, with every `>` escaped so `-->` cannot appear. */
export function encodeMeta(meta: Record<string, unknown>): string {
  return JSON.stringify(meta).replace(/>/g, '\\u003e');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function boundaryFor(content: string): string {
  while (true) {
    const b = randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
    if (b.length >= 4 && !content.includes(`<!-- sfa:end ${b} -->`)) return b;
  }
}

function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Readable, ignored-on-parse HTML shown after a header. */
export function decorationFor(record: ConversationRecord): string {
  switch (record.kind) {
    case 'conversation':
      return record.conversationKind === 'main'
        ? '<b>SF Agents conversation</b>'
        : record.conversationKind === 'thread'
          ? `<b>Agent thread: ${escapeHtml((record.agent ?? '').split(',').join(' ↔ '))}</b>`
          : `<b>Agent transcript: ${escapeHtml(record.agent ?? '')}</b>`;
    case 'message': {
      if (record.role === 'user') {
        const files = record.attachments?.length ? ` <sub>attached ${escapeHtml(record.attachments.map((a) => a.name).join(', '))}</sub>` : '';
        return `<b>User</b>${files}`;
      }
      if (record.role === 'assistant') {
        const calls = record.toolCalls?.length ? ` <sub>calls ${escapeHtml(record.toolCalls.map((c) => c.name).join(', '))}</sub>` : '';
        return `<b>${escapeHtml(record.agent)}</b>${calls}`;
      }
      return `<sub>${escapeHtml(record.tool ?? 'tool')} result (${record.status ?? 'ok'})</sub>`;
    }
    case 'section':
      if (record.op === 'add') return `<sub>New section: <b>${escapeHtml(record.title ?? '')}</b></sub>`;
      return `<sub>Section ${escapeHtml(record.section)} updated${record.title ? `: <b>${escapeHtml(record.title)}</b>` : ''}</sub>`;
    case 'artifact':
      if (record.file || record.url) return `<sub>Artifact (${escapeHtml(record.type)}): <a href="${escapeHtml(record.url ?? record.file!)}">${escapeHtml(record.title)}</a></sub>`;
      return record.path
        ? `<sub>Artifact (${escapeHtml(record.type)}): <a href="${escapeHtml(record.path)}">${escapeHtml(record.title)}</a></sub>`
        : `<sub>Artifact (${escapeHtml(record.type)}): ${escapeHtml(record.title)}</sub>`;
    case 'artifact_update':
      return record.path
        ? `<sub>Artifact ${escapeHtml(record.artifact)} revision ${record.rev}: <a href="${escapeHtml(record.path)}">${escapeHtml(record.title ?? 'updated')}</a></sub>`
        : `<sub>Artifact ${escapeHtml(record.artifact)} revision ${record.rev}</sub>`;
    case 'artifact_pin':
      return `<sub>Artifact ${escapeHtml(record.artifact)} ${record.pinned ? 'pinned' : 'unpinned'}</sub>`;
    case 'context_reset':
      return '<sub>Context reset</sub>';
    case 'run_end':
      return record.status === 'GOAL' ? '' : `<sub>Run ended: ${record.status}${record.error ? ` (${escapeHtml(record.error.slice(0, 200))})` : ''}</sub>`;
    case 'interrupted':
      return '<sub>Run interrupted</sub>';
    case 'recovery':
      return `<sub>Recovered damaged data: ${escapeHtml(record.savedTo)}</sub>`;
    default:
      return '';
  }
}

function toMeta(record: ConversationRecord): Record<string, unknown> {
  const { kind: _kind, extra, ...rest } = record as ConversationRecord & { extra?: Record<string, unknown> };
  const meta: Record<string, unknown> = {};
  if (record.kind === 'conversation') {
    const { conversationKind, ...others } = rest as Record<string, unknown> & { conversationKind: string };
    Object.assign(meta, others, { kind: conversationKind });
  } else if (record.kind === 'message') {
    const { content: _content, ...others } = rest as Record<string, unknown>;
    Object.assign(meta, others);
  } else {
    Object.assign(meta, rest);
  }
  for (const [k, v] of Object.entries(meta)) if (v === undefined) delete meta[k];
  return { ...meta, ...(extra ?? {}) };
}

/** Serializes one record, including its trailing newline. */
export function serializeRecord(record: ConversationRecord): string {
  const meta = toMeta(record);
  const decoration = decorationFor(record);
  if (record.kind !== 'message') {
    return `${HEADER_PREFIX}${record.kind} ${encodeMeta(meta)} -->${decoration}\n`;
  }
  const msg = record as MessageRecord;
  let body = msg.content;
  if (msg.role === 'tool') {
    const fence = fenceFor(msg.content);
    meta['fence'] = fence;
    body = `${fence}text\n${msg.content}\n${fence}`;
  }
  const b = boundaryFor(body);
  meta['b'] = b;
  return `${HEADER_PREFIX}message ${encodeMeta(meta)} -->${decoration}\n${body}\n<!-- sfa:end ${b} -->\n`;
}

export function serializeConversation(records: readonly ConversationRecord[]): string {
  return records.map(serializeRecord).join('\n');
}

// ---------------------------------------------------------------------------
// Parsing

class Cursor {
  pos = 0;
  line = 1;
  constructor(readonly text: string) {}
  get done(): boolean {
    return this.pos >= this.text.length;
  }
  /** Reads one line without its terminator. `terminated` is false at EOF without newline. */
  readLine(): { text: string; terminated: boolean; crlf: boolean; start: number; lineNo: number } {
    const start = this.pos;
    const lineNo = this.line;
    const nl = this.text.indexOf('\n', this.pos);
    if (nl === -1) {
      this.pos = this.text.length;
      return { text: this.text.slice(start), terminated: false, crlf: false, start, lineNo };
    }
    this.pos = nl + 1;
    this.line++;
    let text = this.text.slice(start, nl);
    const crlf = text.endsWith('\r');
    if (crlf) text = text.slice(0, -1);
    return { text, terminated: true, crlf, start, lineNo };
  }
  advanceTo(index: number): void {
    for (let i = this.pos; i < index; i++) if (this.text.charCodeAt(i) === 10) this.line++;
    this.pos = index;
  }
}

function str(meta: Record<string, unknown>, key: string, required: boolean, problems: string[]): string | undefined {
  const v = meta[key];
  if (v === undefined) {
    if (required) problems.push(`missing "${key}"`);
    return undefined;
  }
  if (typeof v !== 'string') {
    problems.push(`"${key}" must be a string`);
    return undefined;
  }
  return v;
}

function num(meta: Record<string, unknown>, key: string, required: boolean, problems: string[]): number | undefined {
  const v = meta[key];
  if (v === undefined) {
    if (required) problems.push(`missing "${key}"`);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    problems.push(`"${key}" must be a number`);
    return undefined;
  }
  return v;
}

function strArray(meta: Record<string, unknown>, key: string, problems: string[]): string[] | undefined {
  const v = meta[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    problems.push(`"${key}" must be an array of strings`);
    return undefined;
  }
  return v as string[];
}

function attachments(meta: Record<string, unknown>, problems: string[]): AttachmentRef[] | undefined {
  const v = meta['attachments'];
  if (v === undefined) return undefined;
  const valid =
    Array.isArray(v) &&
    v.every(
      (a) =>
        a &&
        typeof a === 'object' &&
        typeof a.id === 'string' &&
        typeof a.name === 'string' &&
        typeof a.mime === 'string' &&
        typeof a.path === 'string' &&
        typeof a.size === 'number',
    );
  if (!valid) {
    problems.push('"attachments" must be an array of {id, name, mime, path, size}');
    return undefined;
  }
  return v as AttachmentRef[];
}

/** Builds a typed record from header metadata; returns problems instead of throwing. */
function buildRecord(kind: string, meta: Record<string, unknown>, content: string | undefined): { record?: ConversationRecord; problems: string[] } {
  const p: string[] = [];
  const seq = num(meta, 'seq', true, p) ?? 0;
  const time = str(meta, 'time', true, p) ?? '';
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (!KNOWN_FIELDS[kind]!.includes(k)) extra[k] = v;
  const base = { seq, time, ...(Object.keys(extra).length ? { extra } : {}) };
  let record: ConversationRecord | undefined;
  switch (kind) {
    case 'conversation': {
      const ck = str(meta, 'kind', true, p);
      if (ck !== undefined && ck !== 'main' && ck !== 'transcript' && ck !== 'thread') p.push('"kind" must be "main", "transcript" or "thread"');
      record = {
        kind: 'conversation',
        ...base,
        v: num(meta, 'v', true, p) ?? 0,
        id: str(meta, 'id', true, p) ?? '',
        conversationKind: (ck as 'main' | 'transcript' | 'thread') ?? 'main',
        run: str(meta, 'run', false, p),
        parentRun: str(meta, 'parentRun', false, p),
        agent: str(meta, 'agent', false, p),
      };
      break;
    }
    case 'message': {
      const role = str(meta, 'role', true, p);
      if (role !== undefined && !['user', 'assistant', 'tool'].includes(role)) p.push('"role" must be user, assistant or tool');
      const toolCalls = meta['toolCalls'];
      if (toolCalls !== undefined) {
        if (
          !Array.isArray(toolCalls) ||
          toolCalls.some((c) => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string')
        ) {
          p.push('"toolCalls" must be an array of {id, name, arguments} strings');
        }
      }
      const details = meta['reasoningDetails'];
      if (details !== undefined && !Array.isArray(details)) p.push('"reasoningDetails" must be an array');
      const status = str(meta, 'status', false, p);
      if (status !== undefined && !['ok', 'error', 'denied', 'cancelled', 'not_started'].includes(status)) p.push(`unknown tool status "${status}"`);
      record = {
        kind: 'message',
        ...base,
        id: str(meta, 'id', true, p) ?? '',
        run: str(meta, 'run', true, p) ?? '',
        role: (role as MessageRecord['role']) ?? 'user',
        agent: str(meta, 'agent', true, p) ?? '',
        section: str(meta, 'section', false, p),
        content: content ?? '',
        toolCalls: toolCalls as MessageRecord['toolCalls'],
        reasoning: str(meta, 'reasoning', false, p),
        reasoningDetails: details as MessageRecord['reasoningDetails'],
        finish: str(meta, 'finish', false, p),
        callId: str(meta, 'callId', false, p),
        tool: str(meta, 'tool', false, p),
        status: status as MessageRecord['status'],
        attachments: attachments(meta, p),
      };
      if (record.role === 'tool' && (!record.callId || !record.tool)) p.push('tool messages need "callId" and "tool"');
      break;
    }
    case 'run_start':
      record = {
        kind: 'run_start',
        ...base,
        run: str(meta, 'run', true, p) ?? '',
        agent: str(meta, 'agent', true, p) ?? '',
        parentRun: str(meta, 'parentRun', false, p),
        callId: str(meta, 'callId', false, p),
        provider: str(meta, 'provider', true, p) ?? '',
        model: str(meta, 'model', true, p) ?? '',
        reasoning: str(meta, 'reasoning', false, p),
        config: str(meta, 'config', true, p) ?? '',
        configHash: str(meta, 'configHash', true, p) ?? '',
      };
      break;
    case 'tool_start':
      record = { kind: 'tool_start', ...base, run: str(meta, 'run', true, p) ?? '', callId: str(meta, 'callId', true, p) ?? '', tool: str(meta, 'tool', true, p) ?? '' };
      break;
    case 'run_end': {
      const status = str(meta, 'status', true, p);
      if (status !== undefined && !['GOAL', 'ERROR', 'MAX_TURNS', 'TIMEOUT', 'CANCELLED'].includes(status)) p.push(`unknown run status "${status}"`);
      const usage = meta['usage'];
      record = {
        kind: 'run_end',
        ...base,
        run: str(meta, 'run', true, p) ?? '',
        status: (status as 'GOAL') ?? 'ERROR',
        error: str(meta, 'error', false, p),
        turns: num(meta, 'turns', true, p) ?? 0,
        usage: usage && typeof usage === 'object' ? (usage as Record<string, number>) : undefined,
      };
      break;
    }
    case 'section': {
      const op = str(meta, 'op', true, p);
      if (op !== undefined && op !== 'add' && op !== 'edit') p.push('"op" must be "add" or "edit"');
      const parent = meta['parent'];
      if (parent !== undefined && parent !== null && typeof parent !== 'string') p.push('"parent" must be a string or null');
      const current = meta['current'];
      if (current !== undefined && typeof current !== 'boolean') p.push('"current" must be a boolean');
      record = {
        kind: 'section',
        ...base,
        op: (op as 'add') ?? 'add',
        section: str(meta, 'section', true, p) ?? '',
        rev: num(meta, 'rev', true, p) ?? 0,
        expected: num(meta, 'expected', true, p) ?? 0,
        title: str(meta, 'title', false, p),
        parent: parent as string | null | undefined,
        assign: strArray(meta, 'assign', p),
        unassign: strArray(meta, 'unassign', p),
        current: current as boolean | undefined,
      };
      if (record.op === 'add' && !record.title) p.push('section add needs a "title"');
      break;
    }
    case 'artifact':
      record = {
        kind: 'artifact',
        ...base,
        id: str(meta, 'id', true, p) ?? '',
        type: str(meta, 'type', true, p) ?? '',
        title: str(meta, 'title', true, p) ?? '',
        path: str(meta, 'path', false, p),
        run: str(meta, 'run', false, p),
        message: str(meta, 'message', false, p),
        callId: str(meta, 'callId', false, p),
        mime: str(meta, 'mime', false, p),
        file: str(meta, 'file', false, p),
        url: str(meta, 'url', false, p),
      };
      break;
    case 'artifact_update':
      record = {
        kind: 'artifact_update',
        ...base,
        artifact: str(meta, 'artifact', true, p) ?? '',
        rev: num(meta, 'rev', true, p) ?? 0,
        path: str(meta, 'path', false, p),
        title: str(meta, 'title', false, p),
        mime: str(meta, 'mime', false, p),
        run: str(meta, 'run', false, p),
        callId: str(meta, 'callId', false, p),
        file: str(meta, 'file', false, p),
        url: str(meta, 'url', false, p),
      };
      break;
    case 'artifact_pin': {
      const pinned = meta['pinned'];
      if (typeof pinned !== 'boolean') p.push('"pinned" must be a boolean');
      record = { kind: 'artifact_pin', ...base, artifact: str(meta, 'artifact', true, p) ?? '', pinned: pinned === true };
      break;
    }
    case 'context_reset':
      record = { kind: 'context_reset', ...base };
      break;
    case 'interrupted':
      record = {
        kind: 'interrupted',
        ...base,
        run: str(meta, 'run', true, p) ?? '',
        notStarted: strArray(meta, 'notStarted', p) ?? [],
        unknown: strArray(meta, 'unknown', p) ?? [],
      };
      break;
    case 'recovery':
      record = {
        kind: 'recovery',
        ...base,
        reason: str(meta, 'reason', true, p) ?? '',
        savedTo: str(meta, 'savedTo', true, p) ?? '',
        bytes: num(meta, 'bytes', true, p) ?? 0,
      };
      break;
  }
  return { record, problems: p };
}

/**
 * Parses a conversation file. Structural errors throw a
 * ConversationFormatError with line numbers; an unfinished final record is
 * reported as `damagedTail` so the store can move it aside.
 */
export function parseConversation(text: string, file = 'conversation.md'): ParsedConversation & { lines: number[] } {
  const cursor = new Cursor(text);
  const records: ConversationRecord[] = [];
  const lines: number[] = [];
  const diagnostics: Diagnostic[] = [];
  let completeChars = 0;
  let damagedTail: ParsedConversation['damagedTail'];

  const byteOffset = (charIndex: number) => Buffer.byteLength(text.slice(0, charIndex), 'utf8');

  while (!cursor.done) {
    const line = cursor.readLine();
    if (line.text.trim() === '') {
      if (diagnostics.length === 0 && !damagedTail) completeChars = cursor.pos;
      continue;
    }
    const isLastLine = cursor.done;
    const match = HEADER_RE.exec(line.text);
    if (!match) {
      if (isLastLine && (line.text.startsWith(HEADER_PREFIX) || HEADER_PREFIX.startsWith(line.text))) {
        damagedTail = { offset: byteOffset(line.start), line: line.lineNo, reason: 'unfinished header line' };
        break;
      }
      diagnostics.push({
        line: line.lineNo,
        message: line.text.startsWith(HEADER_PREFIX)
          ? 'malformed SF Agents header line'
          : 'unexpected text between records (all content must be inside a record)',
      });
      continue;
    }
    const kind = match[1]!;
    if (!KINDS.has(kind)) {
      diagnostics.push({ line: line.lineNo, message: `unknown record kind "${kind}"` });
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(match[2]!);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      meta = parsed as Record<string, unknown>;
    } catch (error) {
      if (isLastLine) {
        damagedTail = { offset: byteOffset(line.start), line: line.lineNo, reason: 'unfinished header line' };
        break;
      }
      diagnostics.push({ line: line.lineNo, message: `invalid header JSON: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    let content: string | undefined;
    if (BODY_KINDS.has(kind as RecordKind)) {
      const b = meta['b'];
      if (typeof b !== 'string' || !/^[A-Za-z0-9]+$/.test(b)) {
        diagnostics.push({ line: line.lineNo, message: 'message header needs a boundary "b" of letters and digits' });
        continue;
      }
      if (!line.terminated) {
        damagedTail = { offset: byteOffset(line.start), line: line.lineNo, reason: 'message body missing' };
        break;
      }
      const bodyStart = cursor.pos;
      const marker = `<!-- sfa:end ${b} -->`;
      let markerAt = -1;
      let from = bodyStart;
      while (true) {
        const k = text.indexOf(marker, from);
        if (k === -1) break;
        const after = text.slice(k + marker.length, k + marker.length + 2);
        const lineEndsAfter = after === '' || after.startsWith('\n') || after === '\r\n' || after.startsWith('\r\n');
        if (k - 1 >= bodyStart && text[k - 1] === '\n' && lineEndsAfter) {
          markerAt = k;
          break;
        }
        from = k + 1;
      }
      if (markerAt === -1) {
        damagedTail = { offset: byteOffset(line.start), line: line.lineNo, reason: 'message has no closing marker' };
        break;
      }
      let body = text.slice(bodyStart, markerAt - 1);
      if (line.crlf && body.endsWith('\r')) body = body.slice(0, -1);
      const fence = meta['fence'];
      if (fence !== undefined) {
        if (typeof fence !== 'string' || !/^`{3,}$/.test(fence)) {
          diagnostics.push({ line: line.lineNo, message: '"fence" must be three or more backticks' });
        } else {
          content = unfence(body, fence, line.crlf);
          if (content === undefined) diagnostics.push({ line: line.lineNo, message: 'fenced body does not start and end with its declared fence' });
        }
      } else {
        content = body;
      }
      cursor.advanceTo(markerAt);
      const closeLine = cursor.readLine();
      if (!closeLine.terminated && !cursor.done) diagnostics.push({ line: closeLine.lineNo, message: 'closing marker must end its line' });
    } else if (!line.terminated) {
      // A complete-looking header at EOF without a newline: accept (manual edits often drop it).
    }

    const { record, problems } = buildRecord(kind, meta, content);
    if (problems.length > 0 || !record) {
      diagnostics.push({ line: line.lineNo, message: `${kind} record: ${problems.join(', ')}` });
      continue;
    }
    records.push(record);
    lines.push(line.lineNo);
    if (diagnostics.length === 0) completeChars = cursor.pos;
  }

  if (diagnostics.length > 0) throw new ConversationFormatError(file, diagnostics);
  checkHeaderAndSequence(records, lines, file);
  return { records, lines, completeBytes: byteOffset(completeChars), damagedTail };
}

/** Strips the opening and closing fence lines written around tool output. */
function unfence(body: string, fence: string, crlf: boolean): string | undefined {
  const nl = body.indexOf('\n');
  if (nl === -1) return undefined;
  const opening = body.slice(0, nl).replace(/\r$/, '');
  if (!opening.startsWith(fence) || opening.slice(fence.length).includes('`')) return undefined;
  const rest = body.slice(nl + 1);
  const closeIdx = rest.lastIndexOf(`\n${fence}`);
  if (closeIdx === -1 || rest.slice(closeIdx + 1).replace(/\r$/, '') !== fence) return undefined;
  let content = rest.slice(0, closeIdx);
  if (crlf && content.endsWith('\r')) content = content.slice(0, -1);
  return content;
}

function checkHeaderAndSequence(records: ConversationRecord[], lines: number[], file: string): void {
  const diagnostics: Diagnostic[] = [];
  const first = records[0];
  if (!first) return; // empty file: the store writes a header
  if (first.kind !== 'conversation') {
    diagnostics.push({ line: lines[0]!, message: 'the first record must be a "conversation" header' });
  } else if (first.v > FORMAT_VERSION) {
    diagnostics.push({ line: lines[0]!, message: `format version ${first.v} is newer than this SF Agents supports (${FORMAT_VERSION}); upgrade SF Agents to open it` });
  } else if (first.v < 1) {
    diagnostics.push({ line: lines[0]!, message: `unsupported format version ${first.v}` });
  }
  records.forEach((r, i) => {
    if (i > 0 && r.kind === 'conversation') diagnostics.push({ line: lines[i]!, message: 'only the first record may be a "conversation" header' });
    if (r.seq !== i + 1) diagnostics.push({ line: lines[i]!, message: `expected seq ${i + 1}, found ${r.seq}` });
  });
  if (diagnostics.length) throw new ConversationFormatError(file, diagnostics);
}
