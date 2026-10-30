/**
 * Threads: the persistent conversations between pairs of agents.
 *
 * Whenever agent A messages agent B they talk in the same thread, whichever
 * of them started it and whichever is the main conversation's agent; the
 * thread's file keeps everything either has said. A pair may hold up to N
 * threads at once (N from the "N-name.json" grant of the one who writes),
 * so several instances of an agent can work in parallel; thread 1 is the
 * one they return to.
 *
 * A thread is a conversation file (docs/CONVERSATION-FORMAT.md, kind
 * "thread") under `.sfagents/threads/`: each message from the writing agent
 * is a user message tagged with its name, followed by the replying agent's
 * run (its reasoning, tool calls and reply).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatMessage } from '../providers/types.js';
import { FileConversationStore, MemoryConversationStore, readConversation, type ConversationStore, type StoreIO } from '../conversation/store.js';
import type { ConversationState } from '../conversation/state.js';
import { toChatMessages, type ReplayTarget } from '../conversation/service.js';
import { estimateMessages } from '../conversation/context.js';
import type { MessageRecord, ToolMessageStatus } from '../conversation/types.js';
import type { AssistantMessage, ToolMessage } from '../providers/types.js';
import type { RunRecorder } from '../runtime/recorder.js';
import type { AgentRunResult } from '../runtime/events.js';
import type { AgentNode } from './loader.js';

export const THREADS_DIR_NAME = 'threads';

export class ThreadBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadBusyError';
  }
}

/** File-safe form of an agent name. */
function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

/** Agents in a stable order, so A→B and B→A are the same thread. */
export function threadPair(a: string, b: string): [string, string] {
  return a.localeCompare(b) <= 0 ? [a, b] : [b, a];
}

export function threadKey(a: string, b: string, instance = 1): string {
  const [x, y] = threadPair(a, b);
  return `${slug(x)}--${slug(y)}${instance > 1 ? `--${instance}` : ''}`;
}

export interface ThreadInfo {
  key: string;
  agents: [string, string];
  instance: number;
  /** Path relative to the state directory, e.g. "threads/main--worker.md". */
  path: string;
  messages: number;
  updated: string | undefined;
  /** An exchange is running in it now. */
  busy: boolean;
}

interface Holder {
  writer: string;
  replier: string;
}

export interface ThreadLease {
  key: string;
  instance: number;
  store: ConversationStore;
  relPath: string;
  release(): void;
}

export class ThreadService {
  private readonly stores = new Map<string, ConversationStore>();
  private readonly holders = new Map<string, Holder>();
  private waiters: Array<() => void> = [];

  constructor(
    /** The state directory (".sfagents"); undefined keeps threads in memory. */
    readonly stateDir: string | undefined,
    private readonly io?: Partial<StoreIO>,
  ) {}

  relPath(key: string): string {
    return `${THREADS_DIR_NAME}/${key}.md`;
  }

  private open(key: string, agents: [string, string], instance: number): ConversationStore {
    let store = this.stores.get(key);
    if (store) return store;
    const header = { conversationKind: 'thread' as const, agent: agents.join(','), run: instance > 1 ? `instance-${instance}` : undefined };
    store = this.stateDir
      ? FileConversationStore.open(path.join(this.stateDir, this.relPath(key)), { header, io: this.io })
      : new MemoryConversationStore(header);
    this.stores.set(key, store);
    return store;
  }

