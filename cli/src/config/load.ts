/**
 * Resolves the SF Agents configuration directory, loads an optional untracked
 * `.env` file from it and loads the validated agent tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadAgentTree, type AgentTree } from '@sfagents/core';

export const ROOT_AGENT_FILE = 'agent.json';
export const MCP_CONFIG_FILE = 'mcp.json';
export const ENV_FILE = '.env';

export interface ConfigLocation {
  configDir: string;
  agentFile: string;
  mcpFile: string;
}

/** `--config` may name a directory containing agent.json or an agent JSON file. */
export function locateConfig(configOption: string | undefined, mcpOption: string | undefined, cwd = process.cwd()): ConfigLocation {
  const target = path.resolve(cwd, configOption ?? '.');
  let agentFile: string;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    agentFile = path.join(target, ROOT_AGENT_FILE);
  } else {
    agentFile = target;
  }
  const configDir = path.dirname(agentFile);
  const mcpFile = mcpOption ? path.resolve(cwd, mcpOption) : path.join(configDir, MCP_CONFIG_FILE);
  return { configDir, agentFile, mcpFile };
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

export function loadConfig(location: ConfigLocation): AgentTree {
  if (!fs.existsSync(location.agentFile)) {
    throw new Error(
      `No agent definition found at ${location.agentFile}. Run sfagents from a directory containing ${ROOT_AGENT_FILE}, or pass --config <dir|file>.`,
    );
  }
  return loadAgentTree(location.agentFile, { mcpConfigFile: location.mcpFile });
}
