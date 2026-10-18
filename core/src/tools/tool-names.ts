/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/tool-names.ts.
 * Tool IDs follow the SF Agents JSON schema; upstream names are noted.
 */

export const ToolNames = {
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  EDIT: 'edit',
  GLOB: 'glob',
  /** Upstream: grep_search */
  GREP: 'grep',
  /** Upstream: list_directory */
  LS: 'list_directory',
  /** Upstream: run_shell_command */
  SHELL: 'shell',
  /** SF Agents: delegates to a declared child agent. */
  INVOKE_CHILD: 'invoke_child',
} as const;

/** Built-in tool IDs an agent definition may list in `tools.allow`. */
export const BUILTIN_TOOL_IDS: readonly string[] = [
  ToolNames.READ_FILE,
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.GLOB,
  ToolNames.GREP,
  ToolNames.LS,
  ToolNames.SHELL,
];

/** Prefix for namespaced MCP tools: mcp__<server>__<tool>. */
export const MCP_TOOL_PREFIX = 'mcp__';
