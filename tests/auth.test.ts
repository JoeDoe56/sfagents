import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { AppSettings, ConversationService, MemorySecretStore, ProviderRegistry, loadAgentTree } from '@sfagents/core';
import { WebAuth, WebServer, SESSION_COOKIE } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent } from './helpers.js';

async function start(available = true) {
  const dir = makeTempDir();
  writeAgent(dir, baseAgent('main'));
  const tree = loadAgentTree(dir);
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
  const home = makeTempDir();
  const secrets = new MemorySecretStore(available);
  const auth = new WebAuth({ secrets, dir: home });
  const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(true) });
  const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, registry, settings: new AppSettings(home), watchAgents: false, auth });
  const base = (await server.start()).replace(/\/$/, '');
  return {
    base,
    home,
    auth,
    secrets,
    async stop() {
      await server.close();
      conversation.close();
      registry.close();
    },
  };
}

function req(base: string, pathname: string, opts: { body?: unknown; cookie?: string; accept?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Host: u.host };
    if (body) headers['Content-Type'] = 'application/json';
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    if (opts.accept) headers['Accept'] = opts.accept;
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: body ? 'POST' : 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}

function sessionCookie(headers: http.IncomingHttpHeaders): string {
  const set = (headers['set-cookie'] ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(set, 'a session cookie is set');
  assert.match(set!, /HttpOnly/);
  assert.match(set!, /SameSite=Lax/);
  return set!.split(';')[0]!;
}

function upgradeStatus(base: string, cookie?: string): Promise<string> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port), u.hostname, () => {
      s.write(
        `GET /api/terminal?id=x HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`,
      );
    });
    let data = '';
    s.on('data', (d) => {
      data += d.toString();
      if (data.includes('\r\n')) {
        resolve(data.split('\r\n')[0]!);
        s.destroy();
      }
    });
    s.on('error', reject);
    s.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

describe('web sign-in gate', () => {
  test('the token is stored only as a hash; signing in with it sets a session that opens the app', async () => {
    const s = await start();
    try {
      assert.equal(await s.auth.hasToken(), false);
      const token = await s.auth.createToken();
      assert.match(token, /^sfa_[A-Za-z0-9_-]{43}$/);
      const stored = [...s.secrets.values.values()].join('\n');
      assert.ok(!stored.includes(token), 'the keyring never holds the token itself');
      assert.match(stored, /^scrypt\$/);
      for (const f of fs.readdirSync(s.home)) assert.ok(!fs.readFileSync(path.join(s.home, f), 'utf8').includes(token), `${f} has no token`);

      // Signed out: the API refuses, the page redirects, the sign-in page is public.
      const api = await req(s.base, '/api/state');
      assert.equal(api.status, 401);
      assert.equal(api.json.signIn, '/login.html');
      const page = await req(s.base, '/', { accept: 'text/html' });
      assert.equal(page.status, 303);
      assert.equal(page.headers.location, '/login.html');
      const deep = await req(s.base, '/apps/a1/', { accept: 'text/html' });
      assert.equal(deep.status, 303);
      assert.equal(deep.headers.location, `/login.html?next=${encodeURIComponent('/apps/a1/')}`);
      assert.equal((await req(s.base, '/login.html')).status, 200);
      assert.equal((await req(s.base, '/webauthn.js')).status, 200);
      assert.equal((await req(s.base, '/app.js')).status, 401);
      assert.match(await upgradeStatus(s.base), / 401 /);
      const status = await req(s.base, '/api/auth/status');
      assert.equal(status.json.signedIn, false);
      assert.equal(status.json.passkeys, 0);
      assert.equal(status.json.secureContext, false, '127.0.0.1 over http is not a secure context for passkeys');

      // A wrong token, then the right one.
      const wrong = await req(s.base, '/api/auth/login', { body: { token: 'sfa_nope' } });
      assert.equal(wrong.status, 401);
      const ok = await req(s.base, '/api/auth/login', { body: { token: `  ${token}\n` } });
      assert.equal(ok.status, 200);
      const cookie = sessionCookie(ok.headers);
      assert.equal((await req(s.base, '/api/state', { cookie })).status, 200);
      assert.equal((await req(s.base, '/', { cookie, accept: 'text/html' })).status, 200);
      assert.doesNotMatch(await upgradeStatus(s.base, cookie), / 401 /);
      const me = await req(s.base, '/api/auth/status', { cookie });
      assert.equal(me.json.signedIn, true);
      const list = await req(s.base, '/api/auth/list', { cookie });
      assert.equal(list.json.devices.length, 1);
      // Only a hash of the session is on disk.
      const file = fs.readFileSync(path.join(s.home, 'web-auth.json'), 'utf8');
      assert.ok(!file.includes(cookie.split('=')[1]!));

      // Passkey registration needs a signed-in device.
      assert.equal((await req(s.base, '/api/auth/register-options', { body: {} })).status, 401);
      const reg = await req(s.base, '/api/auth/register-options', { body: {}, cookie });
      assert.equal(reg.status, 200);
      assert.equal(reg.json.options.rp.id, '127.0.0.1');
      assert.equal(typeof reg.json.request, 'string');
      // An unknown passkey is refused.
      const opts = await req(s.base, '/api/auth/passkey-options', { body: {} });
      const bad = await req(s.base, '/api/auth/passkey', { body: { request: opts.json.request, response: { id: 'nope' } } });
      assert.equal(bad.status, 401);

      // Signing out ends the session.
      const out = await req(s.base, '/api/auth/logout', { body: {}, cookie });
      assert.equal(out.status, 200);
      assert.equal((await req(s.base, '/api/state', { cookie })).status, 401);
    } finally {
      await s.stop();
    }
  });

  test('a new token signs every device out; wrong tokens are rate limited', async () => {
    const s = await start();
    try {
      const token = await s.auth.createToken();
      const cookie = sessionCookie((await req(s.base, '/api/auth/login', { body: { token } })).headers);
      assert.equal((await req(s.base, '/api/state', { cookie })).status, 200);
      const second = await s.auth.createToken();
      assert.notEqual(second, token);
      assert.equal((await req(s.base, '/api/state', { cookie })).status, 401, 'the old session ended');
      assert.equal((await req(s.base, '/api/auth/login', { body: { token } })).status, 401, 'the old token no longer works');
      for (let i = 0; i < 9; i++) assert.equal((await req(s.base, '/api/auth/login', { body: { token: `sfa_wrong${i}` } })).status, 401);
      const limited = await req(s.base, '/api/auth/login', { body: { token: second } });
      assert.equal(limited.status, 429, 'ten wrong tokens lock sign-in for a while, even for the right one');
      assert.match(limited.json.error, /Too many/);
    } finally {
      await s.stop();
    }
  });

  test('without a keyring no token can be made', async () => {
    const s = await start(false);
    try {
      await assert.rejects(() => s.auth.createToken(), /test store marked unavailable/);
    } finally {
      await s.stop();
    }
  });
});
