/**
 * Loads a project's agents: every `*.json` file in its `agents` folder that
 * is a valid agent definition. Files that are not (bad JSON, unknown fields,
 * an unknown MCP server) are skipped and reported,
 * so one broken file never takes the others down.
 *
 * An agent is known by its file name: `agents/researcher.json` is
 * "researcher", whatever it calls itself inside. Each agent carries its own
 * permissions; none is limited by another's. An agent may message others it
 * is granted with "N-name.json" entries in `agents` (N: how many
 * threads with that agent it may run at once); grants may form any graph,
 * cycles included.
 *
 * The result is deeply frozen; runtime code cannot widen it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, artifactAccess, conversationAccess, mcpGrants, parseAgentDefinition, type AgentDefinition } from './definition.js';
import { loadMcpConfig, type McpConfigFile } from '../mcp/config.js';
import { PROMPTS_DIR_NAME, PromptReferenceError, ensurePrompts, expandPrompt } from './prompts.js';

export const AGENTS_DIR_NAME = 'agents';
/**
 * The project's own folder for everything that belongs to the person and not
 * to the code: agents, prompts, mcp.json, .env, GenUI views and the
 * conversation (.sfagents). One folder, so one line keeps it out of git.
 */
export const USER_DATA_DIR_NAME = 'userdata';
/** What an older project kept at its top level, and moveUserData() moves into userdata/. */
export const LEGACY_USER_DATA = ['agents', 'prompts', 'mcp.json', '.env', '.sfagents', 'genui', 'artifacts', 'brightdata-mcp-example.json'] as const;

/** Where a project's data is: its userdata folder, or (an older project not moved yet) the project folder itself. */
export function dataDirFor(projectDir: string): string {
  const dir = path.join(projectDir, USER_DATA_DIR_NAME);
  return fs.existsSync(dir) ? dir : projectDir;
}

/**
 * Moves an older project's data (agents/, prompts/, mcp.json, .env,
 * .sfagents/, genui/…) into userdata/, and creates userdata/ for a new one.
 * Returns what moved; what can't move (in use, or already there) stays and
 * is listed in `failed`.
 */
export function moveUserData(projectDir: string): { moved: string[]; failed: Array<{ name: string; error: string }> } {
  const dir = path.join(projectDir, USER_DATA_DIR_NAME);
  const moved: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of LEGACY_USER_DATA) {
    const from = path.join(projectDir, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, name);
    if (fs.existsSync(to)) {
      failed.push({ name, error: `${USER_DATA_DIR_NAME}/${name} already exists` });
      continue;
    }
    try {
      fs.renameSync(from, to);
      moved.push(name);
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) });
      if (fresh) {
        // All or nothing the first time (a running SF Agents holds .sfagents, say): put back what moved,
        // so the project keeps working as it was.
        for (const back of moved.reverse()) {
          try {
            fs.renameSync(path.join(dir, back), path.join(projectDir, back));
          } catch {
            // left in userdata/; reported below
          }
        }
        try {
          fs.rmdirSync(dir);
        } catch {
          // not empty: something could not go back
        }
        return { moved: [], failed };
      }
    }
  }
  return { moved, failed };
}
/** The agent the project starts with when none is chosen: "main", else the first by name. */
export const DEFAULT_AGENT_NAME = 'main';

export interface AgentNode {
  /** The agent's name (its file name without ".json"). */
  readonly id: string;
  /** Canonical absolute path of the definition file. */
  readonly file: string;
  readonly definition: Readonly<AgentDefinition>;
  /** Agents this one may message → how many threads with each it may run at once. */
  readonly grants: ReadonlyMap<string, number>;
}

export interface SkippedAgentFile {
  /** Path relative to the project directory. */
  file: string;
  error: string;
}

