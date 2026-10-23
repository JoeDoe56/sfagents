/**
 * Watches a project's agent files and mcp.json, so a running interface can
 * reload them without a restart. Changes are debounced (an editor's save is
 * often several writes) and reported once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR_NAME } from './loader.js';

export interface ProjectWatcher {
  close(): void;
}

export function watchProject(options: { configDir: string; mcpFile?: string; onChange: () => void; debounceMs?: number }): ProjectWatcher {
  const delay = options.debounceMs ?? 300;
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(options.onChange, delay);
  };
  const agentsDir = path.join(options.configDir, AGENTS_DIR_NAME);
  const watchers: fs.FSWatcher[] = [];
  const watchDir = () => {
    try {
      const w = fs.watch(agentsDir, { persistent: false }, (_event, name) => {
        if (!name || String(name).toLowerCase().endsWith('.json')) fire();
      });
      w.on('error', () => undefined);
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  };
  let dirWatched = watchDir();
  // The project folder, for the agents folder appearing or being replaced.
  try {
    const w = fs.watch(options.configDir, { persistent: false }, (_event, name) => {
      if (name === AGENTS_DIR_NAME) {
        if (!dirWatched) dirWatched = watchDir();
        fire();
      }
    });
    w.on('error', () => undefined);
    watchers.push(w);
  } catch {
    // unreadable project folder: nothing to watch
  }
  // mcp.json may be replaced by rename (editors do), so it is polled.
  const mcpFile = options.mcpFile ?? path.join(options.configDir, 'mcp.json');
  fs.watchFile(mcpFile, { interval: 1000, persistent: false }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) fire();
  });
  return {
    close() {
      clearTimeout(timer);
      for (const w of watchers) w.close();
      fs.unwatchFile(mcpFile);
    },
  };
}
