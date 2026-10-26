/**
 * The providers the user has added: OpenRouter keys, ChatGPT and Claude
 * sign-ins, and custom OpenAI-compatible endpoints (llama.cpp, vLLM, …). Each
 * has a name the user chose ("OpenRouter 1", "Claude work"), which agent
 * files use as their `provider`. Several of the same kind can coexist.
 *
 * providers.json in the per-user folder holds only names, kinds, addresses
 * and the signed-in account's display name. Keys and tokens are in the OS
 * keyring (see secrets.ts), under one entry per provider.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonFile, sfagentsHome, writeFileAtomic } from '../settings/home.js';
import { KeyringSecretStore, type SecretStore } from './secrets.js';
import { removeDir } from '../utils/remove-dir.js';

export const PROVIDER_KINDS = ['openrouter', 'openai', 'anthropic', 'custom'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI (ChatGPT sign-in)',
  anthropic: 'Anthropic (Claude sign-in)',
  custom: 'Custom endpoint',
};

/** The folder a signed-in provider keeps its state in (Codex's home, the Claude SDK's settings). */
export function providerStateDir(dir: string, record: Pick<ProviderRecord, 'id' | 'kind'>): string {
  return path.join(dir, record.kind === 'openai' ? 'codex' : 'claude', record.id);
}

/** Names an agent file may use without adding a provider (the environment-variable providers). */
export const LEGACY_PROVIDER_NAMES = ['openrouter', 'openai-compatible'] as const;

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Custom endpoints: the OpenAI-compatible base URL (e.g. http://127.0.0.1:8080/v1). */
  baseUrl?: string;
  /** The signed-in account, for display (an e-mail address or plan name). */
  account?: string;
  created: string;
}

export interface OpenRouterSecret {
  apiKey: string;
}
export interface CustomSecret {
  apiKey?: string;
}
/**
 * A ChatGPT sign-in: Codex keeps the tokens itself, in the OS keyring under
 * the provider's Codex home, so this only marks the provider as signed in.
 * (Providers added before Codex have `refreshToken` here and must sign in again.)
 */
export interface OpenAISecret {
  codex: true;
}
export interface AnthropicSecret {
  token: string;
}
export type ProviderSecret = OpenRouterSecret | CustomSecret | OpenAISecret | AnthropicSecret;

export class ProviderRegistryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Removes a ChatGPT sign-in from the keyring (Codex keeps it; only Codex can find its entry). */
async function signOutCodex(record: ProviderRecord, stateDir: string): Promise<void> {
  if (record.kind !== 'openai' || !fs.existsSync(stateDir)) return;
  const { codexSignOut } = await import('./codex.js');
  await codexSignOut(stateDir);
}

/** Keyring entry of the Bright Data key (web access is not a model provider, so it has no record). */
const WEB_KEY = 'web:brightdata';

const NAME_PATTERN = /^[^\x00-\x1f\x7f]{1,60}$/;

export function validateProviderName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!n || !NAME_PATTERN.test(n)) throw new ProviderRegistryError('A provider name is 1–60 characters, without control characters.');
  if (n.toLowerCase() === 'openai-compatible') throw new ProviderRegistryError('"openai-compatible" is reserved for agent files that use providerOptions.');
  return n;
}

export function validateBaseUrl(url: unknown): string {
  const s = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new Error();
    return s;
  } catch {
    throw new ProviderRegistryError('The endpoint must be an http(s) address without a user name or password, like http://127.0.0.1:8080/v1.');
  }
}

interface FileShape {
  providers: ProviderRecord[];
}

export interface ProviderRegistryOptions {
  /** Folder for providers.json (default: the per-user folder). */
  dir?: string;
  secrets?: SecretStore;
  /** Called when a provider is removed, before its record goes (signs Codex out, deletes its state). */
  cleanup?: (record: ProviderRecord, stateDir: string) => Promise<void>;
}

export class ProviderRegistry {
  readonly file: string;
  readonly dir: string;
  readonly secrets: SecretStore;
  private cache: { stamp: string; records: ProviderRecord[] } | null = null;
  private readonly listeners = new Set<() => void>();
  private watcher: fs.StatWatcher | null = null;
  private readonly cleanup?: (record: ProviderRecord, stateDir: string) => Promise<void>;

  constructor(options: ProviderRegistryOptions = {}) {
    this.dir = options.dir ?? sfagentsHome();
    this.file = path.join(this.dir, 'providers.json');
    this.secrets = options.secrets ?? new KeyringSecretStore();
    this.cleanup = options.cleanup ?? signOutCodex;
  }

  /** Where a signed-in provider keeps its state. */
  stateDir(record: Pick<ProviderRecord, 'id' | 'kind'>): string {
    return providerStateDir(this.dir, record);
  }

  /** Every provider, re-read when another process (the CLI, another window) changed the file. */
  list(): ProviderRecord[] {
    let stamp = 'missing';
    try {
      // Atomic replacement can retain the same mtime on Windows. File identity
      // and size also change when another process replaces providers.json.
      const stat = fs.statSync(this.file, { bigint: true });
      stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      // no file yet
    }
    if (this.cache && this.cache.stamp === stamp) return this.cache.records;
    const raw = readJsonFile<Partial<FileShape>>(this.file, { providers: [] });
    const records = (Array.isArray(raw.providers) ? raw.providers : []).filter(
      (r): r is ProviderRecord => !!r && typeof r.id === 'string' && typeof r.name === 'string' && (PROVIDER_KINDS as readonly string[]).includes(r.kind),
    );
    this.cache = { stamp, records };
    return records;
  }

