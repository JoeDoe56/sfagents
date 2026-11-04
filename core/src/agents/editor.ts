/**
 * Creating and editing agents without touching JSON: the form the web app
 * and the terminal show, checked field by field, and saved to the same
 * agent files in userdata/agents (so editing a file by hand keeps working).
 * Fields the form does not show (limits, context, other agents it may
 * message, failover providers after the first) are kept as they are.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENT_GRANT_PATTERN, AGENT_NAME_PATTERN, CONTAINER_LIMITS, ConfigError, parseAgentDefinition, parseAgentFolders } from './definition.js';
import { expandPrompt, isPromptReference, PromptReferenceError } from './prompts.js';
import type { AgentTree } from './loader.js';
import { dataDirFor } from './loader.js';
import { loadMcpConfig } from '../mcp/config.js';
import { isNetworkLevel, NETWORK_LEVELS, NETWORK_LEVEL_TEXT, type NetworkLevel } from '../container/network.js';

/** Editing needs directories and choices, not a running agent. Also works before the first save. */
export type AgentEditorContext = Pick<AgentTree, 'agentsDir' | 'promptsDir' | 'mcp'>;

export function loadAgentEditor(project: string): AgentEditorContext {
  const dir = dataDirFor(path.resolve(project));
  return { agentsDir: path.join(dir, 'agents'), promptsDir: path.join(dir, 'prompts'), mcp: loadMcpConfig(path.join(dir, 'mcp.json')) };
}

/** What the agent editor shows. */
export interface AgentForm {
  /** The agent's name: its file name without ".json". */
  name: string;
  description: string;
  /** "" lets the agent reply with the provider picked in the app (or the first one added). */
  provider: string;
  model: string;
  /** The instructions; a line "@name.txt" pulls in a file from the prompts folder. */
  instructions: string;
  /** Required: null until chosen. */
  network: NetworkLevel | null;
  folders: string[];
  mcpServers: string[];
  memoryMb: number;
  cpus: number;
  /** Read each finished reply aloud. */
  speak: boolean;
}

/** Problems with a form, by field (AgentForm's keys). */
export type AgentFormErrors = Partial<Record<keyof AgentForm, string>>;

export class AgentFormError extends Error {
  constructor(readonly errors: AgentFormErrors) {
    super(Object.values(errors).join(' '));
    this.name = 'AgentFormError';
  }
}

/** The editor's limits: the sliders end at what the computer (or the WSL memory cap) can give. */
export interface AgentFormLimits {
  maxMemoryMb: number;
  maxCpus: number;
  /** Providers that exist (Settings), checked when the form names one. */
  providers?: readonly string[];
}

/** What the editor needs besides the form: choices and limits. */
export function agentFormChoices(tree: AgentEditorContext, limits: AgentFormLimits) {
  return {
    networkLevels: NETWORK_LEVELS.map((value) => ({ value, text: NETWORK_LEVEL_TEXT[value] })),
    mcpServers: Object.keys(tree.mcp.servers).sort((a, b) => a.localeCompare(b)),
    promptFiles: promptFiles(tree.promptsDir),
    memoryMb: { min: CONTAINER_LIMITS.memoryMb.min, max: limits.maxMemoryMb, step: CONTAINER_LIMITS.memoryMb.step, default: Math.min(CONTAINER_LIMITS.memoryMb.default, limits.maxMemoryMb) },
    cpus: { min: CONTAINER_LIMITS.cpus.min, max: limits.maxCpus, step: CONTAINER_LIMITS.cpus.step, default: Math.min(CONTAINER_LIMITS.cpus.default, limits.maxCpus) },
    agents: agentFileNames(tree),
  };
}

