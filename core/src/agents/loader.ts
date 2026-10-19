/**
 * Loads and validates an SF Agents definition tree.
 *
 * Rules enforced here (all fail closed, with file and field in the error):
 * - Child files resolve relative to the declaring file and must stay inside
 *   the configuration directory (the directory holding the root agent.json),
 *   after symlink resolution.
 * - No cycles; no file used by two parents; unique agent IDs.
 * - Tree depth is bounded by the root's spawn.maxDepth (default 4).
 * - `shell` is root-only in this version: a workspace path allowlist cannot
 *   confine arbitrary commands and SF Agents has no OS sandbox yet.
 * - A child never exceeds its parent's authority: built-in tools, MCP servers
 *   and tools, auto-approvals and workspace roots must be subsets.
 * - Every MCP server an agent names must exist in mcp.json.
 * - Child agents get no filesystem roots unless they declare them.
 *
 * The resulting tree is deeply frozen; runtime code cannot widen it.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ConfigError,
  FILE_TOOL_IDS,
  mcpGrants,
  parseAgentDefinition,
  type AgentDefinition,
} from './definition.js';
import { ToolNames } from '../tools/tool-names.js';
import { isPathWithinRoot, WorkspaceContext } from '../permissions/workspace.js';
import { loadMcpConfig, type McpConfigFile } from '../mcp/config.js';

export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 1;

export interface AgentNode {
  readonly id: string;
  /** Canonical absolute path of the definition file. */
  readonly file: string;
  readonly depth: number;
  readonly definition: Readonly<AgentDefinition>;
  /** Canonical workspace roots; empty when the agent has no filesystem access. */
  readonly roots: readonly string[];
  readonly parentId?: string;
  readonly children: readonly AgentNode[];
}

export interface AgentTree {
  readonly configDir: string;
  readonly root: AgentNode;
  readonly byId: ReadonlyMap<string, AgentNode>;
  readonly mcp: McpConfigFile;
  /** Configuration files no agent file tool may modify. */
  readonly protectedFiles: readonly string[];
  /** Credential files no agent file tool may read or modify (<configDir>/.env). */
  readonly secretFiles: readonly string[];
  readonly maxDepth: number;
}

