import type { WorkspaceContext } from '../permissions/workspace.js';

/**
 * Everything a built-in tool needs from its owning agent. Replaces upstream's
 * `Config` god-object: tools see only their agent's workspace policy and
 * limits, never another agent's.
 */
export interface ToolContext {
  readonly workspace: WorkspaceContext;
  /** Upper bound on the text returned to the model from one tool call. */
  readonly maxOutputChars: number;
  /** Environment variable names removed from spawned processes. */
  readonly secretEnvNames: readonly string[];
  /** Default and maximum shell command timeout in milliseconds. */
  readonly shellTimeoutMs: number;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
