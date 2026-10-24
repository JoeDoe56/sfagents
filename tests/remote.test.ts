import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { AppSettings, ConversationService, MemorySecretStore, ProviderRegistry, loadAgentTree } from '@sfagents/core';
import { RemoteDesktop, WebServer, applyEmbedEdits, installerPattern, rewriteCsp } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent } from './helpers.js';

/** A stand-in MoonlightWeb: its health answer, a page, the files SF Agents changes, and a socket. */
function fakeMoonlight() {
  const seen: Array<{ url: string; host: string; origin?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: String(req.headers.host), origin: req.headers.origin });
    const headers = {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss://127.0.0.1; frame-ancestors 'none'",
      'Strict-Transport-Security': 'max-age=31536000',
    };
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      return res.end(JSON.stringify({ status: 'ok', version: '0.4.0', name: 'pc', debug: false, verbose: false }));
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', ...headers });
      return res.end('<!doctype html><script type="module" src="/js/app.js?v=1"></script>');
    }
    if (u.pathname === '/js/util/StreamResolution.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', ...headers });
      return res.end("export function devicePixelSize(win) {\n    return null;\n}\nconst made = virtualDisplaySize(c, dev, tv);\n");
    }
    if (u.pathname === '/js/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', ...headers });
      return res.end('// a different release: nothing SF Agents knows\n');
    }
    if (u.pathname === '/api/hosts') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      return res.end('{"hosts":[]}');
    }
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: `WS ${req.url}`, host: String(req.headers.host), origin: req.headers.origin });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  return { server, seen };
}

