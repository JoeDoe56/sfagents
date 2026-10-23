/**
 * OpenAI through a ChatGPT plan: "Sign in with ChatGPT" (OAuth, with PKCE
 * and dynamic client registration) and the Responses API at
 * api.openai.com/v1/responses, with storage off.
 *
 * Follows the flow of the project owner's LLM-Proxy (openai-proxy.mjs), which
 * implements OpenAI's token-sharing preview:
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * Differences: tokens go to the OS keyring (only the client id, refresh
 * token and subject are stored; access tokens stay in memory), and sign-in
 * can be finished from another device by pasting the final address.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import {
  ProviderError,
  type AssistantMessage,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ParsedToolCall,
  type TokenUsage,
} from './types.js';
import type { OpenAISecret } from './registry.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const APP_NAME = 'SF Agents';
const NAMESPACE = 'sfagents_tools';

type Fetcher = typeof fetch;
const b64 = (x: Buffer | string) => Buffer.from(x).toString('base64url');
const random = () => b64(crypto.randomBytes(32));
const sha256 = (x: string) => crypto.createHash('sha256').update(x).digest();

export class SignInError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'SignInError';
  }
}

async function jsonFetch(url: string, init: RequestInit, fetcher: Fetcher): Promise<Record<string, any>> {
  const r = await fetcher(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30000) });
  const body = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok) {
    const code = typeof body['error'] === 'string' ? body['error'] : body['error']?.code;
    throw new SignInError(`OpenAI sign-in request failed (HTTP ${r.status}${code ? `, ${String(code).replace(/[^\w]/g, '')}` : ''}).`, code);
  }
  return body;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: Promise<Discovery> | null = null;
async function discovery(fetcher: Fetcher): Promise<Discovery> {
  discoveryCache ??= (async () => {
    const d = await jsonFetch(`${OPENAI_ISSUER}/.well-known/openid-configuration`, {}, fetcher);
    if (d['issuer'] !== OPENAI_ISSUER) throw new SignInError('Unexpected OAuth issuer.');
    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      const u = new URL(String(d[name]));
      if (u.origin !== OPENAI_ISSUER || u.username || u.password) throw new SignInError('Unexpected OAuth endpoint.');
    }
    return d as unknown as Discovery;
  })().catch((e) => {
    discoveryCache = null;
    throw e;
  });
  return discoveryCache;
}

function exchange(meta: Discovery, fields: Record<string, string>, fetcher: Fetcher) {
  return jsonFetch(
    meta.token_endpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, resource: OPENAI_RESOURCE }) },
    fetcher,
  );
}

/** Checks an ID token's signature (RS256 against the issuer's keys) and claims. */
export function validateIdToken(token: string | undefined, jwks: { keys?: any[] }, clientId: string, nonce: string | undefined, priorSubject?: string): Record<string, any> {
  const parts = token?.split('.') ?? [];
  if (parts.length !== 3) throw new SignInError('Missing or invalid ID token.');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  const jwk = jwks.keys?.find((k) => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
  if (header.alg !== 'RS256' || header.crit || !jwk || (jwk.alg && jwk.alg !== 'RS256')) throw new SignInError('Unsupported ID-token signing key.');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) throw new SignInError('Invalid ID-token signature.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Date.now() / 1000;
  if (
    claims.iss !== OPENAI_ISSUER ||
    !aud.includes(clientId) ||
    ((aud.length > 1 || claims.azp) && claims.azp !== clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    (claims.nbf && claims.nbf > now + 60) ||
    (nonce !== undefined && claims.nonce !== nonce) ||
    !claims.sub ||
    (priorSubject && priorSubject !== claims.sub)
  )
    throw new SignInError('The sign-in could not be verified (ID-token identity, audience, expiry or nonce).');
  return claims;
}

function checkScopes(tokens: Record<string, any>, previous?: string[]): void {
  const scopes = tokens['scope'] ? String(tokens['scope']).split(' ') : (previous ?? []);
  if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke'))
    throw new SignInError('ChatGPT plan access was not granted. Sign in again and allow plan usage.');
  if (!tokens['access_token'] || String(tokens['token_type']).toLowerCase() !== 'bearer' || !(Number(tokens['expires_in']) > 0))
    throw new SignInError('Incomplete OAuth token response.');
}

export interface OpenAISignInResult {
  secret: OpenAISecret;
  email?: string;
  accessToken: string;
  expiresAt: number;
}

/**
 * One sign-in attempt. Open `url` in a browser; OpenAI redirects to a
 * one-time listener on this computer. When the browser is on another device,
 * that last page doesn't load: pass its address to `complete`.
 */
export class OpenAISignIn {
  readonly url: string;
  readonly done: Promise<OpenAISignInResult>;
  private used = false;
  private resolve!: (r: OpenAISignInResult) => void;
  private reject!: (e: Error) => void;
  private readonly timer: NodeJS.Timeout;

  private constructor(
    private readonly server: http.Server,
    private readonly meta: Discovery,
    private readonly redirect: string,
    private readonly state: string,
    private readonly nonce: string,
    private readonly verifier: string,
    hostId: string,
    private readonly fetcher: Fetcher,
  ) {
    this.done = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    this.done.catch(() => {});
    const fields: Record<string, string> = {
      client_id: 'dynamic_agent_client',
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: SCOPES,
      resource: OPENAI_RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: b64(sha256(verifier)),
      agent_name_hint: APP_NAME,
    };
    this.url = `${meta.authorization_endpoint}?${new URLSearchParams(fields)}`;
    this.timer = setTimeout(() => this.finish(new SignInError('Sign-in timed out after 10 minutes. Start again.')), 600_000);
    this.timer.unref();
  }

  static async start(options: { hostId: string; fetcher?: Fetcher }): Promise<OpenAISignIn> {
    const fetcher = options.fetcher ?? fetch;
    const meta = await discovery(fetcher);
    let session: OpenAISignIn | null = null;
    const server = http.createServer((req, res) => {
      const answer = (code: number, text: string) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SF Agents</title><body style="font:17px system-ui;margin:40px;background:#000;color:#fff"><p>${text}</p></body>`);
      };
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || u.pathname !== '/auth/callback' || !session) return answer(404, 'Not found.');
      session.complete(u.href).then(
        () => answer(200, 'Signed in. You can close this tab and go back to SF Agents.'),
        (e) => answer(400, `Sign-in failed: ${getErrorMessage(e).replace(/[<>&]/g, '')}`),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    session = new OpenAISignIn(server, meta, `http://127.0.0.1:${port}/auth/callback`, random(), random(), random(), options.hostId, fetcher);
    return session;
  }

  /** Finishes with the address OpenAI redirected to (pasted, or from the listener). */
  async complete(callbackUrl: string): Promise<OpenAISignInResult> {
    let u: URL;
    try {
      u = new URL(callbackUrl.trim());
    } catch {
      throw new SignInError('That is not the address of the sign-in page. Copy the whole address from the browser.');
    }
    if (`${u.origin}${u.pathname}` !== this.redirect) throw new SignInError('That address is not from this sign-in. Start again and copy the address of the last page.');
    if (this.used) return this.done;
    if (u.searchParams.getAll('state').length !== 1 || !crypto.timingSafeEqual(sha256(u.searchParams.get('state') ?? ''), sha256(this.state)))
      throw new SignInError('Invalid or expired sign-in state. Start again.');
    this.used = true;
    try {
      if (u.searchParams.has('iss') && u.searchParams.get('iss') !== OPENAI_ISSUER) throw new SignInError('Unexpected callback issuer.');
      if (u.searchParams.has('error')) throw new SignInError('Sign-in was declined or could not be completed.');
      const clientId = u.searchParams.get('client_id');
      if (!clientId || clientId === 'dynamic_agent_client') throw new SignInError('OpenAI did not issue a client id.');
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.getAll('code').length !== 1) throw new SignInError('Missing authorization code.');
      const tokens = await exchange(this.meta, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: this.verifier, redirect_uri: this.redirect }, this.fetcher);
      checkScopes(tokens);
      const jwks = await jsonFetch(this.meta.jwks_uri, {}, this.fetcher);
      const identity = validateIdToken(tokens['id_token'], jwks, clientId, this.nonce);
      if (!tokens['refresh_token']) throw new SignInError('OpenAI did not return a refresh token.');
      const result: OpenAISignInResult = {
        secret: { clientId, refreshToken: String(tokens['refresh_token']), subject: String(identity['sub']) },
        email: typeof identity['email'] === 'string' ? identity['email'] : undefined,
        accessToken: String(tokens['access_token']),
        expiresAt: Date.now() + Number(tokens['expires_in']) * 1000,
      };
      this.finish(null, result);
      return result;
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      this.finish(e);
      throw e;
    }
  }

  private finish(error: Error | null, result?: OpenAISignInResult): void {
    clearTimeout(this.timer);
    this.server.close();
    this.server.closeAllConnections?.();
    if (error) this.reject(error);
    else this.resolve(result!);
  }

  cancel(): void {
    this.finish(new SignInError('Sign-in cancelled.'));
  }
}

/** Access tokens for one ChatGPT sign-in: kept in memory, refreshed with the stored refresh token. */
export class OpenAITokens {
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private secret: OpenAISecret,
    private readonly onRotate: (secret: OpenAISecret) => Promise<void>,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  seed(token: string, expiresAt: number): void {
    this.access = { token, expiresAt };
  }

  async token(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    this.refreshing ??= (async () => {
      const meta = await discovery(this.fetcher);
      let t: Record<string, any>;
      try {
        t = await exchange(meta, { grant_type: 'refresh_token', client_id: this.secret.clientId, refresh_token: this.secret.refreshToken }, this.fetcher);
      } catch (error) {
        if (error instanceof SignInError && error.code === 'invalid_grant')
          throw new ProviderError('The ChatGPT sign-in has expired or was revoked. Sign in again in Settings → Providers.', 401, false);
        throw error;
      }
      checkScopes(t, ['chatgpt.tokens.use.direct', 'resource.invoke']);
      if (t['id_token']) validateIdToken(t['id_token'], await jsonFetch(meta.jwks_uri, {}, this.fetcher), this.secret.clientId, undefined, this.secret.subject);
      if (t['refresh_token'] && t['refresh_token'] !== this.secret.refreshToken) {
        this.secret = { ...this.secret, refreshToken: String(t['refresh_token']) };
        await this.onRotate(this.secret);
      }
      this.access = { token: String(t['access_token']), expiresAt: Date.now() + Number(t['expires_in']) * 1000 };
      return this.access.token;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}

/** The models the ChatGPT plan offers (slugs). */
export async function listChatGPTModels(tokens: OpenAITokens, fetcher: Fetcher = fetch): Promise<Array<{ id: string; name?: string }>> {
  const r = await fetcher(`${OPENAI_RESOURCE}/models`, { headers: { Authorization: `Bearer ${await tokens.token()}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new ProviderError(`OpenAI returned HTTP ${r.status} for the model list.`, r.status);
  const x = (await r.json()) as { models?: Array<{ slug: string; visibility?: string; display_name?: string }>; data?: Array<{ id: string }> };
  if (x.models) return x.models.filter((m) => m.visibility === undefined || m.visibility === 'list').map((m) => ({ id: m.slug, name: m.display_name }));
  return (x.data ?? []).map((m) => ({ id: m.id }));
}

// ------------------------------------------------------------------ the Responses API provider

/** Chat messages to Responses input items (system becomes developer; tool results are function_call_output). */
export function toResponsesInput(messages: readonly ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
      continue;
    }
    const role = m.role === 'system' ? 'developer' : m.role;
    if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      for (const t of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments, namespace: NAMESPACE });
      continue;
    }
    const content = m.content;
    if (typeof content === 'string') input.push({ role, content });
    else
      input.push({
        role,
        content: content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url })),
      });
  }
  return input;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 32 * 1024 * 1024) throw new ProviderError('An OpenAI stream event exceeded 32 MiB.', 502);
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

/** Errors that mean "this account can't serve now": another account may. */
export function isAccountLimitStatus(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

export class ChatGPTProvider implements ModelProvider {
  constructor(
    readonly id: string,
    private readonly tokens: OpenAITokens,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private body(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { model: request.model, input: toResponsesInput(request.messages), store: false, stream: true };
    if (request.tools?.length) {
      body['tools'] = [
        {
          type: 'namespace',
          name: NAMESPACE,
          description: 'Tools supplied by SF Agents.',
          tools: request.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
        },
      ];
      body['tool_choice'] = 'auto';
    }
    if (request.reasoning && request.reasoning !== 'none') body['reasoning'] = { effort: request.reasoning === 'max' ? 'xhigh' : request.reasoning, summary: 'auto' };
    return body;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let response: Response;
    try {
      response = await this.fetcher(`${OPENAI_RESOURCE}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.tokens.token()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(this.body(request)),
        redirect: 'error',
        signal: request.signal,
      });
    } catch (error) {
      if (isAbortError(error) || error instanceof ProviderError) throw error;
      throw new ProviderError(`Model request failed: ${getErrorMessage(error)}`, undefined, true);
    }
    if (!response.ok || !response.body) {
      const detail = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
      const msg = detail?.error?.message ?? `OpenAI returned HTTP ${response.status}.`;
      throw new ProviderError(`Model request failed (HTTP ${response.status}): ${msg}`, response.status, response.status >= 500);
    }
    let text = '';
    let reasoning = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: TokenUsage | undefined;
    let finishReason: string | null = null;
    let completed = false;
    try {
      for await (const event of sseEvents(response.body)) {
        switch (event['type']) {
          case 'response.output_text.delta':
            text += event['delta'];
            yield { type: 'text', text: event['delta'] };
            break;
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta':
            reasoning += event['delta'];
            yield { type: 'reasoning', text: event['delta'] };
            break;
          case 'response.output_item.added':
            if (event['item']?.type === 'function_call') calls.set(event['output_index'], { id: event['item'].call_id, name: event['item'].name, args: event['item'].arguments ?? '' });
            break;
          case 'response.function_call_arguments.delta': {
            const c = calls.get(event['output_index']);
            if (c) c.args += event['delta'];
            break;
          }
          case 'response.output_item.done':
            if (event['item']?.type === 'function_call') calls.set(event['output_index'], { id: event['item'].call_id, name: event['item'].name, args: event['item'].arguments ?? '' });
            break;
          case 'response.failed':
          case 'error': {
            const err = event['response']?.error ?? event['error'] ?? event;
            const status = err?.code === 'rate_limit_exceeded' || err?.code === 'usage_limit_reached' || err?.type === 'usage_limit_reached' ? 429 : 502;
            throw new ProviderError(`OpenAI: ${err?.message ?? 'inference failed'}`, status, status === 502);
          }
          case 'response.completed':
          case 'response.incomplete': {
            const r = event['response'] ?? {};
            const u = r.usage;
            if (u) usage = { promptTokens: u.input_tokens, completionTokens: u.output_tokens, totalTokens: u.total_tokens };
            finishReason = event['type'] === 'response.incomplete' ? 'length' : null;
            completed = true;
            break;
          }
        }
        if (completed) break;
      }
    } catch (error) {
      if (isAbortError(error) || error instanceof ProviderError) throw error;
      throw new ProviderError(`Model stream failed: ${getErrorMessage(error)}`, undefined, true);
    }
    if (!completed) throw new ProviderError('The OpenAI stream ended without a final response.', 502, true);
    const toolCalls: ParsedToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => {
        let args: Record<string, unknown> = {};
        try {
          args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        return { id: c.id, name: c.name, args, rawArguments: c.args || '{}' };
      });
    const message: AssistantMessage = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArguments } }));
    if (reasoning) message.reasoning = reasoning;
    yield { type: 'done', message, toolCalls, finishReason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'), usage };
  }
}