export interface AgentTree {
  /** The project directory. */
  readonly configDir: string;
  /** Where the project's data is: userdata/ (agents, prompts, mcp.json, .env, genui, .sfagents), or configDir in an older project. */
  readonly dataDir: string;
  readonly agentsDir: string;
  /** The shared prompt files agents reference ("@name.txt"); may not exist. */
  readonly promptsDir: string;
  /** The agent chosen at load time (the default for the main conversation). */
  readonly root: AgentNode;
  readonly byId: ReadonlyMap<string, AgentNode>;
  readonly mcp: McpConfigFile;
  /** Agent files that were not loaded, and why. */
  readonly skipped: readonly SkippedAgentFile[];
  /** Grants naming agents that are not loaded, and similar notes. */
  readonly warnings: readonly string[];
  /** Configuration files no agent may modify. */
  readonly protectedFiles: readonly string[];
  /** Credential files no agent may read or modify (<configDir>/.env). */
  readonly secretFiles: readonly string[];
}

export interface LoadOptions {
  /** Path to mcp.json; defaults to <project>/mcp.json. */
  mcpConfigFile?: string;
  /** The agent to start with (a name, or a file in the agents folder). */
  agent?: string;
  /** When no agent file is usable, use the built-in default agent instead of failing. */
  fallback?: boolean;
}

/**
 * The agent a new project starts with: no provider, so it replies with the
 * one added in Settings (or picked for it in the web interface).
 */
export const DEFAULT_AGENT = Object.freeze({
  description: 'The default agent, created because the project had none. It replies with the provider added in Settings; name one here with "provider" and "model" to choose.',
  systemPrompt:
    'You are the SF Agents main agent. Answer directly when you can, and use the shell (your own Linux container) to inspect and change files. Keep answers concise.',
  network: 'pkg',
});

/** The prompt files a new project's default agent references. */
const DEFAULT_AGENT_PROMPTS = ['main-agent.txt', 'working-rules.txt'];

/**
 * Creates what a project needs to start: the agents folder, and in it the
 * default agent when the folder has no agent files. Returns the paths it created.
 */
