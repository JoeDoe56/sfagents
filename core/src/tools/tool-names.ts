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
} as const;

/** Prefix for namespaced MCP tools: mcp__<server>__<tool>. */
export const MCP_TOOL_PREFIX = 'mcp__';
