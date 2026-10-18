/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/utils/textUtils.ts.
 * `truncateForModel` is SF Agents-owned.
 */

import { stripVTControlCharacters } from 'node:util';

// C0/C1 control chars (incl. DEL) left behind after escape-sequence stripping,
// except tab and newline which are preserved for readable terminal output.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Strips terminal escape/control sequences from untrusted text before it is
 * written to a terminal (tool output, model text, MCP server errors).
 */
export function stripAnsiAndControl(text: string): string {
  return stripVTControlCharacters(text).replace(CONTROL_CHARS_RE, '');
}

/**
 * Safely replaces text with literal strings, avoiding ECMAScript
 * GetSubstitution issues. Escapes $ characters to prevent template
 * interpretation.
 */
export function safeLiteralReplace(
  str: string,
  oldString: string,
  newString: string,
): string {
  if (oldString === '' || !str.includes(oldString)) {
    return str;
  }

  if (!newString.includes('$')) {
    return str.replaceAll(oldString, newString);
  }

  const escapedNewString = newString.replaceAll('$', '$$$$');
  return str.replaceAll(oldString, escapedNewString);
}

/**
 * Checks if a Buffer is likely binary by testing for the presence of a NULL
 * byte in its first `sampleSize` bytes.
 */
export function isBinary(
  data: Buffer | null | undefined,
  sampleSize = 512,
): boolean {
  if (!data) {
    return false;
  }
  const sample = data.length > sampleSize ? data.subarray(0, sampleSize) : data;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Bounds text that is about to be sent to the model. Keeps the head and the
 * tail so both the start of a listing and a trailing error remain visible.
 */
export function truncateForModel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 120);
  const head = text.slice(0, Math.ceil(keep * 0.6));
  const tail = text.slice(text.length - Math.floor(keep * 0.4));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n[... ${omitted} characters omitted by SF Agents output limit ...]\n\n${tail}`;
}
