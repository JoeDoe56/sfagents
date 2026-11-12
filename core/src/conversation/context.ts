/**
 * Working-context policy: which part of the stored conversation each model
 * request sees.
 *
 * The stored history stays complete; every request gets a selected view:
 *   1. the system prompt and tool schemas (fixed cost),
 *   2. a bounded section index (titles, IDs, ranges; current section first),
 *   3. the most recent complete exchanges that fit, newest first, never
 *      splitting an assistant tool call from its results,
 *   4. a note naming what was left out and how to retrieve it.
 * A share of the budget is reserved for tool results and fetched sections
 * produced during the turn. Token counts are estimates (characters / 4);
 * exact tokenization is provider-specific and not available here.
 */

import type { ChatMessage } from '../providers/types.js';
import type { ConversationState } from './state.js';
import { toChatMessages, type AttachmentResolver, type ReplayTarget } from './service.js';
import { IMAGE_TOKEN_ESTIMATE } from './attachments.js';
import { sectionEntries, unassignedMessages } from './sections.js';
import type { MessageRecord } from './types.js';

export const DEFAULT_MAX_INPUT_TOKENS = 48_000;
export const DEFAULT_RECENT_EXCHANGES = 12;
/** Share of the budget kept free for tool results and fetched history during the turn. */
export const TURN_RESERVE = 0.25;
/** Share of the budget the section index may use. */
const INDEX_SHARE = 0.08;
/** When older exchanges must go, the context restarts at this share of the room (and of the exchange limit). */
const BATCH_KEEP = 0.6;
const MAX_INDEX_ENTRIES = 60;

export interface ContextPolicy {
  maxInputTokens?: number;
  recentExchanges?: number;
  oldMessagesPercent?: number;
}

export interface ContextReport {
  /** Estimated tokens of everything sent before the model's first reply. */
  estimatedTokens: number;
  budget: number;
  includedExchanges: number;
  omittedExchanges: number;
  indexEntries: number;
  indexTotal: number;
}

export interface WorkingContext {
  messages: ChatMessage[];
  /** Seq of the first message of the oldest exchange included (pass it back as floorSeq next time). */
  floorSeq?: number;
  /** Exchanges before this seq had long tool output stubbed (pass it back as stubBefore next time). */
  stubBefore?: number;
  /** Section index and retrieval notes, appended to the system prompt. */
  systemExtra?: string;
  report: ContextReport;
}

export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextBudgetError';
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimated tokens of provider messages; image parts count a fixed amount, not their base64 size. */
export function estimateMessages(messages: readonly ChatMessage[]): number {
  let images = 0;
  const json = JSON.stringify(messages, (key, value) => {
    if (key === 'image_url') {
      images++;
      return '';
    }
    return value;
  });
  return estimateTokens(json) + images * IMAGE_TOKEN_ESTIMATE;
}

/** Groups stored messages into exchanges, each starting with a user message. */
function exchanges(messages: readonly MessageRecord[]): MessageRecord[][] {
  const groups: MessageRecord[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || groups.length === 0) groups.push([m]);
    else groups[groups.length - 1]!.push(m);
  }
  return groups;
}

