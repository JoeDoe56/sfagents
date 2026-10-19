/**
 * Executes one model-requested tool call for one agent.
 *
 * This replaces qwen-code's core/coreToolScheduler.ts for this milestone,
 * keeping its order of checks: look up the tool in the agent's own registry,
 * validate parameters, take the invocation's intrinsic permission, then
 * auto-approval or a confirmation prompt, then execute with cancellation and
 * a timeout, and bound the output returned to the model. Enforcement happens
 * here at invocation time, so a model asking for a tool it was never shown
 * is rejected the same way as one that was filtered out.
 */

import type { AnyDeclarativeTool, AnyToolInvocation, ToolResult } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { ToolNames } from '../tools/tool-names.js';
import type { ParsedToolCall, ToolMessage } from '../providers/types.js';
import { DiscoveredMcpTool } from '../mcp/mcp-tool.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { PersistenceFailure } from './recorder.js';
import type { ToolMessageStatus } from '../conversation/types.js';
import { truncateForModel } from '../utils/text-utils.js';
import type {
  ConfirmationDecision,
  ConfirmationHandler,
  RuntimeEvent,
  ToolActivity,
} from './events.js';

export interface ToolExecutionContext {
  agentId: string;
  agentPath: readonly string[];
  tools: ReadonlyMap<string, AnyDeclarativeTool>;
  autoApprove: readonly string[];
  /** Tools approved with "always" for this agent during this process. */
  sessionApprovals: Set<string>;
  approveAll: boolean;
  confirm?: ConfirmationHandler;
  toolTimeoutMs: number;
  maxOutputChars: number;
  emit: (event: RuntimeEvent) => void;
  /**
   * Called after approval, immediately before execution (records the
   * execution start). Throwing PersistenceFailure stops the run.
   */
  beforeExecute?: (callId: string, tool: string) => void;
}

export interface ToolExecutionOutcome {
  message: ToolMessage;
  activity: ToolActivity;
  status: ToolMessageStatus;
}

function statusOf(result: ToolResult): ToolMessageStatus {
  if (!result.error) return 'ok';
  if (result.error.type === ToolErrorType.EXECUTION_DENIED) return 'denied';
  if (result.error.type === ToolErrorType.EXECUTION_CANCELLED) return 'cancelled';
  return 'error';
}

function isAutoApproved(tool: AnyDeclarativeTool, ctx: ToolExecutionContext): boolean {
  if (ctx.approveAll) return true;
  if (ctx.sessionApprovals.has(tool.name)) return true;
  if (ctx.autoApprove.includes(tool.name)) return true;
  if (tool instanceof DiscoveredMcpTool) {
    return ctx.autoApprove.includes(tool.approvalKey) || ctx.autoApprove.includes(`mcp__${tool.serverName}__*`);
  }
  return false;
}

function failure(callId: string, name: string, message: string, type: ToolErrorType): { result: ToolResult; callId: string; name: string } {
  return { callId, name, result: { llmContent: message, returnDisplay: message, error: { message, type } } };
}

async function runWithTimeout(
  invocation: AnyToolInvocation,
  parentSignal: AbortSignal,
  timeoutMs: number | undefined,
  callId: string,
): Promise<ToolResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', onAbort, { once: true });
  if (parentSignal.aborted) controller.abort(parentSignal.reason);
  let timer: NodeJS.Timeout | undefined;
  try {
    const execution = invocation.execute(controller.signal, undefined, { callId });
    if (timeoutMs === undefined) return await execution;
    return await Promise.race([
      execution,
      new Promise<ToolResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error('tool timeout'));
          const message = `Tool execution timed out after ${Math.round(timeoutMs / 1000)}s and was cancelled.`;
          resolve({ llmContent: message, returnDisplay: 'Timed out', error: { message, type: ToolErrorType.EXECUTION_TIMEOUT } });
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onAbort);
  }
}

