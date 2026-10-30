/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime event and result types.
 *
 * Event concepts follow qwen-code packages/core/src/core/turn.ts
 * (content, thought, tool call request/response, error, finished) and
 * `AgentTerminateMode` is kept from agents/runtime/agent-types.ts. Every
 * event names the agent that produced it as a path from the root, so a
 * front end can show child activity without Core knowing about terminals.
 */

import type { ToolCallConfirmationDetails } from '../tools/tools.js';
import type { ToolErrorType } from '../tools/tool-error.js';
import type { TokenUsage } from '../providers/types.js';

/** Why an agent run stopped (qwen-code agents/runtime/agent-types.ts). */
export enum AgentTerminateMode {
  /** The agent's execution terminated due to an unrecoverable error. */
  ERROR = 'ERROR',
  /** The agent's execution exceeded the maximum allowed working time. */
  TIMEOUT = 'TIMEOUT',
  /** The agent produced a final answer. */
  GOAL = 'GOAL',
  /** The agent exceeded its maximum number of model turns. */
  MAX_TURNS = 'MAX_TURNS',
  /** The agent's execution was cancelled via an abort signal. */
  CANCELLED = 'CANCELLED',
}

export interface ToolActivity {
  name: string;
  ok: boolean;
  errorType?: ToolErrorType;
}

/** Structured outcome of one agent run (a root turn or a child invocation). */
export interface AgentRunResult {
  agentId: string;
  status: AgentTerminateMode;
  /** Final assistant text (may be partial when status is not GOAL). */
  text: string;
  error?: string;
  turns: number;
  toolCalls: ToolActivity[];
  usage: TokenUsage;
  durationMs: number;
}

interface EventBase {
  /** Agent IDs from the root to the emitting agent, e.g. ["main", "worker"]. */
  agentPath: readonly string[];
}

export type RuntimeEvent =
  | (EventBase & { type: 'agent_start'; task: string })
  | (EventBase & { type: 'text'; text: string })
  | (EventBase & { type: 'reasoning'; text: string })
  | (EventBase & {
      type: 'tool_request';
      callId: string;
      name: string;
      args: Record<string, unknown>;
      description: string;
    })
  | (EventBase & {
      type: 'tool_result';
      callId: string;
      name: string;
      ok: boolean;
      display: string;
      errorType?: ToolErrorType;
    })
  | (EventBase & {
      type: 'context';
      /** Estimated tokens (characters / 4) of the first request of the turn. */
      estimatedTokens: number;
      budget: number;
      includedExchanges: number;
      omittedExchanges: number;
      indexEntries: number;
      indexTotal: number;
    })
  | (EventBase & {
      type: 'model_usage';
      /** Token usage the provider reported for one model request. */
      usage: TokenUsage;
    })
  | (EventBase & {
      type: 'agent_message';
      /** The agent it is from. */
      from: string;
      /** Thread key it came through. */
      thread?: string;
      text: string;
    })
  | (EventBase & { type: 'warning'; message: string })
  | (EventBase & { type: 'error'; message: string })
  | (EventBase & { type: 'agent_end'; result: AgentRunResult });

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface ConfirmationRequest {
  agentPath: readonly string[];
  toolName: string;
  details: ToolCallConfirmationDetails;
}

export type ConfirmationDecision = 'allow_once' | 'allow_always' | 'deny';

/**
 * Asks the user to approve a tool call. Implemented by the front end (the
 * CLI prompts on the terminal). Without a handler, calls that need approval
 * are denied.
 */
export type ConfirmationHandler = (request: ConfirmationRequest, signal: AbortSignal) => Promise<ConfirmationDecision>;
