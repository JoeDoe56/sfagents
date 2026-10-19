/**
 * Conversation stores. `FileConversationStore` is the durable,
 * single-writer implementation of docs/CONVERSATION-FORMAT.md;
 * `MemoryConversationStore` has the same behavior without a file (ephemeral
 * sessions and tests).
 *
 * Every append is validated against the reconstructed state before any
 * byte is written, written with one append call and flushed before
 * returning. That flushed append is the commit boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseConversation, serializeRecord } from './format.js';
import { ConversationState, SemanticError } from './state.js';
import {
  FORMAT_VERSION,
  type ConversationKind,
  type ConversationRecord,
  type NewRecord,
} from './types.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';

export class ConversationStorageError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ConversationStorageError';
  }
}

export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOperationError';
  }
}

export interface ConversationStore {
  readonly state: ConversationState;
  /** Absolute path of the backing file; undefined for memory stores. */
  readonly file?: string;
  /** Validates, writes durably and applies one record. */
  append(record: NewRecord): ConversationRecord;
  close(): void;
}

export interface HeaderInfo {
  conversationKind: ConversationKind;
  run?: string;
  parentRun?: string;
  agent?: string;
}

function newId(prefix: string): string {
  return `${prefix}${randomBytes(8).toString('hex').slice(0, 10)}`;
}

function complete(state: ConversationState, record: NewRecord): ConversationRecord {
  return { ...record, seq: state.nextSeq, time: record.time ?? new Date().toISOString() } as ConversationRecord;
}

function validate(state: ConversationState, full: ConversationRecord): void {
  try {
    state.check(full);
  } catch (error) {
    if (error instanceof SemanticError) throw new InvalidOperationError(error.message);
    throw error;
  }
}

export class MemoryConversationStore implements ConversationStore {
  readonly state = new ConversationState();
  readonly file = undefined;

  constructor(header: HeaderInfo = { conversationKind: 'main' }) {
    this.append({ kind: 'conversation', v: FORMAT_VERSION, id: newId('c_'), ...header });
  }

  append(record: NewRecord): ConversationRecord {
    const full = complete(this.state, record);
    validate(this.state, full);
    this.state.apply(full);
    return full;
  }

  close(): void {}
}

/** Low-level IO, replaceable for fault-injection tests. */
export interface StoreIO {
  write(fd: number, data: string): void;
  fsync(fd: number): void;
}

const defaultIO: StoreIO = {
  write: (fd, data) => {
    const buf = Buffer.from(data, 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
  },
  fsync: (fd) => fs.fsyncSync(fd),
};

export interface OpenOptions {
  /** Header for a new file. */
  header: HeaderInfo;
  io?: Partial<StoreIO>;
  /** Directory for damaged tails moved aside (default: <file dir>/recovered). */
  recoveredDir?: string;
}

export interface OpenReport {
  created: boolean;
  /** Path of a damaged tail that was moved aside, relative to the file's directory. */
  recoveredTo?: string;
  recoveredReason?: string;
}

export class FileConversationStore implements ConversationStore {
  readonly state: ConversationState;
  readonly report: OpenReport;
  private fd: number | undefined;
  private expectedSize: number;
  private failed: ConversationStorageError | undefined;
  private readonly io: StoreIO;

  private constructor(
    readonly file: string,
    state: ConversationState,
    fd: number,
    size: number,
    report: OpenReport,
    io: StoreIO,
  ) {
    this.state = state;
    this.fd = fd;
    this.expectedSize = size;
    this.report = report;
    this.io = io;
  }

  /**
   * Opens (or creates) a conversation file for writing. The caller must hold
   * the conversation lock. A damaged trailing record is moved to the
   * recovered directory and replaced by a `recovery` record; damage
   * elsewhere throws a ConversationFormatError.
   */
  static open(file: string, options: OpenOptions): FileConversationStore {
    const io = { ...defaultIO, ...options.io };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exists = fs.existsSync(file);
    const text = exists ? fs.readFileSync(file, 'utf8') : '';
    const parsed = parseConversation(text, file);
    const state = ConversationState.from(parsed.records, parsed.lines, file);
    const report: OpenReport = { created: !exists || parsed.records.length === 0 };

    if (parsed.damagedTail) {
      const raw = fs.readFileSync(file);
      const tail = raw.subarray(parsed.completeBytes);
      const dir = options.recoveredDir ?? path.join(path.dirname(file), 'recovered');
      fs.mkdirSync(dir, { recursive: true });
      const saved = path.join(dir, `${path.basename(file, '.md')}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
      fs.writeFileSync(saved, tail);
      fs.truncateSync(file, parsed.completeBytes);
      report.recoveredTo = path.relative(path.dirname(file), saved).split(path.sep).join('/');
      report.recoveredReason = `${parsed.damagedTail.reason} at line ${parsed.damagedTail.line}`;
    }

    const fd = fs.openSync(file, 'a');
    const size = fs.fstatSync(fd).size;
    const store = new FileConversationStore(file, state, fd, size, report, io);
    if (state.records.length === 0) {
      store.append({ kind: 'conversation', v: FORMAT_VERSION, id: newId('c_'), ...options.header });
    } else if (state.header && state.header.conversationKind !== options.header.conversationKind) {
      store.close();
      throw new ConversationStorageError(`${file} is a ${state.header.conversationKind} file, not a ${options.header.conversationKind}`);
    }
    if (report.recoveredTo) {
      store.append({ kind: 'recovery', reason: report.recoveredReason!, savedTo: report.recoveredTo, bytes: fs.statSync(path.resolve(path.dirname(file), report.recoveredTo)).size });
    }
    return store;
  }

  append(record: NewRecord): ConversationRecord {
    if (this.failed) throw this.failed;
    if (this.fd === undefined) throw new ConversationStorageError(`${this.file} is closed`);
    const full = complete(this.state, record);
    validate(this.state, full);
    let current: fs.Stats;
    try {
      current = fs.statSync(this.file);
    } catch (error) {
      throw this.fail(`cannot check ${this.file} before writing: ${getErrorMessage(error)}`, error);
    }
    if (current.size !== this.expectedSize) {
      throw this.fail(
        `${this.file} was changed by another program while SF Agents had it open (size ${current.size}, expected ${this.expectedSize}). Writing stopped to avoid corrupting history; close SF Agents, check the file, and reopen.`,
      );
    }
    const data = (this.expectedSize > 0 ? '\n' : '') + serializeRecord(full);
    try {
      this.io.write(this.fd, data);
      this.io.fsync(this.fd);
    } catch (error) {
      throw this.fail(`failed to write ${this.file}: ${getErrorMessage(error)}`, error);
    }
    this.expectedSize += Buffer.byteLength(data, 'utf8');
    this.state.apply(full);
    return full;
  }

  /** After a write failure the store refuses further writes. */
  private fail(message: string, cause?: unknown): ConversationStorageError {
    this.failed = new ConversationStorageError(message, cause);
    return this.failed;
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      fs.closeSync(this.fd);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EBADF') throw error;
    }
    this.fd = undefined;
  }
}

/** Reads a conversation without locking (inspection). */
export function readConversation(file: string): { state: ConversationState; damagedTail?: string } {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseConversation(text, file);
  return {
    state: ConversationState.from(parsed.records, parsed.lines, file),
    damagedTail: parsed.damagedTail ? `${parsed.damagedTail.reason} at line ${parsed.damagedTail.line}` : undefined,
  };
}

export { newId };