export async function executeToolCall(
  call: ParsedToolCall,
  ctx: ToolExecutionContext,
  signal: AbortSignal,
): Promise<ToolExecutionOutcome> {
  const outcome = await executeInner(call, ctx, signal);
  const { result } = outcome;
  const ok = !result.error;
  ctx.emit({
    type: 'tool_result',
    agentPath: ctx.agentPath,
    callId: call.id,
    name: call.name,
    ok,
    display: result.returnDisplay,
    errorType: result.error?.type,
  });
  return {
    message: {
      role: 'tool',
      tool_call_id: call.id,
      content: truncateForModel(result.llmContent || (ok ? '(no output)' : 'Error'), ctx.maxOutputChars),
    },
    activity: { name: call.name, ok, errorType: result.error?.type },
    status: statusOf(result),
  };
}

async function executeInner(
  call: ParsedToolCall,
  ctx: ToolExecutionContext,
  signal: AbortSignal,
): Promise<{ result: ToolResult; callId: string; name: string }> {
  const tool = ctx.tools.get(call.name);
  if (!tool) {
    ctx.emit({ type: 'tool_request', agentPath: ctx.agentPath, callId: call.id, name: call.name, args: call.args, description: '(unavailable tool)' });
    const available = [...ctx.tools.keys()];
    return failure(
      call.id,
      call.name,
      `Tool "${call.name}" is not available to agent "${ctx.agentId}". Available tools: ${available.length ? available.join(', ') : '(none)'}.`,
      ToolErrorType.TOOL_NOT_REGISTERED,
    );
  }

  let invocation: AnyToolInvocation;
  try {
    invocation = tool.build(call.args);
  } catch (error) {
    ctx.emit({ type: 'tool_request', agentPath: ctx.agentPath, callId: call.id, name: call.name, args: call.args, description: '(invalid parameters)' });
    return failure(call.id, call.name, `Error: Invalid parameters for ${call.name}: ${getErrorMessage(error)}`, ToolErrorType.INVALID_TOOL_PARAMS);
  }

  let description: string;
  try {
    description = invocation.getDescription();
  } catch {
    description = call.name;
  }
  ctx.emit({ type: 'tool_request', agentPath: ctx.agentPath, callId: call.id, name: call.name, args: call.args, description });

  try {
    const permission = await invocation.getDefaultPermission(signal);
    if (permission === 'deny') {
      return failure(
        call.id,
        call.name,
        `Permission denied: ${invocation.getDenialReason?.() ?? 'this call is not permitted by the agent policy.'}`,
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    if (permission === 'ask' && !isAutoApproved(tool, ctx)) {
      let decision: ConfirmationDecision = 'deny';
      if (ctx.confirm) {
        const details = await invocation.getConfirmationDetails(signal);
        decision = await ctx.confirm({ agentPath: ctx.agentPath, toolName: call.name, details }, signal);
      }
      if (decision === 'deny') {
        return failure(
          call.id,
          call.name,
          ctx.confirm
            ? `The user denied permission to run ${call.name}. Do not retry the same call; continue without it or ask the user how to proceed.`
            : `${call.name} requires approval, and no approval is possible in this non-interactive run. Do not retry; continue without it. (The user can add it to tools.autoApprove or pass --yes.)`,
          ToolErrorType.EXECUTION_DENIED,
        );
      }
      if (decision === 'allow_always') ctx.sessionApprovals.add(tool.name);
    }

    if (signal.aborted) {
      return failure(call.id, call.name, 'Tool call cancelled before execution.', ToolErrorType.EXECUTION_CANCELLED);
    }
    // Child agents have their own turn budget and timeout.
    const timeout = call.name === ToolNames.INVOKE_CHILD ? undefined : ctx.toolTimeoutMs;
    ctx.beforeExecute?.(call.id, call.name);
    const result = await runWithTimeout(invocation, signal, timeout, call.id);
    return { callId: call.id, name: call.name, result };
  } catch (error) {
    if (error instanceof PersistenceFailure) throw error;
    if (isAbortError(error) || signal.aborted) {
      return failure(call.id, call.name, 'Tool call cancelled.', ToolErrorType.EXECUTION_CANCELLED);
    }
    return failure(call.id, call.name, `Tool ${call.name} threw an unexpected error: ${getErrorMessage(error)}`, ToolErrorType.UNHANDLED_EXCEPTION);
  }
}
