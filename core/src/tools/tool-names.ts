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
  /** SF Agents: messages another agent in their persistent thread. */
  MESSAGE_AGENT: 'message_agent',
} as const;

/** Built-in tool IDs an agent definition may list in `tools.allow`. */
export const BUILTIN_TOOL_IDS: readonly string[] = [ToolNames.SHELL];

/**
 * File tools that sandboxed shell commands replaced. Old agent files that
 * list them still load: they get `shell` instead, with the workspace
 * read-only when none of them could write.
 */
export const LEGACY_FILE_TOOL_IDS: readonly string[] = ['read_file', 'write_file', 'edit', 'glob', 'grep', 'list_directory'];
export const LEGACY_WRITE_TOOL_IDS: readonly string[] = ['write_file', 'edit'];

/** Prefix for namespaced MCP tools: mcp__<server>__<tool>. */
export const MCP_TOOL_PREFIX = 'mcp__';
