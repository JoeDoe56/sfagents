/**
 * Watches a project's agent files and mcp.json, so a running interface can
 * reload them without a restart. Changes are debounced (an editor's save is
 * often several writes) and reported once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR_NAME } from './loader.js';
import { PROMPTS_DIR_NAME } from './prompts.js';

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
  const promptsDir = path.join(options.configDir, PROMPTS_DIR_NAME);
  const watchers: fs.FSWatcher[] = [];
  const watchDir = (dir: string, relevant: (name: string) => boolean) => {
    try {
      const w = fs.watch(dir, { persistent: false }, (_event, name) => {
        if (!name || relevant(String(name).toLowerCase())) fire();
      });
      w.on('error', () => undefined);
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  };
  const agentFile = (name: string) => name.endsWith('.json');
  // Prompt files agents reference ("@name.txt").
  const promptFile = (name: string) => name.endsWith('.txt') || name.endsWith('.md');
  let dirWatched = watchDir(agentsDir, agentFile);
  let promptsWatched = watchDir(promptsDir, promptFile);
  // The project folder, for the agents folder appearing or being replaced.
  try {
    const w = fs.watch(options.configDir, { persistent: false }, (_event, name) => {
      if (name === AGENTS_DIR_NAME) {
        if (!dirWatched) dirWatched = watchDir(agentsDir, agentFile);
        fire();
      } else if (name === PROMPTS_DIR_NAME) {
        if (!promptsWatched) promptsWatched = watchDir(promptsDir, promptFile);
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