export function ensureProject(project: string): string[] {
  const created: string[] = [];
  // The agents, prompts and the rest go in the project's data folder (userdata/ once moved).
  const projectDir = dataDirFor(project);
  // The folder GenUI views are written in, ready for the agents.
  const genui = path.join(projectDir, 'genui');
  if (projectDir !== project && !fs.existsSync(genui)) {
    fs.mkdirSync(genui, { recursive: true });
    created.push(genui);
  }
  // The shared prompt files (default ones the first time).
  if (fs.existsSync(path.join(projectDir, AGENTS_DIR_NAME)) || !fs.existsSync(path.join(projectDir, 'agent.json'))) created.push(...ensurePrompts(projectDir));
  const agentsDir = path.join(projectDir, AGENTS_DIR_NAME);
  if (!fs.existsSync(agentsDir)) {
    // An old single-file project is moved by hand (loadAgentTree says how).
    if (fs.existsSync(path.join(projectDir, 'agent.json'))) return created;
    fs.mkdirSync(agentsDir, { recursive: true });
    created.push(agentsDir);
  }
  if (!fs.statSync(agentsDir).isDirectory()) return created;
  if (fs.readdirSync(agentsDir).some((n) => n.toLowerCase().endsWith('.json'))) return created;
  const file = path.join(agentsDir, `${DEFAULT_AGENT_NAME}.json`);
  // With the default prompt files at hand, the new agent uses them.
  const shared = DEFAULT_AGENT_PROMPTS.every((name) => fs.existsSync(path.join(projectDir, PROMPTS_DIR_NAME, name)));
  // The agent works in its own container: /workspaces, and the Project Folders setting read-only under /roots.
  const agent = { ...DEFAULT_AGENT, ...(shared ? { systemPrompt: DEFAULT_AGENT_PROMPTS.map((name) => `@${name}`) } : {}) };
  fs.writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`, { flag: 'wx' });
  created.push(file);
  return created;
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
  // A folder inside userdata/ belongs to the project above it.
  const project = (dataDir: string) => (path.basename(dataDir) === USER_DATA_DIR_NAME ? path.dirname(dataDir) : dataDir);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    if (path.basename(abs) === AGENTS_DIR_NAME && !fs.existsSync(path.join(abs, AGENTS_DIR_NAME))) return { projectDir: project(path.dirname(abs)) };
    if (path.basename(abs) === USER_DATA_DIR_NAME && fs.existsSync(path.join(abs, AGENTS_DIR_NAME))) return { projectDir: path.dirname(abs) };
    return { projectDir: abs };
  }
  if (abs.toLowerCase().endsWith('.json') && path.basename(path.dirname(abs)) === AGENTS_DIR_NAME) {
    return { projectDir: project(path.dirname(path.dirname(abs))), agent: path.basename(abs).replace(/\.json$/i, '') };
  }
  if (path.basename(abs) === 'agent.json' && fs.existsSync(abs)) {
    throw new ConfigError(
      abs,
      undefined,
      `agents now live in an "${AGENTS_DIR_NAME}" folder: move this file to ${path.join(path.dirname(abs), AGENTS_DIR_NAME, 'main.json')}, and replace "spawn.children" with "N-name.json" entries in "agents"`,
    );
  }
  return { projectDir: path.dirname(abs) };
}

/** Loads every valid agent of a project. Throws only when none is usable. */
export function loadAgentTree(target: string, options: LoadOptions = {}): AgentTree {
  const located = locateProject(target);
  const configDir = fs.realpathSync(located.projectDir);
  const dataDir = dataDirFor(configDir);
  const agentsDir = path.join(dataDir, AGENTS_DIR_NAME);
  const promptsDir = path.join(dataDir, PROMPTS_DIR_NAME);
  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    const legacy = path.join(configDir, 'agent.json');
    if (fs.existsSync(legacy)) locateProject(legacy); // throws the migration message
    throw new ConfigError(agentsDir, undefined, `no "${AGENTS_DIR_NAME}" folder: create it and add an agent definition (for example ${AGENTS_DIR_NAME}/main.json)`);
  }
  const mcpFile = path.resolve(options.mcpConfigFile ?? path.join(dataDir, 'mcp.json'));
  const mcp = loadMcpConfig(mcpFile);
  const mcpShown = rel(configDir, mcpFile);

  const skipped: SkippedAgentFile[] = [];
  const warnings: string[] = [];
  if (mcp.error) warnings.push(`${mcpShown} could not be used, so no MCP server is available: ${mcp.error.replace(`${mcpFile}: `, '')}`);
  for (const s of mcp.skipped ?? []) warnings.push(`${mcpShown}: MCP server "${s.server}" was left out: ${s.error}`);
  const protectedFiles = new Set<string>([mcpFile]);
  const loaded = new Map<string, { file: string; definition: AgentDefinition }>();

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
      let def = parseAgentDefinition(readJson(file), shown, agentName);
      // "@name.txt" lines come from the prompts folder.
      try {
        const expanded = expandPrompt(def.systemPrompt, promptsDir);
        for (const f of expanded.files) protectedFiles.add(f);
        def = { ...def, systemPrompt: expanded.text, ...(expanded.files.length ? { prompts: expanded.files.map((f) => rel(configDir, f)) } : {}) };
      } catch (error) {
        if (error instanceof PromptReferenceError) throw new ConfigError(shown, 'systemPrompt', error.message);
        throw error;
      }
      for (const [server] of mcpGrants(def)) {
        if (!mcp.servers[server] && (mcp.error || mcp.skipped?.some((s) => s.server === server))) {
          // The server is in a broken mcp.json: the agent loads without it.
          warnings.push(`${shown}: MCP server "${server}" is not available until ${rel(configDir, mcpFile)} is fixed`);
          const tools = def.tools!;
          def = { ...def, tools: { ...tools, mcpServers: tools.mcpServers!.filter((g) => (typeof g === 'string' ? g : g.server) !== server) } };
        } else if (!mcp.servers[server]) {
          throw new ConfigError(
            shown,
            'tools.mcpServers',
            `unknown MCP server "${server}". ${mcp.file ? `Servers defined in ${rel(configDir, mcp.file)}: ${Object.keys(mcp.servers).join(', ') || '(none)'}` : 'No mcp.json was found.'}`,
          );
        }
      }
      if (loaded.has(agentName)) throw new ConfigError(shown, undefined, `another file is already named "${agentName}"`);
      loaded.set(agentName, { file, definition: def });
    } catch (error) {
      skipped.push({ file: shown, error: error instanceof ConfigError ? error.message.replace(`${error.file}: `, '').replace(`${error.file} `, '') : String(error) });
    }
  }

  if (loaded.size === 0) {
    const why = skipped.length ? ` Skipped: ${skipped.map((s) => `${s.file}: ${s.error}`).join('; ')}` : '';
    if (!options.fallback) throw new ConfigError(agentsDir, undefined, `no valid agent definitions.${why}`);
    // Nothing loaded: the built-in default agent replies until a file is fixed.
    const file = path.join(agentsDir, `${DEFAULT_AGENT_NAME}.json`);
    const definition = parseAgentDefinition(structuredClone(DEFAULT_AGENT), rel(configDir, file), DEFAULT_AGENT_NAME);
    loaded.set(DEFAULT_AGENT_NAME, { file, definition });
    warnings.push(`No agent file could be loaded, so the built-in default agent replies until one is fixed.${why}`);
  }

  const byId = new Map<string, AgentNode>();
  for (const [id, a] of loaded) {
    const grants = new Map<string, number>();
    for (const g of a.definition.agents ?? []) {
      if (!loaded.has(g.agent)) {
        warnings.push(`${rel(configDir, a.file)}: "${g.file}" is not a loaded agent, so "${id}" cannot message it`);
        continue;
      }
      grants.set(g.agent, g.max);
    }
    byId.set(id, { id, file: a.file, definition: a.definition, grants });
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
    dataDir,
    agentsDir,
    promptsDir,
    root: byId.get(rootName)!,
    byId,
    mcp,
    skipped,
    warnings,
    protectedFiles: [...protectedFiles],
    secretFiles: [path.join(dataDir, '.env')],
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
    const tools = ['shell'];
    for (const [server, list] of mcpGrants(d)) tools.push(list ? `mcp:${server}[${[...list].join(',')}]` : `mcp:${server}[*]`);
    for (const [agent, max] of node.grants) tools.push(`message:${agent}×${max}`);
    const access = conversationAccess(d, 0);
    if (access !== 'none') tools.push(`conversation:${access}`);
    const artifacts = artifactAccess(d, 0);
    if (artifacts !== 'none') tools.push(`artifacts:${artifacts}`);
    lines.push(`${node === tree.root ? '* ' : '  '}${node.id}${d.name ? ` "${d.name}"` : ''}  (${d.provider ? `${d.provider}:${d.model}` : `no provider${d.model ? `, ${d.model}` : ''}`}${d.reasoning ? `, reasoning ${d.reasoning}` : ''})  ${rel(tree.configDir, node.file)}`);
    lines.push(`      tools: ${tools.length ? tools.join(', ') : '(none)'}`);
    if (d.tools?.autoApprove?.length) lines.push(`      auto-approve: ${d.tools.autoApprove.join(', ')}`);
    if (d.prompts?.length) lines.push(`      prompts: ${d.prompts.join(', ')}`);
    lines.push(`      network: ${d.network}`);
  }
  for (const s of tree.skipped) lines.push(`  skipped ${s.file}: ${s.error}`);
  for (const w of tree.warnings) lines.push(`  note: ${w}`);
  return lines.join('\n');
}
