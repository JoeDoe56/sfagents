/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/ls.ts.
 * Keeps glob-style ignore patterns, directories-first sorting, the entry cap
 * and output format. Removed: git/.qwenignore filtering and skill/extension
 * path exceptions. Paths outside the agent's roots are denied, not asked.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolInvocation, ToolResult, PermissionDecision } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolContext } from './tool-context.js';

const MAX_ENTRY_COUNT = 500;

export interface LSToolParams {
  path?: string;
  ignore?: string[];
}

class LSToolInvocation extends BaseToolInvocation<LSToolParams, ToolResult> {
  constructor(
    private readonly ctx: ToolContext,
    params: LSToolParams,
  ) {
    super(params);
  }

  private target(): string {
    return this.params.path ?? this.ctx.workspace.getPrimaryDirectory();
  }

  private shouldIgnore(filename: string, patterns?: string[]): boolean {
    if (!patterns || patterns.length === 0) return false;
    for (const pattern of patterns) {
      const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      if (new RegExp(`^${regexPattern}$`).test(filename)) return true;
    }
    return false;
  }

  getDescription(): string {
    return this.ctx.workspace.display(this.ctx.workspace.resolve(this.target()));
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    const check = this.ctx.workspace.check(this.target(), 'read');
    if (!check.ok) {
      this.denialReason = check.reason;
      return 'deny';
    }
    return 'allow';
  }

  private errorResult(llmContent: string, returnDisplay: string, type: ToolErrorType): ToolResult {
    return { llmContent, returnDisplay: `Error: ${returnDisplay}`, error: { message: llmContent, type } };
  }

  async execute(): Promise<ToolResult> {
    const check = this.ctx.workspace.check(this.target(), 'read');
    if (!check.ok || !check.resolvedPath) {
      return this.errorResult(check.reason ?? 'Path not permitted', 'Path not permitted.', ToolErrorType.PATH_NOT_IN_WORKSPACE);
    }
    const dirPath = check.resolvedPath;
    try {
      const stats = await fs.stat(dirPath).catch(() => null);
      if (!stats) {
        return this.errorResult(`Error: Directory not found or inaccessible: ${this.target()}`, 'Directory not found or inaccessible.', ToolErrorType.FILE_NOT_FOUND);
      }
      if (!stats.isDirectory()) {
        return this.errorResult(`Error: Path is not a directory: ${this.target()}`, 'Path is not a directory.', ToolErrorType.PATH_IS_NOT_A_DIRECTORY);
      }
      const dirents = await fs.readdir(dirPath, { withFileTypes: true });
      if (dirents.length === 0) {
        return { llmContent: `Directory ${dirPath} is empty.`, returnDisplay: 'Directory is empty.' };
      }
      const entries: Array<{ name: string; isDirectory: boolean }> = [];
      for (const dirent of dirents) {
        if (this.shouldIgnore(dirent.name, this.params.ignore)) continue;
        let isDirectory = dirent.isDirectory();
        if (dirent.isSymbolicLink()) {
          // Report symlinks by their target type when the target is permitted.
          const linkCheck = this.ctx.workspace.check(path.join(dirPath, dirent.name), 'read');
          if (linkCheck.ok && linkCheck.resolvedPath) {
            isDirectory = (await fs.stat(linkCheck.resolvedPath).catch(() => null))?.isDirectory() ?? false;
          }
        }
        entries.push({ name: dirent.name, isDirectory });
      }
      entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
      const total = entries.length;
      const truncated = total > MAX_ENTRY_COUNT;
      const shown = truncated ? entries.slice(0, MAX_ENTRY_COUNT) : entries;
      let resultMessage = `Listed ${total} item(s) in ${dirPath}:\n---\n${shown
        .map((e) => `${e.isDirectory ? '[DIR] ' : ''}${e.name}`)
        .join('\n')}`;
      if (truncated) {
        const omitted = total - MAX_ENTRY_COUNT;
        resultMessage += `\n---\n[${omitted} ${omitted === 1 ? 'item' : 'items'} truncated] ...`;
      }
      return { llmContent: resultMessage, returnDisplay: `Listed ${total} item(s)${truncated ? ' (truncated)' : ''}` };
    } catch (error) {
      return this.errorResult(
        `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
        'Failed to list directory.',
        ToolErrorType.LS_EXECUTION_ERROR,
      );
    }
  }
}

export class LSTool extends BaseDeclarativeTool<LSToolParams, ToolResult> {
  static readonly Name = ToolNames.LS;

  constructor(private readonly ctx: ToolContext) {
    super(
      LSTool.Name,
      'ListDirectory',
      'Lists the names of files and subdirectories directly within a directory. Can optionally ignore entries matching provided glob patterns.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          path: {
            description: 'Directory to list. Absolute, or relative to the primary workspace root. Defaults to the primary root.',
            type: 'string',
          },
          ignore: {
            description: 'List of glob patterns to ignore',
            items: { type: 'string' },
            type: 'array',
          },
        },
      },
    );
  }

  protected createInvocation(params: LSToolParams): ToolInvocation<LSToolParams, ToolResult> {
    return new LSToolInvocation(this.ctx, params);
  }
}
