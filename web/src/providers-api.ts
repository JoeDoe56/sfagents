/**
 * The Settings sheet's server side: app settings, and the providers the user
 * added (OpenRouter keys, ChatGPT and Claude sign-ins, custom endpoints).
 * Keys and tokens go straight to the OS keyring; nothing here returns them.
 *
 *   GET  /api/settings                    every setting, its value and whether it needs a restart
 *   POST /api/settings {values}           saves (validated); null resets one
 *   GET  /api/providers                   the providers and whether a keyring is available
 *   POST /api/providers {kind, name, apiKey?, baseUrl?}       OpenRouter or a custom endpoint
 *   POST /api/providers/signin {kind, name}                   starts ChatGPT or Claude sign-in → {id, url}
 *   POST /api/providers/signin/<id> {callbackUrl | code}      finishes it (pasted address or code)
 *   POST /api/providers/signin/<id> {action: "cancel"}
 *   POST /api/providers/<id> {action: "rename", name} | {action: "remove"}
 */

import { randomUUID } from 'node:crypto';
import {
  AppSettings,
  ClaudeSignIn,
  KeyringUnavailableError,
  OpenAISignIn,
  PROVIDER_KIND_LABELS,
  ProviderRegistry,
  ProviderRegistryError,
  SettingsError,
  chatGPTHostId,
  getErrorMessage,
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
  openai?: OpenAISignIn;
  claude?: ClaudeSignIn;
  timer: NodeJS.Timeout;
}

export interface ProvidersApiOptions {
  registry: ProviderRegistry;
  settings: AppSettings;
  /** Values the running server actually uses (they differ from the stored ones until a restart). */
  running: Record<string, unknown>;
  broadcast: (event: string, data: unknown) => void;
  log: (line: string) => void;
}

export function describeProvider(p: ProviderRecord) {
  return { id: p.id, name: p.name, kind: p.kind, kindLabel: PROVIDER_KIND_LABELS[p.kind], baseUrl: p.baseUrl ?? null, account: p.account ?? null, created: p.created };
}

export class ProvidersApi {
  private readonly signIns = new Map<string, SignInSession>();
  private keyring: { available: boolean; label: string; reason?: string; checked: number } | null = null;

  constructor(private readonly options: ProvidersApiOptions) {
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
    return { providers: this.list(), keyring: { available, label, ...(reason ? { reason } : {}) }, suggestions: this.suggestions() };
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

  private async startSignIn(body: Record<string, unknown>) {
    const kind = body['kind'];
    if (kind !== 'openai' && kind !== 'anthropic') throw new ApiError(400, '"kind" must be "openai" or "anthropic".');
    const name = this.checkName(body['name']);
    const keyring = await this.keyringStatus(true);
    if (!keyring.available) throw new ApiError(503, keyring.reason ?? 'No keyring.');
    const id = randomUUID();
    let session: SignInSession;
    const timer = setTimeout(() => this.endSignIn(id, 'Sign-in timed out.'), 15 * 60_000);
    timer.unref();
    if (kind === 'openai') {
      const openai = await OpenAISignIn.start({ hostId: chatGPTHostId(this.options.registry) });
      session = { id, kind, name, url: openai.url, state: 'waiting', openai, timer };
      // On this computer the browser comes back to the listener by itself.
      openai.done.then(
        (result) => this.finishOpenAI(session, result),
        (error) => this.endSignIn(id, getErrorMessage(error)),
      );
    } else {
      const claude = await ClaudeSignIn.start();
      session = { id, kind, name, url: claude.url, state: 'waiting', claude, timer };
    }
    this.signIns.set(id, session);
    return { id, kind, name, url: session.url };
  }

  private async finishOpenAI(session: SignInSession, result: Awaited<OpenAISignIn['done']>): Promise<void> {
    if (session.state !== 'waiting') return;
    try {
      const provider = await this.options.registry.add({ name: session.name, kind: 'openai', account: result.email, secret: result.secret });
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
      s.openai?.cancel();
      s.claude?.cancel();
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
    if (s.state !== 'waiting') return { id, state: s.state, error: s.error ?? null, provider: s.provider ? describeProvider(s.provider) : null };
    if (s.kind === 'openai') {
      const callbackUrl = body['callbackUrl'];
      if (typeof callbackUrl !== 'string') throw new ApiError(400, 'Paste the address of the page the sign-in ended on.');
      // complete() rejects a wrong address without ending the attempt; a valid one finishes it (finishOpenAI adds the provider).
      await s.openai!.complete(callbackUrl);
      await new Promise((r) => setTimeout(r, 50));
    } else {
      const code = body['code'];
      if (typeof code !== 'string') throw new ApiError(400, 'Paste the code Claude showed.');
      let token: string;
      try {
        token = await s.claude!.complete(code);
      } catch (error) {
        this.endSignIn(id, getErrorMessage(error));
        throw error;
      }
      const provider = await this.options.registry.add({ name: s.name, kind: 'anthropic', account: 'Claude plan', secret: { token } });
      this.endSignIn(id, undefined, provider);
    }
    const done = this.signIns.get(id)!;
    return { id, state: done.state, error: done.error ?? null, provider: done.provider ? describeProvider(done.provider) : null };
  }

  close(): void {
    for (const id of this.signIns.keys()) this.endSignIn(id, 'The server stopped.');
  }
}
