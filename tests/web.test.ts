import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ConversationService, MemorySecretStore, ProviderRegistry, ensureProject, loadAgentTree } from '@sfagents/core';
import { WebServer, Up2kStore, up2kChunkSize, chunkHash, describeCall, parsePublicOrigin } from '@sfagents/web';
import { baseAgent, CLI_ENTRY, REPO_ROOT, lastToolContent, makeTempDir, scriptedFactory, useAnySandbox, writeJson, type Script, writeAgent } from './helpers.js';

await useAnySandbox();

function project(agent: Record<string, unknown> = {}) {
  const dir = makeTempDir('sfagents-web-');
  writeAgent(dir, { ...baseAgent('main'), ...agent });
  return dir;
}

async function startServer(script: Script, agent: Record<string, unknown> = {}, extra: { maxUploadBytes?: number; publicOrigin?: string } = {}) {
  const dir = project(agent);
  const tree = loadAgentTree(dir);
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
  const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(script).factory, watchAgents: false, auth: false, ...extra });
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
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, auth: false });
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
  test('accepts only the configured reverse-proxy host and exact browser origin', async () => {
    const origin = 'https://llms.example.ts.net';
    const s = await startServer(() => ({ text: 'ok' }), {}, { publicOrigin: origin });
    const headers = { Host: new URL(origin).host, Origin: origin };
    try {
      assert.equal((await request(s.base, '/api/state', { headers })).status, 200);
      assert.equal((await postJson(s.base, '/api/cancel', {}, headers)).status, 200);
      assert.equal((await request(s.base, '/api/state')).status, 200, 'loopback still works');
      for (const Origin of ['https://evil.example', 'http://llms.example.ts.net', 'null']) {
        assert.equal((await postJson(s.base, '/api/cancel', {}, { ...headers, Origin })).status, 403);
      }
      assert.equal((await request(s.base, '/', { headers: { Host: 'llms.example.ts.net:1234' } })).status, 421);
      assert.equal((await request(s.base, '/', { headers: { Host: 'evil.example', 'X-Forwarded-Host': headers.Host } })).status, 421);
    } finally {
      await s.stop();
    }
  });

  test('validates external origins without allowing URL paths or credentials', () => {
    assert.equal(parsePublicOrigin('https://EXAMPLE.com:443/'), 'https://example.com');
    for (const value of ['no-url', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#fragment']) {
      assert.throws(() => parsePublicOrigin(value), /--public-origin/);
    }
  });

  test('serves the client with a CSP and refuses foreign hosts, origins and non-JSON posts', async () => {
    const s = await startServer(() => ({ text: 'ok' }));
    try {
      const index = await request(s.base, '/');
      assert.equal(index.status, 200);
      assert.match(String(index.headers['content-security-policy']), /default-src 'self'/);
      assert.match(index.body.toString(), /<script type="module" src="app.js">/);
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
      if (call === 0) return { delayMs: 300, text: 'Working on it. ', toolCalls: [{ name: 'create_artifact', args: { title: 'Page', path: 'index.html', content: '<h1>hi</h1>' } }] };
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

  test('inline replies join a thread, tell the model what they answer, and reactions are kept', async () => {
    let seen: unknown;
    const s = await startServer((req) => {
      seen = req.messages[req.messages.length - 1];
      return { text: 'answer' };
    });
    const ev = events(s.base);
    try {
      await ev.wait((e) => e.event === 'state');
      assert.equal((await postJson(s.base, '/api/messages', { text: 'first question' })).status, 202);
      const end1 = await ev.wait((e) => e.event === 'run_end');
      const items1 = end1.data['items'] as Array<{ kind: string; id: string; replyTo?: string }>;
      const root = items1.find((i) => i.kind === 'user')!.id;
      const answer = items1.find((i) => i.kind === 'assistant')!.id;

      assert.equal((await postJson(s.base, '/api/messages', { text: 'about that', replyTo: 'm999' })).status, 400);
      ev.received.length = 0;
      // A reply starts a thread on the message it answers; the agent's answer to it joins that thread.
      assert.equal((await postJson(s.base, '/api/messages', { text: 'about that', replyTo: answer })).status, 202);
      const start = await ev.wait((e) => e.event === 'run_start');
      assert.equal(start.data['replyTo'], answer);
      const end2 = await ev.wait((e) => e.event === 'run_end');
      const items2 = end2.data['items'] as Array<{ kind: string; id: string; text: string; replyTo?: string }>;
      const reply = items2.find((i) => i.kind === 'user' && i.text === 'about that')!;
      assert.equal(reply.replyTo, answer);
      assert.equal(items2[items2.length - 1]!.replyTo, answer);
      assert.equal(items2.find((i) => i.text === 'first question')!.replyTo, undefined);
      assert.match((seen as { content: string }).content, /^\[Inline reply to this earlier message: "answer"\]\n\nabout that$/);
      // A reply to a reply stays in the same thread.
      ev.received.length = 0;
      assert.equal((await postJson(s.base, '/api/messages', { text: 'and more', replyTo: reply.id })).status, 202);
      const end3 = await ev.wait((e) => e.event === 'run_end');
      const items3 = end3.data['items'] as Array<{ kind: string; text: string; replyTo?: string }>;
      assert.equal(items3.find((i) => i.text === 'and more')!.replyTo, answer);
      // It survives a reload of the conversation.
      assert.match(fs.readFileSync(path.join(s.dir, '.sfagents', 'conversation.md'), 'utf8'), /"replyTo":"m\d+"/);

      assert.equal((await postJson(s.base, '/api/reactions', { id: root, emoji: 'hello' })).status, 400);
      assert.equal((await postJson(s.base, '/api/reactions', { id: 'm999', emoji: '👍' })).status, 400);
      const set = await postJson(s.base, '/api/reactions', { id: root, emoji: '❤️' });
      assert.equal(set.status, 200);
      assert.deepEqual(set.json['reactions'], { [root]: '❤️' });
      await ev.wait((e) => e.event === 'reactions');
      const state = JSON.parse((await request(s.base, '/api/state')).body.toString()) as { reactions: Record<string, string> };
      assert.equal(state.reactions[root], '❤️');
      assert.deepEqual((await postJson(s.base, '/api/reactions', { id: root, emoji: null })).json['reactions'], {});
      assert.equal((await postJson(s.base, '/api/reactions', { id: answer, emoji: '1️⃣' })).status, 200);
      assert.equal((await postJson(s.base, '/api/reactions', { id: answer, emoji: '🏳️‍🌈' })).status, 200);
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
      { tools: { allow: ['shell'], ask: true } },
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

  test('the topic index follows the sections the model creates', async () => {
    const s = await startServer((req, call) => {
      if (call === 0) return { toolCalls: [{ name: 'add_section', args: { title: 'Kiln schedule', messages: ['current_exchange'] } }] };
      if (call === 1) return { text: 'Filed under Kiln schedule.' };
      if (call === 2) return { toolCalls: [{ name: 'add_section', args: { title: 'Cone 6 glazes', parent: 's1', messages: ['current_exchange'] } }] };
      return { text: 'ok' };
    });
    const ev = events(s.base);
    try {
      const first = await ev.wait((e) => e.event === 'state');
      assert.deepEqual(first.data['sections'], []);
      await postJson(s.base, '/api/messages', { text: 'When should I fire the kiln?' });
      const sec = await ev.wait((e) => e.event === 'sections');
      const list = sec.data['sections'] as Array<{ id: string; title: string; depth: number; first: { id: string } }>;
      assert.equal(list.length, 1);
      assert.equal(list[0]!.title, 'Kiln schedule');
      const userId = (await ev.wait((e) => e.event === 'user')).data['item'] as { id: string };
      assert.equal(list[0]!.first.id, userId.id, 'a jump lands on the first message of the section');
      await ev.wait((e) => e.event === 'run_end');
      await postJson(s.base, '/api/messages', { text: 'Which glazes at cone 6?' });
      const end = await ev.wait((e) => e.event === 'run_end' && (e.data['sections'] as unknown[]).length === 2);
      const after = end.data['sections'] as Array<{ title: string; depth: number }>;
      assert.deepEqual(after.map((x) => [x.title, x.depth]), [['Kiln schedule', 0], ['Cone 6 glazes', 1]]);
      const state = JSON.parse((await request(s.base, '/api/state')).body.toString()) as { sections: unknown[] };
      assert.equal(state.sections.length, 2);
    } finally {
      ev.close();
      await s.stop();
    }
  });

  test('the resource monitor reads the machine through /api/system', async () => {
    const s = await startServer(() => ({ text: 'unused' }));
    try {
      const r = await request(s.base, '/api/system');
      assert.equal(r.status, 200);
      const snap = JSON.parse(r.body.toString());
      assert.equal(typeof snap.host, 'string');
      assert.ok(Number.isInteger(snap.cpu.threads) && snap.cpu.threads >= 1);
      assert.ok(snap.cpu.cores === null || (Number.isInteger(snap.cpu.cores) && snap.cpu.cores >= 1 && snap.cpu.cores <= snap.cpu.threads));
      assert.ok(snap.memory.total > 0 && snap.memory.used >= 0);
      assert.ok(snap.uptime.system > 0 && snap.uptime.sfagents >= 0);
      assert.ok(Array.isArray(snap.drives));
      for (const d of snap.drives) assert.ok(d.total >= d.used && d.used >= 0, JSON.stringify(d));
      // Other sites cannot read it (DNS rebinding).
      assert.equal((await request(s.base, '/api/system', { headers: { Host: 'evil.example:80' } })).status, 421);
    } finally {
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
    const child = spawn(process.execPath, [CLI_ENTRY, 'web', '--port', '0', '--config', dir], { env: { ...process.env, OPENROUTER_API_KEY: 'test-key', SFAGENTS_WEB_NO_LOGIN: '1', SFAGENTS_NO_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  test('rejects a bad port, --lhm (sensors are always built in) and --ephemeral', async () => {
    const dir = project();
    const { runCli } = await import('./helpers.js');
    const bad = await runCli(['web', '--port', 'abc', '--config', dir], { env: { OPENROUTER_API_KEY: 'k' } });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--port must be a number/);
    const badOrigin = await runCli(['web', '--public-origin', 'https://example.com/path', '--config', dir], { env: { OPENROUTER_API_KEY: 'k' } });
    assert.equal(badOrigin.code, 2);
    assert.match(badOrigin.stderr, /--public-origin/);
    assert.equal(fs.existsSync(path.join(dir, '.sfagents', 'conversation.lock')), false);
    const eph = await runCli(['web', '--ephemeral', '--config', dir], { env: { OPENROUTER_API_KEY: 'k' } });
    assert.equal(eph.code, 2);
    const lhm = await runCli(['web', '--lhm', 'http://127.0.0.1:8085', '--config', dir], { env: { OPENROUTER_API_KEY: 'k' } });
    assert.equal(lhm.code, 2);
    assert.match(lhm.stderr, /--lhm/);
  });
});


describe('agent settings and context', () => {
  test('a new project starts with no provider and flags broken files; an added provider becomes the account', async () => {
    const dir = makeTempDir('sfagents-web-');
    ensureProject(dir);
    fs.writeFileSync(path.join(dir, 'agents', 'broken.json'), '{');
    fs.writeFileSync(path.join(dir, 'mcp.json'), 'not json');
    const tree = loadAgentTree(dir, { fallback: true });
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const registry = new ProviderRegistry({ dir: makeTempDir(), secrets: new MemorySecretStore() });
    const server = new WebServer({ tree, conversation, port: 0, registry, watchAgents: false, auth: false });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      let info = JSON.parse((await request(base, '/api/agent')).body.toString());
      assert.equal(info.id, 'main');
      assert.equal(info.account, '');
      assert.deepEqual(info.accounts, []);
      const state = JSON.parse((await request(base, '/api/state')).body.toString()) as { notices: Array<string | { text: string; level: string }> };
      const texts = state.notices.map((n) => (typeof n === 'string' ? n : n.text));
      assert.ok(texts.some((t) => /^broken\.json was skipped: invalid JSON/.test(t)), JSON.stringify(texts));
      assert.ok(texts.some((t) => /mcp\.json could not be used/.test(t)), JSON.stringify(texts));
      for (const p of ['/api/agent/usage', '/api/agent/context']) assert.equal((await request(base, p, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200, p);
      await registry.add({ name: 'Claude', kind: 'anthropic', secret: { token: 't' } });
      await registry.add({ name: 'OpenRouter', kind: 'openrouter', secret: { apiKey: 'k' } });
      info = JSON.parse((await request(base, '/api/agent')).body.toString());
      assert.equal(info.account, 'Claude');
      assert.deepEqual(info.accounts.map((a: { name: string; model: string }) => [a.name, a.model]), [['Claude', 'claude-sonnet-5-5'], ['OpenRouter', 'anthropic/claude-sonnet-5.5']]);
      const set = await postJson(base, '/api/agent', { account: 'OpenRouter' });
      assert.equal(set.status, 200);
      assert.equal(set.json['account'], 'OpenRouter');
    } finally {
      await server.close();
      conversation.close();
    }
  });

  test('reasoning effort: read, change, persist, and sent with requests', async () => {
    const seen: Array<string | undefined> = [];
    const s = await startServer((req) => {
      seen.push(req.reasoning);
      return { text: 'ok' };
    }, { reasoning: 'low' });
    const ev = events(s.base);
    try {
      const get = await request(s.base, '/api/agent');
      const info = JSON.parse(get.body.toString());
      assert.equal(info.reasoning, 'low');
      assert.deepEqual(info.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.equal((await postJson(s.base, '/api/agent', { reasoning: 'ultra' })).status, 400);
      const set = await postJson(s.base, '/api/agent', { reasoning: 'xhigh' });
      assert.equal(set.status, 200);
      assert.equal(set.json['reasoning'], 'xhigh');
      assert.equal(set.json['configuredReasoning'], 'low');
      await ev.wait((e) => e.event === 'agent' && e.data['reasoning'] === 'xhigh');
      assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, '.sfagents', 'web-agent.json'), 'utf8')).efforts.main, 'xhigh');
      await ev.wait((e) => e.event === 'state');
      assert.equal((await postJson(s.base, '/api/messages', { text: 'think hard' })).status, 202);
      await ev.wait((e) => e.event === 'run_end');
      assert.equal(seen.at(-1), 'xhigh');
      // Back to the agent's own setting.
      const cleared = await postJson(s.base, '/api/agent', { reasoning: null });
      assert.equal(cleared.json['reasoning'], 'low');
    } finally {
      ev.close();
      await s.stop();
    }
  });

  test('context breakdown: parts add up, tools are listed, a fresh context empties the messages', async () => {
    const s = await startServer(() => ({ text: 'An answer with a few words in it.' }), { context: { maxInputTokens: 20000 } });
    const ev = events(s.base);
    try {
      await ev.wait((e) => e.event === 'state');
      await postJson(s.base, '/api/messages', { text: 'hello there' });
      await ev.wait((e) => e.event === 'run_end');
      const r = await request(s.base, '/api/agent/context', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(r.status, 200);
      const c = JSON.parse(r.body.toString());
      assert.equal(c.budget, 20000);
      assert.equal(c.reserve, 5000);
      const sum = c.categories.reduce((a: number, x: { tokens: number }) => a + x.tokens, 0);
      assert.equal(c.used, sum);
      assert.equal(c.free, c.budget - c.reserve - c.used);
      const byId = Object.fromEntries(c.categories.map((x: { id: string }) => [x.id, x]));
      assert.ok(byId.system.tokens > 0);
      assert.ok(byId.messages.tokens > 0);
      assert.ok(byId.conversation.items.some((t: { name: string }) => t.name === 'search_conversation'));
      assert.equal(c.exchanges.included, 1);
      assert.equal(c.modelWindow, null);
      assert.ok(c.lastRequest?.usage);
      const cross = await request(s.base, '/api/agent/context', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(cross.status, 403);
      const fresh = await postJson(s.base, '/api/agent', { action: 'reset-context' });
      assert.equal(fresh.status, 200);
      const after = fresh.json as { categories: Array<{ id: string; tokens: number }>; exchanges: { sinceReset: number } };
      assert.equal(after.categories.find((x) => x.id === 'messages')!.tokens, 0);
      assert.equal(after.exchanges.sinceReset, 0);
    } finally {
      ev.close();
      await s.stop();
    }
  });
});

test("model windows come from the provider's model list, cached", async () => {
  const { ModelWindows } = await import('@sfagents/web');
  let calls = 0;
  const fake = (async (url: string | URL) => {
    calls++;
    assert.equal(String(url), 'https://openrouter.ai/api/v1/models');
    return new Response(JSON.stringify({ data: [{ id: 'a/b', context_length: 400000 }, { id: 'c/d', top_provider: { context_length: 128000 } }] }), { status: 200 });
  }) as typeof fetch;
  const w = new ModelWindows(fake);
  const def = (model: string) => ({ ...baseAgent('main'), model }) as never;
  assert.equal(await w.lookup(def('a/b')), 400000);
  assert.equal(await w.lookup(def('a/b')), 400000);
  assert.equal(await w.lookup(def('c/d')), 128000);
  assert.equal(await w.lookup(def('x/y')), null);
  assert.equal(calls, 3);
});
