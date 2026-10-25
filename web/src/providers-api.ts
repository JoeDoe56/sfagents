/**
 * The Settings sheet's server side: app settings, and the providers the user
 * added (OpenRouter keys, ChatGPT and Claude sign-ins, custom endpoints).
 * Keys and tokens go straight to the OS keyring; nothing here returns them.
 *
 *   GET  /api/settings                    every setting, its value and whether it needs a restart
 *   POST /api/settings {values}           saves (validated); null resets one
 *   GET  /api/providers                   the providers and whether a keyring is available
 *   POST /api/providers {kind, name, apiKey?, baseUrl?}       OpenRouter or a custom endpoint
 *   POST /api/providers/signin {kind, name}                   starts ChatGPT or Claude sign-in in this computer's browser → {id, opened}
 *   POST /api/providers/signin/<id> {action: "reopen"}        opens the ChatGPT sign-in page again
 *   POST /api/providers/signin/<id> {action: "cancel"}
 *
 * Both sign-ins finish on the computer SF Agents runs on: the page returns to
 * a listener here (Codex's or Claude's), and a "signin" event says when the
 * provider was added.
 *   POST /api/providers/<id> {action: "rename", name} | {action: "remove"}
 *   POST /api/providers/web {apiKey} | {action: "remove"}     the Bright Data key for agents' web access
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  AppSettings,
  ClaudeSignIn,
  CodexSignIn,
  KeyringUnavailableError,
  PROVIDER_KIND_LABELS,
  ProviderRegistry,
  ProviderRegistryError,
  SettingsError,
  getErrorMessage,
  openInBrowser,
  validateProviderName,
  type ProviderKind,
  type ProviderRecord,
} from '@sfagents/core';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface SignInSession {
  id: string;
  kind: 'openai' | 'anthropic';
  name: string;
  url: string;
  state: 'waiting' | 'done' | 'failed';
  error?: string;
  provider?: ProviderRecord;
  codex?: CodexSignIn;
  /** The Codex home made for the new provider (deleted when the sign-in fails). */
  home?: string;
  claude?: ClaudeSignIn;
  timer: NodeJS.Timeout;
}

/** How sign-ins start (tests replace them). */
export interface SignInStarters {
  codex(home: string): Promise<CodexSignIn>;
  claude(): Promise<ClaudeSignIn>;
  open(url: string): Promise<boolean>;
}

export interface ProvidersApiOptions {
  registry: ProviderRegistry;
  settings: AppSettings;
  /** Values the running server actually uses (they differ from the stored ones until a restart). */
  running: Record<string, unknown>;
  broadcast: (event: string, data: unknown) => void;
  log: (line: string) => void;
  signIn?: Partial<SignInStarters>;
}

export function describeProvider(p: ProviderRecord) {
  return { id: p.id, name: p.name, kind: p.kind, kindLabel: PROVIDER_KIND_LABELS[p.kind], baseUrl: p.baseUrl ?? null, account: p.account ?? null, created: p.created };
}

export class ProvidersApi {
  private readonly signIns = new Map<string, SignInSession>();
  private keyring: { available: boolean; label: string; reason?: string; checked: number } | null = null;
  private readonly starters: SignInStarters;

  constructor(private readonly options: ProvidersApiOptions) {
    this.starters = {
      codex: (home) => CodexSignIn.start({ home }),
      claude: () => ClaudeSignIn.start(),
      open: openInBrowser,
      ...options.signIn,
    };
    options.registry.onChange(() => options.broadcast('providers', { providers: this.list() }));
  }

  list() {
    return this.options.registry.list().map(describeProvider);
  }

  private async keyringStatus(force = false) {
    if (!force && this.keyring && Date.now() - this.keyring.checked < 30_000) return this.keyring;
    const label = this.options.registry.secrets.label;
    try {
      await this.options.registry.secrets.check();
      this.keyring = { available: true, label, checked: Date.now() };
    } catch (error) {
      this.keyring = { available: false, label, reason: getErrorMessage(error), checked: Date.now() };
    }
    return this.keyring;
  }

  settings() {
    return {
      settings: this.options.settings
        .all()
        .filter((s) => !s.platform || s.platform === process.platform)
        .map((s) => ({ ...s, running: this.options.running[s.key] ?? s.value })),
      file: this.options.settings.file,
    };
  }

