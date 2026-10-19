import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ConversationService, loadAgentTree } from '@sfagents/core';
import { WebServer, Up2kStore, up2kChunkSize, chunkHash, describeCall } from '@sfagents/web';
import { baseAgent, CLI_ENTRY, REPO_ROOT, lastToolContent, makeTempDir, scriptedFactory, writeJson, type Script } from './helpers.js';

function project(agent: Record<string, unknown> = {}) {
  const dir = makeTempDir('sfagents-web-');
  writeJson(path.join(dir, 'agent.json'), { ...baseAgent('main'), ...agent });
  return dir;
}

async function startServer(script: Script, agent: Record<string, unknown> = {}, extra: { maxUploadBytes?: number } = {}) {
  const dir = project(agent);
  const tree = loadAgentTree(path.join(dir, 'agent.json'));
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
  const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(script).factory, ...extra });
  const url = await server.start();
  const base = url.replace(/\/$/, '');
  return {
    dir,
    conversation,
    server,
    base,
    async stop() {
      await server.close();
      conversation.close();
    },
  };
}

function request(
  base: string,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: options.method ?? 'GET', headers: { Host: u.host, ...(options.headers ?? {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function postJson(base: string, pathname: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await request(base, pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: JSON.parse(r.body.toString() || '{}') as Record<string, unknown> };
}

/** Collects Server-Sent Events until `until` returns true. */
function events(base: string) {
  const received: Array<{ event: string; data: Record<string, unknown> }> = [];
  const waiters: Array<() => void> = [];
  const u = new URL(`${base}/api/events`);
  const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: u.host } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) received.push({ event, data: JSON.parse(data) });
        waiters.splice(0).forEach((w) => w());
      }
    });
  });
  return {
    received,
    async wait(pred: (e: { event: string; data: Record<string, unknown> }) => boolean, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = received.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`timed out; got ${received.map((r) => r.event).join(', ')}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
    close: () => req.destroy(),
  };
}

/** Uploads a buffer through the up2k protocol; returns the attachment. */
async function upload(base: string, name: string, data: Buffer, options: { skip?: (i: number) => boolean } = {}) {
  const chunkSize = up2kChunkSize(data.length);
  const chunks: Buffer[] = [];
  for (let o = 0; o < data.length; o += chunkSize) chunks.push(data.subarray(o, o + chunkSize));
  const hashes = chunks.map(chunkHash);
  const hs = await postJson(base, '/api/up2k/handshake', { name, size: data.length, mime: 'application/octet-stream', hashes });
  assert.equal(hs.status, 200, JSON.stringify(hs.json));
  const needed = new Set(hs.json['needed'] as string[]);
  // Upload needed chunks in reverse order, in parallel.
  const jobs = chunks.map((c, i) => [c, i] as const).filter(([, i]) => needed.has(hashes[i]!) && !options.skip?.(i)).reverse();
  await Promise.all(
    jobs.map(async ([c, i]) => {
      const r = await request(base, '/api/up2k/chunk', { method: 'POST', headers: { 'X-Up2k-Wark': String(hs.json['wark']), 'X-Up2k-Hash': hashes[i]!, 'Content-Type': 'application/octet-stream', 'Content-Length': String(c.length) }, body: c });
      assert.equal(r.status, 200, r.body.toString());
    }),
  );
  const final = await postJson(base, '/api/up2k/handshake', { name, size: data.length, mime: 'application/octet-stream', hashes });
  return { first: hs.json, final: final.json, hashes, chunkSize };
}

describe('up2k uploads', () => {
  test('chunk sizes follow the up2k rule', () => {
    assert.equal(up2kChunkSize(0), 1024 * 1024);
    assert.equal(up2kChunkSize(256 * 1024 * 1024), 1024 * 1024);
    assert.equal(up2kChunkSize(256 * 1024 * 1024 + 1), 1.5 * 1024 * 1024);
    const big = up2kChunkSize(10 * 1024 ** 3);
    assert.ok(Math.ceil((10 * 1024 ** 3) / big) <= 256 || big >= 32 * 1024 * 1024);
    assert.equal(chunkHash(Buffer.from('abc')).length, 44);
  });

  test('parallel out-of-order chunks, verification, resume after restart and deduplication', async () => {
    const s = await startServer(() => ({ text: 'ok' }));
    const data = randomBytes(3 * 1024 * 1024 + 12345);
    try {
      // An interrupted upload: only the even chunks arrive.
      const partial = await upload(s.base, 'data.bin', data, { skip: (i) => i % 2 === 1 });
      assert.equal(partial.final['done'], false);
      assert.equal((partial.final['needed'] as string[]).length, 2);
      // A chunk whose bytes do not match its hash is refused.
      const bad = await request(s.base, '/api/up2k/chunk', { method: 'POST', headers: { 'X-Up2k-Wark': String(partial.first['wark']), 'X-Up2k-Hash': partial.hashes[1]!, 'Content-Type': 'application/octet-stream' }, body: randomBytes(partial.chunkSize) });
      assert.equal(bad.status, 422);
      // A body of the wrong length is refused.
      const short = await request(s.base, '/api/up2k/chunk', { method: 'POST', headers: { 'X-Up2k-Wark': String(partial.first['wark']), 'X-Up2k-Hash': partial.hashes[1]!, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(10) });
      assert.equal(short.status, 400);
      // Unknown uploads and non-consecutive stitching are refused.
      const unknown = await request(s.base, '/api/up2k/chunk', { method: 'POST', headers: { 'X-Up2k-Wark': 'A'.repeat(44), 'X-Up2k-Hash': partial.hashes[1]!, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1) });
      assert.equal(unknown.status, 404);
      const gap = await request(s.base, '/api/up2k/chunk', { method: 'POST', headers: { 'X-Up2k-Wark': String(partial.first['wark']), 'X-Up2k-Hash': `${partial.hashes[1]},${partial.hashes[3]}`, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1) });
      assert.equal(gap.status, 400);
    } finally {
      await s.stop();
    }
    // Restart on the same state directory: the upload resumes with only the missing chunks.
    const tree = loadAgentTree(path.join(s.dir, 'agent.json'));
    const conversation = ConversationService.open(path.join(s.dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const resumed = await upload(base, 'data.bin', data);
      assert.equal((resumed.first['needed'] as string[]).length, 2, 'only the missing chunks are requested after a restart');
      assert.equal(resumed.final['done'], true);
      const attachment = resumed.final['attachment'] as { id: string; path: string; size: number };
      assert.equal(attachment.size, data.length);
      assert.ok(fs.readFileSync(path.join(s.dir, '.sfagents', attachment.path)).equals(data), 'reassembled bytes are identical');
      // Deduplication: the same content needs no chunks at all, under any name.
      const again = await postJson(base, '/api/up2k/handshake', { name: 'copy.bin', size: data.length, hashes: resumed.hashes });
      assert.equal(again.json['done'], true);
      assert.deepEqual(again.json['needed'], []);
      // Invalid handshakes.
      assert.equal((await postJson(base, '/api/up2k/handshake', { name: 'x', size: 10, hashes: [] })).status, 400);
      assert.equal((await postJson(base, '/api/up2k/handshake', { name: 'x', size: -1, hashes: [] })).status, 400);
      assert.equal((await postJson(base, '/api/up2k/handshake', { name: '', size: 0, hashes: [] })).status, 400);
      assert.equal((await postJson(base, '/api/up2k/handshake', { name: 'x', size: 3, hashes: ['short'] })).status, 400);
    } finally {
      await server.close();
      conversation.close();
    }
  });

  test('a zero-byte file and the upload size limit', async () => {
    const s = await startServer(() => ({ text: 'ok' }), {}, { maxUploadBytes: 1000 });
    try {
      const empty = await postJson(s.base, '/api/up2k/handshake', { name: 'empty.txt', size: 0, hashes: [] });
      assert.equal(empty.json['done'], true);
      const tooBig = await postJson(s.base, '/api/up2k/handshake', { name: 'big', size: 2000, hashes: [chunkHash(Buffer.alloc(2000))] });
      assert.equal(tooBig.status, 413);
    } finally {
      await s.stop();
    }
  });

  test('the browser client hashes and sizes chunks exactly like the server', async () => {
    const pub = path.join(REPO_ROOT, 'web', 'public');
    const { sha512 } = (await import(pathToFileURL(path.join(pub, 'sha512.js')).href)) as { sha512: (d: Uint8Array) => Uint8Array };
    const client = (await import(pathToFileURL(path.join(pub, 'up2k.js')).href)) as { up2kChunkSize: (n: number) => number };
    for (const n of [0, 1, 111, 112, 127, 128, 129, 1000, 100_003]) {
      const buf = randomBytes(n);
      assert.equal(Buffer.from(sha512(buf)).toString('hex'), createHash('sha512').update(buf).digest('hex'), `sha512 of ${n} bytes`);
    }
    for (const size of [0, 1, 5e6, 268435456, 268435457, 1e9, 5e10, 3e12]) assert.equal(client.up2kChunkSize(size), up2kChunkSize(size), String(size));
  });

  test('the store keeps state across instances', async () => {
    const dir = makeTempDir();
    const a = new Up2kStore(dir);
    a.init();
    const salt = fs.readFileSync(path.join(dir, 'uploads', '.up2k', 'salt'), 'utf8');
    const b = new Up2kStore(dir);
    b.init();
    assert.equal(fs.readFileSync(path.join(dir, 'uploads', '.up2k', 'salt'), 'utf8'), salt);
    assert.equal(a.wark(5, ['x']), b.wark(5, ['x']));
  });
});

describe('web server', () => {
  test('serves the client with a CSP and refuses foreign hosts, origins and non-JSON posts', async () => {
    const s = await startServer(() => ({ text: 'ok' }));
    try {
      const index = await request(s.base, '/');
      assert.equal(index.status, 200);
      assert.match(String(index.headers['content-security-policy']), /default-src 'self'/);
      assert.match(index.body.toString(), /<textarea class="input above" id="input"/);
      const vendor = await request(s.base, '/vendor/sfgl/src/index.js');
      assert.equal(vendor.status, 200);
      assert.equal((await request(s.base, '/../package.json')).status, 404);
      // A web app manifest whose icons all exist.
      assert.match(index.body.toString(), /<link rel="manifest" href="manifest.webmanifest">/);
      const manifest = await request(s.base, '/manifest.webmanifest');
      assert.equal(manifest.status, 200);
      assert.match(String(manifest.headers['content-type']), /^application\/manifest\+json/);
      const m = JSON.parse(manifest.body.toString()) as { display: string; start_url: string; icons: Array<{ src: string; sizes: string; purpose: string }> };
      assert.equal(m.display, 'standalone');
      assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
      for (const icon of m.icons) assert.equal((await request(s.base, `/${icon.src}`)).status, 200, icon.src);
      assert.equal((await request(s.base, '/icons/apple-touch-icon.png')).status, 200);
      assert.equal((await request(s.base, '/api/state', { headers: { Host: 'evil.example:80' } })).status, 421);
      const cross = await postJson(s.base, '/api/messages', { text: 'hi' }, { Origin: 'http://evil.example' });
      assert.equal(cross.status, 403);
      const plain = await request(s.base, '/api/messages', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"text":"hi"}' });
      assert.equal(plain.status, 415);
      assert.equal(s.conversation.state.messages.length, 0, 'nothing was sent');
    } finally {
      await s.stop();
    }
  });

  test('a message streams over SSE, creates an artifact, and the artifact can be pinned and served sandboxed', async () => {
    const script: Script = (req, call) => {
      if (call === 0) return { delayMs: 300, text: 'Working on it. ', toolCalls: [{ name: 'create_artifact', args: { title: 'Page', filename: 'index.html', content: '<h1>hi</h1>' } }] };
      return { text: `Done (${lastToolContent(req)?.slice(0, 20)})` };
    };
    const s = await startServer(script);
    const ev = events(s.base);
    try {
      await ev.wait((e) => e.event === 'state');
      const sent = await postJson(s.base, '/api/messages', { text: 'make a page' });
      assert.equal(sent.status, 202);
      const busy = await postJson(s.base, '/api/messages', { text: 'again' });
      assert.equal(busy.status, 409);
      await ev.wait((e) => e.event === 'user');
      await ev.wait((e) => e.event === 'delta');
      await ev.wait((e) => e.event === 'activity');
      const arts = await ev.wait((e) => e.event === 'artifacts');
      const list = arts.data['artifacts'] as Array<{ id: string; type: string; url: string; pinned: boolean }>;
      assert.equal(list.length, 1);
      assert.equal(list[0]!.type, 'html');
      const end = await ev.wait((e) => e.event === 'run_end');
      assert.equal(end.data['status'], 'GOAL');
      const items = end.data['items'] as Array<{ kind: string; text: string }>;
      assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'activity', 'assistant']);
      assert.equal(items[2]!.text, 'Created “Page”');

      const raw = await request(s.base, list[0]!.url);
      assert.equal(raw.status, 200);
      assert.match(String(raw.headers['content-security-policy']), /^sandbox allow-scripts/);
      assert.equal(raw.headers['x-content-type-options'], 'nosniff');
      assert.equal(raw.body.toString(), '<h1>hi</h1>');

      assert.equal((await postJson(s.base, `/api/artifacts/${list[0]!.id}/pin`, { pinned: true })).status, 200);
      const pinned = await ev.wait((e) => e.event === 'artifacts' && (e.data['artifacts'] as Array<{ pinned: boolean }>)[0]?.pinned === true);
      assert.ok(pinned);
      assert.equal((await postJson(s.base, '/api/artifacts/a999/pin', { pinned: true })).status, 404);
      assert.equal((await request(s.base, '/api/artifacts/a999/raw')).status, 404);
    } finally {
      ev.close();
      await s.stop();
    }
  });

  test('attachments sent with a message reach the model and are served back', async () => {
    let seen: unknown;
    const s = await startServer((req) => {
      seen = req.messages[req.messages.length - 1];
      return { text: 'got it' };
    });
    const ev = events(s.base);
    try {
      await ev.wait((e) => e.event === 'state');
      const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
      const hs = await postJson(s.base, '/api/up2k/handshake', { name: 'dot.png', size: png.length, mime: 'image/png', hashes: [chunkHash(png)] });
      const r = await request(s.base, '/api/up2k/chunk', { method: 'POST', headers: { 'X-Up2k-Wark': String(hs.json['wark']), 'X-Up2k-Hash': chunkHash(png), 'Content-Type': 'application/octet-stream' }, body: png });
      const attachment = (JSON.parse(r.body.toString()) as { attachment: { id: string; url: string } }).attachment;
      assert.ok(attachment.id);
      assert.equal((await postJson(s.base, '/api/messages', { text: 'look', attachments: ['u_nope'] })).status, 400);
      assert.equal((await postJson(s.base, '/api/messages', { text: 'look', attachments: [attachment.id] })).status, 202);
      await ev.wait((e) => e.event === 'run_end');
      const content = (seen as { content: Array<{ type: string; image_url?: { url: string } }> }).content;
      assert.equal(content[1]!.image_url!.url, `data:image/png;base64,${png.toString('base64')}`);
      const served = await request(s.base, attachment.url);
      assert.equal(served.status, 200);
      assert.equal(served.headers['content-type'], 'image/png');
      assert.ok(served.body.equals(png));
    } finally {
      ev.close();
      await s.stop();
    }
  });

  test('approvals are asked in the browser; denial and cancellation work', async () => {
    const s = await startServer(
      (req, call) => {
        if (call === 0) return { toolCalls: [{ name: 'shell', args: { command: 'echo approved-run' } }] };
        if (call === 1) return { text: `result: ${lastToolContent(req)}` };
        if (call === 2) return { toolCalls: [{ name: 'shell', args: { command: 'echo nope' } }] };
        if (call === 3) return { text: `second: ${lastToolContent(req)}` };
        return { text: 'slow', delayMs: 5000 };
      },
      { tools: { allow: ['shell'] } },
    );
    const ev = events(s.base);
    try {
      await ev.wait((e) => e.event === 'state');
      await postJson(s.base, '/api/messages', { text: 'run it' });
      const ask = await ev.wait((e) => e.event === 'approval');
      const approval = ask.data['approval'] as { id: string; detail: string; tool: string };
      assert.equal(approval.tool, 'shell');
      assert.match(approval.detail, /echo approved-run/);
      assert.equal((await postJson(s.base, `/api/approvals/${approval.id}`, { decision: 'maybe' })).status, 400);
      assert.equal((await postJson(s.base, `/api/approvals/${approval.id}`, { decision: 'allow_once' })).status, 200);
      const end1 = await ev.wait((e) => e.event === 'run_end');
      assert.match(JSON.stringify(end1.data['items']), /approved-run/);

      await postJson(s.base, '/api/messages', { text: 'again' });
      const ask2 = await ev.wait((e) => e.event === 'approval' && (e.data['approval'] as { id: string }).id !== approval.id);
      await postJson(s.base, `/api/approvals/${(ask2.data['approval'] as { id: string }).id}`, { decision: 'deny' });
      await ev.wait((e) => e.event === 'run_end' && e !== end1);

      await postJson(s.base, '/api/messages', { text: 'slow one' });
      await ev.wait((e) => e.event === 'run_start' && ev.received.filter((x) => x.event === 'run_start').length === 3);
      await postJson(s.base, '/api/cancel', {});
      const end3 = await ev.wait((e) => e.event === 'run_end' && e.data['status'] === 'CANCELLED');
      assert.ok(end3);
      const items = end3.data['items'] as Array<{ kind: string; text: string; status?: string }>;
      assert.ok(items.some((i) => i.kind === 'activity' && i.status === 'denied'));
      assert.ok(items.some((i) => i.kind === 'notice' && i.text === 'Stopped'));
    } finally {
      ev.close();
      await s.stop();
    }
  });

  test('tool calls are described for people', () => {
    assert.equal(describeCall('read_file', JSON.stringify({ file_path: 'src/app.ts' })), 'Read src/app.ts');
    assert.equal(describeCall('shell', JSON.stringify({ command: 'npm test' })), 'Ran `npm test`');
    assert.equal(describeCall('mcp__local__echo', '{}'), 'Used echo (local)');
    assert.equal(describeCall('weird', 'not json'), 'Used weird');
  });
});

describe('sfagents web (CLI)', () => {
  test('starts on the requested port, serves the page, and stops cleanly on SIGINT', async () => {
    const dir = project();
    const child = spawn(process.execPath, [CLI_ENTRY, 'web', '--port', '0', '--config', dir], { env: { ...process.env, OPENROUTER_API_KEY: 'test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const deadline = Date.now() + 15000;
    while (!/http:\/\/127\.0\.0\.1:(\d+)\//.test(out)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no URL printed: ${out} ${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const base = /(http:\/\/127\.0\.0\.1:\d+)\//.exec(out)![1]!;
    const page = await request(base, '/');
    assert.equal(page.status, 200);
    assert.ok(fs.existsSync(path.join(dir, '.sfagents', 'conversation.lock')), 'the web server holds the conversation lock');
    if (process.platform === 'win32') {
      // Windows has no SIGINT for child processes; kill() terminates it abruptly.
      child.kill();
      await new Promise((resolve) => child.on('exit', resolve));
      return;
    }
    child.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    assert.equal(code, 0, err);
    assert.equal(fs.existsSync(path.join(dir, '.sfagents', 'conversation.lock')), false, 'lock released');
  });

  test('rejects a bad port and --ephemeral', async () => {
    const dir = project();
    const { runCli } = await import('./helpers.js');
    const bad = await runCli(['web', '--port', 'abc', '--config', dir], { env: { OPENROUTER_API_KEY: 'k' } });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--port must be a number/);
    const eph = await runCli(['web', '--ephemeral', '--config', dir], { env: { OPENROUTER_API_KEY: 'k' } });
    assert.equal(eph.code, 2);
  });
});

