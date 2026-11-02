import type { NetworkLevel } from '../container/network.js';
import type { HostCommands } from './host-commands.js';

/**
 * Everything a built-in tool needs from its owning agent. Replaces upstream's
 * `Config` god-object: tools see only their agent's container and limits,
 * never another agent's.
 */
export interface ToolContext {
  /** The agent's id: it names its container. */
  readonly agentId: string;
  /** Upper bound on the text returned to the model from one tool call. */
  readonly maxOutputChars: number;
  /** Environment variable names removed from spawned processes (MCP servers). */
  readonly secretEnvNames: readonly string[];
  /** Default and maximum shell command timeout in milliseconds. */
  readonly shellTimeoutMs: number;
  /**
   * The agent's container: its network level, the project folders it reads
   * (read-only, at /roots/<name>), and files and folders in them it never sees
   * (secrets, SF Agents' own data).
   */
  readonly container: { readonly level: NetworkLevel; readonly roots: readonly string[]; readonly hidden: readonly string[] };
  /** SF Agents' own commands this agent may run (`sfa-web`, `sfa-artifact`). */
  readonly commands?: HostCommands;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