  saveSettings(body: Record<string, unknown>) {
    const values = body['values'];
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ApiError(400, '"values" must be an object.');
    try {
      this.options.settings.set(values as Record<string, unknown>);
    } catch (error) {
      if (error instanceof SettingsError) throw new ApiError(400, error.message);
      throw error;
    }
    const result = this.settings();
    this.options.broadcast('settings', result);
    return result;
  }

  async providers() {
    const { reason, available, label } = await this.keyringStatus();
    const brightData = available ? (await this.options.registry.webKey()) !== null : false;
    return { providers: this.list(), keyring: { available, label, ...(reason ? { reason } : {}) }, suggestions: this.suggestions(), web: { brightData } };
  }

  private suggestions(): Record<ProviderKind, string> {
    const r = this.options.registry;
    return { openrouter: r.suggestName('openrouter'), openai: r.suggestName('openai'), anthropic: r.suggestName('anthropic'), custom: r.suggestName('custom') };
  }

  private checkName(name: unknown): string {
    try {
      const n = validateProviderName(name);
      if (this.options.registry.find(n)) throw new ApiError(409, `A provider named "${n}" already exists.`);
      for (const s of this.signIns.values()) if (s.state === 'waiting' && s.name.toLowerCase() === n.toLowerCase()) throw new ApiError(409, `A sign-in for "${n}" is already in progress.`);
      return n;
    } catch (error) {
      if (error instanceof ProviderRegistryError) throw new ApiError(error.status, error.message);
      throw error;
    }
  }

