/**
 * Types for the SF Agents conversation format, version 1
 * (docs/CONVERSATION-FORMAT.md). Provider-independent: assistant tool calls
 * and reasoning continuation data are stored as opaque values.
 */

export const FORMAT_VERSION = 1;

export type ConversationKind = 'main' | 'transcript';
export type MessageRole = 'user' | 'assistant' | 'tool';
export type ToolMessageStatus = 'ok' | 'error' | 'denied' | 'cancelled' | 'not_started';
export type RunStatus = 'GOAL' | 'ERROR' | 'MAX_TURNS' | 'TIMEOUT' | 'CANCELLED';

export interface StoredToolCall {
  id: string;
  name: string;
  /** Exact argument JSON string sent to the provider. */
  arguments: string;
}

interface RecordBase {
  seq: number;
  time: string;
  /** Unknown fields, preserved on round-trip. */
  extra?: Record<string, unknown>;
}

export interface ConversationHeader extends RecordBase {
  kind: 'conversation';
  v: number;
  id: string;
  conversationKind: ConversationKind;
  run?: string;
  parentRun?: string;
  agent?: string;
}

export interface MessageRecord extends RecordBase {
  kind: 'message';
  id: string;
  run: string;
  role: MessageRole;
  agent: string;
  section?: string;
  content: string;
  toolCalls?: StoredToolCall[];
  reasoning?: string;
  reasoningDetails?: Array<Record<string, unknown>>;
  finish?: string;
  callId?: string;
  tool?: string;
  status?: ToolMessageStatus;
}

export interface RunStartRecord extends RecordBase {
  kind: 'run_start';
  run: string;
  agent: string;
  parentRun?: string;
  callId?: string;
  provider: string;
  model: string;
  reasoning?: string;
  config: string;
  configHash: string;
}

export interface ToolStartRecord extends RecordBase {
  kind: 'tool_start';
  run: string;
  callId: string;
  tool: string;
}

export interface RunEndRecord extends RecordBase {
  kind: 'run_end';
  run: string;
  status: RunStatus;
  error?: string;
  turns: number;
  usage?: Record<string, number>;
}

export interface SectionRecord extends RecordBase {
  kind: 'section';
  op: 'add' | 'edit';
  section: string;
  rev: number;
  expected: number;
  title?: string;
  /** For edit: null moves to top level; undefined leaves unchanged. */
  parent?: string | null;
  assign?: string[];
  unassign?: string[];
  current?: boolean;
}

export interface ArtifactRecord extends RecordBase {
  kind: 'artifact';
  id: string;
  type: string;
  title: string;
  path?: string;
  run?: string;
  message?: string;
  callId?: string;
}

export interface ContextResetRecord extends RecordBase {
  kind: 'context_reset';
}

export interface InterruptedRecord extends RecordBase {
  kind: 'interrupted';
  run: string;
  notStarted: string[];
  unknown: string[];
}

export interface RecoveryRecord extends RecordBase {
  kind: 'recovery';
  reason: string;
  savedTo: string;
  bytes: number;
}

export type ConversationRecord =
  | ConversationHeader
  | MessageRecord
  | RunStartRecord
  | ToolStartRecord
  | RunEndRecord
  | SectionRecord
  | ArtifactRecord
  | ContextResetRecord
  | InterruptedRecord
  | RecoveryRecord;

export type RecordKind = ConversationRecord['kind'];

/** A record without the fields the store assigns (seq, time). */
export type NewRecord = ConversationRecord extends infer R
  ? R extends ConversationRecord
    ? Omit<R, 'seq' | 'time'> & { time?: string }
    : never
  : never;

export interface Diagnostic {
  line: number;
  message: string;
}

export class ConversationFormatError extends Error {
  constructor(
    readonly file: string,
    readonly diagnostics: Diagnostic[],
  ) {
    super(`${file}: ${diagnostics.map((d) => `line ${d.line}: ${d.message}`).join('; ')}`);
    this.name = 'ConversationFormatError';
  }
}

/** Result of parsing: complete records plus any unfinished trailing bytes. */
export interface ParsedConversation {
  records: ConversationRecord[];
  /** Byte offset just after the last complete record (and its newline). */
  completeBytes: number;
  /** Present when the file ends inside a record. */
  damagedTail?: { offset: number; line: number; reason: string };
}
