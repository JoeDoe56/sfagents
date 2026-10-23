/**
 * ConversationService: the only writer of a conversation. Every runtime,
 * CLI and future graphical-client mutation goes through it.
 *
 * Responsibilities: open with the writer lock and conservative recovery,
 * record runs (main conversation and child transcripts), reset the working
 * context, and build the provider-facing working context from stored
 * history. Section operations and retrieval live in sections.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AgentNode } from '../agents/loader.js';
import type { AssistantMessage, ChatMessage, ToolMessage } from '../providers/types.js';
import type { AgentRunResult } from '../runtime/events.js';
import type { RunRecorder } from '../runtime/recorder.js';
import { ConversationLock } from './lock.js';
import { FileConversationStore, MemoryConversationStore, readConversation, type ConversationStore, type StoreIO } from './store.js';
import type { ConversationState } from './state.js';
import type { AttachmentRef, MessageRecord, ToolMessageStatus } from './types.js';
import type { ArtifactView } from './state.js';
import { userMessageFor } from './attachments.js';
import { ArtifactError, artifactTypeFor, mimeForFilename, safeFilename } from './artifacts.js';

export const STATE_DIR_NAME = '.sfagents';
export const CONVERSATION_FILE_NAME = 'conversation.md';

export function defaultConversationFile(configDir: string): string {
  return path.join(configDir, STATE_DIR_NAME, CONVERSATION_FILE_NAME);
}

export function newRunId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(10);
  return `r${[...bytes].map((b) => alphabet[b % 36]).join('')}`;
}

export interface OpenNotice {
  kind: 'created' | 'resumed' | 'recovered' | 'interrupted';
  message: string;
}

export interface ServiceOptions {
  /** Directory holding agent.json; definition paths are recorded relative to it. */
  configDir: string;
  io?: Partial<StoreIO>;
}

/** What the runtime needs to know to replay stored provider data safely. */
export interface ReplayTarget {
  provider: string;
  model: string;
}