/** The prompt files ("@name.txt") and their length, for the live character count. */
function promptFiles(dir: string): Array<{ name: string; chars: number }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name))
      .map((e) => ({ name: e.name, chars: fs.readFileSync(path.join(dir, e.name), 'utf8').trim().length }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function agentFileNames(tree: AgentEditorContext): string[] {
  try {
    return fs
      .readdirSync(tree.agentsDir)
      .filter((n) => n.toLowerCase().endsWith('.json'))
      .map((n) => n.replace(/\.json$/i, ''));
  } catch {
    return [];
  }
}

function fileOf(tree: AgentEditorContext, name: string): string | undefined {
  const lower = `${name.toLowerCase()}.json`;
  try {
    const found = fs.readdirSync(tree.agentsDir).find((n) => n.toLowerCase() === lower);
    return found ? path.join(tree.agentsDir, found) : undefined;
  } catch {
    return undefined;
  }
}

function readRaw(file: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path.basename(file)} is not an agent definition (a JSON object).`);
  return raw as Record<string, unknown>;
}

/** A new agent's form: nothing chosen that must be chosen (the network level). */
export function newAgentForm(limits?: AgentFormLimits): AgentForm {
  return {
    name: '',
    description: '',
    provider: '',
    model: '',
    instructions: '',
    network: null,
    folders: [],
    mcpServers: [],
    memoryMb: Math.min(CONTAINER_LIMITS.memoryMb.default, limits?.maxMemoryMb ?? Infinity),
    cpus: Math.min(CONTAINER_LIMITS.cpus.default, limits?.maxCpus ?? Infinity),
    speak: false,
  };
}

/** An agent file as the form shows it (also one that did not load, so it can be fixed here). */
export function readAgentForm(tree: AgentEditorContext, name: string): AgentForm {
  const file = fileOf(tree, name);
  if (!file) throw new Error(`No agent named "${name}".`);
  const raw = readRaw(file);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const first = Array.isArray(raw['provider']) ? raw['provider'][0] : raw['provider'];
  const provider = typeof first === 'string' ? first : first && typeof first === 'object' ? str((first as Record<string, unknown>)['provider']) : '';
  const model = first && typeof first === 'object' && typeof (first as Record<string, unknown>)['model'] === 'string' ? str((first as Record<string, unknown>)['model']) : str(raw['model']);
  const prompt = raw['systemPrompt'];
  const tools = (raw['tools'] ?? {}) as Record<string, unknown>;
  const container = (raw['container'] ?? {}) as Record<string, unknown>;
  const voice = (raw['voice'] ?? {}) as Record<string, unknown>;
  return {
    name: path.basename(file).replace(/\.json$/i, ''),
    description: str(raw['description']),
    provider,
    model,
    instructions: Array.isArray(prompt) ? prompt.filter((p) => typeof p === 'string').join('\n\n') : str(prompt),
    network: isNetworkLevel(raw['network']) ? raw['network'] : null,
    folders: Array.isArray(raw['folders']) ? raw['folders'].filter((f): f is string => typeof f === 'string') : [],
    mcpServers: Array.isArray(tools['mcpServers']) ? (tools['mcpServers'] as unknown[]).map((g) => (typeof g === 'string' ? g : str((g as Record<string, unknown>)?.['server']))).filter(Boolean) : [],
    memoryMb: typeof container['memoryMb'] === 'number' ? container['memoryMb'] : CONTAINER_LIMITS.memoryMb.default,
    cpus: typeof container['cpus'] === 'number' ? container['cpus'] : CONTAINER_LIMITS.cpus.default,
    speak: voice['speak'] === true,
  };
}

/** The instructions' length with the prompt files filled in (the live count). */
export function instructionsLength(text: string, files: ReadonlyArray<{ name: string; chars: number }>): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const ref = isPromptReference(line) ? files.find((f) => f.name === line.trim().slice(1)) : undefined;
    n += (ref ? ref.chars : line.length) + 1;
  }
  return Math.max(0, n - 1);
}

/**
 * Checks a form, field by field. `original` is the agent being edited
 * (undefined for a new one): its own name is not a clash.
 */
export function validateAgentForm(tree: AgentEditorContext, form: AgentForm, limits: AgentFormLimits, original?: string): AgentFormErrors {
  const errors: AgentFormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Give the agent a name.';
  else if (!AGENT_NAME_PATTERN.test(name) || name.startsWith('.') || /\.json$/i.test(name)) errors.name = 'A name can’t contain \\ / : * ? " < > | and can’t start with a dot.';
  else if (name.toLowerCase() !== original?.toLowerCase() && fileOf(tree, name)) errors.name = `There is already an agent named "${name}".`;
  if (form.description.length > 2000) errors.description = 'Keep the description under 2,000 characters.';
  if (form.provider.trim()) {
    if (limits.providers && !limits.providers.some((p) => p.toLowerCase() === form.provider.trim().toLowerCase()) && form.provider !== 'openrouter') {
      errors.provider = `"${form.provider}" is not a provider in Settings.`;
    }
    if (!form.model.trim()) errors.model = 'Choose a model for this provider.';
  } else if (form.model.trim()) errors.provider = 'Choose the provider this model is from.';
  if (!form.instructions.trim()) errors.instructions = 'Write the agent’s instructions.';
  else {
    try {
      expandPrompt(form.instructions, tree.promptsDir);
    } catch (error) {
      errors.instructions = error instanceof PromptReferenceError ? error.message : String(error);
    }
    if (form.instructions.length > 200_000) errors.instructions = 'Keep the instructions under 200,000 characters.';
  }
  if (!form.network) errors.network = 'Choose what the agent’s container can reach.';
  else if (!isNetworkLevel(form.network)) errors.network = `Choose one of ${NETWORK_LEVELS.join(', ')}.`;
  try { parseAgentFolders(form.folders, 'agent'); }
  catch (error) { errors.folders = error instanceof Error ? error.message.replace(/^agent \[.*?\]: /, '') : String(error); }
  const unknown = form.mcpServers.filter((s) => !tree.mcp.servers[s]);
  if (unknown.length) errors.mcpServers = `Not in mcp.json: ${unknown.join(', ')}.`;
  const m = CONTAINER_LIMITS.memoryMb;
  if (!Number.isInteger(form.memoryMb) || form.memoryMb < m.min || form.memoryMb > limits.maxMemoryMb) errors.memoryMb = `Between ${m.min} MB and ${limits.maxMemoryMb} MB.`;
  const c = CONTAINER_LIMITS.cpus;
  if (!Number.isFinite(form.cpus) || form.cpus < c.min || form.cpus > limits.maxCpus) errors.cpus = `Between ${c.min} and ${limits.maxCpus} cores.`;
  return errors;
}

/** The agent file's JSON for a form, on top of what the file had (fields the form doesn't show stay). */
function rawFor(form: AgentForm, before: Record<string, unknown>, renamed: boolean): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...before };
  // A label from before a rename would show the old name.
  if (renamed) {
    delete raw['id'];
    delete raw['name'];
  }
  const set = (key: string, value: unknown) => {
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  };
  set('description', form.description.trim() || undefined);
  const provider = form.provider.trim();
  const model = form.model.trim();
  if (!provider) {
    delete raw['provider'];
    delete raw['model'];
    delete raw['providerOptions'];
  } else if (Array.isArray(raw['provider']) && raw['provider'].length > 1) {
    // Failover providers after the first are kept; the first is the form's.
    const list = [...(raw['provider'] as unknown[])];
    const first = list[0];
    if (first && typeof first === 'object') list[0] = { ...(first as object), provider, model };
    else {
      // Entries without their own model used the top-level one: keep theirs.
      const old = typeof raw['model'] === 'string' ? raw['model'] : model;
      for (let i = 1; i < list.length; i++) if (typeof list[i] === 'string') list[i] = { provider: list[i], model: old };
      list[0] = provider;
    }
    raw['provider'] = list;
    raw['model'] = model;
  } else {
    raw['provider'] = provider;
    raw['model'] = model;
  }
  const beforePrompt = raw['systemPrompt'];
  if (!(Array.isArray(beforePrompt) && beforePrompt.join('\n\n') === form.instructions)) raw['systemPrompt'] = form.instructions;
  raw['network'] = form.network;
  const folders = parseAgentFolders(form.folders, 'agent');
  set('folders', folders.length ? folders : undefined);
  // MCP servers: per-tool lists of servers that stay are kept; auto-approvals of removed ones go.
  const tools = { ...((raw['tools'] as Record<string, unknown> | undefined) ?? {}) };
  const grants = Array.isArray(tools['mcpServers']) ? (tools['mcpServers'] as unknown[]) : [];
  const serverOf = (g: unknown) => (typeof g === 'string' ? g : String((g as Record<string, unknown>)?.['server'] ?? ''));
  const kept = form.mcpServers.map((s) => grants.find((g) => serverOf(g) === s) ?? s);
  if (kept.length) tools['mcpServers'] = kept;
  else delete tools['mcpServers'];
  if (Array.isArray(tools['autoApprove'])) {
    const auto = (tools['autoApprove'] as string[]).filter((a) => form.mcpServers.includes(a.split('__')[1] ?? ''));
    if (auto.length) tools['autoApprove'] = auto;
    else delete tools['autoApprove'];
  }
  set('tools', Object.keys(tools).length ? tools : undefined);
  const container: Record<string, number> = {};
  if (form.memoryMb !== CONTAINER_LIMITS.memoryMb.default) container['memoryMb'] = form.memoryMb;
  if (form.cpus !== CONTAINER_LIMITS.cpus.default) container['cpus'] = form.cpus;
  set('container', Object.keys(container).length ? container : undefined);
  set('voice', form.speak ? { speak: true } : undefined);
  return raw;
}

/** Field names in a ConfigError, as the form's. */
function formField(field: string | undefined): keyof AgentForm | undefined {
  if (!field) return undefined;
  const top = field.split(/[.[]/)[0]!;
  const map: Record<string, keyof AgentForm> = {
    id: 'name',
    name: 'name',
    description: 'description',
    provider: 'provider',
    providerOptions: 'provider',
    model: 'model',
    systemPrompt: 'instructions',
    network: 'network',
    folders: 'folders',
    tools: 'mcpServers',
    container: field.includes('cpus') ? 'cpus' : 'memoryMb',
    voice: 'speak',
  };
  return map[top];
}

/**
 * Saves a form to its agent file: a new file for a new agent, and for a
 * renamed one the file moves and other agents' "N-name.json" entries follow.
 * Throws AgentFormError with the problems by field; nothing is written then.
 * Returns the agent's file.
 */
export function saveAgentForm(tree: AgentEditorContext, form: AgentForm, limits: AgentFormLimits, original?: string): string {
  const errors = validateAgentForm(tree, form, limits, original);
  if (Object.keys(errors).length) throw new AgentFormError(errors);
  const name = form.name.trim();
  const oldFile = original ? fileOf(tree, original) : undefined;
  if (original && !oldFile) throw new AgentFormError({ name: `The agent "${original}" no longer exists.` });
  const renamed = !!oldFile && path.basename(oldFile) !== `${name}.json`;
  let before: Record<string, unknown> = {};
  if (oldFile) {
    try {
      before = readRaw(oldFile);
    } catch {
      // A broken file is replaced by the form.
    }
  }
  const raw = rawFor({ ...form, name }, before, renamed);
  const file = renamed || !oldFile ? path.join(tree.agentsDir, `${name}.json`) : oldFile;
  try {
    parseAgentDefinition(raw, path.basename(file), name);
  } catch (error) {
    if (error instanceof ConfigError) {
      const field = formField(error.field) ?? 'name';
      throw new AgentFormError({ [field]: error.message.replace(`${error.file} `, '').replace(`${error.file}: `, '') });
    }
    throw error;
  }
  fs.mkdirSync(tree.agentsDir, { recursive: true });
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  if (renamed && oldFile) {
    // A case-only rename on Windows or macOS is the same file.
    if (path.resolve(oldFile).toLowerCase() !== path.resolve(file).toLowerCase()) fs.rmSync(oldFile, { force: true });
    renameGrants(tree, path.basename(oldFile).replace(/\.json$/i, ''), name);
  }
  return file;
}

/** Other agents' "N-old.json" entries become "N-new.json". */
function renameGrants(tree: AgentEditorContext, from: string, to: string): void {
  for (const n of fs.readdirSync(tree.agentsDir)) {
    if (!n.toLowerCase().endsWith('.json')) continue;
    const file = path.join(tree.agentsDir, n);
    let raw: Record<string, unknown>;
    try {
      raw = readRaw(file);
    } catch {
      continue;
    }
    if (!Array.isArray(raw['agents'])) continue;
    let changed = false;
    raw['agents'] = (raw['agents'] as unknown[]).map((entry) => {
      const m = typeof entry === 'string' ? AGENT_GRANT_PATTERN.exec(entry) : null;
      if (!m || m[2]!.toLowerCase() !== `${from.toLowerCase()}.json`) return entry;
      changed = true;
      return `${m[1]}-${to}.json`;
    });
    if (changed) fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  }
}

/** Copies an agent to "<name> copy" (numbered when taken); returns the new name. */
export function duplicateAgentFile(tree: AgentEditorContext, name: string): string {
  const file = fileOf(tree, name);
  if (!file) throw new Error(`No agent named "${name}".`);
  const base = path.basename(file).replace(/\.json$/i, '');
  let copy = `${base} copy`;
  for (let i = 2; fileOf(tree, copy); i++) copy = `${base} copy ${i}`;
  const raw = readRaw(file);
  delete raw['id'];
  delete raw['name'];
  fs.writeFileSync(path.join(tree.agentsDir, `${copy}.json`), `${JSON.stringify(raw, null, 2)}\n`, { flag: 'wx' });
  return copy;
}

/** Deletes an agent's file (its container is removed by the caller; workspaces stay). */
export function deleteAgentFile(tree: AgentEditorContext, name: string): void {
  const file = fileOf(tree, name);
  if (!file) throw new Error(`No agent named "${name}".`);
  fs.rmSync(file);
}
