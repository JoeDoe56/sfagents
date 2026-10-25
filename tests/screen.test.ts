import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppSettings, ConversationService, MemorySecretStore, ProviderRegistry, loadAgentTree } from '@sfagents/core';
import { ScreenMirror, WebServer, classifyAddress, streamConfig, transportChain, vdisplayTaskXml, winArg } from '@sfagents/web';
import { REPO_ROOT, baseAgent, makeTempDir, scriptedFactory, writeAgent } from './helpers.js';

const ctx = { kind: 'private' as const, serverHost: 'pc.local', serverPort: 443, signalingPort: 50001, streamRelayPort: 50002 };

describe('screen: stream configuration', () => {
  test('addresses are sorted as MoonlightWeb sorts them', () => {
    assert.equal(classifyAddress('127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('192.168.1.20'), 'private');
    assert.equal(classifyAddress('10.0.0.5'), 'private');
    assert.equal(classifyAddress('100.101.102.103'), 'tunnel');
    assert.equal(classifyAddress('8.8.8.8'), 'public');
  });

  test('the transport chain: data channel first, <video> only for H.264, wss last', () => {
    assert.deepEqual(transportChain({}, 'private', 'h264'), ['webrtc-dc-udp', 'webrtc-dc-tcp', 'webrtc-media-udp', 'webrtc-media-tcp', 'wss']);
    assert.deepEqual(transportChain({}, 'private', 'hevc'), ['webrtc-dc-udp', 'webrtc-dc-tcp', 'wss']);
    // A pinned rung comes first with its TCP sibling.
    assert.deepEqual(transportChain({ transport_mode: 'webrtc-media-udp' }, 'private', 'h264'), ['webrtc-media-udp', 'webrtc-media-tcp', 'webrtc-dc-udp', 'webrtc-dc-tcp', 'wss']);
    // Blocked UDP drops the UDP rungs for an internet browser only.
    assert.deepEqual(transportChain({ udp_blocked: true }, 'public', 'hevc'), ['webrtc-dc-tcp', 'wss']);
    assert.deepEqual(transportChain({ udp_blocked: true }, 'private', 'hevc'), ['webrtc-dc-udp', 'webrtc-dc-tcp', 'wss']);
  });

  test('the helper config carries the page settings and SF Agents paths', () => {
    const made = streamConfig({ appId: 1000, video_codec: 'h264', stream_height: 720, stream_aspect: '16:9', client_refresh_mhz: 59940, client_uniqueid: 'ABCDEF0123456789' }, ctx);
    assert.ok(!('error' in made));
    const { cfg } = made;
    assert.equal(cfg['appId'], 1000);
    assert.equal(cfg['codec'], 0);
    assert.equal(cfg['height'], 720);
    assert.equal(cfg['width'], 1280);
    assert.equal(cfg['fps'], 60);
    assert.equal(cfg['bitrateKbps'], 20000);
    assert.equal(cfg['internalTransport'], 'webrtc');
    assert.equal(cfg['virtualPrimary'], true);
    assert.equal(cfg['wsPath'], '/api/screen/ws');
    assert.equal(cfg['stunServer'], '');
    assert.equal(cfg['muteHostAudio'], true);
    assert.equal(cfg['signalingPort'], 50001);
    // Only an internet browser gets a STUN server.
    const pub = streamConfig({ appId: 1 }, { ...ctx, kind: 'public' });
    assert.ok(!('error' in pub) && pub.cfg['stunServer']);
  });

  test('a <video> rung streams H.264 whatever was asked', () => {
    const made = streamConfig({ appId: 1, video_codec: 'hevc', transport_mode: 'webrtc-media-udp' }, ctx);
    assert.ok(!('error' in made));
    assert.equal(made.cfg['internalTransport'], 'webrtc-media');
    assert.equal(made.cfg['codec'], 0);
    assert.equal(made.cfg['codecOverridden'], true);
  });

  test('a bad request is refused', () => {
    assert.deepEqual(streamConfig({}, ctx), { code: 400, error: 'Missing or invalid appId' });
    assert.equal((streamConfig({ appId: 1, transport_index: 9 }, ctx) as { code: number }).code, 502);
  });
});

describe('screen: Windows setup', () => {
  test('the virtual display task runs the installed helper with the highest rights, on demand', () => {
    const xml = vdisplayTaskXml('C:\\Program Files\\SF Agents\\Screen\\sfagents-screen.exe', 'PC\\caleb');
    assert.match(xml, /<UserId>PC\\caleb<\/UserId>/);
    assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
    assert.match(xml, /<Command>"C:\\Program Files\\SF Agents\\Screen\\sfagents-screen.exe"<\/Command>/);
    assert.match(xml, /<Arguments>--vdisplay-apply<\/Arguments>/);
    assert.doesNotMatch(xml, /<Triggers>/);
  });

  test('command-line arguments are quoted as Windows reads them', () => {
    assert.equal(winArg('plain'), 'plain');
    assert.equal(winArg(''), '""');
    assert.equal(winArg('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
    assert.equal(winArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
    assert.equal(winArg('say "hi"'), '"say \\"hi\\""');
  });
});

describe('screen: server', () => {
  async function start(exe?: string) {
    const dir = makeTempDir();
    writeAgent(dir, baseAgent('main'));
    const tree = loadAgentTree(dir);
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const home = makeTempDir();
    const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(true) });
    const screen = new ScreenMirror({ dir: path.join(home, 'screen'), exe, platform: 'linux', arch: 'x64' });
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, registry, settings: new AppSettings(home), auth: false, screen });
    const base = (await server.start()).replace(/\/$/, '');
    return {
      base,
      async stop() {
        await server.close();
        conversation.close();
        registry.close();
      },
    };
  }
  const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
  const post = (base: string, p: string, body: unknown = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });

  test('the stream page is served with its own policy', async () => {
    const s = await start();
    try {
      const page = await fetch(`${s.base}/screen/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy') ?? '', /'wasm-unsafe-eval'.*frame-ancestors 'self'/);
      assert.match(await page.text(), /screen-main\.js/);
      assert.equal((await fetch(`${s.base}/screen/js/screen-app.js`)).status, 200);
      assert.deepEqual(await json(fetch(`${s.base}/api/screen/health`)), { status: 'ok' });
    } finally {
      await s.stop();
    }
  });

  test('each device keeps its resolution, and a bad one is refused', async () => {
    const s = await start();
    try {
      assert.equal((await json(fetch(`${s.base}/api/screen`))).settings.resolution, 'auto');
      assert.equal((await post(s.base, '/api/screen/settings', { resolution: '720' })).status, 200);
      assert.equal((await json(fetch(`${s.base}/api/screen`))).settings.resolution, '720');
      assert.equal((await post(s.base, '/api/screen/settings', { resolution: '4k' })).status, 400);
    } finally {
      await s.stop();
    }
  });

  test('a stream starts through the helper, and its end is known', { skip: process.platform === 'win32' && 'the fake helper is a shell script' }, async () => {
    const dir = makeTempDir();
    const exe = path.join(dir, 'fake-screen');
    const log = path.join(dir, 'cfg.json');
    fs.writeFileSync(
      exe,
      `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
let first = true;
rl.on('line', (line) => {
  if (first) {
    first = false;
    require('node:fs').writeFileSync(${JSON.stringify(log)}, line);
    process.stdout.write(JSON.stringify({ event: 'response', code: 200, body: { status: 'streaming', signalingUrl: 'wss://x/api/screen/ws' } }) + '\\n');
  } else if (JSON.parse(line).cmd === 'quit') {
    process.stdout.write(JSON.stringify({ event: 'ended' }) + '\\n');
    process.exit(0);
  }
});
`,
      { mode: 0o755 },
    );
    const s = await start(exe);
    try {
      const res = await post(s.base, '/api/screen/start', { appId: 1000, video_codec: 'h264', stream_height: 720 });
      const body = await json(res);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.status, 'streaming');
      assert.equal(body.dual_supported, false);
      const cfg = JSON.parse(fs.readFileSync(log, 'utf8'));
      assert.equal(cfg.appId, 1000);
      assert.equal(cfg.clientKind, 'loopback');
      assert.equal((await json(fetch(`${s.base}/api/screen/stream-state?stream=${body.stream_id}`))).state, 'live');
      assert.equal((await post(s.base, '/api/screen/quit')).status, 200);
      assert.equal((await json(fetch(`${s.base}/api/screen/stream-state?stream=${body.stream_id}`))).state, 'ended');
    } finally {
      await s.stop();
    }
  });

  test('the vendored page is what the script makes of MoonlightWeb', () => {
    const up = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web/public/screen/UPSTREAM.json'), 'utf8'));
    const helper = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web/native/screen/UPSTREAM.json'), 'utf8'));
    assert.equal(up.commit, helper.commit);
    // SF Agents' own files are copied as they are.
    for (const rel of [...up.replaced, ...up.own]) {
      assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'web/public/screen', rel), 'utf8'), fs.readFileSync(path.join(REPO_ROOT, 'web/screen-page', rel), 'utf8'), rel);
    }
  });
});
