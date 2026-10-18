/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/read-file.ts
 * and utils/fileUtils.ts (text path only). Removed: images, PDFs, notebooks,
 * media budgets, prior-read cache, memory paths, telemetry.
 */

import fs from 'node:fs/promises';
import type { ToolInvocation, ToolResult, ToolLocation, PermissionDecision } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolContext } from './tool-context.js';
import { isBinary } from '../utils/text-utils.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';

export const DEFAULT_MAX_LINES_TEXT_FILE = 2000;
export const MAX_LINE_LENGTH_TEXT_FILE = 2000;
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export interface ReadFileToolParams {
  file_path: string;
  offset?: number | null;
  limit?: number | null;
}

class ReadFileToolInvocation extends BaseToolInvocation<ReadFileToolParams, ToolResult> {
  constructor(
    private readonly ctx: ToolContext,
    params: ReadFileToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const shortPath = this.ctx.workspace.display(this.ctx.workspace.resolve(this.params.file_path));
    const offset = this.params.offset ?? undefined;
    const limit = this.params.limit ?? undefined;
    if (offset !== undefined && limit !== undefined) {
      return `${shortPath} (lines ${offset + 1}-${offset + limit})`;
    } else if (offset !== undefined) {
      return `${shortPath} (from line ${offset + 1})`;
    } else if (limit !== undefined) {
      return `${shortPath} (first ${limit} lines)`;
    }
    return shortPath;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.ctx.workspace.resolve(this.params.file_path), line: this.params.offset ?? undefined }];
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    const check = this.ctx.workspace.check(this.params.file_path, 'read');
    if (!check.ok) {
      this.denialReason = check.reason;
      return 'deny';
    }
    return 'allow';
  }

  async execute(): Promise<ToolResult> {
    const check = this.ctx.workspace.check(this.params.file_path, 'read');
    if (!check.ok || !check.resolvedPath) {
      return errorResult(check.reason ?? 'Path not permitted', ToolErrorType.PATH_NOT_IN_WORKSPACE);
    }
    const filePath = check.resolvedPath;
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return errorResult(`File not found: ${this.params.file_path}`, ToolErrorType.FILE_NOT_FOUND);
      }
      return errorResult(`Error reading file ${this.params.file_path}: ${getErrorMessage(error)}`, ToolErrorType.READ_CONTENT_FAILURE);
    }
    if (stats.isDirectory()) {
      return errorResult(`Path is a directory, not a file: ${this.params.file_path}. Use ${ToolNames.LS} instead.`, ToolErrorType.TARGET_IS_DIRECTORY);
    }
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      return errorResult(`File size exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit: ${this.params.file_path}`, ToolErrorType.FILE_TOO_LARGE);
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (error) {
      return errorResult(`Error reading file ${this.params.file_path}: ${getErrorMessage(error)}`, ToolErrorType.READ_CONTENT_FAILURE);
    }
    if (isBinary(buffer, 4096)) {
      return {
        llmContent: `Cannot display content of binary file: ${this.params.file_path} (${stats.size} bytes).`,
        returnDisplay: `Skipped binary file`,
      };
    }

    const content = buffer.toString('utf8').replace(/^﻿/, '');
    const lines = content.split(/\r?\n/);
    const originalLineCount = lines.length;
    const startLine = Math.max(0, this.params.offset ?? 0);
    const effectiveLimit = this.params.limit ?? DEFAULT_MAX_LINES_TEXT_FILE;
    const endLine = Math.min(startLine + effectiveLimit, originalLineCount);
    if (startLine >= originalLineCount && originalLineCount > 0 && !(originalLineCount === 1 && lines[0] === '')) {
      return errorResult(`offset ${startLine} is beyond the end of the file (${originalLineCount} lines).`, ToolErrorType.INVALID_TOOL_PARAMS);
    }
    const selected = lines.slice(startLine, endLine);
    let linesWereTruncatedInLength = false;
    const formatted = selected.map((line) => {
      if (line.length > MAX_LINE_LENGTH_TEXT_FILE) {
        linesWereTruncatedInLength = true;
        return line.substring(0, MAX_LINE_LENGTH_TEXT_FILE) + '... [truncated]';
      }
      return line;
    });
    const contentRangeTruncated = startLine > 0 || endLine < originalLineCount;
    let llmContent = formatted.join('\n');
    if (contentRangeTruncated) {
      llmContent =
        `Showing lines ${startLine + 1}-${endLine} of ${originalLineCount} total lines.\n` +
        (endLine < originalLineCount
          ? `To read more, call ${ToolNames.READ_FILE} with offset: ${endLine}.\n`
          : '') +
        `---\n${llmContent}`;
    } else if (linesWereTruncatedInLength) {
      llmContent = `Some lines were longer than ${MAX_LINE_LENGTH_TEXT_FILE} characters and were truncated.\n---\n${llmContent}`;
    }
    return {
      llmContent,
      returnDisplay: contentRangeTruncated ? `Read lines ${startLine + 1}-${endLine} of ${originalLineCount}` : `Read ${originalLineCount} lines`,
    };
  }
}

function errorResult(message: string, type: ToolErrorType): ToolResult {
  return { llmContent: message, returnDisplay: message, error: { message, type } };
}

export class ReadFileTool extends BaseDeclarativeTool<ReadFileToolParams, ToolResult> {
  static readonly Name = ToolNames.READ_FILE;

  constructor(private readonly ctx: ToolContext) {
    super(
      ReadFileTool.Name,
      'ReadFile',
      `Reads and returns the content of a text file. Relative paths are resolved against the primary workspace root. If the file is large, the content is truncated and the response explains how to read more with the 'offset' and 'limit' parameters.`,
      Kind.Read,
      {
        type: 'object',
        properties: {
          file_path: {
            description: 'Path of the file to read. Absolute, or relative to the primary workspace root.',
            type: 'string',
          },
          offset: {
            description: 'Optional: the 0-based line number to start reading from.',
            type: ['integer', 'null'],
            minimum: 0,
          },
          limit: {
            description: `Optional: maximum number of lines to read (default ${DEFAULT_MAX_LINES_TEXT_FILE}).`,
            type: ['integer', 'null'],
            minimum: 1,
          },
        },
        required: ['file_path'],
      },
    );
  }

  protected override validateToolParamValues(params: ReadFileToolParams): string | null {
    if (params.file_path.trim() === '') {
      return "The 'file_path' parameter must be non-empty.";
    }
    return null;
  }

  protected createInvocation(params: ReadFileToolParams): ToolInvocation<ReadFileToolParams, ToolResult> {
    return new ReadFileToolInvocation(this.ctx, params);
  }
}
