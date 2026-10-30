/**
 * Deferred tool loading.
 *
 * Tools an agent rarely needs (an MCP server's dozens of tools, and later
 * the generated-UI tools) need not ride along in every request. Deferred
 * tools are left out of the request's tool list; the system prompt names
 * them, and `tool_search` loads them: it returns their full definitions and
 * adds them to the tool list from the next request of the run on.
 *
 * Which tools are deferred is `tools.defer` in the agent file: "auto" (the
 * default) defers deferrable tools (MCP tools) once an agent has more than
 * AUTO_DEFER_MIN of them, true defers them all, false none, and a list of
 * names or patterns ("mcp__github__*") defers exactly those.
 */

import type { AnyDeclarativeTool, FunctionDeclaration, ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';

export const TOOL_SEARCH = ToolNames.TOOL_SEARCH;
/** "auto" defers deferrable tools once there are more than this many. */
export const AUTO_DEFER_MIN = 10;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;

/** Tools that are never deferred: the agent needs them to work at all. */
const NEVER_DEFERRED: ReadonlySet<string> = new Set([
  ToolNames.TOOL_SEARCH,
  ToolNames.SHELL,
  ToolNames.MESSAGE_AGENT,
  ToolNames.WAIT_FOR_MESSAGES,
  ToolNames.MESSAGE_USER,
]);

export type DeferSetting = boolean | 'auto' | readonly string[];

/** Whether `name` matches a pattern (`*` matches any run of characters). */
export function matchesToolPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/** The names of the tools to defer, given the agent's tools and its `tools.defer`. */
export function deferredToolNames(tools: ReadonlyMap<string, AnyDeclarativeTool>, setting: DeferSetting | undefined): Set<string> {
  const out = new Set<string>();
  if (setting === false) return out;
  if (Array.isArray(setting)) {
    for (const name of tools.keys()) if (!NEVER_DEFERRED.has(name) && setting.some((p) => matchesToolPattern(name, p))) out.add(name);
    return out;
  }
  const candidates = [...tools.entries()].filter(([name, tool]) => tool.deferrable && !NEVER_DEFERRED.has(name)).map(([name]) => name);
  if (setting === true || candidates.length > AUTO_DEFER_MIN) for (const name of candidates) out.add(name);
  return out;
}

/** The tool calls made earlier in `messages` (their tools stay loaded in a later run). */
export function calledToolNames(messages: ReadonlyArray<{ role: string; tool_calls?: ReadonlyArray<{ function?: { name?: string } }> }>): Set<string> {
  const out = new Set<string>();
  for (const m of messages) if (m.role === 'assistant') for (const c of m.tool_calls ?? []) if (c.function?.name) out.add(c.function.name);
  return out;
}

/** Short descriptions for the prompt's list of deferred tools. */
function firstSentence(text: string, max = 90): string {
  const line = text.split('\n')[0]!.trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/** What the system prompt says about the deferred tools. */
export function deferredToolsNote(deferred: ReadonlyMap<string, AnyDeclarativeTool>): string {
  const lines = [...deferred.entries()].map(([name, tool]) => `- ${name}: ${firstSentence(tool.description)}`);
  return `<deferred_tools>
These tools are available but not loaded, to keep requests small. Before calling one, load it with ${TOOL_SEARCH}: "select:name1,name2" loads those exactly, or keywords find matching tools. A loaded tool stays available for the rest of this turn.
${lines.join('\n')}
</deferred_tools>`;
}

/** Ranks deferred tools against a keyword query. */
function search(deferred: ReadonlyMap<string, AnyDeclarativeTool>, query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const required = terms.filter((t) => t.startsWith('+')).map((t) => t.slice(1)).filter(Boolean);
  const optional = terms.filter((t) => !t.startsWith('+'));
  const scored: Array<[string, number]> = [];
  for (const [name, tool] of deferred) {
    const n = name.toLowerCase();
    const d = tool.description.toLowerCase();
    if (!required.every((t) => n.includes(t))) continue;
    let score = required.length * 3;
    for (const t of optional) {
      if (n === t) score += 10;
      else if (n.includes(t)) score += 4;
      if (d.includes(t)) score += 1;
    }
    if (score > 0 || !optional.length) scored.push([name, score]);
  }
  return scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

interface ToolSearchParams {
  query: string;
  max_results?: number;
}

class ToolSearchInvocation extends BaseToolInvocation<ToolSearchParams, ToolResult> {
  constructor(
    private readonly tool: ToolSearchTool,
    params: ToolSearchParams,
  ) {
    super(params);
  }
  getDescription(): string {
    return `Loading tools: ${this.params.query}`;
  }
  async execute(): Promise<ToolResult> {
    return this.tool.run(this.params);
  }
}

/**
 * tool_search: finds deferred tools and loads them. `loaded` is shared with
 * the run, which adds the loaded tools to the next request.
 */
export class ToolSearchTool extends BaseDeclarativeTool<ToolSearchParams, ToolResult> {
  constructor(
    private readonly deferred: ReadonlyMap<string, AnyDeclarativeTool>,
    readonly loaded: Set<string>,
  ) {
    super(
      TOOL_SEARCH,
      'Tool search',
      'Loads deferred tools (listed in <deferred_tools>) so they can be called. "select:a,b" loads those tools by name; otherwise the query is keywords matched against tool names and descriptions ("+word" requires the word in the name). Returns each tool\'s definition; loaded tools can be called from your next step on.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: '"select:name1,name2", or keywords.' },
          max_results: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `For keyword queries: how many tools to load at most (default ${DEFAULT_RESULTS}).` },
        },
        required: ['query'],
      },
    );
  }

  protected createInvocation(params: ToolSearchParams): ToolInvocation<ToolSearchParams, ToolResult> {
    return new ToolSearchInvocation(this, params);
  }

  run(p: ToolSearchParams): ToolResult {
    const query = p.query.trim();
    let names: string[];
    let unknown: string[] = [];
    if (/^select:/i.test(query)) {
      const wanted = query.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
      names = wanted.filter((n) => this.deferred.has(n));
      unknown = wanted.filter((n) => !this.deferred.has(n));
    } else {
      names = search(this.deferred, query).slice(0, Math.min(MAX_RESULTS, Math.max(1, p.max_results ?? DEFAULT_RESULTS)));
    }
    if (!names.length) {
      const msg = unknown.length ? `No deferred tool is named ${unknown.map((n) => `"${n}"`).join(', ')}.` : `No deferred tool matches "${query}".`;
      return { llmContent: `${msg} The deferred tools are listed in <deferred_tools>.`, returnDisplay: 'No tools found', error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS } };
    }
    for (const n of names) this.loaded.add(n);
    const defs: FunctionDeclaration[] = names.map((n) => this.deferred.get(n)!.schema);
    const note = unknown.length ? `\nNot found: ${unknown.join(', ')}.` : '';
    return {
      llmContent: `Loaded ${names.length} tool${names.length === 1 ? '' : 's'}; call them from your next step on.${note}\n<functions>\n${defs.map((d) => JSON.stringify(d)).join('\n')}\n</functions>`,
      returnDisplay: `Loaded ${names.join(', ')}`,
    };
  }
}