function req(base: string, pathname: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: body ? 'POST' : 'GET', headers: { Host: u.host, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}

describe('remote desktop helpers', () => {
  test('the framed page may be framed by SF Agents only, and its sockets go to SF Agents', () => {
    assert.equal(
      rewriteCsp("default-src 'self'; connect-src 'self' wss://localhost:443; frame-ancestors 'none'", 'pc.ts.net'),
      "default-src 'self'; connect-src 'self' ws://pc.ts.net wss://pc.ts.net; frame-ancestors 'self'",
    );
  });

  test('the edits apply only where they fit exactly once', () => {
    const sr = "export function devicePixelSize(win) {\n    return 1;\n}\nconst made = virtualDisplaySize(c, dev, tv);\n";
    const out = applyEmbedEdits('/js/util/StreamResolution.js', sr)!;
    assert.match(out, /^import \{ EMBED, embedPixelSize \} from '\.\.\/embed\.js';/);
    assert.match(out, /if \(EMBED && !win\) return embedPixelSize\(\);/);
    assert.match(out, /virtualDisplaySize\(EMBED \? \{ mode: 'device' \} : c, dev, tv\)/);
    assert.equal(applyEmbedEdits('/js/util/StreamResolution.js', 'export const x = 1;'), null, 'an unknown release is left alone');
    assert.equal(applyEmbedEdits('/js/other.js', 'x'), 'x');
  });

  test('installers per platform', () => {
    assert.ok(installerPattern('win32', 'x64')!.test('moonlightweb-installer-0.4.0-win-x64.exe'));
    assert.ok(!installerPattern('win32', 'x64')!.test('moonlightweb-installer-0.4.0-win-arm64.exe'));
    assert.ok(installerPattern('darwin', 'arm64')!.test('moonlightweb-0.4.0-macos-arm64.pkg'));
    assert.equal(installerPattern('darwin', 'x64'), null);
    assert.ok(installerPattern('linux', 'x64')!.test('moonlightweb-0.4.0-x86_64.AppImage'));
  });
});

describe('remote desktop through SF Agents', () => {
  test('finds MoonlightWeb, serves its page under /apps/remote/ changed for the sheet, and keeps per-device settings', async () => {
    const mw = fakeMoonlight();
    await new Promise<void>((r) => mw.server.listen(0, '127.0.0.1', r));
    const mwPort = (mw.server.address() as net.AddressInfo).port;
    const dir = makeTempDir();
    writeAgent(dir, baseAgent('main'));
    const tree = loadAgentTree(dir);
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const home = makeTempDir();
    const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(true) });
    const remote = new RemoteDesktop({ dir: path.join(home, 'remote'), knownPorts: [mwPort], candidates: [] });
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, registry, settings: new AppSettings(home), watchAgents: false, auth: false, remote });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      // Before MoonlightWeb is found, there is no app to serve.
      assert.equal((await req(base, '/apps/remote/')).status, 404);
      const info = await req(base, '/api/remote?find=1');
      assert.equal(info.json.status.state, 'ready');
      assert.equal(info.json.status.url, `http://127.0.0.1:${mwPort}`);
      assert.equal(info.json.status.managed, false);
      assert.equal(info.json.device, 'default');
      assert.deepEqual(info.json.settings, { scale: 1, displayScale: null });

      const page = await req(base, '/apps/remote/?embed=sfagents&client=abc');
      assert.equal(page.status, 200);
      assert.match(page.text, /js\/app\.js/);
      assert.equal(page.headers['x-frame-options'], undefined, 'SF Agents may frame it');
      assert.equal(page.headers['strict-transport-security'], undefined);
      assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'self'/);
      assert.match(String(page.headers['content-security-policy']), new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:\\d+ wss://`));
      // MoonlightWeb sees a request from this computer, to its own address.
      const first = mw.seen.find((s) => s.url.startsWith('/?embed'))!;
      assert.equal(first.host, `127.0.0.1:${mwPort}`);

      // The page's own absolute paths go to MoonlightWeb (its page is the referer)…
      const referer = { Referer: `${base}/apps/remote/?embed=sfagents` };
      const hosts = await req(base, '/api/hosts', { headers: referer });
      assert.deepEqual(hosts.json, { hosts: [] });
      // …the embed script is SF Agents' own…
      const embed = await req(base, '/js/embed.js', { headers: referer });
      assert.equal(embed.status, 200);
      assert.match(embed.text, /export const EMBED/);
      // …a known file is changed, an unknown one is passed on as it is.
      const sr = await req(base, '/js/util/StreamResolution.js?v=1', { headers: referer });
      assert.match(sr.text, /embedPixelSize/);
      const app = await req(base, '/js/app.js?v=1', { headers: referer });
      assert.equal(app.text, '// a different release: nothing SF Agents knows\n');
      // SF Agents' own API is still its own.
      assert.equal((await req(base, '/api/state')).status, 200);

      // Its signaling socket is routed to it, with an origin it accepts.
      const ws = await new Promise<string>((resolve, reject) => {
        const s = net.connect(Number(new URL(base).port), '127.0.0.1', () =>
          s.write(`GET /ws HTTP/1.1\r\nHost: ${new URL(base).host}\r\nOrigin: ${base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`),
        );
        let data = '';
        s.on('data', (d) => {
          data += d.toString();
          if (data.includes('\r\n\r\n')) {
            resolve(data.split('\r\n')[0]!);
            s.destroy();
          }
        });
        s.on('error', reject);
      });
      assert.match(ws, / 101 /);
      const wsSeen = mw.seen.find((s) => s.url === 'WS /ws')!;
      assert.equal(wsSeen.origin, `http://127.0.0.1:${mwPort}`, 'the origin matches the host MoonlightWeb sees');

      // Per-device settings.
      const set = await req(base, '/api/remote', { body: { action: 'settings', scale: 0.5, displayScale: 150 } });
      assert.deepEqual(set.json.settings, { scale: 0.5, displayScale: 150 });
      assert.equal((await req(base, '/api/remote', { body: { action: 'settings', scale: 3 } })).status, 400);
      assert.equal((await req(base, '/api/remote', { body: { action: 'settings', displayScale: 133 } })).status, 400);
      assert.deepEqual((await req(base, '/api/remote')).json.settings, { scale: 0.5, displayScale: 150 });
      assert.ok(fs.existsSync(path.join(home, 'remote', 'devices.json')));
      assert.equal((await req(base, '/api/remote', { body: { action: 'streaming' } })).status, 200);
      assert.equal((await req(base, '/api/remote', { body: { action: 'ended' } })).status, 200);
    } finally {
      await server.close();
      conversation.close();
      registry.close();
      mw.server.close();
    }
  });

  test('without MoonlightWeb the sheet offers to install it', async () => {
    const r = new RemoteDesktop({ dir: makeTempDir(), knownPorts: [1], candidates: [] });
    const s = await r.ensure();
    assert.equal(s.state, 'missing');
    assert.equal(s.canInstall, installerPattern() !== null);
    r.close();
  });
});
