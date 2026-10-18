/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/cli/src/utils/cleanup.ts:
 * registered cleanup functions (MCP disconnects) run on exit, each capped by
 * a per-step timeout and the whole pass by an overall timeout.
 */

const cleanupFunctions: Array<() => void | Promise<void>> = [];
const PER_CLEANUP_TIMEOUT_MS = 2_000;
const OVERALL_CLEANUP_TIMEOUT_MS = 5_000;

export function registerCleanup(fn: () => void | Promise<void>): () => void {
  cleanupFunctions.push(fn);
  return () => {
    const index = cleanupFunctions.indexOf(fn);
    if (index !== -1) cleanupFunctions.splice(index, 1);
  };
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export async function runExitCleanup(): Promise<void> {
  const fns = cleanupFunctions.splice(0).reverse();
  const pass = (async () => {
    for (const fn of fns) {
      await withTimeout(Promise.resolve().then(fn), PER_CLEANUP_TIMEOUT_MS);
    }
  })();
  await withTimeout(pass, OVERALL_CLEANUP_TIMEOUT_MS);
}
