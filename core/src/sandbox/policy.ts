/**
 * Builds an agent's sandbox policy from its workspace: its roots are
 * writable; SF Agents' own files inside them are protected so a command can
 * neither read credentials and conversation state nor give the agent new
 * powers (agent files, mcp.json); and git's hooks and config are read-only,
 * since git runs them outside the sandbox the next time the user uses it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath } from '../permissions/workspace.js';
import { accessFor, type SandboxAccess, type SandboxPolicy, type SandboxRule } from './sandbox.js';

export interface SandboxPolicyInput {
  roots: readonly string[];
  /** Files no command may read or write (the project's .env). */
  secretFiles?: readonly string[];
  /** Conversation state: the .sfagents folder, or the files of a conversation kept elsewhere. */
  stateDirs?: readonly string[];
  stateFiles?: readonly string[];
  /** Configuration files commands may read but not change (mcp.json). */
  protectedFiles?: readonly string[];
  /** The agents folder: read-only, so no command can add or change an agent. */
  agentsDir?: string;
  /** Extra rules (workspace.access), applied last. */
  access?: readonly SandboxRule[];
  network?: boolean;
  hostChannel?: SandboxPolicy['hostChannel'];
  tools?: SandboxPolicy['tools'];
}

/** Read-only paths inside each root's git folder: these make git run commands. */
export const GIT_PROTECTED = ['hooks', 'config', 'modules'];

function canonical(p: string): string {
  return resolveWorkspacePath(path.resolve(p));
}

export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  // What the agent was given: its roots, then its workspace.access entries.
  const granted: SandboxRule[] = [
    ...input.roots.map((root): SandboxRule => ({ path: canonical(root), access: 'write' })),
    ...(input.access ?? []).map((rule) => ({ ...rule, path: canonical(rule.path) })),
  ];
  // What is taken back inside that: SF Agents' own files and git's hooks.
  const guards: SandboxRule[] = [];
  for (const rule of granted) {
    if (rule.access !== 'write') continue;
    const git = path.join(rule.path, '.git');
    if (fs.existsSync(git) && fs.statSync(git).isDirectory()) {
      for (const name of GIT_PROTECTED) guards.push({ path: path.join(git, name), access: 'read' });
    }
  }
  if (input.agentsDir) guards.push({ path: canonical(input.agentsDir), access: 'read', ensure: { kind: 'dir' } });
  for (const file of input.protectedFiles ?? []) {
    const p = canonical(file);
    // Agent files are covered by the agents folder; mcp.json may not exist yet.
    if (input.agentsDir && p.startsWith(canonical(input.agentsDir) + path.sep)) continue;
    guards.push({ path: p, access: 'read', ensure: { kind: 'file', content: path.basename(p).toLowerCase() === 'mcp.json' ? '{ "mcpServers": {} }\n' : '' } });
  }
  for (const file of [...(input.secretFiles ?? []), ...(input.stateFiles ?? [])]) {
    guards.push({ path: canonical(file), access: 'none', ensure: { kind: 'file' } });
  }
  for (const dir of input.stateDirs ?? []) guards.push({ path: canonical(dir), access: 'none', ensure: { kind: 'dir' } });
  // A guard only narrows: outside what was granted it would open a path up.
  // Guards come last, so they win over an access entry for the same path.
  const rules = [...granted, ...guards.filter((g) => accessFor(granted, g.path) !== 'none' && rank(g.access) < rank(accessFor(granted, g.path)))];
  return {
    rules,
    network: input.network ?? false,
    ...(input.hostChannel ? { hostChannel: input.hostChannel } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
  };
}

function rank(access: SandboxAccess): number {
  return access === 'write' ? 2 : access === 'read' ? 1 : 0;
}
