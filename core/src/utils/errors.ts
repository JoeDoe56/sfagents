/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/utils/errors.ts.
 */

const MAX_ERROR_MESSAGE_LENGTH = 4000;

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * True for user cancellation: DOMException-style AbortError, Node abort
 * errors and the OpenAI SDK's APIUserAbortError.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  return (error as { code?: unknown }).code === 'ABORT_ERR';
}

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… [truncated]`
    : message;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return truncate(`${error.message} (cause: ${cause.message})`);
    }
    return truncate(error.message);
  }
  if (typeof error === 'string') return truncate(error);
  try {
    return truncate(JSON.stringify(error));
  } catch {
    return truncate(String(error));
  }
}
