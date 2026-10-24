/**
 * The web interface's sign-in.
 *
 * - On first start the CLI makes a random access token and prints it once.
 *   Only a salted scrypt hash of it is kept, in the OS keyring: nothing in
 *   SF Agents (or an agent) can read the token back.
 * - A browser pastes the token once; the server checks it against the hash
 *   and gives that device a session (an HttpOnly cookie, 90 days, renewed
 *   while used). Wrong tokens are rate-limited.
 * - Signed in, a device can add a passkey (WebAuthn) and sign in with it
 *   from then on. Passkeys need HTTPS or localhost (Tailscale Serve is fine).
 * - `sfagents web --new-token` replaces the token and signs every device out
 *   and removes the passkeys.
 *
 * Sessions and passkeys are public-key or hashed data, kept in web-auth.json
 * in the per-user folder; the token hash is in the keyring.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { KeyringSecretStore, readJsonFile, sfagentsHome, writeFileAtomic, type SecretStore } from '@sfagents/core';

export const SESSION_COOKIE = 'sfagents_session';
const TOKEN_KEY = 'web-access-token';
const SESSION_DAYS = 90;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface DeviceRecord {
  /** sha256 of the session secret. */
  session: string;
  id: string;
  name: string;
  created: string;
  lastSeen: string;
  expires: string;
}

interface PasskeyRecord {
  id: string;
  publicKey: string; // base64url
  counter: number;
  transports?: string[];
  rpId: string;
  name: string;
  created: string;
  lastUsed?: string;
  device?: string;
}