  /** By name (case-insensitive) or id. */
  find(nameOrId: string): ProviderRecord | undefined {
    const key = nameOrId.trim().toLowerCase();
    return this.list().find((r) => r.id === nameOrId || r.name.toLowerCase() === key);
  }

  private write(records: ProviderRecord[]): void {
    writeFileAtomic(this.file, `${JSON.stringify({ providers: records }, null, 2)}\n`);
    this.cache = null;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Called when providers are added, renamed or removed (here or by another process). Returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.watcher) {
      this.watcher = fs.watchFile(this.file, { interval: 1500, persistent: false }, () => {
        this.cache = null;
        this.emit();
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.watcher) {
        fs.unwatchFile(this.file);
        this.watcher = null;
      }
    };
  }

  /** A name nobody uses yet: "OpenRouter 1", "OpenRouter 2", … */
  suggestName(kind: ProviderKind): string {
    const base = { openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Claude', custom: 'Custom' }[kind];
    for (let i = 1; ; i++) if (!this.find(`${base} ${i}`)) return `${base} ${i}`;
  }

  private secretKey(id: string): string {
    return `provider:${id}`;
  }

  /** Stores the secret in the keyring first; the provider is listed only once that worked. */
  async add(input: { name: string; kind: ProviderKind; baseUrl?: string; account?: string; secret: ProviderSecret; id?: string }): Promise<ProviderRecord> {
    const name = validateProviderName(input.name);
    if (!(PROVIDER_KINDS as readonly string[]).includes(input.kind)) throw new ProviderRegistryError(`Unknown provider kind "${input.kind}".`);
    if (this.find(name)) throw new ProviderRegistryError(`A provider named "${name}" already exists.`, 409);
    if (input.id !== undefined && (!/^[\w-]{8,64}$/.test(input.id) || this.list().some((r) => r.id === input.id))) throw new ProviderRegistryError('Invalid provider id.');
    const record: ProviderRecord = {
      id: input.id ?? randomUUID(),
      name,
      kind: input.kind,
      ...(input.kind === 'custom' ? { baseUrl: validateBaseUrl(input.baseUrl) } : {}),
      ...(input.account ? { account: input.account.slice(0, 200) } : {}),
      created: new Date().toISOString(),
    };
    await this.secrets.check();
    await this.secrets.set(this.secretKey(record.id), JSON.stringify(input.secret));
    this.write([...this.list(), record]);
    return record;
  }

  update(id: string, changes: { name?: string; baseUrl?: string; account?: string }): ProviderRecord {
    const records = this.list();
    const i = records.findIndex((r) => r.id === id);
    if (i < 0) throw new ProviderRegistryError('No such provider.', 404);
    const next = { ...records[i]! };
    if (changes.name !== undefined) {
      const name = validateProviderName(changes.name);
      const other = this.find(name);
      if (other && other.id !== id) throw new ProviderRegistryError(`A provider named "${name}" already exists.`, 409);
      next.name = name;
    }
    if (changes.baseUrl !== undefined) {
      if (next.kind !== 'custom') throw new ProviderRegistryError('Only custom endpoints have an address.');
      next.baseUrl = validateBaseUrl(changes.baseUrl);
    }
    if (changes.account !== undefined) next.account = changes.account.slice(0, 200);
    const all = [...records];
    all[i] = next;
    this.write(all);
    return next;
  }

  async remove(id: string): Promise<void> {
    const records = this.list();
    const record = records.find((r) => r.id === id);
    if (!record) throw new ProviderRegistryError('No such provider.', 404);
    if (record.kind === 'openai' || record.kind === 'anthropic') {
      const dir = this.stateDir(record);
      try {
        await this.cleanup?.(record, dir);
      } catch {
        // signing out is best effort; the listing goes either way
      }
      // Never blocks the removal: on Windows a Codex process that just stopped can hold the folder for a moment.
      removeDir(dir);
    }
    try {
      await this.secrets.delete(this.secretKey(id));
    } catch {
      // the keyring may be locked; the listing goes either way
    }
    this.write(records.filter((r) => r.id !== id));
  }

  async secret<T extends ProviderSecret>(id: string): Promise<T | null> {
    const raw = await this.secrets.get(this.secretKey(id));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setSecret(id: string, secret: ProviderSecret): Promise<void> {
    await this.secrets.set(this.secretKey(id), JSON.stringify(secret));
  }

  /** The Bright Data API key for agents' web access (`sf-web`), or null. */
  async webKey(): Promise<string | null> {
    try {
      return await this.secrets.get(WEB_KEY);
    } catch {
      return null;
    }
  }

  /** Stores (or with null, removes) the Bright Data API key. */
  async setWebKey(key: string | null): Promise<void> {
    if (key === null) {
      await this.secrets.delete(WEB_KEY);
    } else {
      const k = key.trim();
      if (!k || k.length > 4000 || /\s/.test(k)) throw new ProviderRegistryError('That does not look like an API key.');
      await this.secrets.check();
      await this.secrets.set(WEB_KEY, k);
    }
    this.emit();
  }

  close(): void {
    if (this.watcher) fs.unwatchFile(this.file);
    this.watcher = null;
    this.listeners.clear();
  }
}
