/**
 * SF Agents' per-user folder: app settings and the list of providers (names,
 * kinds, addresses: never keys or tokens, which live in the OS keyring).
 *
 *   Windows  %APPDATA%\SF Agents
 *   macOS    ~/Library/Application Support/SF Agents
 *   Linux    $XDG_CONFIG_HOME/sfagents (~/.config/sfagents)
 *
 * SFAGENTS_HOME overrides it (tests, portable installs).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sfagentsHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env['SFAGENTS_HOME']) return path.resolve(env['SFAGENTS_HOME']);
  const home = os.homedir();
  if (platform === 'win32') return path.join(env['APPDATA'] || path.join(home, 'AppData', 'Roaming'), 'SF Agents');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'SF Agents');
  return path.join(env['XDG_CONFIG_HOME'] || path.join(home, '.config'), 'sfagents');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Writes a file atomically (temp file + rename), private to the user. */
export function writeFileAtomic(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // renamed
    }
  }
}

/** Reads a JSON file, or `fallback` when it is missing. A malformed file is an error that names it. */
export function readJsonFile<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as T;
  } catch {
    throw new Error(`${file} is not valid JSON. Fix or delete it.`);
  }
}
