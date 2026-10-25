import type { WorkspaceContext } from '../permissions/workspace.js';
import type { SandboxPolicy } from '../sandbox/sandbox.js';

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
  /** What shell commands can reach (the agent's roots, minus SF Agents' own files). */
  readonly sandbox: SandboxPolicy;
  /** Ask before each shell command (`tools.ask`). */
  readonly askShell: boolean;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