  /**
   * Takes a thread between `writer` and `replier` for one exchange: the
   * lowest-numbered free one of the `max` the writer may use, waiting for
   * one to free up if all are busy. When every one is busy because the
   * replier is waiting on the writer (it asked the writer something), waiting
   * would never end, so this throws instead.
   */
  async acquire(writer: string, replier: string, max: number, signal: AbortSignal, preferred?: number): Promise<ThreadLease> {
    const pair = threadPair(writer, replier);
    for (;;) {
      if (signal.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
      const order = preferred && preferred >= 1 && preferred <= max ? [preferred] : Array.from({ length: max }, (_, i) => i + 1);
      for (const instance of order) {
        const key = threadKey(writer, replier, instance);
        if (this.holders.has(key)) continue;
        const holder = { writer, replier };
        this.holders.set(key, holder);
        let store: ConversationStore;
        try {
          store = this.open(key, pair, instance);
        } catch (error) {
          this.holders.delete(key);
          throw error;
        }
        let released = false;
        return {
          key,
          instance,
          store,
          relPath: this.relPath(key),
          release: () => {
            if (released) return;
            released = true;
            this.holders.delete(key);
            const wake = this.waiters;
            this.waiters = [];
            wake.forEach((w) => w());
          },
        };
      }
      const busy = order.map((i) => this.holders.get(threadKey(writer, replier, i))).filter(Boolean) as Holder[];
      if (busy.length && busy.every((h) => h.writer === replier && h.replier === writer)) {
        throw new ThreadBusyError(
          `"${replier}" is waiting for your reply in your thread${max > 1 ? 's' : ''} with it, so it cannot take a new message now. Put what you want to tell or ask it in your reply instead.`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }));
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
  }

  /** Every thread on disk (or in memory), newest first. */
  list(): ThreadInfo[] {
    const infos: ThreadInfo[] = [];
    const seen = new Set<string>();
    const add = (key: string, state: ConversationState | undefined, mtime?: Date) => {
      if (seen.has(key)) return;
      seen.add(key);
      const header = state?.header;
      const agents = (header?.agent ?? '').split(',') as [string, string];
      if (agents.length !== 2) return;
      const instance = Number(/--(\d+)$/.exec(key)?.[1] ?? 1);
      const last = state?.records[state.records.length - 1];
      infos.push({
        key,
        agents,
        instance,
        path: this.relPath(key),
        // Messages written plus replies given.
        messages: (state?.messages.filter((m) => m.role === 'user').length ?? 0) + [...(state?.runs.values() ?? [])].filter((r) => r.end).length,
        updated: last?.time ?? mtime?.toISOString(),
        busy: this.holders.has(key),
      });
    };
    for (const [key, store] of this.stores) add(key, store.state);
    if (this.stateDir) {
      const dir = path.join(this.stateDir, THREADS_DIR_NAME);
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.md')) continue;
          const key = name.slice(0, -3);
          if (seen.has(key)) continue;
          try {
            add(key, readConversation(path.join(dir, name)).state, fs.statSync(path.join(dir, name)).mtime);
          } catch {
            // an unreadable file is not listed
          }
        }
      }
    }
    return infos.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  }

  /** A thread's records (live while open, else read from disk). */
  read(key: string): ConversationState | undefined {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) return undefined;
    const live = this.stores.get(key);
    if (live) return live.state;
    if (!this.stateDir) return undefined;
    const file = path.join(this.stateDir, this.relPath(key));
    return fs.existsSync(file) ? readConversation(file).state : undefined;
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}

/**
 * The thread as `agent` sees it: the other agent's messages and replies as
 * user messages, its own past turns (with their tool calls) as they were.
 * Oldest exchanges drop off to stay within `budget` estimated tokens; the
 * newest message is always kept.
 */
