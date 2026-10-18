/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/glob.ts and
 * glob-search.ts. Keeps recency-then-alphabetical sorting, the 100-file
 * result cap and the collection cap. Removed: worker-thread execution and
 * git/.qwenignore filtering. Added: every match is re-checked against the
 * agent's canonical workspace roots, so absolute patterns, `..` segments and
 * symlinks cannot list files outside them.
 */

import path from 'node:path';
import { glob, type Path } from 'glob';
import type { ToolInvocation, ToolResult, PermissionDecision } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolContext } from './tool-context.js';

const MAX_FILE_COUNT = 100;
const MAX_GLOB_COLLECTED_ENTRIES = MAX_FILE_COUNT * 10;
export const DEFAULT_IGNORES = ['**/node_modules/**', '**/.git/**'];

export interface GlobPath {
  fullpath(): string;
  mtimeMs?: number;
}

export function sortFileEntries(
  entries: GlobPath[],
  nowTimestamp: number,
  recencyThresholdMs: number,
): GlobPath[] {
  const sortedEntries = [...entries];
  sortedEntries.sort((a, b) => {
    const mtimeA = a.mtimeMs ?? 0;
    const mtimeB = b.mtimeMs ?? 0;
    const aIsRecent = nowTimestamp - mtimeA < recencyThresholdMs;
    const bIsRecent = nowTimestamp - mtimeB < recencyThresholdMs;
    if (aIsRecent && bIsRecent) {
      return mtimeB - mtimeA;
    } else if (aIsRecent) {
      return -1;
    } else if (bIsRecent) {
      return 1;
    } else {
      return a.fullpath().localeCompare(b.fullpath());
    }
  });
  return sortedEntries;
}

export interface GlobToolParams {
  pattern: string;
  path?: string;
}

class GlobToolInvocation extends BaseToolInvocation<GlobToolParams, ToolResult> {
  constructor(
    private readonly ctx: ToolContext,
    params: GlobToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.path) {
      description += ` in ${this.ctx.workspace.display(this.ctx.workspace.resolve(this.params.path))}`;
    }
    return description;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (!this.params.path) return 'allow';
    const check = this.ctx.workspace.check(this.params.path, 'read');
    if (!check.ok) {
      this.denialReason = check.reason;
      return 'deny';
    }
    return 'allow';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const searchDirs: string[] = [];
      let searchLocationDescription: string;
      if (this.params.path) {
        const check = this.ctx.workspace.check(this.params.path, 'read');
        if (!check.ok || !check.resolvedPath) {
          const message = check.reason ?? 'Path not permitted';
          return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.PATH_NOT_IN_WORKSPACE } };
        }
        searchDirs.push(check.resolvedPath);
        searchLocationDescription = `within ${check.resolvedPath}`;
      } else {
        const dirs = this.ctx.workspace.getDirectories();
        searchDirs.push(...dirs);
        searchLocationDescription = dirs.length > 1 ? `across ${dirs.length} workspace directories` : 'in the workspace directory';
      }

      const collected: GlobPath[] = [];
      const seen = new Set<string>();
      let hitCollectionLimit = false;
      for (const searchDir of searchDirs) {
        const matches: Path[] = await glob(this.params.pattern, {
          cwd: searchDir,
          withFileTypes: true,
          stat: true,
          nodir: true,
          dot: true,
          follow: false,
          ignore: DEFAULT_IGNORES,
          signal,
          nocase: process.platform === 'win32' || process.platform === 'darwin',
        });
        for (const entry of matches) {
          const full = entry.fullpath();
          if (!this.ctx.workspace.check(full, 'read').ok) continue;
          const key = process.platform === 'win32' ? full.toLowerCase() : full;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push({ fullpath: () => full, mtimeMs: entry.mtimeMs });
          if (collected.length >= MAX_GLOB_COLLECTED_ENTRIES) {
            hitCollectionLimit = true;
            break;
          }
        }
        if (hitCollectionLimit) break;
      }

      if (collected.length === 0) {
        return {
          llmContent: `No files found matching pattern "${this.params.pattern}" ${searchLocationDescription}`,
          returnDisplay: 'No files found',
        };
      }

      const sortedEntries = sortFileEntries(collected, Date.now(), 24 * 60 * 60 * 1000);
      const totalFileCount = sortedEntries.length;
      const truncated = hitCollectionLimit || totalFileCount > MAX_FILE_COUNT;
      const shown = truncated ? sortedEntries.slice(0, MAX_FILE_COUNT) : sortedEntries;
      let resultMessage = hitCollectionLimit
        ? `Found at least ${totalFileCount} file(s) matching "${this.params.pattern}" ${searchLocationDescription}`
        : `Found ${totalFileCount} file(s) matching "${this.params.pattern}" ${searchLocationDescription}`;
      resultMessage += `, sorted by modification time (newest first):\n---\n${shown.map((e) => e.fullpath()).join('\n')}`;
      if (hitCollectionLimit) {
        resultMessage += `\n---\n[Results truncated after scanning ${totalFileCount} matching files. Narrow the pattern or path.]`;
      } else if (truncated) {
        const omitted = totalFileCount - MAX_FILE_COUNT;
        resultMessage += `\n---\n[${omitted} ${omitted === 1 ? 'file' : 'files'} truncated] ...`;
      }
      return {
        llmContent: resultMessage,
        returnDisplay: `${hitCollectionLimit ? 'Found at least' : 'Found'} ${totalFileCount} matching file(s)${truncated ? ' (truncated)' : ''}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const rawError = `Error during glob search operation: ${errorMessage}`;
      return { llmContent: rawError, returnDisplay: `Error: ${errorMessage}`, error: { message: rawError, type: ToolErrorType.GLOB_EXECUTION_ERROR } };
    }
  }
}

export class GlobTool extends BaseDeclarativeTool<GlobToolParams, ToolResult> {
  static readonly Name = ToolNames.GLOB;

  constructor(private readonly ctx: ToolContext) {
    super(
      GlobTool.Name,
      'FindFiles',
      'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time (newest first). node_modules and .git are skipped.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          pattern: { description: 'The glob pattern to match files against', type: 'string' },
          path: {
            description: 'Directory to search in. Absolute, or relative to the primary workspace root. Defaults to all workspace roots.',
            type: 'string',
          },
        },
        required: ['pattern'],
      },
    );
  }

  protected override validateToolParamValues(params: GlobToolParams): string | null {
    if (!params.pattern || params.pattern.trim() === '') return "The 'pattern' parameter cannot be empty.";
    if (path.isAbsolute(params.pattern)) {
      return "The 'pattern' must be relative; use the 'path' parameter to choose a directory.";
    }
    return null;
  }

  protected createInvocation(params: GlobToolParams): ToolInvocation<GlobToolParams, ToolResult> {
    return new GlobToolInvocation(this.ctx, params);
  }
}
