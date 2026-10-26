/**
 * Deletes a folder (or file) without ever throwing. On Windows a process that
 * just exited, or one still starting to exit, can hold its folder for a moment
 * (EPERM/EBUSY): then the delete is retried in the background for a while.
 */

import fs from 'node:fs';

/** True if it is gone now; false if the delete goes on in the background. */
export function removeDir(target: string, options: { retries?: number; delayMs?: number } = {}): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    void fs.promises.rm(target, { recursive: true, force: true, maxRetries: options.retries ?? 20, retryDelay: options.delayMs ?? 500 }).catch(() => {});
    return false;
  }
}
