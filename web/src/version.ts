/**
 * Which commit this copy of SF Agents is: the one its build was made from
 * (scripts/stamp-version.mjs writes dist/version.json), and the one the
 * checkout is on now. They differ when the code was pulled without a rebuild.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface RunningVersion {
  /** Commit the running build was made from, or null when the build has no stamp. */
  built: string | null;
  /** Commit the checkout is on, or null outside a git checkout. */
  checkout: string | null;
}

function readBuilt(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./version.json', import.meta.url)), 'utf8')) as Record<string, unknown>;
    return typeof raw.commit === 'string' && raw.commit ? raw.commit : null;
  } catch {
    return null;
  }
}

function readCheckout(): string | null {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 3000, windowsHide: true });
  const commit = git.status === 0 ? git.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

let cached: RunningVersion | null = null;

/** Read once, at the first call (the server makes it at startup). */
export function runningVersion(): RunningVersion {
  cached ??= { built: readBuilt(), checkout: readCheckout() };
  return cached;
}
