/**
 * Resolves the SF Agents project directory (the one holding the `agents`
 * folder), loads an optional untracked `.env` file from it and loads the
 * project's agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR_NAME, locateProject, loadAgentTree, type AgentTree } from '@sfagents/core';

export const MCP_CONFIG_FILE = 'mcp.json';
export const ENV_FILE = '.env';

export interface ConfigLocation {
  /** The project directory. */
  configDir: string;
  /** The agent to start with, when one was named. */
  agent?: string;
  mcpFile: string;
}

/**
 * `--config` names the project directory (default: the current one) or one
 * agent file in its agents folder; `--agent` names the agent to start with.
 */
export function locateConfig(configOption: string | undefined, mcpOption: string | undefined, cwd = process.cwd(), agentOption?: string): ConfigLocation {
  const located = locateProject(path.resolve(cwd, configOption ?? '.'));
  const configDir = located.projectDir;
  const mcpFile = mcpOption ? path.resolve(cwd, mcpOption) : path.join(configDir, MCP_CONFIG_FILE);
  const agent = agentOption ?? located.agent;
  return { configDir, mcpFile, ...(agent ? { agent } : {}) };
}

/**
 * Loads KEY=value lines from <configDir>/.env without overriding variables
 * already set in the environment. Returns the names that were loaded.
 */
export function loadEnvFile(configDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = path.join(configDir, ENV_FILE);
  if (!fs.existsSync(file)) return [];
  const loaded: string[] = [];
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

/**
 * Loads the project's agents. With `fallback` (the commands that start the
 * app, after ensureProject), a project whose agent files are all broken
 * still starts with the built-in default agent.
 */
export function loadConfig(location: ConfigLocation, options: { fallback?: boolean } = {}): AgentTree {
  if (options.fallback) {
    return loadAgentTree(location.configDir, { mcpConfigFile: location.mcpFile, fallback: true, ...(location.agent ? { agent: location.agent } : {}) });
  }
  if (!fs.existsSync(path.join(location.configDir, AGENTS_DIR_NAME)) && !fs.existsSync(path.join(location.configDir, 'agent.json'))) {
    throw new Error(
      `No agents found: ${location.configDir} has no "${AGENTS_DIR_NAME}" folder. Run sfagents from a project directory with ${AGENTS_DIR_NAME}/<name>.json files, or pass --config <dir>.`,
    );
  }
  return loadAgentTree(location.configDir, { mcpConfigFile: location.mcpFile, ...(location.agent ? { agent: location.agent } : {}) });
}
