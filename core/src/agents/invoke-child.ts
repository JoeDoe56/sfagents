/**
 * The `invoke_child` tool: delegates a bounded task to one of the calling
 * agent's directly declared children and returns a structured result.
 *
 * Replaces qwen-code's `agent` tool (tools/agent/agent.ts) for this
 * milestone. Visibility comes only from the frozen definition tree: the
 * schema's enum lists the caller's direct children, and execution looks the
 * child up among those same children, so naming any other agent fails.
 */

import type { ToolInvocation, ToolResult } from '../tools/tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { AgentNode } from './loader.js';
import { AgentTerminateMode, type AgentRunResult, type RuntimeEvent } from '../runtime/events.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

/** Upper bound on task + context passed to a child. */
export const MAX_CHILD_INPUT_CHARS = 32_000;

export interface ChildRunner {
  runChild(params: {
    parent: AgentNode;
    parentPath: readonly string[];
    child: AgentNode;
    task: string;
    context?: string;
    signal: AbortSignal;
    emit: (event: RuntimeEvent) => void;
  }): Promise<AgentRunResult>;
}

export interface InvokeChildParams {
  agent: string;
  task: string;
  context?: string;
}

/** The structured result the parent model receives. */
export interface ChildResultPayload {
  agent: string;
  status: 'completed' | 'error' | 'max_turns' | 'timeout' | 'cancelled';
  response: string;
  error?: string;
  turns: number;
  toolCalls: Record<string, { ok: number; failed: number }>;
  durationMs: number;
}

const STATUS: Record<AgentTerminateMode, ChildResultPayload['status']> = {
  [AgentTerminateMode.GOAL]: 'completed',
  [AgentTerminateMode.ERROR]: 'error',
  [AgentTerminateMode.MAX_TURNS]: 'max_turns',
  [AgentTerminateMode.TIMEOUT]: 'timeout',
  [AgentTerminateMode.CANCELLED]: 'cancelled',
};

export function toChildPayload(result: AgentRunResult): ChildResultPayload {
  const toolCalls: ChildResultPayload['toolCalls'] = {};
  for (const call of result.toolCalls) {
    const entry = (toolCalls[call.name] ??= { ok: 0, failed: 0 });
    if (call.ok) entry.ok++;
    else entry.failed++;
  }
  return {
    agent: result.agentId,
    status: STATUS[result.status],
    response: result.text,
    ...(result.error ? { error: result.error } : {}),
    turns: result.turns,
    toolCalls,
    durationMs: result.durationMs,
  };
}

class InvokeChildInvocation extends BaseToolInvocation<InvokeChildParams, ToolResult> {
  constructor(
    private readonly tool: InvokeChildTool,
    params: InvokeChildParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const task = this.params.task.replace(/\s+/g, ' ');
    return `${this.params.agent}: ${task.length > 100 ? `${task.slice(0, 100)}…` : task}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const child = this.tool.parent.children.find((c) => c.id === this.params.agent);
    if (!child) {
      const message = `Agent "${this.params.agent}" is not a declared child of "${this.tool.parent.id}". Declared children: ${this.tool.parent.children.map((c) => c.id).join(', ') || '(none)'}.`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.EXECUTION_DENIED } };
    }
    let result: AgentRunResult;
    try {
      result = await this.tool.runner.runChild({
        parent: this.tool.parent,
        parentPath: this.tool.parentPath,
        child,
        task: this.params.task,
        context: this.params.context,
        signal,
        emit: this.tool.emit,
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        return { llmContent: 'Child invocation cancelled.', returnDisplay: 'Cancelled', error: { message: 'cancelled', type: ToolErrorType.EXECUTION_CANCELLED } };
      }
      const message = `Child agent "${child.id}" could not run: ${getErrorMessage(error)}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.CHILD_AGENT_ERROR } };
    }
    const payload = toChildPayload(result);
    const llmContent = JSON.stringify(payload, null, 2);
    const display = `${child.id}: ${payload.status} (${result.turns} turn${result.turns === 1 ? '' : 's'}, ${result.toolCalls.length} tool call${result.toolCalls.length === 1 ? '' : 's'})`;
    if (result.status !== AgentTerminateMode.GOAL) {
      return {
        llmContent,
        returnDisplay: display,
        error: { message: result.error ?? payload.status, type: ToolErrorType.CHILD_AGENT_ERROR },
        metadata: { childResult: payload },
      };
    }
    return { llmContent, returnDisplay: display, metadata: { childResult: payload } };
  }
}

export class InvokeChildTool extends BaseDeclarativeTool<InvokeChildParams, ToolResult> {
  static readonly Name = ToolNames.INVOKE_CHILD;

  constructor(
    readonly runner: ChildRunner,
    readonly parent: AgentNode,
    readonly parentPath: readonly string[],
    readonly emit: (event: RuntimeEvent) => void,
  ) {
    const children = parent.children;
    const list = children
      .map((c) => `- ${c.id}: ${c.definition.description ?? '(no description)'}`)
      .join('\n');
    super(
      InvokeChildTool.Name,
      'InvokeChild',
      `Delegates a task to one of your child agents and waits for its result. The child starts fresh: it sees only its own instructions, the task and the context you pass, not this conversation. Give it a complete, self-contained task. It returns JSON with "status", "response" and a summary of its tool use; verify important claims before relying on them.\n\nAvailable child agents:\n${list}`,
      Kind.Delegate,
      {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: children.map((c) => c.id), description: 'ID of the child agent to invoke.' },
          task: { type: 'string', minLength: 1, description: 'Complete description of what the child should do and return.' },
          context: { type: 'string', description: 'Optional facts, file paths or excerpts the child needs. Keep it focused.' },
        },
        required: ['agent', 'task'],
      },
    );
  }

  protected override validateToolParamValues(params: InvokeChildParams): string | null {
    const size = params.task.length + (params.context?.length ?? 0);
    if (size > MAX_CHILD_INPUT_CHARS) {
      return `task and context together must be at most ${MAX_CHILD_INPUT_CHARS} characters (got ${size}). Summarize, or pass file paths the child can read.`;
    }
    return null;
  }

  protected createInvocation(params: InvokeChildParams): ToolInvocation<InvokeChildParams, ToolResult> {
    return new InvokeChildInvocation(this, params);
  }
}
