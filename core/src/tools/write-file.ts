/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/write-file.ts.
 * Keeps create-or-overwrite semantics, parent directory creation, BOM and
 * line-ending preservation, and a diff in the confirmation prompt. Removed:
 * prior-read enforcement, artifacts, memory paths, IDE diff and telemetry.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ToolInvocation,
  ToolResult,
  ToolLocation,
  PermissionDecision,
  ToolCallConfirmationDetails,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolContext } from './tool-context.js';
import { makeDiff, readTextFile, writeTextFile, type TextFileSnapshot } from './file-io.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';

export interface WriteFileToolParams {
  file_path: string;
  content: string;
}

class WriteFileToolInvocation extends BaseToolInvocation<WriteFileToolParams, ToolResult> {
  constructor(
    private readonly ctx: ToolContext,
    params: WriteFileToolParams,
  ) {
    super(params);
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.ctx.workspace.resolve(this.params.file_path) }];
  }

  getDescription(): string {
    return `Writing to ${this.ctx.workspace.display(this.ctx.workspace.resolve(this.params.file_path))}`;
  }

  /** Writes always need approval unless the agent auto-approves write_file. */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const check = this.ctx.workspace.check(this.params.file_path, 'write');
    if (!check.ok) {
      this.denialReason = check.reason;
      return 'deny';
    }
    return 'ask';
  }

  override async getConfirmationDetails(): Promise<ToolCallConfirmationDetails> {
    const filePath = this.ctx.workspace.resolve(this.params.file_path);
    const existing = await readExisting(filePath);
    return {
      type: 'edit',
      title: existing ? `Overwrite ${this.ctx.workspace.display(filePath)}` : `Create ${this.ctx.workspace.display(filePath)}`,
      fileName: path.basename(filePath),
      filePath,
      fileDiff: makeDiff(path.basename(filePath), existing?.content ?? '', this.params.content),
    };
  }

  async execute(): Promise<ToolResult> {
    const check = this.ctx.workspace.check(this.params.file_path, 'write');
    if (!check.ok || !check.resolvedPath) {
      const message = check.reason ?? 'Path not permitted';
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.PATH_NOT_IN_WORKSPACE } };
    }
    const filePath = check.resolvedPath;
    try {
      const stats = await fs.stat(filePath).catch((e: unknown) => {
        if (isNodeError(e) && e.code === 'ENOENT') return null;
        throw e;
      });
      if (stats?.isDirectory()) {
        const message = `Path is a directory, not a file: ${this.params.file_path}`;
        return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.TARGET_IS_DIRECTORY } };
      }
      const existing = stats ? await readExisting(filePath) : null;
      await writeTextFile(filePath, this.params.content, {
        bom: existing?.bom ?? false,
        lineEnding: existing?.lineEnding ?? 'lf',
      });
      const lineCount = this.params.content.split('\n').length;
      const verb = existing ? 'overwrote' : 'created';
      return {
        llmContent: `Successfully ${verb} file: ${filePath} (${lineCount} lines).`,
        returnDisplay: `${existing ? 'Overwrote' : 'Created'} ${this.ctx.workspace.display(filePath)}`,
      };
    } catch (error) {
      const message = `Error writing to file ${this.params.file_path}: ${getErrorMessage(error)}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.FILE_WRITE_FAILURE } };
    }
  }
}

async function readExisting(filePath: string): Promise<TextFileSnapshot | null> {
  try {
    return await readTextFile(filePath);
  } catch {
    return null;
  }
}

export class WriteFileTool extends BaseDeclarativeTool<WriteFileToolParams, ToolResult> {
  static readonly Name = ToolNames.WRITE_FILE;

  constructor(private readonly ctx: ToolContext) {
    super(
      WriteFileTool.Name,
      'WriteFile',
      `Writes content to a file, creating it and any missing parent directories, or replacing it entirely if it exists. Prefer the ${ToolNames.EDIT} tool for changes to part of an existing file, and read an existing file with ${ToolNames.READ_FILE} before replacing it.`,
      Kind.Edit,
      {
        type: 'object',
        properties: {
          file_path: {
            description: 'Path of the file to write. Absolute, or relative to the primary workspace root.',
            type: 'string',
          },
          content: {
            description: 'The complete content to write to the file.',
            type: 'string',
          },
        },
        required: ['file_path', 'content'],
      },
    );
  }

  protected override validateToolParamValues(params: WriteFileToolParams): string | null {
    if (params.file_path.trim() === '') return "The 'file_path' parameter must be non-empty.";
    return null;
  }

  protected createInvocation(params: WriteFileToolParams): ToolInvocation<WriteFileToolParams, ToolResult> {
    return new WriteFileToolInvocation(this.ctx, params);
  }
}