export interface LoadOptions {
  /** Path to mcp.json; defaults to <configDir>/mcp.json. */
  mcpConfigFile?: string;
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

function canonical(file: string): string {
  return fs.realpathSync(file);
}

function rel(configDir: string, file: string): string {
  return path.relative(configDir, file) || path.basename(file);
}

export function loadAgentTree(rootFile: string, options: LoadOptions = {}): AgentTree {
  const absRoot = path.resolve(rootFile);
  if (!fs.existsSync(absRoot)) {
    throw new ConfigError(absRoot, undefined, 'root agent definition not found');
  }
  const rootCanonical = canonical(absRoot);
  const configDir = path.dirname(rootCanonical);
  const mcpFile = path.resolve(options.mcpConfigFile ?? path.join(configDir, 'mcp.json'));
  const mcp = loadMcpConfig(mcpFile);

  const byId = new Map<string, AgentNode>();
  const visitedFiles = new Map<string, string>(); // file -> parent id that declared it
  const protectedFiles = new Set<string>([rootCanonical, mcpFile]);
  let maxDepth = DEFAULT_MAX_DEPTH;

  const build = (
    file: string,
    depth: number,
    parent: AgentNode | undefined,
    stack: string[],
  ): AgentNode => {
    const shown = rel(configDir, file);
    const def = parseAgentDefinition(readJson(file), shown);
    if (depth === 0) maxDepth = def.spawn?.maxDepth ?? DEFAULT_MAX_DEPTH;
    else if (def.spawn?.maxDepth !== undefined) {
      throw new ConfigError(shown, 'spawn.maxDepth', 'may only be set on the root agent');
    }
    if (depth > maxDepth) {
      throw new ConfigError(shown, undefined, `agent tree is deeper than spawn.maxDepth (${maxDepth}) set on the root agent`);
    }
    const existing = byId.get(def.id);
    if (existing) {
      throw new ConfigError(shown, 'id', `duplicate agent id "${def.id}" (also defined in ${rel(configDir, existing.file)})`);
    }

    const allow = def.tools?.allow ?? [];
    if (depth > 0 && allow.includes(ToolNames.SHELL)) {
      throw new ConfigError(
        shown,
        'tools.allow',
        '"shell" is only allowed on the root agent in this version: workspace roots cannot confine shell commands and no OS sandbox is available',
      );
    }

    // MCP servers must exist.
    const grants = mcpGrants(def);
    for (const [server] of grants) {
      if (!mcp.servers[server]) {
        throw new ConfigError(
          shown,
          'tools.mcpServers',
          `unknown MCP server "${server}". ${mcp.file ? `Servers defined in ${rel(configDir, mcp.file)}: ${Object.keys(mcp.servers).join(', ') || '(none)'}` : 'No mcp.json was found.'}`,
        );
      }
    }

    // Workspace roots.
    let roots: string[] = [];
    const rootSpecs = def.workspace?.roots ?? (depth === 0 ? ['.'] : []);
    rootSpecs.forEach((spec, i) => {
      const abs = path.resolve(path.dirname(file), spec);
      try {
        roots.push(WorkspaceContext.resolveAndValidateDir(abs));
      } catch (error) {
        throw new ConfigError(shown, `workspace.roots[${i}]`, error instanceof Error ? error.message : String(error));
      }
    });
    roots = [...new Set(roots)];
    if (roots.length === 0 && allow.some((t) => FILE_TOOL_IDS.includes(t))) {
      throw new ConfigError(
        shown,
        'workspace.roots',
        'this agent allows file tools but declares no workspace roots. Child agents do not inherit filesystem access; list the directories explicitly',
      );
    }

    if (parent) checkEscalation(shown, def, roots, parent);

    const node: {
      id: string;
      file: string;
      depth: number;
      definition: AgentDefinition;
      roots: string[];
      parentId?: string;
      children: AgentNode[];
    } = {
      id: def.id,
      file,
      depth,
      definition: def,
      roots,
      parentId: parent?.id,
      children: [],
    };
    byId.set(def.id, node);

    (def.spawn?.children ?? []).forEach((childSpec, i) => {
      const field = `spawn.children[${i}]`;
      if (!childSpec.toLowerCase().endsWith('.json')) {
        throw new ConfigError(shown, field, 'child definition paths must end in .json');
      }
      const childAbs = path.resolve(path.dirname(file), childSpec);
      if (!fs.existsSync(childAbs)) {
        throw new ConfigError(shown, field, `unknown child: file not found: ${childSpec}`);
      }
      const childFile = canonical(childAbs);
      if (!isPathWithinRoot(childFile, configDir)) {
        throw new ConfigError(shown, field, `child definition is outside the configuration directory ${configDir}: ${childSpec}`);
      }
      if (stack.includes(childFile)) {
        const chain = [...stack, childFile].map((f) => rel(configDir, f)).join(' -> ');
        throw new ConfigError(shown, field, `cycle in agent tree: ${chain}`);
      }
      const declaredBy = visitedFiles.get(childFile);
      if (declaredBy !== undefined) {
        throw new ConfigError(shown, field, `${rel(configDir, childFile)} is already a child of "${declaredBy}"; each definition file may have only one parent`);
      }
      visitedFiles.set(childFile, def.id);
      protectedFiles.add(childFile);
      node.children.push(build(childFile, depth + 1, node, [...stack, childFile]));
    });

    return node;
  };

  visitedFiles.set(rootCanonical, '(root)');
  const root = build(rootCanonical, 0, undefined, [rootCanonical]);
  const secretFiles = [path.join(configDir, '.env')];
  const tree: AgentTree = { configDir, root, byId, mcp, protectedFiles: [...protectedFiles], secretFiles, maxDepth };
  return deepFreeze(tree);
}

function checkEscalation(file: string, child: AgentDefinition, childRoots: readonly string[], parent: AgentNode): void {
  const p = parent.definition;
  const parentAllow = new Set(p.tools?.allow ?? []);
  (child.tools?.allow ?? []).forEach((tool, i) => {
    if (!parentAllow.has(tool)) {
      throw new ConfigError(file, `tools.allow[${i}]`, `permission escalation: parent "${parent.id}" does not allow "${tool}"`);
    }
  });

  const parentGrants = mcpGrants(p);
  for (const [server, tools] of mcpGrants(child)) {
    if (!parentGrants.has(server)) {
      throw new ConfigError(file, 'tools.mcpServers', `permission escalation: parent "${parent.id}" has no access to MCP server "${server}"`);
    }
    const parentTools = parentGrants.get(server);
    if (parentTools !== undefined) {
      if (tools === undefined) {
        throw new ConfigError(
          file,
          'tools.mcpServers',
          `permission escalation: parent "${parent.id}" may only use tools [${[...parentTools].join(', ')}] on "${server}", so the child must list a subset`,
        );
      }
      for (const t of tools) {
        if (!parentTools.has(t)) {
          throw new ConfigError(file, 'tools.mcpServers', `permission escalation: parent "${parent.id}" may not use "${t}" on MCP server "${server}"`);
        }
      }
    }
  }

  const parentAuto = new Set(p.tools?.autoApprove ?? []);
  (child.tools?.autoApprove ?? []).forEach((entry, i) => {
    if (parentAuto.has(entry)) return;
    if (entry.startsWith('mcp__') && !entry.endsWith('__*')) {
      const server = entry.slice(5).split('__')[0];
      if (parentAuto.has(`mcp__${server}__*`)) return;
    }
    throw new ConfigError(file, `tools.autoApprove[${i}]`, `permission escalation: parent "${parent.id}" does not auto-approve "${entry}"`);
  });

  childRoots.forEach((root, i) => {
    if (!parent.roots.some((pr) => isPathWithinRoot(root, pr))) {
      throw new ConfigError(
        file,
        `workspace.roots[${i}]`,
        `permission escalation: ${root} is not inside any workspace root of parent "${parent.id}" (${parent.roots.join(', ') || 'none'})`,
      );
    }
  });
}

/** Human-readable tree for `sfagents agents validate`. */
export function describeTree(tree: AgentTree): string {
  const lines: string[] = [];
  const walk = (node: AgentNode, prefix: string, last: boolean, isRoot: boolean) => {
    const d = node.definition;
    const tools = [...(d.tools?.allow ?? [])];
    for (const [server, list] of mcpGrants(d)) tools.push(list ? `mcp:${server}[${[...list].join(',')}]` : `mcp:${server}[*]`);
    if (node.children.length > 0) tools.push(`invoke_child(${node.children.map((c) => c.id).join(',')})`);
    const head = isRoot ? '' : `${prefix}${last ? '└─ ' : '├─ '}`;
    lines.push(`${head}${node.id}  (${d.provider}:${d.model}${d.reasoning ? `, reasoning ${d.reasoning}` : ''})  ${rel(tree.configDir, node.file)}`);
    const detailPrefix = isRoot ? '   ' : `${prefix}${last ? '   ' : '│  '}   `;
    lines.push(`${detailPrefix}tools: ${tools.length ? tools.join(', ') : '(none)'}`);
    if (d.tools?.autoApprove?.length) lines.push(`${detailPrefix}auto-approve: ${d.tools.autoApprove.join(', ')}`);
    lines.push(`${detailPrefix}roots: ${node.roots.length ? node.roots.join(', ') : '(no filesystem access)'}`);
    const childPrefix = isRoot ? '' : `${prefix}${last ? '   ' : '│  '}`;
    node.children.forEach((child, i) => walk(child, childPrefix, i === node.children.length - 1, false));
  };
  walk(tree.root, '', true, true);
  return lines.join('\n');
}