function hashDefinition(node: AgentNode): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(node.definition)).digest('hex').slice(0, 16)}`;
}

/** Synthetic results for calls that never produced an observed result. */
export const INTERRUPTED_NOT_STARTED =
  '[SF Agents: interrupted] This tool call was requested but never started, because the previous session ended first. It had no effect. Re-issue it only if it is still needed.';
export const INTERRUPTED_UNKNOWN =
  '[SF Agents: interrupted] This tool call was started, but the session ended before its result was recorded. Its outcome is UNKNOWN: it may or may not have taken effect. Check the current state before retrying.';

export interface CreateArtifactInput {
  title: string;
  filename: string;
  content: string | Buffer;
  /** Defaults from the file name. */
  type?: string;
  mime?: string;
  run?: string;
  callId?: string;
}

/** An artifact that is a user's file, or an application on this computer. */
export interface LinkArtifactInput {
  title: string;
  /** Absolute path of the file (file artifacts). */
  file?: string;
  /** The application's address (application artifacts). */
  url?: string;
  /** Defaults from the file (document, code, image, …; "genui" in the GenUI folder) or "app". */
  type?: string;
  run?: string;
  callId?: string;
}

/** Project folder whose files are GenUI components (rendered inline in the chat; schema to come). */
export const GENUI_DIR_NAME = 'genui';

export interface UpdateArtifactInput {
  content: string | Buffer;
  title?: string;
  filename?: string;
  run?: string;
  callId?: string;
}

export interface ArtifactContent {
  view: ArtifactView;
  rev: number;
  filename: string;
  mime: string;
  data: Buffer;
}

/** Reads an attached file's bytes (undefined when it is missing). */
export type AttachmentResolver = (ref: AttachmentRef) => Buffer | undefined;

export class ConversationService {
  private readonly transcriptStores = new Map<string, ConversationStore>();
  /** Managed files of an in-memory conversation (artifacts, uploads). */
  private readonly memoryFiles = new Map<string, Buffer>();
  private closed = false;
  /** Run ID of the root turn in progress (for "current_exchange"). */
  activeRootRun: string | undefined;
  readonly notices: OpenNotice[] = [];

  private constructor(
    readonly main: ConversationStore,
    /** Directory holding the conversation file (undefined for memory). */
    readonly dir: string | undefined,
    readonly configDir: string,
    private readonly lock: ConversationLock | undefined,
    private readonly io: Partial<StoreIO> | undefined,
  ) {}

  /** An ephemeral conversation that lives only in memory. */
  static memory(configDir: string): ConversationService {
    return new ConversationService(new MemoryConversationStore(), undefined, configDir, undefined, undefined);
  }

  /** Opens (or creates) a persistent conversation, taking the writer lock. */
  static open(file: string, options: ServiceOptions): ConversationService {
    const absolute = path.resolve(file);
    const dir = path.dirname(absolute);
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (path.basename(dir) === STATE_DIR_NAME && !fs.existsSync(ignore)) {
      fs.writeFileSync(ignore, '# SF Agents local state: never commit.\n*\n');
    }
    const lockPath = path.join(dir, `${path.basename(absolute, '.md')}.lock`);
    const lock = ConversationLock.acquire(lockPath, absolute);
    let main: FileConversationStore;
    try {
      main = FileConversationStore.open(absolute, { header: { conversationKind: 'main' }, io: options.io });
    } catch (error) {
      lock.release();
      throw error;
    }
    const service = new ConversationService(main, dir, options.configDir, lock, options.io);
    try {
      service.noteOpen(main);
      service.recover(main, 'main conversation');
    } catch (error) {
      service.close();
      throw error;
    }
    return service;
  }

  get file(): string | undefined {
    return this.main.file;
  }

  get state(): ConversationState {
    return this.main.state;
  }

  private noteOpen(store: FileConversationStore): void {
    const n = store.state.messages.length;
    this.notices.push(
      store.report.created
        ? { kind: 'created', message: `Started a new conversation at ${store.file}` }
        : { kind: 'resumed', message: `Resumed ${store.file} (${n} message${n === 1 ? '' : 's'})` },
    );
    if (store.report.recoveredTo) {
      this.notices.push({
        kind: 'recovered',
        message: `Recovered from a damaged ending (${store.report.recoveredReason}); the unreadable bytes were saved to ${path.join(path.dirname(store.file), store.report.recoveredTo)}`,
      });
    }
  }

  /**
   * Marks runs that never ended as interrupted and classifies their tool
   * calls. Nothing is retried. Recurses into child transcripts whose
   * invoking call has no recorded result.
   */
  private recover(store: ConversationStore, label: string): void {
    const state = store.state;
    for (const run of state.unfinishedRuns()) {
      const notStarted: string[] = [];
      const unknown: string[] = [];
      for (const callId of run.requested.keys()) {
        if (run.results.has(callId)) continue;
        (run.started.has(callId) ? unknown : notStarted).push(callId);
      }
      store.append({ kind: 'interrupted', run: run.id, notStarted, unknown });
      const parts = [
        unknown.length ? `${unknown.length} tool call${unknown.length === 1 ? '' : 's'} with unknown outcome (${unknown.map((c) => run.requested.get(c)?.name).join(', ')})` : '',
        notStarted.length ? `${notStarted.length} never started` : '',
      ].filter(Boolean);
      this.notices.push({
        kind: 'interrupted',
        message: `A previous run of ${run.start?.agent ?? 'an agent'} in the ${label} was interrupted${parts.length ? `: ${parts.join('; ')}` : ''}. Nothing was retried automatically.`,
      });
    }
    if (!this.dir) return;
    for (const artifact of state.artifacts) {
      if (artifact.type !== 'agent_transcript' || !artifact.run || !artifact.path) continue;
      const parentRun = artifact.message ? state.messageById.get(artifact.message)?.run : undefined;
      const answered = artifact.callId && parentRun ? state.runs.get(parentRun)?.results.has(artifact.callId) : false;
      if (answered) continue;
      const file = path.join(this.dir, artifact.path);
      if (!fs.existsSync(file)) continue;
      const child = FileConversationStore.open(file, { header: { conversationKind: 'transcript', run: artifact.run }, io: this.io });
      try {
        this.recover(child, `transcript ${artifact.path}`);
      } finally {
        child.close();
      }
    }
  }

  /** Starts recording a root-agent run in the main conversation. */
  beginRootRun(node: AgentNode): RunRecorder {
    this.assertOpen();
    const recorder = new StoreRunRecorder(this, this.main, newRunId(), node.id, undefined, undefined);
    this.activeRootRun = recorder.runId;
    return recorder;
  }

  /**
   * Lists a thread between agents among this conversation's artifacts (once
   * per thread file): the interface shows it, and opens it as a conversation.
   */
  noteThread(relPath: string, title: string): void {
    if (this.closed) return;
    if (this.state.artifacts.some((a) => a.type === 'agent_transcript' && a.path === relPath)) return;
    this.main.append({ kind: 'artifact', id: `a${this.main.state.nextSeq}`, type: 'agent_transcript', title, path: relPath });
  }

  /** /clear: later working contexts start after this point; history stays searchable. */
  resetContext(): void {
    this.assertOpen();
    this.main.append({ kind: 'context_reset' });
  }

  /** @internal Creates the transcript store for a child run. */
  openTranscript(run: string, parentRun: string, agent: string): { store: ConversationStore; relPath: string | undefined } {
    if (!this.dir) {
      const store = new MemoryConversationStore({ conversationKind: 'transcript', run, parentRun, agent });
      this.transcriptStores.set(run, store);
      return { store, relPath: undefined };
    }
    const relPath = `transcripts/${run}.md`;
    const store = FileConversationStore.open(path.join(this.dir, relPath), {
      header: { conversationKind: 'transcript', run, parentRun, agent },
      io: this.io,
    });
    this.transcriptStores.set(run, store);
    return { store, relPath };
  }

  /** @internal */
  closeTranscript(run: string): void {
    const store = this.transcriptStores.get(run);
    if (store && this.dir) {
      store.close();
      this.transcriptStores.delete(run);
    }
  }

  /** Reads a child transcript (memory transcripts stay available for inspection). */
  transcript(run: string): ConversationState | undefined {
    const live = this.transcriptStores.get(run);
    if (live) return live.state;
    if (!this.dir) return undefined;
    const file = path.join(this.dir, 'transcripts', `${run}.md`);
    if (!fs.existsSync(file)) return undefined;
    return readConversation(file).state;
  }

  // -------------------------------------------------------------------------
  // Managed files (artifacts and uploads), relative to the state directory.

  /** Absolute path of a managed file, refusing anything outside the state directory. */
  managedPath(rel: string): string | undefined {
    if (!this.dir) return undefined;
    const abs = path.resolve(this.dir, rel);
    const relCheck = path.relative(this.dir, abs);
    if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return undefined;
    return abs;
  }

  private writeManaged(rel: string, data: Buffer): void {
    if (!this.dir) {
      this.memoryFiles.set(rel, data);
      return;
    }
    const abs = this.managedPath(rel);
    if (!abs) throw new ArtifactError(`Refusing to write outside the state directory: ${rel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const fd = fs.openSync(abs, 'wx');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Reads a managed file; undefined when missing or outside the state directory. */
  readManaged(rel: string): Buffer | undefined {
    if (!this.dir) return this.memoryFiles.get(rel);
    const abs = this.managedPath(rel);
    if (!abs) return undefined;
    try {
      return fs.readFileSync(abs);
    } catch {
      return undefined;
    }
  }

  /** Reads a user attachment's bytes. */
  readAttachment(ref: AttachmentRef): Buffer | undefined {
    if (!ref.path.startsWith('uploads/')) return undefined;
    return this.readManaged(ref.path);
  }

  /** Stores an attachment directly (in-memory conversations and tests; the web server uses up2k). */
  addUpload(name: string, mime: string, data: Buffer): AttachmentRef {
    this.assertOpen();
    const id = `u${randomBytes(8).toString('hex')}`;
    const rel = `uploads/${id}/${safeFilename(name, 'upload')}`;
    this.writeManaged(rel, data);
    return { id, name, mime, path: rel, size: data.length };
  }

  // -------------------------------------------------------------------------
  // Artifacts

  /** Artifacts, newest updated first. */
  artifacts(): ArtifactView[] {
    return [...this.state.artifactViews.values()].sort((a, b) => b.updatedSeq - a.updatedSeq);
  }

  private requireArtifact(id: string): ArtifactView {
    const view = this.state.artifactViews.get(id);
    if (!view) throw new ArtifactError(`There is no artifact "${id}". Use list_artifacts to see the IDs.`);
    return view;
  }

  /** Creates a model artifact: writes revision 1, then records it. */
  createArtifact(input: CreateArtifactInput): ArtifactView {
    this.assertOpen();
    const title = input.title.trim().slice(0, 200) || 'Untitled';
    const filename = safeFilename(input.filename);
    const id = `a${this.state.nextSeq}`;
    const rel = `artifacts/${id}/r1/${filename}`;
    this.writeManaged(rel, Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8'));
    const run = input.run;
    const message = run && input.callId ? this.state.runs.get(run)?.requested.get(input.callId)?.messageId : undefined;
    this.main.append({
      kind: 'artifact',
      id,
      type: input.type ?? artifactTypeFor(filename),
      title,
      path: rel,
      mime: input.mime ?? mimeForFilename(filename),
      ...(run ? { run } : {}),
      ...(message ? { message } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
    });
    return this.state.artifactViews.get(id)!;
  }

  /** Where a file artifact's path is recorded: relative to the project when inside it. */
  private recordedPath(abs: string): string {
    const rel = path.relative(this.configDir, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    return abs;
  }

  /** Resolves a recorded file path. */
  resolveArtifactFile(recorded: string): string {
    return path.isAbsolute(recorded) ? recorded : path.join(this.configDir, ...recorded.split('/'));
  }

  /** The display type of a file artifact: by its folder (GenUI), else by its extension. */
  fileArtifactType(abs: string): string {
    const rel = path.relative(this.configDir, abs).split(path.sep);
    if (rel.length > 1 && rel[0] === GENUI_DIR_NAME) return 'genui';
    return artifactTypeFor(abs);
  }

  /** Records an artifact that is a user's file (shown as it is on disk) or an app on this computer. Nothing is copied. */
  linkArtifact(input: LinkArtifactInput): ArtifactView {
    this.assertOpen();
    if (!input.file === !input.url) throw new ArtifactError('An artifact is either a file or an application address.');
    const title = input.title.trim().slice(0, 200) || 'Untitled';
    const id = `a${this.state.nextSeq}`;
    const run = input.run;
    const message = run && input.callId ? this.state.runs.get(run)?.requested.get(input.callId)?.messageId : undefined;
    this.main.append({
      kind: 'artifact',
      id,
      type: input.type ?? (input.file ? this.fileArtifactType(input.file) : 'app'),
      title,
      ...(input.file ? { file: this.recordedPath(input.file), mime: mimeForFilename(input.file) } : { url: input.url }),
      ...(run ? { run } : {}),
      ...(message ? { message } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
    });
    return this.state.artifactViews.get(id)!;
  }

  /** Retitles or repoints a linked artifact. */
  relinkArtifact(id: string, input: { title?: string; file?: string; url?: string; run?: string; callId?: string }): ArtifactView {
    this.assertOpen();
    const view = this.requireArtifact(id);
    if (view.type === 'agent_transcript') throw new ArtifactError(`Artifact ${id} is a thread between agents and cannot be changed.`);
    const title = input.title?.trim().slice(0, 200);
    const file = input.file ? this.recordedPath(input.file) : undefined;
    this.main.append({
      kind: 'artifact_update',
      artifact: id,
      rev: view.rev + 1,
      ...(title ? { title } : {}),
      ...(file ? { file, mime: mimeForFilename(input.file!) } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.run ? { run: input.run } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
    });
    return this.state.artifactViews.get(id)!;
  }

  /** Writes a new revision of a model artifact and records it. */
  updateArtifact(id: string, input: UpdateArtifactInput): ArtifactView {
    this.assertOpen();
    const view = this.requireArtifact(id);
    if (view.type === 'agent_transcript') throw new ArtifactError(`Artifact ${id} is an agent transcript and cannot be edited.`);
    const rev = view.rev + 1;
    const filename = safeFilename(input.filename ?? (view.path ? path.posix.basename(view.path) : 'artifact.txt'));
    const rel = `artifacts/${id}/r${rev}/${filename}`;
    this.writeManaged(rel, Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8'));
    const title = input.title?.trim().slice(0, 200);
    const mime = mimeForFilename(filename);
    this.main.append({
      kind: 'artifact_update',
      artifact: id,
      rev,
      path: rel,
      ...(title ? { title } : {}),
      ...(mime !== view.mime ? { mime } : {}),
      ...(input.run ? { run: input.run } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
    });
    return this.state.artifactViews.get(id)!;
  }

  /** Pins or unpins an artifact (a user action). No record when nothing changes. */
  setArtifactPinned(id: string, pinned: boolean): ArtifactView {
    this.assertOpen();
    const view = this.requireArtifact(id);
    if (view.pinned !== pinned) this.main.append({ kind: 'artifact_pin', artifact: id, pinned });
    return this.state.artifactViews.get(id)!;
  }

  /** Path (relative to the state directory) of a given revision. */
  artifactRevisionPath(id: string, rev?: number): string | undefined {
    const view = this.requireArtifact(id);
    const wanted = rev ?? view.rev;
    if (wanted === view.rev) return view.path;
    if (wanted < 1 || wanted > view.rev) throw new ArtifactError(`Artifact ${id} has revisions 1 to ${view.rev}.`);
    if (wanted === 1) return this.state.artifactById.get(id)?.path;
    let found: string | undefined;
    for (const r of this.state.records) {
      if (r.kind === 'artifact_update' && r.artifact === id && r.rev <= wanted && r.path) found = r.path;
    }
    return found ?? this.state.artifactById.get(id)?.path;
  }

  /** The bytes of an artifact revision (latest by default). */
  artifactContent(id: string, rev?: number): ArtifactContent {
    const view = this.requireArtifact(id);
    if (view.url && !view.file) throw new ArtifactError(`Artifact ${id} is an application (${view.url}), not a file.`);
    if (view.file) {
      const abs = this.resolveArtifactFile(view.file);
      let data: Buffer;
      try {
        data = fs.readFileSync(abs);
      } catch {
        throw new ArtifactError(`The file of artifact ${id} is missing: ${abs}`);
      }
      return { view, rev: view.rev, filename: path.basename(abs), mime: mimeForFilename(abs), data };
    }
    const rel = this.artifactRevisionPath(id, rev);
    if (!rel) throw new ArtifactError(`Artifact ${id} has no stored content.`);
    const data = this.readManaged(rel);
    if (!data) throw new ArtifactError(`The file for artifact ${id} is missing (${rel}).`);
    const filename = path.posix.basename(rel);
    return { view, rev: rev ?? view.rev, filename, mime: view.type === 'agent_transcript' ? 'text/markdown' : mimeForFilename(filename), data };
  }

  /** Where an artifact's latest revision is stored on disk (undefined for in-memory conversations). */
  artifactFile(id: string): string | undefined {
    const view = this.requireArtifact(id);
    if (view.file) return this.resolveArtifactFile(view.file);
    if (view.url) return undefined;
    if (!this.dir) return undefined;
    const rel = this.artifactRevisionPath(id);
    return rel ? this.managedPath(rel) ?? undefined : undefined;
  }

  /** Paths that agent file tools must never read or write. */
  protectedPaths(): string[] {
    if (!this.main.file || !this.dir) return [];
    const base = path.basename(this.main.file, '.md');
    if (path.basename(this.dir) === STATE_DIR_NAME) return [this.dir];
    return [
      this.main.file,
      path.join(this.dir, `${base}.lock`),
      path.join(this.dir, 'transcripts'),
      path.join(this.dir, 'recovered'),
      path.join(this.dir, 'artifacts'),
      path.join(this.dir, 'uploads'),
    ];
  }

  /**
   * Converts stored history after the last context reset into provider
   * messages. Tool results are placed directly after the assistant message
   * that requested them; calls without an observed result get a labelled
   * synthetic result so the request stays protocol-valid. Opaque reasoning
   * continuation data is replayed only to the provider and model that
   * produced it.
   */
  history(target: ReplayTarget, fromSeq = this.state.lastResetSeq): ChatMessage[] {
    return toChatMessages(this.state, target, fromSeq, undefined, (ref) => this.readAttachment(ref));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The conversation is closed');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const store of this.transcriptStores.values()) store.close();
    this.transcriptStores.clear();
    this.main.close();
    this.lock?.release();
  }
}

/** Converts stored messages (from `fromSeq` on) into a protocol-valid provider history. */
export function toChatMessages(
  state: ConversationState,
  target: ReplayTarget,
  fromSeq = 0,
  messages?: readonly MessageRecord[],
  resolveAttachment?: AttachmentResolver,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const list = messages ?? state.messages.filter((m) => m.seq > fromSeq);
  for (const m of list) {
    if (m.role === 'user') {
      out.push(userMessageFor(m, resolveAttachment));
    } else if (m.role === 'assistant') {
      const run = state.runs.get(m.run);
      const sameModel = run?.start?.provider === target.provider && run?.start?.model === target.model;
      const msg: AssistantMessage = { role: 'assistant', content: m.content.length > 0 ? m.content : null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      }
      if (sameModel && m.reasoningDetails) msg.reasoning_details = m.reasoningDetails;
      else if (sameModel && m.reasoning) msg.reasoning = m.reasoning;
      out.push(msg);
      for (const call of m.toolCalls ?? []) {
        const result = run?.results.get(call.id);
        if (result) {
          out.push({ role: 'tool', tool_call_id: call.id, content: result.content });
        } else {
          const started = run?.started.has(call.id) ?? false;
          out.push({ role: 'tool', tool_call_id: call.id, content: started ? INTERRUPTED_UNKNOWN : INTERRUPTED_NOT_STARTED });
        }
      }
    }
    // Tool messages are emitted with their assistant message above.
  }
  return out;
}

/** RunRecorder writing to one store (main conversation or a transcript). */
class StoreRunRecorder implements RunRecorder {
  /** callId → assistant message id that requested it. */
  private readonly callMessage = new Map<string, string>();

  constructor(
    private readonly service: ConversationService,
    private readonly store: ConversationStore,
    readonly runId: string,
    private readonly agent: string,
    private readonly parentRun: string | undefined,
    private readonly parentCallId: string | undefined,
  ) {}

  private message(fields: Omit<MessageRecord, 'kind' | 'seq' | 'time' | 'id' | 'run' | 'agent' | 'section'>): MessageRecord {
    const state = this.store.state;
    const section = this.store === this.service.main && fields.role !== 'tool' ? (state.currentSection ?? undefined) : undefined;
    return this.store.append({
      kind: 'message',
      id: `m${state.nextSeq}`,
      run: this.runId,
      agent: this.agent,
      ...(section ? { section } : {}),
      ...fields,
    }) as MessageRecord;
  }

  user(content: string, attachments?: AttachmentRef[]): void {
    this.message({ role: 'user', content, ...(attachments?.length ? { attachments } : {}) });
  }

  start(node: AgentNode): void {
    const d = node.definition;
    this.store.append({
      kind: 'run_start',
      run: this.runId,
      agent: this.agent,
      ...(this.parentRun ? { parentRun: this.parentRun, callId: this.parentCallId } : {}),
      provider: d.provider === 'openai-compatible' ? `openai-compatible:${d.providerOptions?.baseUrl}` : d.provider,
      model: d.model,
      ...(d.reasoning ? { reasoning: d.reasoning } : {}),
      config: path.relative(this.service.configDir, node.file).split(path.sep).join('/'),
      configHash: hashDefinition(node),
    });
  }

  assistant(message: AssistantMessage, finishReason: string | null): void {
    const record = this.message({
      role: 'assistant',
      content: message.content ?? '',
      ...(message.tool_calls?.length
        ? { toolCalls: message.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) }
        : {}),
      ...(message.reasoning_details ? { reasoningDetails: message.reasoning_details } : {}),
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(finishReason ? { finish: finishReason } : {}),
    });
    for (const c of message.tool_calls ?? []) this.callMessage.set(c.id, record.id);
  }

  toolStart(callId: string, tool: string): void {
    this.store.append({ kind: 'tool_start', run: this.runId, callId, tool });
  }

  toolResult(message: ToolMessage, tool: string, status: ToolMessageStatus): void {
    this.message({ role: 'tool', content: message.content, callId: message.tool_call_id, tool, status });
  }

  end(result: AgentRunResult): void {
    const usage: Record<string, number> = {};
    for (const [k, v] of Object.entries(result.usage)) if (typeof v === 'number') usage[k] = v;
    this.store.append({
      kind: 'run_end',
      run: this.runId,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      turns: result.turns,
      ...(Object.keys(usage).length ? { usage } : {}),
    });
    if (this.parentRun) this.service.closeTranscript(this.runId);
  }

}
