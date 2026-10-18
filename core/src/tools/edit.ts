/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/edit.ts.
 * Keeps `applyReplacement`, the `calculateEdit` decision table (create with
 * empty old_string, file not found, zero or multiple occurrences, no change),
 * relaxed matching through edit-helper.ts, BOM and line-ending preservation.
 * Removed: prior-read cache, team-memory secret scanning, sandbox file
 * versions, commit attribution, IDE diff, modifiable-tool flow, telemetry.
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
import { makeDiff, readTextFile, writeTextFile, type LineEnding } from './file-io.js';
import { safeLiteralReplace } from '../utils/text-utils.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import {
  countOccurrences,
  findLineBasedMatchOffsets,
  maybeAugmentOldStringForDeletion,
  normalizeEditStrings,
} from './edit-helper.js';

export function applyReplacement(
  currentContent: string | null,
  oldString: string,
  newString: string,
  isNewFile: boolean,
  matchOffsets?: readonly number[],
): string {
  if (isNewFile) {
    return newString;
  }
  if (currentContent === null) {
    return oldString === '' ? newString : '';
  }
  if (oldString === '' && !isNewFile) {
    return currentContent;
  }
  if (matchOffsets !== undefined) {
    const pieces: string[] = [];
    let cursor = 0;
    for (const offset of matchOffsets) {
      pieces.push(currentContent.slice(cursor, offset), newString);
      cursor = offset + oldString.length;
    }
    pieces.push(currentContent.slice(cursor));
    return pieces.join('');
  }
  return safeLiteralReplace(currentContent, oldString, newString);
}

export interface EditToolParams {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface CalculatedEdit {
  currentContent: string | null;
  newContent: string;
  occurrences: number;
  error?: { display: string; raw: string; type: ToolErrorType };
  isNewFile: boolean;
  bom: boolean;
  lineEnding: LineEnding;
}

export async function calculateEdit(filePath: string, params: EditToolParams): Promise<CalculatedEdit> {
  const replaceAll = params.replace_all ?? false;
  let currentContent: string | null = null;
  let fileExists = false;
  let isNewFile = false;
  let bom = false;
  let lineEnding: LineEnding = 'lf';
  let occurrences = 0;
  let error: CalculatedEdit['error'];

  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      return {
        currentContent: null,
        newContent: '',
        occurrences: 0,
        isNewFile: false,
        bom,
        lineEnding,
        error: {
          display: 'Path is a directory.',
          raw: `Path is a directory, not a file: ${params.file_path}`,
          type: ToolErrorType.TARGET_IS_DIRECTORY,
        },
      };
    }
    const snapshot = await readTextFile(filePath);
    currentContent = snapshot.content;
    bom = snapshot.bom;
    lineEnding = snapshot.lineEnding;
    fileExists = true;
  } catch (err: unknown) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
    fileExists = false;
  }

  const normalized = normalizeEditStrings(currentContent, params.old_string, params.new_string);
  let finalOldString = normalized.oldString;
  const finalNewString = normalized.newString;
  let matchOffsets: number[] | undefined;

  if (params.old_string === '' && !fileExists) {
    isNewFile = true;
  } else if (!fileExists) {
    error = {
      display: 'File not found. Cannot apply edit. Use an empty old_string to create a new file.',
      raw: `File not found: ${params.file_path}`,
      type: ToolErrorType.FILE_NOT_FOUND,
    };
  } else if (currentContent !== null) {
    finalOldString = maybeAugmentOldStringForDeletion(
      currentContent,
      finalOldString,
      finalNewString,
      normalized.lineBasedMatch,
    );
    if (normalized.lineBasedMatch) {
      matchOffsets = findLineBasedMatchOffsets(currentContent, finalOldString);
    }
    occurrences = matchOffsets?.length ?? countOccurrences(currentContent, finalOldString);
    if (params.old_string === '') {
      error = {
        display: 'Failed to edit. Attempted to create a file that already exists.',
        raw: `File already exists, cannot create: ${params.file_path}`,
        type: ToolErrorType.ATTEMPT_TO_CREATE_EXISTING_FILE,
      };
    } else if (occurrences === 0) {
      error = {
        display: 'Failed to edit, could not find the string to replace.',
        raw: `Failed to edit, 0 occurrences found for old_string in ${params.file_path}. No edits made. The exact text in old_string was not found. Ensure you're not escaping content incorrectly and check whitespace, indentation, and context. Use ${ToolNames.READ_FILE} tool to verify.`,
        type: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
      };
    } else if (!replaceAll && occurrences > 1) {
      error = {
        display: 'Failed to edit because the text matches multiple locations. Provide more context or set replace_all to true.',
        raw: `Failed to edit. Found ${occurrences} occurrences for old_string in ${params.file_path} but replace_all was not enabled.`,
        type: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
      };
    } else if (finalOldString === finalNewString) {
      error = {
        display: 'No changes to apply. The old_string and new_string are identical.',
        raw: `No changes to apply. The old_string and new_string are identical in file: ${params.file_path}`,
        type: ToolErrorType.EDIT_NO_CHANGE,
      };
    }
  }

  const newContent = !error
    ? applyReplacement(currentContent, finalOldString, finalNewString, isNewFile, matchOffsets)
    : (currentContent ?? '');

  if (!error && fileExists && currentContent === newContent) {
    error = {
      display: 'No changes to apply. The new content is identical to the current content.',
      raw: `No changes to apply. The new content is identical to the current content in file: ${params.file_path}`,
      type: ToolErrorType.EDIT_NO_CHANGE,
    };
  }

  return { currentContent, newContent, occurrences, error, isNewFile, bom, lineEnding };
}

