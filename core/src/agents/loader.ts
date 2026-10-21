/**
 * Loads a project's agents: every `*.json` file in its `agents` folder that
 * is a valid agent definition. Files that are not (bad JSON, unknown fields,
 * an unknown MCP server, missing workspace roots) are skipped and reported,
 * so one broken file never takes the others down.
 *
 * An agent is known by its file name: `agents/researcher.json` is
 * "researcher", whatever it calls itself inside. Each agent carries its own
 * permissions; none is limited by another's. An agent may message others it
 * is granted with "N-name.json" entries in `tools.allow` (N: how many
 * threads with that agent it may run at once); grants may form any graph,
 * cycles included.
 *
 * The result is deeply frozen; runtime code cannot widen it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, artifactAccess, conversationAccess, mcpGrants, parseAgentDefinition, type AgentDefinition } from './definition.js';
import { WorkspaceContext } from '../permissions/workspace.js';
import { loadMcpConfig, type McpConfigFile } from '../mcp/config.js';

export const AGENTS_DIR_NAME = 'agents';
/** The agent the project starts with when none is chosen: "main", else the first by name. */
export const DEFAULT_AGENT_NAME = 'main';

export interface AgentNode {
  /** The agent's name (its file name without ".json"). */
  readonly id: string;
  /** Canonical absolute path of the definition file. */
  readonly file: string;
  readonly definition: Readonly<AgentDefinition>;
  /** Canonical workspace roots; empty when the agent has no filesystem access. */
  readonly roots: readonly string[];
  /** Agents this one may message → how many threads with each it may run at once. */
  readonly grants: ReadonlyMap<string, number>;
}

export interface SkippedAgentFile {
  /** Path relative to the project directory. */
  file: string;
  error: string;
}

export interface AgentTree {
  /** The project directory (holding the agents folder, mcp.json, .env and .sfagents). */
  readonly configDir: string;
  readonly agentsDir: string;
  /** The agent chosen at load time (the default for the main conversation). */
  readonly root: AgentNode;
  readonly byId: ReadonlyMap<string, AgentNode>;
  readonly mcp: McpConfigFile;
  /** Agent files that were not loaded, and why. */
  readonly skipped: readonly SkippedAgentFile[];
  /** Grants naming agents that are not loaded, and similar notes. */
  readonly warnings: readonly string[];
  /** Configuration files no agent file tool may modify. */
  readonly protectedFiles: readonly string[];
  /** Credential files no agent file tool may read or modify (<configDir>/.env). */
  readonly secretFiles: readonly string[];
}