export function threadMessages(state: ConversationState, agent: string, target: ReplayTarget, budget: number): { messages: ChatMessage[]; omitted: number } {
  const runAgent = (m: MessageRecord) => state.runs.get(m.run)?.start?.agent;
  // Exchanges: a message from the other agent and the run that answered it.
  const exchanges: ChatMessage[][] = [];
  let current: ChatMessage[] | null = null;
  const replies = new Map<string, string>(); // run → final reply text (the other agent's runs)
  for (const m of state.messages) {
    if (m.role === 'assistant' && m.content && runAgent(m) !== agent) replies.set(m.run, m.content);
  }
  const emittedReply = new Set<string>();
  for (const m of state.messages) {
    if (m.role === 'user' && m.event === 'agent') {
      // A third agent's message that reached the replying agent mid-run: only that agent saw it.
      if (runAgent(m) !== agent) continue;
      if (!current) exchanges.push((current = []));
      current.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'user') {
      if (m.agent === agent) {
        // Its own earlier message to the other agent (when it wrote first).
        current = [{ role: 'assistant', content: m.content }];
      } else {
        current = [{ role: 'user', content: m.content }];
      }
      exchanges.push(current);
      continue;
    }
    if (!current) {
      current = [];
      exchanges.push(current);
    }
    if (runAgent(m) === agent) {
      if (m.role === 'assistant') current.push(...toChatMessages(state, target, 0, [m]));
    } else if (m.role === 'assistant' && !emittedReply.has(m.run) && replies.get(m.run) === m.content) {
      // The other agent's reply to a message this agent wrote.
      emittedReply.add(m.run);
      current.push({ role: 'user', content: m.content });
    }
  }
  // Adjacent same-role plain messages are merged so providers accept the sequence.
  const flat = (groups: ChatMessage[][]) => {
    const out: ChatMessage[] = [];
    for (const msg of groups.flat()) {
      const prev = out[out.length - 1];
      if (prev && prev.role === msg.role && (msg.role === 'user' || (msg.role === 'assistant' && !('tool_calls' in msg && msg.tool_calls) && !('tool_calls' in prev && prev.tool_calls))) && typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = `${prev.content}\n\n${msg.content}`;
      } else out.push({ ...msg } as ChatMessage);
    }
    // Providers want a user message first: when this agent wrote first, say so.
    if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(Your thread so far. You wrote first.)' });
    return out;
  };
  let start = 0;
  while (start < exchanges.length - 1 && estimateMessages(flat(exchanges.slice(start))) > budget) start++;
  return { messages: flat(exchanges.slice(start)), omitted: start };
}

/** Records the replying agent's run in a thread's file. */
export class ThreadRecorder implements RunRecorder {
  constructor(
    private readonly store: ConversationStore,
    readonly runId: string,
    private readonly agent: string,
    private readonly configDir: string,
  ) {}

  private message(fields: Omit<MessageRecord, 'kind' | 'seq' | 'time' | 'id' | 'run' | 'agent' | 'section'>): MessageRecord {
    return this.store.append({ kind: 'message', id: `m${this.store.state.nextSeq}`, run: this.runId, agent: this.agent, ...fields }) as MessageRecord;
  }

  user(content: string): void {
    this.message({ role: 'user', content });
  }

  note(from: string, content: string): void {
    this.store.append({ kind: 'message', id: `m${this.store.state.nextSeq}`, run: this.runId, agent: from, role: 'user', content, event: 'agent' });
  }

  start(node: AgentNode): void {
    const d = node.definition;
    this.store.append({
      kind: 'run_start',
      run: this.runId,
      agent: this.agent,
      provider: d.provider === 'openai-compatible' ? `openai-compatible:${d.providerOptions?.baseUrl}` : d.provider,
      model: d.model,
      ...(d.reasoning ? { reasoning: d.reasoning } : {}),
      config: path.relative(this.configDir, node.file).split(path.sep).join('/'),
      configHash: `sha256:${createHash('sha256').update(JSON.stringify(node.definition)).digest('hex').slice(0, 16)}`,
    });
  }

  assistant(message: AssistantMessage, finishReason: string | null): void {
    this.message({
      role: 'assistant',
      content: message.content ?? '',
      ...(message.tool_calls?.length ? { toolCalls: message.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })) } : {}),
      ...(message.reasoning_details ? { reasoningDetails: message.reasoning_details } : {}),
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(finishReason ? { finish: finishReason } : {}),
    });
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
  }
}