class EditToolInvocation extends BaseToolInvocation<EditToolParams, ToolResult> {
  constructor(
    private readonly ctx: ToolContext,
    params: EditToolParams,
  ) {
    super(params);
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.ctx.workspace.resolve(this.params.file_path) }];
  }

  getDescription(): string {
    const p = this.ctx.workspace.display(this.ctx.workspace.resolve(this.params.file_path));
    if (this.params.old_string === '') return `Create ${p}`;
    const snippet = (s: string) => s.split('\n')[0]!.slice(0, 30) + (s.length > 30 ? '...' : '');
    return `${p}: ${snippet(this.params.old_string)} => ${snippet(this.params.new_string)}`;
  }

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
    let diff = '';
    try {
      const edit = await calculateEdit(filePath, this.params);
      diff = edit.error
        ? `(edit will fail: ${edit.error.display})`
        : makeDiff(path.basename(filePath), edit.currentContent ?? '', edit.newContent);
    } catch (error) {
      diff = `(could not compute diff: ${getErrorMessage(error)})`;
    }
    return {
      type: 'edit',
      title: `Edit ${this.ctx.workspace.display(filePath)}`,
      fileName: path.basename(filePath),
      filePath,
      fileDiff: diff,
    };
  }

  async execute(): Promise<ToolResult> {
    const check = this.ctx.workspace.check(this.params.file_path, 'write');
    if (!check.ok || !check.resolvedPath) {
      const message = check.reason ?? 'Path not permitted';
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.PATH_NOT_IN_WORKSPACE } };
    }
    const filePath = check.resolvedPath;
    let edit: CalculatedEdit;
    try {
      edit = await calculateEdit(filePath, this.params);
    } catch (error) {
      const message = `Error preparing edit for ${this.params.file_path}: ${getErrorMessage(error)}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.READ_CONTENT_FAILURE } };
    }
    if (edit.error) {
      return {
        llmContent: edit.error.raw,
        returnDisplay: edit.error.display,
        error: { message: edit.error.raw, type: edit.error.type },
      };
    }
    try {
      await writeTextFile(filePath, edit.newContent, { bom: edit.bom, lineEnding: edit.lineEnding });
    } catch (error) {
      const message = `Error writing file ${this.params.file_path}: ${getErrorMessage(error)}`;
      return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.FILE_WRITE_FAILURE } };
    }
    const display = this.ctx.workspace.display(filePath);
    return edit.isNewFile
      ? { llmContent: `Created new file: ${filePath} with provided content.`, returnDisplay: `Created ${display}` }
      : {
          llmContent: `The file: ${filePath} has been updated (${edit.occurrences} replacement${edit.occurrences === 1 ? '' : 's'}).`,
          returnDisplay: `Edited ${display} (${edit.occurrences} replacement${edit.occurrences === 1 ? '' : 's'})`,
        };
  }
}

export class EditTool extends BaseDeclarativeTool<EditToolParams, ToolResult> {
  static readonly Name = ToolNames.EDIT;

  constructor(private readonly ctx: ToolContext) {
    super(
      EditTool.Name,
      'Edit',
      `Replaces text within a file. By default, replaces a single occurrence; set \`replace_all\` to true to replace every instance of \`old_string\`. Include enough surrounding context in old_string to identify the location uniquely. Always use the ${ToolNames.READ_FILE} tool to examine the file's current content before attempting a text replacement. To create a new file, use an empty old_string.`,
      Kind.Edit,
      {
        type: 'object',
        properties: {
          file_path: {
            description: 'Path of the file to modify. Absolute, or relative to the primary workspace root.',
            type: 'string',
          },
          old_string: {
            description: 'The exact literal text to replace, including whitespace and indentation.',
            type: 'string',
          },
          new_string: {
            description: 'The exact literal text to replace old_string with.',
            type: 'string',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences of old_string (default false).',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    );
  }

  protected override validateToolParamValues(params: EditToolParams): string | null {
    if (params.file_path.trim() === '') return "The 'file_path' parameter must be non-empty.";
    return null;
  }

  protected createInvocation(params: EditToolParams): ToolInvocation<EditToolParams, ToolResult> {
    return new EditToolInvocation(this.ctx, params);
  }
}
