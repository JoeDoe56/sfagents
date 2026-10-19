/**
 * Single-writer lock for a conversation directory.
 *
 * The lock file is created exclusively and records {pid, host, started}.
 * A lock is replaced only when it is provably stale: same host and the
 * recorded process no longer exists, or an unreadable lock file older than
 * a grace period (a writer crashed between creating and filling it). A lock
 * held by another host is never assumed abandoned.
 */

import fs from 'node:fs';
import os from 'node:os';
import { isNodeError } from '../utils/errors.js';

export interface LockInfo {
  pid: number;
  host: string;
  started: string;
  file?: string;
}

const UNREADABLE_LOCK_GRACE_MS = 30_000;

export class ConversationLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: LockInfo | undefined,
    readonly remote: boolean,
  ) {
    super(
      holder
        ? `The conversation is in use by process ${holder.pid} on ${remote ? `another host (${holder.host})` : 'this computer'} since ${holder.started}. ` +
            (remote
              ? `If that process is gone, run "sfagents conversation unlock" to remove ${lockPath}.`
              : 'Close the other SF Agents session first, or use --ephemeral or --conversation <file>.')
        : `The conversation lock ${lockPath} exists but could not be read. If no other SF Agents session is running, run "sfagents conversation unlock".`,
    );
    this.name = 'ConversationLockedError';
  }
}

export function readLock(lockPath: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    if (typeof parsed.pid === 'number' && typeof parsed.host === 'string') return parsed;
  } catch {
    // unreadable
  }
  return undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: exists but owned by someone else.
    return isNodeError(error) && error.code === 'EPERM';
  }
  // A killed process whose parent has not reaped it still answers signal 0
  // on Linux; a zombie holds no conversation open, so it does not count.
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') return false;
    } catch {
      // /proc unavailable: fall through
    }
  }
  return true;
}

const held = new Set<ConversationLock>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous release on any exit path (including Ctrl+C after cleanup).
  process.once('exit', () => {
    for (const lock of held) lock.release();
  });
}

export class ConversationLock {
  private released = false;

  private constructor(
    readonly lockPath: string,
    readonly info: LockInfo,
  ) {}

  static acquire(lockPath: string, file?: string): ConversationLock {
    const info: LockInfo = { pid: process.pid, host: os.hostname(), started: new Date().toISOString(), file };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify(info));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const lock = new ConversationLock(lockPath, info);
        held.add(lock);
        installExitHook();
        return lock;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }
      const holder = readLock(lockPath);
      if (holder) {
        const remote = holder.host !== info.host;
        if (remote || processExists(holder.pid)) throw new ConversationLockedError(lockPath, holder, remote);
      } else {
        let ageMs = 0;
        try {
          ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        } catch {
          continue; // removed meanwhile; retry
        }
        if (ageMs < UNREADABLE_LOCK_GRACE_MS) throw new ConversationLockedError(lockPath, undefined, false);
      }
      // Stale: the recorded process is gone. Remove and retry once.
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
    }
    throw new ConversationLockedError(lockPath, readLock(lockPath), false);
  }

  /** Removes the lock if it is still ours. Safe to call more than once. */
  release(): void {
    if (this.released) return;
    this.released = true;
    held.delete(this);
    const current = readLock(this.lockPath);
    if (current && current.pid === this.info.pid && current.started === this.info.started) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // best effort
      }
    }
  }
}

/** Unconditionally removes a lock file (user-confirmed recovery). */
export function forceUnlock(lockPath: string): boolean {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}
