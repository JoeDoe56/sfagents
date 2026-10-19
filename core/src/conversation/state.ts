/**
 * In-memory state reconstructed from conversation records, with the
 * semantic validation rules from docs/CONVERSATION-FORMAT.md. Records are
 * applied in order; an invalid record throws and leaves the state unchanged.
 */

import type {
  ArtifactRecord,
  ConversationHeader,
  ConversationRecord,
  InterruptedRecord,
  MessageRecord,
  RunEndRecord,
  RunStartRecord,
  SectionRecord,
} from './types.js';
import { ConversationFormatError } from './types.js';

export interface SectionState {
  id: string;
  title: string;
  parent: string | null;
  createdSeq: number;
}

export interface RunState {
  id: string;
  start?: RunStartRecord;
  end?: RunEndRecord;
  /** callId → requesting assistant message. */
  requested: Map<string, { name: string; messageId: string }>;
  started: Set<string>;
  results: Map<string, MessageRecord>;
  interrupted?: InterruptedRecord;
}

export class SemanticError extends Error {}

export class ConversationState {
  header?: ConversationHeader;
  readonly records: ConversationRecord[] = [];
  readonly messages: MessageRecord[] = [];
  readonly messageById = new Map<string, MessageRecord>();
  readonly sections = new Map<string, SectionState>();
  /** Explicit (re)assignments: message ID → section ID, or null for unassigned. */
  readonly assignment = new Map<string, string | null>();
  currentSection: string | null = null;
  structureRevision = 0;
  readonly runs = new Map<string, RunState>();
  readonly artifacts: ArtifactRecord[] = [];
  readonly artifactById = new Map<string, ArtifactRecord>();
  /** seq of the last context_reset (0 when none). */
  lastResetSeq = 0;

  get nextSeq(): number {
    return this.records.length + 1;
  }

  /** The section a message belongs to, or undefined when unassigned. */
  sectionOf(messageId: string): string | undefined {
    if (this.assignment.has(messageId)) return this.assignment.get(messageId) ?? undefined;
    return this.messageById.get(messageId)?.section;
  }

  nextSectionId(): string {
    return `s${this.sections.size + 1}`;
  }

  /** Ancestors from the root down to (not including) the section. */
  ancestors(sectionId: string): SectionState[] {
    const chain: SectionState[] = [];
    let cur = this.sections.get(sectionId)?.parent ?? null;
    while (cur) {
      const s = this.sections.get(cur);
      if (!s) break;
      chain.unshift(s);
      cur = s.parent;
    }
    return chain;
  }

  private run(id: string): RunState {
    let r = this.runs.get(id);
    if (!r) {
      r = { id, requested: new Map(), started: new Set(), results: new Map() };
      this.runs.set(id, r);
    }
    return r;
  }

  /** Validates a record against the current state without applying it. */
  check(record: ConversationRecord): void {
    const fail = (message: string): never => {
      throw new SemanticError(message);
    };
    if (record.kind === 'conversation') {
      if (this.records.length > 0) fail('only the first record may be a conversation header');
      return;
    }
    if (!this.header) fail('the first record must be a conversation header');
    switch (record.kind) {
      case 'message': {
        if (this.messageById.has(record.id)) fail(`duplicate message id ${record.id}`);
        if (record.section !== undefined && !this.sections.has(record.section)) fail(`message ${record.id} names unknown section ${record.section}`);
        if (record.role === 'tool') {
          const run = this.runs.get(record.run);
          const requested = run?.requested.get(record.callId!);
          if (!requested) fail(`tool result ${record.id} answers call ${record.callId}, which no assistant message in run ${record.run} requested`);
          if (run!.results.has(record.callId!)) fail(`call ${record.callId} already has a result`);
        }
        if (record.role === 'assistant') {
          const ids = new Set<string>();
          for (const c of record.toolCalls ?? []) {
            if (ids.has(c.id) || this.runs.get(record.run)?.requested.has(c.id)) fail(`duplicate tool call id ${c.id} in run ${record.run}`);
            ids.add(c.id);
          }
        }
        return;
      }
      case 'run_start':
        if (this.runs.get(record.run)?.start) fail(`run ${record.run} started twice`);
        return;
      case 'tool_start': {
        const run = this.runs.get(record.run);
        if (!run?.start) fail(`tool_start for unknown run ${record.run}`);
        if (!run!.requested.has(record.callId)) fail(`tool_start for call ${record.callId}, which run ${record.run} never requested`);
        if (run!.started.has(record.callId)) fail(`call ${record.callId} started twice`);
        return;
      }
      case 'run_end': {
        const run = this.runs.get(record.run);
        if (!run?.start) fail(`run_end for unknown run ${record.run}`);
        if (run!.end) fail(`run ${record.run} ended twice`);
        return;
      }
      case 'interrupted':
        if (!this.runs.get(record.run)?.start) fail(`interrupted record for unknown run ${record.run}`);
        return;
      case 'section':
        this.checkSection(record);
        return;
      case 'artifact':
        if (this.artifactById.has(record.id)) fail(`duplicate artifact id ${record.id}`);
        if (record.message !== undefined && !this.messageById.has(record.message)) fail(`artifact ${record.id} names unknown message ${record.message}`);
        return;
      default:
        return;
    }
  }