interface AuthFile {
  devices: DeviceRecord[];
  passkeys: PasskeyRecord[];
  /** Random per-installation WebAuthn user handle. */
  userId?: string;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');

function scryptHash(token: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(token, salt, 64, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
}

/** A new access token: 32 random bytes, readable in one line. */
export function newAccessToken(): string {
  return `sfa_${crypto.randomBytes(32).toString('base64url')}`;
}

export function deviceName(ua: string | undefined): string {
  const s = ua ?? '';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'Browser';
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return browser ? `${browser} on ${os}` : os;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export interface AuthOptions {
  secrets?: SecretStore;
  /** Folder for web-auth.json (default: the per-user folder). */
  dir?: string;
}

export class WebAuth {
  readonly secrets: SecretStore;
  private readonly file: string;
  private data: AuthFile;
  private readonly challenges = new Map<string, { challenge: string; expires: number; rpId: string; origin: string; device?: string }>();
  private failures: number[] = [];

  constructor(options: AuthOptions = {}) {
    this.secrets = options.secrets ?? new KeyringSecretStore();
    this.file = path.join(options.dir ?? sfagentsHome(), 'web-auth.json');
    this.data = readJsonFile<AuthFile>(this.file, { devices: [], passkeys: [] });
    this.data.devices ??= [];
    this.data.passkeys ??= [];
    // Sessions that ran out (a device that never came back) are dropped.
    const now = Date.now();
    this.data.devices = this.data.devices.filter((d) => Date.parse(d.expires) > now);
  }

  private save(): void {
    writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  // ---------------------------------------------------------------- the token

  async hasToken(): Promise<boolean> {
    return (await this.secrets.get(TOKEN_KEY)) !== null;
  }

  /**
   * Makes a new token, keeps only its hash, and returns the token (to print
   * once). Replacing a token signs every device out and removes the passkeys.
   */
  async createToken(): Promise<string> {
    await this.secrets.check();
    const token = newAccessToken();
    const salt = crypto.randomBytes(16);
    const hash = await scryptHash(token, salt);
    await this.secrets.set(TOKEN_KEY, `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`);
    this.data = { devices: [], passkeys: [], userId: this.data.userId };
    this.save();
    return token;
  }

  private async checkToken(token: string): Promise<boolean> {
    const stored = await this.secrets.get(TOKEN_KEY);
    if (!stored) throw new AuthError(503, 'No access token is set up. Start SF Agents with "sfagents web" in a terminal; it prints one.');
    const [kind, , , , salt, hash] = stored.split('$');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const got = await scryptHash(token.trim(), Buffer.from(salt, 'base64url'));
    const want = Buffer.from(hash, 'base64url');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  /** At most 10 wrong tokens per 10 minutes, then wait. */
  private throttle(): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 10 * 60_000);
    if (this.failures.length >= 10) {
      const wait = Math.ceil((10 * 60_000 - (now - this.failures[0]!)) / 1000);
      throw new AuthError(429, `Too many wrong tokens. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`);
    }
  }

  // ---------------------------------------------------------------- sessions

  private newSession(res: ServerResponse, req: IncomingMessage, secure: boolean, name?: string): DeviceRecord {
    const secret = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const device: DeviceRecord = {
      session: sha(secret),
      id: crypto.randomBytes(8).toString('hex'),
      name: name ?? deviceName(req.headers['user-agent']),
      created: now.toISOString(),
      lastSeen: now.toISOString(),
      expires: new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
    };
    this.data.devices.push(device);
    this.save();
    this.setCookie(res, secret, secure);
    return device;
  }

  private setCookie(res: ServerResponse, secret: string, secure: boolean, maxAge = SESSION_DAYS * 86_400): void {
    const cookie = `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), cookie]);
  }

  /** The signed-in device of a request, renewing its session when it is old. */
  device(req: IncomingMessage): DeviceRecord | null {
    const secret = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!secret) return null;
    const hash = sha(secret);
    const d = this.data.devices.find((x) => x.session === hash);
    if (!d) return null;
    const now = Date.now();
    if (Date.parse(d.expires) < now) return null;
    // Sliding expiry, written at most once an hour.
    if (now - Date.parse(d.lastSeen) > 3_600_000) {
      d.lastSeen = new Date(now).toISOString();
      d.expires = new Date(now + SESSION_DAYS * 86_400_000).toISOString();
      this.save();
    }
    return d;
  }

  signOut(req: IncomingMessage, res: ServerResponse, secure: boolean): void {
    const d = this.device(req);
    if (d) {
      this.data.devices = this.data.devices.filter((x) => x !== d);
      this.save();
    }
    this.setCookie(res, '', secure, 0);
  }

  // ---------------------------------------------------------------- passkeys

  private userId(): Uint8Array {
    if (!this.data.userId) {
      this.data.userId = crypto.randomBytes(16).toString('base64url');
      this.save();
    }
    return new Uint8Array(Buffer.from(this.data.userId, 'base64url'));
  }

  private remember(challenge: string, rpId: string, origin: string, device?: string): string {
    const id = crypto.randomBytes(16).toString('base64url');
    const now = Date.now();
    for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
    this.challenges.set(id, { challenge, expires: now + 5 * 60_000, rpId, origin, device });
    return id;
  }

  private take(id: unknown) {
    const c = typeof id === 'string' ? this.challenges.get(id) : undefined;
    if (typeof id === 'string') this.challenges.delete(id);
    if (!c || c.expires < Date.now()) throw new AuthError(400, 'The passkey request expired. Try again.');
    return c;
  }

  status(req: IncomingMessage, rpId: string) {
    const d = this.device(req);
    return {
      signedIn: !!d,
      device: d ? { id: d.id, name: d.name } : null,
      passkeys: this.data.passkeys.filter((p) => p.rpId === rpId).length,
      devicePasskey: d ? this.data.passkeys.some((p) => p.device === d.id && p.rpId === rpId) : false,
    };
  }

  list(rpId: string) {
    return {
      devices: this.data.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen })),
      passkeys: this.data.passkeys.filter((p) => p.rpId === rpId).map((p) => ({ id: p.id, name: p.name, created: p.created, lastUsed: p.lastUsed ?? null })),
    };
  }

  /**
   * Routes under /api/auth/. `rpId` and `origin` are the browser's view of
   * this server (the public origin behind a proxy, else the Host).
   */
  async handle(action: string, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse, ctx: { rpId: string; origin: string; secure: boolean }): Promise<unknown> {
    switch (action) {
      case 'login': {
        this.throttle();
        const token = typeof body['token'] === 'string' ? body['token'] : '';
        if (!token || !(await this.checkToken(token))) {
          this.failures.push(Date.now());
          throw new AuthError(401, 'That is not the access token. It was printed by "sfagents web" when SF Agents first started.');
        }
        const d = this.newSession(res, req, ctx.secure);
        return { ok: true, device: { id: d.id, name: d.name } };
      }
      case 'logout':
        this.signOut(req, res, ctx.secure);
        return { ok: true };
      case 'register-options': {
        const d = this.device(req);
        if (!d) throw new AuthError(401, 'Sign in first.');
        const opts = await generateRegistrationOptions({
          rpName: 'SF Agents',
          rpID: ctx.rpId,
          userName: 'SF Agents',
          userID: this.userId() as never,
          userDisplayName: 'SF Agents',
          attestationType: 'none',
          excludeCredentials: this.data.passkeys.filter((p) => p.rpId === ctx.rpId).map((p) => ({ id: p.id, transports: p.transports })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        });
        return { request: this.remember(opts.challenge, ctx.rpId, ctx.origin, d.id), options: opts };
      }
      case 'register': {
        const d = this.device(req);
        if (!d) throw new AuthError(401, 'Sign in first.');
        const c = this.take(body['request']);
        let result;
        try {
          result = await verifyRegistrationResponse({ response: body['response'] as never, expectedChallenge: c.challenge, expectedOrigin: c.origin, expectedRPID: c.rpId, requireUserVerification: false });
        } catch (error) {
          throw new AuthError(400, `The passkey could not be verified: ${(error as Error).message}`);
        }
        if (!result.verified) throw new AuthError(400, 'The passkey could not be verified.');
        const cred = result.registrationInfo.credential;
        this.data.passkeys.push({
          id: cred.id,
          publicKey: Buffer.from(cred.publicKey).toString('base64url'),
          counter: cred.counter,
          transports: cred.transports,
          rpId: c.rpId,
          name: d.name,
          created: new Date().toISOString(),
          device: d.id,
        });
        this.save();
        return { ok: true };
      }
      case 'passkey-options': {
        const opts = await generateAuthenticationOptions({ rpID: ctx.rpId, userVerification: 'preferred', allowCredentials: [] });
        return { request: this.remember(opts.challenge, ctx.rpId, ctx.origin), options: opts };
      }
      case 'passkey': {
        this.throttle();
        const c = this.take(body['request']);
        const response = body['response'] as { id?: string } | undefined;
        const key = this.data.passkeys.find((p) => p.id === response?.id && p.rpId === c.rpId);
        if (!key) {
          this.failures.push(Date.now());
          throw new AuthError(401, 'That passkey is not registered here (it may have been removed, or the access token was replaced).');
        }
        let result;
        try {
          result = await verifyAuthenticationResponse({
            response: response as never,
            expectedChallenge: c.challenge,
            expectedOrigin: c.origin,
            expectedRPID: c.rpId,
            credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')) as never, counter: key.counter, transports: key.transports },
            requireUserVerification: false,
          });
        } catch (error) {
          this.failures.push(Date.now());
          throw new AuthError(401, `The passkey could not be verified: ${(error as Error).message}`);
        }
        if (!result.verified) throw new AuthError(401, 'The passkey could not be verified.');
        key.counter = result.authenticationInfo.newCounter;
        key.lastUsed = new Date().toISOString();
        const d = this.newSession(res, req, ctx.secure, key.name);
        // Signing in with a device's passkey keeps that device's identity (its settings).
        if (key.device) {
          const old = this.data.devices.find((x) => x.id === key.device && x !== d);
          if (old) this.data.devices = this.data.devices.filter((x) => x !== old);
          d.id = key.device;
        }
        this.save();
        return { ok: true, device: { id: d.id, name: d.name } };
      }
      case 'remove-passkey': {
        if (!this.device(req)) throw new AuthError(401, 'Sign in first.');
        this.data.passkeys = this.data.passkeys.filter((p) => p.id !== body['id']);
        this.save();
        return this.list(ctx.rpId);
      }
      case 'remove-device': {
        if (!this.device(req)) throw new AuthError(401, 'Sign in first.');
        this.data.devices = this.data.devices.filter((d) => d.id !== body['id']);
        this.save();
        return this.list(ctx.rpId);
      }
      default:
        throw new AuthError(404, 'Not found.');
    }
  }
}
