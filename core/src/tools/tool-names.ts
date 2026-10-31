/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/tool-names.ts.
 * Tool IDs follow the SF Agents JSON schema; upstream names are noted.
 */

export const ToolNames = {
  /** Upstream: run_shell_command */
  SHELL: 'shell',
  /** SF Agents: messages the person or another agent, or waits for messages. */
  MESSAGE: 'message',
  /** SF Agents: loads deferred tools (see tools.defer). */
  TOOL_SEARCH: 'tool_search',
  /** Not a tool the model calls: puts the `sf-web` command in the agent's shell. */
  WEB: 'web',
} as const;

/** Built-in tool IDs an agent definition may list in `tools.allow`. */
export const BUILTIN_TOOL_IDS: readonly string[] = [ToolNames.SHELL, ToolNames.WEB];

/**
 * File tools that sandboxed shell commands replaced. Old agent files that
 * list them still load: they get `shell` instead, with the workspace
 * read-only when none of them could write.
 */
export const LEGACY_FILE_TOOL_IDS: readonly string[] = ['read_file', 'write_file', 'edit', 'glob', 'grep', 'list_directory'];
export const LEGACY_WRITE_TOOL_IDS: readonly string[] = ['write_file', 'edit'];

/** Prefix for namespaced MCP tools: mcp__<server>__<tool>. */
export const MCP_TOOL_PREFIX = 'mcp__';