export interface LoadOptions {
  /** Path to mcp.json; defaults to <project>/mcp.json. */
  mcpConfigFile?: string;
  /** The agent to start with (a name, or a file in the agents folder). */
  agent?: string;
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(file, undefined, `cannot read file: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ConfigError(file, undefined, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value as object)) {
    seen.add(value as object);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v, seen);
    if (value instanceof Map) {
      for (const v of value.values()) deepFreeze(v, seen);
    }
    Object.freeze(value);
  }
  return value;
}

function rel(configDir: string, file: string): string {
  return path.relative(configDir, file) || path.basename(file);
}

/**
 * Where a project is: a project directory (holding `agents/`), the agents
 * folder itself, or one agent file inside it (which also picks that agent).
 */
export function locateProject(target: string): { projectDir: string; agent?: string } {
  const abs = path.resolve(target);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    if (path.basename(abs) === AGENTS_DIR_NAME && !fs.existsSync(path.join(abs, AGENTS_DIR_NAME))) return { projectDir: path.dirname(abs) };
    return { projectDir: abs };
  }
  if (abs.toLowerCase().endsWith('.json') && path.basename(path.dirname(abs)) === AGENTS_DIR_NAME) {
    return { projectDir: path.dirname(path.dirname(abs)), agent: path.basename(abs).replace(/\.json$/i, '') };
  }
  if (path.basename(abs) === 'agent.json' && fs.existsSync(abs)) {
    throw new ConfigError(
      abs,
      undefined,
      `agents now live in an "${AGENTS_DIR_NAME}" folder: move this file to ${path.join(path.dirname(abs), AGENTS_DIR_NAME, 'main.json')}, and replace "spawn.children" with "N-name.json" entries in tools.allow`,
    );
  }
  return { projectDir: path.dirname(abs) };
}

/** Loads every valid agent of a project. Throws only when none is usable. */
export function loadAgentTree(target: string, options: LoadOptions = {}): AgentTree {
  const located = locateProject(target);
  const configDir = fs.realpathSync(located.projectDir);
  const agentsDir = path.join(configDir, AGENTS_DIR_NAME);
  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    const legacy = path.join(configDir, 'agent.json');
    if (fs.existsSync(legacy)) locateProject(legacy); // throws the migration message
    throw new ConfigError(agentsDir, undefined, `no "${AGENTS_DIR_NAME}" folder: create it and add an agent definition (for example ${AGENTS_DIR_NAME}/main.json)`);
  }
  const mcpFile = path.resolve(options.mcpConfigFile ?? path.join(configDir, 'mcp.json'));
  const mcp = loadMcpConfig(mcpFile);

  const skipped: SkippedAgentFile[] = [];
  const warnings: string[] = [];
  const protectedFiles = new Set<string>([mcpFile]);
  const loaded = new Map<string, { file: string; definition: AgentDefinition; roots: string[] }>();

  const files = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  for (const name of files) {
    const file = fs.realpathSync(path.join(agentsDir, name));
    protectedFiles.add(file);
    const shown = rel(configDir, file);
    const agentName = name.replace(/\.json$/i, '');
    try {
      const def = parseAgentDefinition(readJson(file), shown, agentName);
      for (const [server] of mcpGrants(def)) {
        if (!mcp.servers[server]) {
          throw new ConfigError(
            shown,
            'tools.mcpServers',
            `unknown MCP server "${server}". ${mcp.file ? `Servers defined in ${rel(configDir, mcp.file)}: ${Object.keys(mcp.servers).join(', ') || '(none)'}` : 'No mcp.json was found.'}`,
          );
        }
      }
      // Workspace roots are relative to the project directory ("." is the
      // project, and the default).
      const specs = def.workspace?.roots ?? ['.'];
      const roots: string[] = [];
      specs.forEach((spec, i) => {
        try {
          roots.push(WorkspaceContext.resolveAndValidateDir(path.resolve(configDir, spec)));
        } catch (error) {
          throw new ConfigError(shown, `workspace.roots[${i}]`, error instanceof Error ? error.message : String(error));
        }
      });
      if (loaded.has(agentName)) throw new ConfigError(shown, undefined, `another file is already named "${agentName}"`);
      loaded.set(agentName, { file, definition: def, roots: [...new Set(roots)] });
    } catch (error) {
      skipped.push({ file: shown, error: error instanceof ConfigError ? error.message.replace(`${shown}: `, '').replace(`${shown} `, '') : String(error) });
    }
  }

  if (loaded.size === 0) {
    const why = skipped.length ? ` Skipped: ${skipped.map((s) => `${s.file}: ${s.error}`).join('; ')}` : '';
    throw new ConfigError(agentsDir, undefined, `no valid agent definitions.${why}`);
  }

  const byId = new Map<string, AgentNode>();
  for (const [id, a] of loaded) {
    const grants = new Map<string, number>();
    for (const g of a.definition.tools?.agents ?? []) {
      if (!loaded.has(g.agent)) {
        warnings.push(`${rel(configDir, a.file)}: "${g.file}" is not a loaded agent, so "${id}" cannot message it`);
        continue;
      }
      grants.set(g.agent, g.max);
    }
    byId.set(id, { id, file: a.file, definition: a.definition, roots: a.roots, grants });
  }

  let rootName = options.agent ?? located.agent;
  if (rootName) {
    rootName = rootName.replace(/\.json$/i, '');
    if (!byId.has(rootName)) {
      const bad = skipped.find((s) => path.basename(s.file).replace(/\.json$/i, '') === rootName);
      throw new ConfigError(agentsDir, undefined, bad ? `agent "${rootName}" was not loaded: ${bad.error}` : `no agent named "${rootName}". Agents: ${[...byId.keys()].join(', ')}`);
    }
  } else {
    rootName = byId.has(DEFAULT_AGENT_NAME) ? DEFAULT_AGENT_NAME : [...byId.keys()][0]!;
  }

  const tree: AgentTree = {
    configDir,
    agentsDir,
    root: byId.get(rootName)!,
    byId,
    mcp,
    skipped,
    warnings,
    protectedFiles: [...protectedFiles],
    secretFiles: [path.join(configDir, '.env')],
  };
  return deepFreeze(tree);
}

/** The same project with another agent as the default (the main conversation's agent). */
export function withRoot(tree: AgentTree, agent: string): AgentTree {
  const root = tree.byId.get(agent);
  if (!root) throw new Error(`no agent named "${agent}"`);
  return root === tree.root ? tree : Object.freeze({ ...tree, root });
}

/** Human-readable list for `sfagents agents validate`. */
export function describeTree(tree: AgentTree): string {
  const lines: string[] = [];
  for (const node of tree.byId.values()) {
    const d = node.definition;
    const tools = [...(d.tools?.allow ?? [])];
    for (const [server, list] of mcpGrants(d)) tools.push(list ? `mcp:${server}[${[...list].join(',')}]` : `mcp:${server}[*]`);
    for (const [agent, max] of node.grants) tools.push(`message:${agent}×${max}`);
    const access = conversationAccess(d, 0);
    if (access !== 'none') tools.push(`conversation:${access}`);
    const artifacts = artifactAccess(d, 0);
    if (artifacts !== 'none') tools.push(`artifacts:${artifacts}`);
    lines.push(`${node === tree.root ? '* ' : '  '}${node.id}${d.name ? ` "${d.name}"` : ''}  (${d.provider}:${d.model}${d.reasoning ? `, reasoning ${d.reasoning}` : ''})  ${rel(tree.configDir, node.file)}`);
    lines.push(`      tools: ${tools.length ? tools.join(', ') : '(none)'}`);
    if (d.tools?.autoApprove?.length) lines.push(`      auto-approve: ${d.tools.autoApprove.join(', ')}`);
    lines.push(`      roots: ${node.roots.length ? node.roots.join(', ') : '(no filesystem access)'}`);
  }
  for (const s of tree.skipped) lines.push(`  skipped ${s.file}: ${s.error}`);
  for (const w of tree.warnings) lines.push(`  note: ${w}`);
  return lines.join('\n');
}
