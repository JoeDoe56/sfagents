/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/mcp-tool.ts
 * (`DiscoveredMCPTool`, `transformMcpContentToParts`, `getDisplayFromParts`).
 * Keeps: per-server trust, MCP confirmation details, normalization of text,
 * image/audio, embedded resource, resource link and structuredContent
 * blocks, and isError handling. Output is text because OpenAI-compatible
 * tool messages are text; binary blocks are summarized. Removed: MCP apps,
 * classifier projection, progress streaming, persisted output files.
 */

import { createHash } from 'node:crypto';
import type { ToolInvocation, ToolResult, PermissionDecision, ToolCallConfirmationDetails, JsonSchema } from '../tools/tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { MCP_TOOL_PREFIX } from '../tools/tool-names.js';
import type { McpCallResult, McpManager, McpToolInfo } from './manager.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

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

export interface McpToolParams {
  [key: string]: unknown;
}

class McpToolInvocation extends BaseToolInvocation<McpToolParams, ToolResult> {
  constructor(
    private readonly tool: DiscoveredMcpTool,
    params: McpToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const args = JSON.stringify(this.params);
    return `${this.tool.serverName}.${this.tool.serverToolName}(${args.length > 200 ? `${args.slice(0, 200)}…` : args})`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return this.tool.trusted ? 'allow' : 'ask';
  }

  override async getConfirmationDetails(): Promise<ToolCallConfirmationDetails> {
    return {
      type: 'mcp',
      title: `Confirm MCP tool: ${this.tool.serverToolName} (server ${this.tool.serverName})`,
      serverName: this.tool.serverName,
      toolName: this.tool.serverToolName,
      toolDisplayName: this.tool.name,
      args: this.params,
    };
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    let result: McpCallResult;
    try {
      result = await this.tool.manager.callTool(this.tool.serverName, this.tool.serverToolName, this.params, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        return {
          llmContent: `MCP tool call ${this.tool.serverToolName} was cancelled.`,
          returnDisplay: 'Cancelled',
          error: { message: 'cancelled', type: ToolErrorType.EXECUTION_CANCELLED },
        };
      }
      const message = `MCP tool '${this.tool.serverToolName}' on server '${this.tool.serverName}' failed: ${getErrorMessage(error)}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.MCP_TOOL_ERROR } };
    }
    const text = transformMcpResult(this.tool.serverToolName, result);
    if (result.isError) {
      const message = `MCP tool '${this.tool.serverToolName}' reported an error: ${text}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.MCP_TOOL_ERROR } };
    }
    const firstLine = text.split('\n')[0] ?? '';
    return {
      llmContent: text,
      returnDisplay: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine || '(empty result)',
    };
  }
}

function normalizeInputSchema(schema: Record<string, unknown>): JsonSchema {
  const copy: Record<string, unknown> = { ...schema };
  if (copy['type'] !== 'object') copy['type'] = 'object';
  if (typeof copy['properties'] !== 'object' || copy['properties'] === null) copy['properties'] = {};
  return copy;
}

/** One MCP tool as seen by one agent. */
export class DiscoveredMcpTool extends BaseDeclarativeTool<McpToolParams, ToolResult> {
  constructor(
    readonly manager: McpManager,
    readonly serverName: string,
    readonly serverToolName: string,
    info: McpToolInfo,
    functionName: string,
    readonly trusted: boolean,
  ) {
    super(
      functionName,
      `${serverName}.${serverToolName}`,
      `${info.description || `MCP tool ${serverToolName}`} (MCP server: ${serverName})`,
      Kind.Other,
      normalizeInputSchema(info.inputSchema),
    );
  }

  override get deferrable(): boolean {
    return true;
  }

  get approvalKey(): string {
    return mcpApprovalKey(this.serverName, this.serverToolName);
  }

  protected createInvocation(params: McpToolParams): ToolInvocation<McpToolParams, ToolResult> {
    return new McpToolInvocation(this, params);
  }
}