  private wrap<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((error: unknown) => {
      if (error instanceof ApiError) throw error;
      if (error instanceof ProviderRegistryError) throw new ApiError(error.status, error.message);
      if (error instanceof KeyringUnavailableError) throw new ApiError(503, error.message);
      throw new ApiError(400, getErrorMessage(error));
    });
  }

  async handle(method: string, parts: string[], body: Record<string, unknown>): Promise<unknown> {
    const [, a, b] = parts; // parts[0] === 'providers'
    if (method === 'GET' && !a) return this.providers();
    if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
    if (!a) return this.wrap(this.addKeyProvider(body));
    if (a === 'signin' && !b) return this.wrap(this.startSignIn(body));
    if (a === 'signin' && b) return this.wrap(this.continueSignIn(b, body));
    if (a === 'web' && !b) return this.wrap(this.setWebKey(body));
    const record = this.options.registry.list().find((r) => r.id === a);
    if (!record) throw new ApiError(404, 'No such provider.');
    if (body['action'] === 'rename') {
      const name = this.checkName(body['name']);
      return this.wrap(Promise.resolve().then(() => describeProvider(this.options.registry.update(record.id, { name }))));
    }
    if (body['action'] === 'remove') {
      await this.wrap(this.options.registry.remove(record.id));
      return { ok: true };
    }
    throw new ApiError(400, '"action" must be "rename" or "remove".');
  }

  private async addKeyProvider(body: Record<string, unknown>) {
    const kind = body['kind'];
    if (kind !== 'openrouter' && kind !== 'custom') throw new ApiError(400, 'Use sign-in for OpenAI and Anthropic; "kind" here is "openrouter" or "custom".');
    const name = this.checkName(body['name']);
    const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : '';
    if (kind === 'openrouter' && !apiKey) throw new ApiError(400, 'Enter the API key.');
    if (apiKey.length > 4000 || /\s/.test(apiKey)) throw new ApiError(400, 'That does not look like an API key.');
    const keyring = await this.keyringStatus(true);
    if (!keyring.available) throw new ApiError(503, keyring.reason ?? 'No keyring.');
    const record = await this.options.registry.add({ name, kind, baseUrl: typeof body['baseUrl'] === 'string' ? body['baseUrl'] : undefined, secret: { apiKey } });
    this.options.log(`web: added provider "${record.name}" (${record.kind})`);
    return describeProvider(record);
  }

  private async setWebKey(body: Record<string, unknown>) {
    if (body['action'] === 'remove') {
      await this.options.registry.setWebKey(null);
      this.options.log('web: removed the Bright Data key');
      return { ok: true };
    }
    const keyring = await this.keyringStatus(true);
    if (!keyring.available) throw new ApiError(503, keyring.reason ?? 'No keyring.');
    await this.options.registry.setWebKey(typeof body['apiKey'] === 'string' ? body['apiKey'] : '');
    this.options.log('web: saved a Bright Data key');
    return { ok: true };
  }

  private async startSignIn(body: Record<string, unknown>) {
    const kind = body['kind'];
    if (kind !== 'openai' && kind !== 'anthropic') throw new ApiError(400, '"kind" must be "openai" or "anthropic".');
    const name = this.checkName(body['name']);
    const keyring = await this.keyringStatus(true);
    if (!keyring.available) throw new ApiError(503, keyring.reason ?? 'No keyring.');
    for (const s of this.signIns.values()) if (s.state === 'waiting' && s.kind === kind) this.endSignIn(s.id, 'Another sign-in started.');
    const id = randomUUID();
    let session: SignInSession;
    const timer = setTimeout(() => this.endSignIn(id, 'Sign-in timed out.'), 15 * 60_000);
    timer.unref();
    let opened: boolean;
    try {
      if (kind === 'openai') {
        // The provider's id is chosen now: Codex keeps the sign-in under that provider's own folder.
        const recordId = randomUUID();
        const home = this.options.registry.stateDir({ id: recordId, kind });
        const codex = await this.starters.codex(home).catch((error) => {
          fs.rmSync(home, { recursive: true, force: true });
          throw error;
        });
        session = { id, kind, name, url: codex.url, state: 'waiting', codex, home, timer };
        this.signIns.set(id, session);
        codex.done.then(
          (result) => this.finish(session, { id: recordId, account: result.email, secret: { codex: true } }),
          (error) => this.endSignIn(id, getErrorMessage(error)),
        );
        opened = await this.starters.open(codex.url);
      } else {
        // Claude opens its page in this computer's browser by itself.
        const claude = await this.starters.claude();
        session = { id, kind, name, url: claude.url, state: 'waiting', claude, timer };
        this.signIns.set(id, session);
        claude.done.then(
          (token) => this.finish(session, { account: 'Claude plan', secret: { token } }),
          (error) => this.endSignIn(id, getErrorMessage(error)),
        );
        opened = true;
      }
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    this.options.log(`web: started the ${kind === 'openai' ? 'ChatGPT' : 'Claude'} sign-in for "${name}"`);
    return { id, kind, name, opened };
  }

  private async finish(session: SignInSession, add: { id?: string; account?: string; secret: { codex: true } | { token: string } }): Promise<void> {
    if (session.state !== 'waiting') return;
    try {
      const provider = await this.options.registry.add({ name: session.name, kind: session.kind, id: add.id, account: add.account, secret: add.secret });
      this.options.log(`web: added provider "${provider.name}" (${provider.kind})`);
      this.endSignIn(session.id, undefined, provider);
    } catch (error) {
      this.endSignIn(session.id, getErrorMessage(error));
    }
  }

  private endSignIn(id: string, error?: string, provider?: ProviderRecord): void {
    const s = this.signIns.get(id);
    if (!s || s.state !== 'waiting') return;
    clearTimeout(s.timer);
    s.state = error ? 'failed' : 'done';
    s.error = error;
    s.provider = provider;
    if (error) {
      s.codex?.cancel();
      s.claude?.cancel();
      // A failed ChatGPT sign-in leaves nothing behind (Codex wrote no keyring entry, or it is unused).
      if (s.home) setTimeout(() => fs.rmSync(s.home!, { recursive: true, force: true }), 1000).unref();
    }
    this.options.broadcast('signin', { id, state: s.state, error: error ?? null, provider: provider ? describeProvider(provider) : null });
    setTimeout(() => this.signIns.delete(id), 60_000).unref();
  }

  private async continueSignIn(id: string, body: Record<string, unknown>) {
    const s = this.signIns.get(id);
    if (!s) throw new ApiError(404, 'That sign-in has ended. Start again.');
    if (body['action'] === 'cancel') {
      this.endSignIn(id, 'Cancelled.');
      return { id, state: s.state };
    }
    if (body['action'] === 'reopen') {
      if (s.state !== 'waiting') throw new ApiError(409, 'That sign-in has ended. Start again.');
      if (!s.codex) throw new ApiError(400, 'Claude opens its sign-in page once. Start again to open it again.');
      return { id, state: s.state, opened: await this.starters.open(s.url) };
    }
    if (s.state !== 'waiting') return { id, state: s.state, error: s.error ?? null, provider: s.provider ? describeProvider(s.provider) : null };
    throw new ApiError(400, '"action" must be "reopen" or "cancel". The sign-in finishes in the browser on this computer.');
  }

  close(): void {
    for (const id of this.signIns.keys()) this.endSignIn(id, 'The server stopped.');
  }
}