function buildIndex(state: ConversationState, maxTokens: number, retrievable: boolean): { text?: string; shown: number; total: number } {
  const entries = sectionEntries(state);
  if (entries.length === 0) return { shown: 0, total: 0 };
  // Priority: current section and its ancestors, then most recently used.
  const priority = new Set<string>();
  if (state.currentSection) {
    for (const a of state.ancestors(state.currentSection)) priority.add(a.id);
    priority.add(state.currentSection);
  }
  const byRecency = [...entries].sort((a, b) => (b.lastSeq ?? b.depth) - (a.lastSeq ?? a.depth));
  for (const e of byRecency) {
    if (priority.size >= MAX_INDEX_ENTRIES) break;
    for (const a of state.ancestors(e.id)) priority.add(a.id);
    priority.add(e.id);
  }
  const lines: string[] = [];
  let shown = 0;
  let tokens = 0;
  for (const e of entries) {
    if (!priority.has(e.id)) continue;
    // Keep parents of shown entries visible for hierarchy.
    const line = `${'  '.repeat(e.depth)}- [${e.id}] ${e.title} (${e.messages} msg${e.firstSeq ? `, m${e.firstSeq}–m${e.lastSeq}` : ''})${e.current ? ' ← current' : ''}`;
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens) break;
    lines.push(line);
    tokens += cost;
    shown++;
  }
  const unassigned = unassignedMessages(state).length;
  const more = entries.length - shown;
  const header = `<conversation_sections revision="${state.structureRevision}">`;
  const footer = [
    more > 0 ? `${more} more section(s) not listed${retrievable ? ' — message action "sections" lists them (paginated)' : ''}.` : '',
    unassigned > 0 ? `${unassigned} message(s) are not in any section.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { text: [header, ...lines, ...(footer ? [footer] : []), '</conversation_sections>'].join('\n'), shown, total: entries.length };
}

/**
 * Builds the provider messages and system-prompt extra for one root turn.
 * `fixedText` is the base system prompt plus serialized tool schemas.
 * The last exchange (holding the new user message) is always included; if
 * it alone exceeds the budget, a ContextBudgetError explains why.
 */
export function buildWorkingContext(
  state: ConversationState,
  target: ReplayTarget,
  policy: ContextPolicy,
  fixedText: string,
  options: {
    retrievable: boolean;
    resolveAttachment?: AttachmentResolver;
    floorSeq?: number;
    /** The stub point last used; kept unless the context starts again anyway. */
    stubBefore?: number;
    /** Something before the messages changed (system prompt, tools): the provider rereads everything anyway. */
    rebuild?: boolean;
  },
): WorkingContext {
  const budget = policy.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const window = policy.recentExchanges ?? DEFAULT_RECENT_EXCHANGES;
  const fixed = estimateTokens(fixedText);
  const usable = Math.floor(budget * (1 - TURN_RESERVE)) - fixed;
  const index = buildIndex(state, Math.floor(budget * INDEX_SHARE), options.retrievable);
  const indexTokens = index.text ? estimateTokens(index.text) : 0;

  const groups = exchanges(state.messages.filter((m) => m.seq > state.lastResetSeq));
  // Long tool output from earlier replies is stubbed (the message tool's
  // "output" action gets it back). Where the stubs start changes only when
  // the context starts again anyway (an older batch dropped, or the system
  // prompt changed), so stubbing never costs a cache rewrite of its own.
  const convert = (stubBefore: number | undefined) =>
    groups.map((g) => toChatMessages(state, target, 0, g, options.resolveAttachment, options.retrievable && stubBefore !== undefined && (g[0]?.seq ?? 0) < stubBefore));
  let stubBefore = options.retrievable && !options.rebuild ? options.stubBefore : undefined;
  let converted = convert(stubBefore);
  if (converted.length === 0) {
    return { messages: [], systemExtra: index.text, report: { estimatedTokens: fixed + indexTokens, budget, includedExchanges: 0, omittedExchanges: 0, indexEntries: index.shown, indexTotal: index.total } };
  }

  const current = converted[converted.length - 1]!;
  const currentSeq = groups[groups.length - 1]![0]!.seq;
  const currentTokens = estimateMessages(current);
  let remaining = usable - indexTokens - 200; // room for the retrieval note
  if (currentTokens > remaining) {
    throw new ContextBudgetError(
      `The current message needs about ${currentTokens} tokens (estimated), but only about ${Math.max(0, remaining)} of the ${budget}-token context budget remain after the system prompt, tools and section index. Shorten the message, or raise context.maxInputTokens in agent.json.`,
    );
  }
  remaining -= currentTokens;
  if (policy.oldMessagesPercent !== undefined) remaining = Math.min(remaining, Math.floor(budget * policy.oldMessagesPercent / 100));
  // Older exchanges are dropped in batches, not one per reply: the start of
  // the context then stays the same for many replies, so the provider's
  // prompt cache keeps serving it (any change there makes the provider
  // process everything after it again). While everything from the last
  // starting point still fits, it is kept as it is; once it does not, the
  // context starts again from a later exchange, leaving room to grow.
  const pick = (room: number, limit: number, floor?: number): ChatMessage[][] => {
    const current = converted[converted.length - 1]!;
    const out: ChatMessage[][] = [current];
    let left = room;
    for (let i = converted.length - 2; i >= 0 && out.length < limit; i--) {
      if (floor !== undefined && (groups[i]![0]?.seq ?? 0) < floor) break;
      const cost = estimateMessages(converted[i]!);
      if (cost > left) return floor !== undefined ? [] : out;
      out.unshift(converted[i]!);
      left -= cost;
    }
    return out;
  };
  const floorIndex = options.floorSeq === undefined ? -1 : groups.findIndex((g) => (g[0]?.seq ?? 0) >= options.floorSeq!);
  // Everything since the floor, if it all fits (no exchange in between left out).
  const sinceFloor = (): ChatMessage[][] => {
    if (floorIndex < 0) return [];
    const out = pick(remaining, window, groups[floorIndex]![0]!.seq);
    return out.length === converted.length - floorIndex ? out : [];
  };
  let included = stubBefore === undefined && options.retrievable ? [] : sinceFloor();
  if (!included.length) {
    // The context starts again: stub everything before the current exchange.
    if (options.retrievable) {
      stubBefore = currentSeq;
      converted = convert(stubBefore);
      included = sinceFloor();
    }
    if (!included.length) included = floorIndex >= 0 ? pick(Math.floor(remaining * BATCH_KEEP), Math.max(1, Math.floor(window * BATCH_KEEP))) : pick(remaining, window);
  }
  const omitted = converted.length - included.length;
  const messages = included.flat();
  const floorSeq = groups[groups.length - included.length]?.[0]?.seq;

  const notes: string[] = [];
  if (omitted > 0 || state.lastResetSeq > 0) {
    const parts = [
      omitted > 0 ? `${omitted} earlier exchange(s) since the last context reset are not shown` : '',
      state.lastResetSeq > 0 ? 'messages before the last context reset are not shown' : '',
    ].filter(Boolean);
    notes.push(
      `Context note: ${parts.join('; ')}.${options.retrievable ? ' They are stored: use message with action "search" or "sections" (op "fetch") when the person refers to them.' : ''}`,
    );
  }
  if (options.retrievable && state.currentSection) {
    const earliest = earliestIncludedSeq(groups, included.length);
    const hidden = state.messages.filter((m) => m.role !== 'tool' && m.seq < earliest && state.sectionOf(m.id) === state.currentSection).length;
    if (hidden > 0) notes.push(`The current section [${state.currentSection}] has ${hidden} earlier message(s) outside this context; message action "sections" with op "fetch" and section "${state.currentSection}" retrieves them.`);
  }
  const systemExtra = [index.text, ...notes].filter(Boolean).join('\n\n') || undefined;
  const estimatedTokens = fixed + (systemExtra ? estimateTokens(systemExtra) : 0) + estimateMessages(messages);
  return {
    messages,
    ...(floorSeq !== undefined ? { floorSeq } : {}),
    ...(stubBefore !== undefined ? { stubBefore } : {}),
    systemExtra,
    report: { estimatedTokens, budget, includedExchanges: included.length, omittedExchanges: omitted, indexEntries: index.shown, indexTotal: index.total },
  };
}

function earliestIncludedSeq(groups: MessageRecord[][], includedCount: number): number {
  const first = groups[groups.length - includedCount];
  return first?.[0]?.seq ?? Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Context breakdown (the web interface's context view)

export interface ContextTool {
  name: string;
  /** "builtin", "mcp", "agents" or "conversation". */
  group: 'builtin' | 'mcp' | 'agents' | 'conversation';
  /** MCP server name, for MCP tools. */
  server?: string;
  /** The tool's schema as sent to the model. */
  schema: unknown;
  /**
   * A command run through another tool (sfa-web and sfa-artifact, in the
   * shell): listed with its usage, but its tokens are already that tool's.
   */
  partOf?: string;
}

export interface ContextBreakdown {
  /** The working-context budget (context.maxInputTokens). */
  budget: number;
  /** Kept free for tool results and fetched history during a turn. */
  reserve: number;
  /** Estimated tokens the next request would carry before a new message. */
  used: number;
  free: number;
  categories: Array<{
    id: 'system' | 'builtin' | 'mcp' | 'agents' | 'conversation' | 'index' | 'messages';
    label: string;
    tokens: number;
    items?: Array<{ name: string; tokens: number; detail?: string; schema?: unknown; partOf?: string }>;
  }>;
  exchanges: { included: number; omitted: number; recentLimit: number; sinceReset: number };
  sections: { shown: number; total: number };
  /** Set when even the latest exchange does not fit the budget. */
  problem?: string;
}

/**
 * Splits what the next root request would carry into the parts a person
 * cares about: the system prompt, each tool family (per tool), the section
 * index and notes, and the stored messages that fit. Estimates use the same
 * characters / 4 rule as the working context itself.
 */
export function contextBreakdown(
  state: ConversationState,
  target: ReplayTarget,
  policy: ContextPolicy,
  systemPrompt: string,
  tools: readonly ContextTool[],
  options: { retrievable: boolean; resolveAttachment?: AttachmentResolver; extraSystem?: string },
): ContextBreakdown {
  const budget = policy.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const reserve = Math.floor(budget * TURN_RESERVE);
  const fixedText = systemPrompt + JSON.stringify(tools.filter((t) => !t.partOf).map((t) => t.schema));
  let working: WorkingContext | undefined;
  let problem: string | undefined;
  try {
    working = buildWorkingContext(state, target, policy, fixedText, options);
  } catch (error) {
    if (!(error instanceof ContextBudgetError)) throw error;
    problem = error.message;
  }
  const toolTokens = (t: ContextTool) => estimateTokens(JSON.stringify(t.schema));
  const family = (group: ContextTool['group']) => tools.filter((t) => t.group === group);
  const itemsOf = (list: readonly ContextTool[]) =>
    list
      .map((t) => ({ name: t.name, tokens: toolTokens(t), ...(t.server ? { detail: t.server } : t.partOf ? { detail: `command in ${t.partOf}`, partOf: t.partOf } : {}), schema: t.schema }))
      .sort((a, b) => b.tokens - a.tokens);
  const sum = (list: Array<{ tokens: number; partOf?: string }>) => list.reduce((a, x) => a + (x.partOf ? 0 : x.tokens), 0);
  const builtin = itemsOf(family('builtin'));
  const mcp = itemsOf(family('mcp'));
  const agents = itemsOf(family('agents'));
  const conversation = itemsOf(family('conversation'));
  const indexText = [working?.systemExtra, options.extraSystem].filter(Boolean).join('\n\n');
  const messagesTokens = working?.messages.length ? estimateMessages(working.messages) : 0;
  const categories: ContextBreakdown['categories'] = [
    { id: 'system', label: 'System prompt', tokens: estimateTokens(systemPrompt) },
    { id: 'builtin', label: 'Built-in tools', tokens: sum(builtin), items: builtin },
    { id: 'mcp', label: 'MCP tools', tokens: sum(mcp), items: mcp },
    { id: 'agents', label: 'Agents', tokens: sum(agents), items: agents },
    { id: 'conversation', label: 'Conversation tools', tokens: sum(conversation), items: conversation },
    { id: 'index', label: 'Sections and notes', tokens: indexText ? estimateTokens(indexText) : 0 },
    { id: 'messages', label: 'Messages', tokens: messagesTokens },
  ];
  const used = sum(categories);
  const sinceReset = exchanges(state.messages.filter((m) => m.seq > state.lastResetSeq)).length;
  return {
    budget,
    reserve,
    used,
    free: Math.max(0, budget - reserve - used),
    categories,
    exchanges: {
      included: working?.report.includedExchanges ?? 0,
      omitted: working?.report.omittedExchanges ?? sinceReset,
      recentLimit: policy.recentExchanges ?? DEFAULT_RECENT_EXCHANGES,
      sinceReset,
    },
    sections: { shown: working?.report.indexEntries ?? 0, total: working?.report.indexTotal ?? 0 },
    ...(problem ? { problem } : {}),
  };
}