  private checkSection(record: SectionRecord): void {
    const fail = (message: string): never => {
      throw new SemanticError(message);
    };
    if (record.rev !== this.structureRevision + 1) fail(`section record revision ${record.rev} does not follow ${this.structureRevision}`);
    if (record.op === 'add') {
      if (this.sections.has(record.section)) fail(`section ${record.section} already exists`);
      if (!/^s[0-9]+$/.test(record.section)) fail(`section ids look like s<number>, got ${record.section}`);
    } else if (!this.sections.has(record.section)) {
      fail(`edit of unknown section ${record.section}`);
    }
    if (record.title !== undefined && record.title.trim() === '') fail('section titles must not be empty');
    if (record.parent !== undefined && record.parent !== null) {
      if (!this.sections.has(record.parent)) fail(`unknown parent section ${record.parent}`);
      // Cycle check: the new parent must not be the section or one of its descendants.
      let cur: string | null = record.parent;
      while (cur) {
        if (cur === record.section) fail(`moving ${record.section} under ${record.parent} would create a cycle`);
        cur = this.sections.get(cur)?.parent ?? null;
      }
    }
    for (const id of [...(record.assign ?? []), ...(record.unassign ?? [])]) {
      const m = this.messageById.get(id);
      if (!m) fail(`unknown message ${id}`);
      if (m!.role === 'tool') fail(`${id} is a tool result; assign the assistant message that requested it`);
    }
  }

  /** Validates and applies a record. */
  apply(record: ConversationRecord): void {
    this.check(record);
    this.records.push(record);
    switch (record.kind) {
      case 'conversation':
        this.header = record;
        break;
      case 'message': {
        this.messages.push(record);
        this.messageById.set(record.id, record);
        const run = this.run(record.run);
        if (record.role === 'assistant') {
          for (const c of record.toolCalls ?? []) run.requested.set(c.id, { name: c.name, messageId: record.id });
        }
        if (record.role === 'tool') run.results.set(record.callId!, record);
        break;
      }
      case 'run_start':
        this.run(record.run).start = record;
        break;
      case 'tool_start':
        this.run(record.run).started.add(record.callId);
        break;
      case 'run_end':
        this.run(record.run).end = record;
        break;
      case 'interrupted':
        this.run(record.run).interrupted = record;
        break;
      case 'section': {
        if (record.op === 'add') {
          this.sections.set(record.section, {
            id: record.section,
            title: record.title!,
            parent: record.parent ?? null,
            createdSeq: record.seq,
          });
        } else {
          const s = this.sections.get(record.section)!;
          if (record.title !== undefined) s.title = record.title;
          if (record.parent !== undefined) s.parent = record.parent;
        }
        for (const id of record.assign ?? []) this.assignment.set(id, record.section);
        for (const id of record.unassign ?? []) {
          if (this.sectionOf(id) === record.section) this.assignment.set(id, null);
        }
        if (record.current === true || (record.op === 'add' && record.current !== false)) this.currentSection = record.section;
        this.structureRevision = record.rev;
        break;
      }
      case 'artifact':
        this.artifacts.push(record);
        this.artifactById.set(record.id, record);
        break;
      case 'context_reset':
        this.lastResetSeq = record.seq;
        break;
      default:
        break;
    }
  }

  /** Builds state from parsed records, converting semantic errors to line diagnostics. */
  static from(records: readonly ConversationRecord[], lines: readonly number[], file: string): ConversationState {
    const state = new ConversationState();
    const diagnostics: Array<{ line: number; message: string }> = [];
    records.forEach((r, i) => {
      try {
        state.apply(r);
      } catch (error) {
        if (!(error instanceof SemanticError)) throw error;
        diagnostics.push({ line: lines[i] ?? 0, message: error.message });
        // Keep going so every problem is reported; skip the invalid record.
      }
    });
    if (diagnostics.length) throw new ConversationFormatError(file, diagnostics);
    return state;
  }

  /** Runs that started but never ended and were not already marked interrupted. */
  unfinishedRuns(): RunState[] {
    return [...this.runs.values()].filter((r) => r.start && !r.end && !r.interrupted);
  }
}
