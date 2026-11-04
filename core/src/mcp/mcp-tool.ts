/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/mcp-tool.ts
 * (`DiscoveredMCPTool`, `transformMcpContentToParts`, `getDisplayFromParts`).
 * Keeps: normalization of text,
 * image/audio, embedded resource, resource link and structuredContent
 * blocks, and isError handling. Output is text because OpenAI-compatible
 * tool messages are text; binary blocks are summarized. Removed: MCP apps,
 * classifier projection, progress streaming, persisted output files, and
 * MCP tools as model tools (agents reach MCP through `sfa-mcp`, ./sfa-mcp.ts).
 */

import { createHash } from 'node:crypto';
import { MCP_TOOL_PREFIX } from '../tools/tool-names.js';
import type { McpCallResult } from './manager.js';

const MAX_FUNCTION_NAME = 64;

/** Model-facing name: mcp__<server>__<tool>, made provider-safe and ≤ 64 chars. */
export function mcpFunctionName(server: string, tool: string): string {
  const sanitized = tool.replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `${MCP_TOOL_PREFIX}${server}__${sanitized}`;
  if (full.length <= MAX_FUNCTION_NAME && sanitized === tool) return full;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  const room = MAX_FUNCTION_NAME - `${MCP_TOOL_PREFIX}${server}__`.length - hash.length - 1;
  return `${MCP_TOOL_PREFIX}${server}__${sanitized.slice(0, Math.max(1, room))}_${hash}`;
}

/** Key used for autoApprove matching, based on the server's own tool name. */
export function mcpApprovalKey(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

type Block = Record<string, unknown>;

/** Converts an MCP CallToolResult into model-facing text. */
export function transformMcpResult(toolName: string, result: McpCallResult): string {
  const parts: string[] = [];
  const structured = result.structuredContent;
  const structuredText = structured !== undefined ? JSON.stringify(structured) : undefined;
  const content = Array.isArray(result.content) ? (result.content as Block[]) : undefined;
  if (!content) {
    return structuredText ?? '[Error: Could not parse tool response]';
  }
  for (const block of content) {
    switch (block['type']) {
      case 'text':
        parts.push(String(block['text'] ?? ''));
        break;
      case 'image':
      case 'audio': {
        const data = typeof block['data'] === 'string' ? block['data'] : '';
        parts.push(
          `[Tool '${toolName}' provided ${block['type']} data with mime-type ${String(block['mimeType'] ?? 'unknown')} (${Math.floor((data.length * 3) / 4)} bytes); binary content is not shown]`,
        );
        break;
      }
      case 'resource': {
        const resource = block['resource'] as Block | undefined;
        if (typeof resource?.['text'] === 'string') {
          parts.push(resource['text']);
        } else if (typeof resource?.['blob'] === 'string') {
          parts.push(
            `[Tool '${toolName}' provided an embedded resource ${String(resource['uri'] ?? '')} with mime-type ${String(resource['mimeType'] ?? 'application/octet-stream')}; binary content is not shown]`,
          );
        }
        break;
      }
      case 'resource_link':
        parts.push(`Resource Link: ${String(block['title'] ?? block['name'] ?? '')} at ${String(block['uri'] ?? '')}`);
        break;
      default:
        break;
    }
  }
  // Servers may already include the serialized structured payload as text.
  if (structuredText !== undefined && !parts.includes(structuredText)) parts.unshift(structuredText);
  return parts.join('\n');
}
