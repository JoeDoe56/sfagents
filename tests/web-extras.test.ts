import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AppSettings, ConversationService, MemorySecretStore, ProviderRegistry, loadAgentTree } from '@sfagents/core';
import { Dictation, ProvidersApi, WebServer } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent, writeJson } from './helpers.js';

async function start(options: { agent?: Record<string, unknown>; keyring?: boolean; watch?: boolean; files?: Record<string, unknown>; dictation?: Dictation } = {}) {
  const dir = makeTempDir();
  writeAgent(dir, { ...baseAgent('main'), ...(options.agent ?? {}) });
  for (const [f, v] of Object.entries(options.files ?? {})) writeJson(path.join(dir, f), v);
  const tree = loadAgentTree(dir);
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
  const home = makeTempDir();
  const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(options.keyring !== false) });
  const server = new WebServer({
    tree,
    conversation,
    port: 0,
    providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory,
    registry,
    settings: new AppSettings(home),
    watchAgents: options.watch === true,
    auth: false,
    ...(options.dictation ? { dictation: options.dictation } : {}),
  });
  const base = (await server.start()).replace(/\/$/, '');
  return {
    dir,
    home,
    base,
    registry,
    conversation,
    async stop() {
      await server.close();
      conversation.close();
      registry.close();
    },
  };
}

function req(base: string, pathname: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? (body ? 'POST' : 'GET'), headers: { Host: u.host, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) } },
      (res) => {
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
      },
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

describe('settings and providers in the web interface', () => {
  test('settings save; restart-only ones say so', async () => {
    const s = await start();
    try {
      const before = await req(s.base, '/api/settings');
      const port = before.json.settings.find((x: { key: string }) => x.key === 'web.port');
      assert.equal(port.restart, true);
      assert.notEqual(port.running, undefined);
      assert.equal((await req(s.base, '/api/settings', { body: { values: { 'web.port': 0 } } })).status, 400);
      const saved = await req(s.base, '/api/settings', { body: { values: { 'web.port': 9123 } } });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.settings.find((x: { key: string }) => x.key === 'web.port').value, 9123);
      assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8'))['web.port'], 9123);
    } finally {
      await s.stop();
    }
  });

  test('providers: added, listed without their keys, renamed, removed; refused without a keyring', async () => {
    const s = await start({ agent: { provider: ['OpenRouter 1', 'OpenRouter 2'] } });
    try {
      assert.equal((await req(s.base, '/api/providers')).json.keyring.available, true);
      const add = await req(s.base, '/api/providers', { body: { kind: 'openrouter', name: 'OpenRouter 1', apiKey: 'sk-or-v1-abc' } });
      assert.equal(add.status, 200, add.text);
      assert.equal(add.json.name, 'OpenRouter 1');
      assert.equal((await req(s.base, '/api/providers', { body: { kind: 'openrouter', name: 'openrouter 1', apiKey: 'x' } })).status, 409);
      assert.equal((await req(s.base, '/api/providers', { body: { kind: 'openrouter', name: 'Empty' } })).status, 400);
      await req(s.base, '/api/providers', { body: { kind: 'openrouter', name: 'OpenRouter 2', apiKey: 'sk-or-v1-def' } });
      const list = await req(s.base, '/api/providers');
      assert.deepEqual(list.json.providers.map((p: { name: string }) => p.name), ['OpenRouter 1', 'OpenRouter 2']);
      assert.doesNotMatch(list.text, /sk-or-v1/);
      assert.doesNotMatch(fs.readFileSync(path.join(s.home, 'providers.json'), 'utf8'), /sk-or-v1/);
      // The agent sheet's account choices, in the agent file's order; picking one sticks.
      const agent = await req(s.base, '/api/agent');
      assert.deepEqual(agent.json.accounts.map((a: { name: string }) => a.name), ['OpenRouter 1', 'OpenRouter 2']);
      assert.equal(agent.json.account, 'OpenRouter 1');
      const picked = await req(s.base, '/api/agent', { body: { account: 'OpenRouter 2' } });
      assert.equal(picked.json.account, 'OpenRouter 2');
      assert.equal((await req(s.base, '/api/agent', { body: { account: 'Nope' } })).status, 400);
      const id = list.json.providers[0].id;
      assert.equal((await req(s.base, `/api/providers/${id}`, { body: { action: 'rename', name: 'OpenRouter main' } })).json.name, 'OpenRouter main');
      assert.equal((await req(s.base, `/api/providers/${id}`, { body: { action: 'remove' } })).status, 200);
      assert.equal(await s.registry.secret(id), null);
      assert.equal((await req(s.base, '/api/providers/signin', { body: { kind: 'openrouter', name: 'x' } })).status, 400);
    } finally {
      await s.stop();
    }
    const none = await start({ keyring: false });
    try {
      const status = await req(none.base, '/api/providers');
      assert.equal(status.json.keyring.available, false);
      assert.match(status.json.keyring.reason, /No system keyring/);
      const refused = await req(none.base, '/api/providers', { body: { kind: 'openrouter', name: 'OpenRouter 1', apiKey: 'sk' } });
      assert.equal(refused.status, 503);
      assert.equal((await req(none.base, '/api/providers')).json.providers.length, 0);
    } finally {
      await none.stop();
    }
  });
});

describe('speech settings and the voice', () => {
  test('the STT & TTS settings are checked, the reference clip is kept, and speaking asks for the model first', async () => {
    const dictation = new Dictation({ dir: makeTempDir() });
    const app = await start({ dictation });
    try {
      const saved = await req(app.base, '/api/settings', { body: { values: { 'dictation.glossary': ' SF Agents, Caleb ' } } });
      assert.equal(saved.status, 200, saved.text);
      const value = (k: string) => saved.json.settings.find((s: { key: string }) => s.key === k).value;
      assert.equal(saved.json.settings.some((s: { key: string }) => s.key === 'speech.guidanceScale'), false, 'VibeVoice\'s guidance scale is gone');
      assert.equal(saved.json.settings.some((s: { key: string }) => s.key === 'speech.autoSwap'), false, 'the model swap is gone');
      assert.equal(value('dictation.glossary'), 'SF Agents, Caleb');

      assert.equal((await req(app.base, '/api/voice')).status, 404);
      const clip = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.alloc(40)]);
      const put = await fetch(`${app.base}/api/voice`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: clip });
      assert.equal(put.status, 200);
      assert.equal(((await put.json()) as { voice: { reference: boolean } }).voice.reference, true);
      const got = await fetch(`${app.base}/api/voice`);
      assert.ok(Buffer.from(await got.arrayBuffer()).equals(clip));
      const bad = await fetch(`${app.base}/api/voice`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'not audio' });
      assert.equal(bad.status, 400);
      const del = await fetch(`${app.base}/api/voice`, { method: 'DELETE' });
      assert.equal(((await del.json()) as { voice: { reference: boolean } }).voice.reference, false);

      const spoken = await req(app.base, '/api/speak', { body: { text: 'Hello.' } });
      assert.equal(spoken.status, 409, 'the voice model is not downloaded');
      assert.match(spoken.json.error, /not set up/);
      const streamed = await req(app.base, '/api/speak', { body: { text: 'Hello.', stream: true } });
      assert.equal(streamed.status, 409, 'streaming says so too');
      assert.match(streamed.json.error, /not set up/);
      assert.equal((await req(app.base, '/api/speak', { body: { text: ' ' } })).status, 400);
    } finally {
      await app.stop();
      dictation.close();
    }
  });
});

describe('provider sign-in', () => {
  test('ChatGPT and Claude sign-ins open on this computer and add the provider by themselves', async () => {
    const home = makeTempDir();
    const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(), cleanup: async () => {} });
    const events: Array<[string, any]> = [];
    const opened: string[] = [];
    const finishers: Record<string, { resolve: (v: any) => void; reject: (e: Error) => void }> = {};
    const pending = (kind: string, url: string) => {
      let resolve!: (v: any) => void;
      let reject!: (e: Error) => void;
      const done = new Promise((res, rej) => ((resolve = res), (reject = rej)));
      done.catch(() => {});
      finishers[kind] = { resolve, reject };
      return { url, done, cancel: () => reject(new Error('Cancelled.')) } as any;
    };
    const homes: string[] = [];
    const api = new ProvidersApi({
      registry,
      settings: new AppSettings(home),
      running: {},
      broadcast: (e, d) => events.push([e, d]),
      log: () => {},
      signIn: {
        codex: async (h) => (homes.push(h), fs.mkdirSync(h, { recursive: true }), pending('openai', 'https://auth.openai.com/oauth/authorize?x=1')),
        claude: async () => pending('anthropic', 'https://claude.com/cai/oauth/authorize?state=s'),
        open: async (url) => (opened.push(url), true),
      },
    });
    const started = (await api.handle('POST', ['providers', 'signin'], { kind: 'openai', name: 'OpenAI 1' })) as any;
    assert.equal(started.opened, true);
    assert.deepEqual(opened, ['https://auth.openai.com/oauth/authorize?x=1'], 'the page opens in this computer\'s browser');
    await api.handle('POST', ['providers', 'signin', started.id], { action: 'reopen' });
    assert.equal(opened.length, 2);
    await assert.rejects(() => api.handle('POST', ['providers', 'signin', started.id], { code: 'abc' }), /finishes in the browser/);
    finishers['openai']!.resolve({ email: 'me@example.com' });
    await new Promise((r) => setTimeout(r, 20));
    const added = registry.find('OpenAI 1')!;
    assert.equal(added.account, 'me@example.com');
    assert.equal(registry.stateDir(added), homes[0], 'Codex keeps the sign-in under the new provider\'s folder');
    assert.deepEqual(await registry.secret(added.id), { codex: true });
    assert.ok(events.some(([e, d]) => e === 'signin' && d.state === 'done' && d.provider.name === 'OpenAI 1'));

    const claude = (await api.handle('POST', ['providers', 'signin'], { kind: 'anthropic', name: 'Claude 1' })) as any;
    finishers['anthropic']!.resolve('sk-ant-oat01-token');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await registry.secret(registry.find('Claude 1')!.id), { token: 'sk-ant-oat01-token' });
    void claude;

    // A failed sign-in leaves no provider and no Codex folder.
    const failed = (await api.handle('POST', ['providers', 'signin'], { kind: 'openai', name: 'OpenAI 2' })) as any;
    finishers['openai']!.reject(new Error('Sign-in was cancelled or failed.'));
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(registry.find('OpenAI 2'), undefined);
    assert.equal(fs.existsSync(homes[1]!), false);
    assert.ok(events.some(([e, d]) => e === 'signin' && d.id === failed.id && d.state === 'failed'));
    api.close();
    registry.close();
  });
});

describe('application artifacts', () => {
  test('an app on a local port is served under /apps/<id>/, with its absolute paths, redirects and sockets', async () => {
    const app = http.createServer((r, res) => {
      if (r.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' }).end('<script src="/src/main.js"></script>');
      if (r.url === '/src/main.js') return res.writeHead(200).end(`main from ${r.headers.host}`);
      if (r.url === '/api/data') return res.writeHead(200).end('app data');
      if (r.url === '/old') return res.writeHead(302, { Location: `http://${r.headers.host}/new` }).end();
      res.writeHead(404).end('no');
    });
    app.on('upgrade', (r, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d: Buffer) => socket.write(d));
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    const port = (app.address() as { port: number }).port;
    const s = await start();
    try {
      const v = s.conversation.linkArtifact({ title: 'Proto', url: `http://127.0.0.1:${port}/` });
      const page = await req(s.base, `/apps/${v.id}/`);
      assert.equal(page.status, 200);
      assert.match(page.text, /src="\/src\/main.js"/);
      assert.equal(page.headers['x-frame-options'], undefined, 'the app can be shown inside SF Agents');
      const cookie = String(page.headers['set-cookie']).split(';')[0]!;
      assert.equal(cookie, `sfagents_app=${v.id}`);
      // An absolute path from the app's page goes to the app (also /api/…, which is the app's own).
      const script = await req(s.base, '/src/main.js', { headers: { Referer: `${s.base}/apps/${v.id}/` } });
      assert.equal(script.text, `main from 127.0.0.1:${port}`);
      assert.equal((await req(s.base, '/api/data', { headers: { Referer: `${s.base}/apps/${v.id}/` } })).text, 'app data');
      // Without a referer, the cookie routes paths SF Agents doesn't serve; its own stay its own.
      assert.equal((await req(s.base, '/src/main.js', { headers: { Cookie: cookie } })).status, 200);
      assert.equal((await req(s.base, '/api/state', { headers: { Cookie: cookie } })).json?.agent?.id, 'main');
      const redirect = await req(s.base, `/apps/${v.id}/old`);
      assert.equal(redirect.headers.location, `/apps/${v.id}/new`);
      // A live-reload socket reaches the app.
      const echoed = await new Promise<string>((resolve, reject) => {
        const u = new URL(s.base);
        const r = http.request({ host: u.hostname, port: u.port, path: '/', headers: { Host: u.host, Connection: 'Upgrade', Upgrade: 'websocket', Cookie: cookie } });
        r.on('upgrade', (_res, socket) => {
          socket.on('data', (d: Buffer) => {
            resolve(d.toString());
            socket.destroy();
          });
          socket.write('ping');
        });
        r.on('error', reject);
        r.end();
      });
      assert.equal(echoed, 'ping');
      // The artifact list shows where it opens.
      const state = await req(s.base, '/api/state');
      const listed = state.json.artifacts.find((a: { id: string }) => a.id === v.id);
      assert.deepEqual([listed.type, listed.url, listed.target], ['app', `/apps/${v.id}/`, `http://127.0.0.1:${port}/`]);
      app.close();
      await new Promise((r) => setTimeout(r, 50));
      const down = await req(s.base, `/apps/${v.id}/`);
      assert.equal(down.status, 502);
      assert.match(down.text, /isn't running/);
    } finally {
      app.close();
      await s.stop();
    }
  });

  test('file artifacts are the files: changes show, a moved file is reported missing', async () => {
    const s = await start();
    try {
      const file = path.join(s.dir, 'notes.md');
      fs.writeFileSync(file, '# One');
      const v = s.conversation.linkArtifact({ title: 'Notes', file });
      const first = (await req(s.base, '/api/state')).json.artifacts[0];
      assert.equal(first.file, file);
      assert.equal((await req(s.base, first.url)).text, '# One');
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(file, '# Two, longer');
      const second = (await req(s.base, '/api/state')).json.artifacts[0];
      assert.notEqual(second.version, first.version);
      assert.equal((await req(s.base, `/api/artifacts/${v.id}/raw`)).text, '# Two, longer');
      fs.unlinkSync(file);
      assert.equal((await req(s.base, '/api/state')).json.artifacts[0].missing, true);
      const search = await req(s.base, `/api/search?q=${encodeURIComponent('notes')}`);
      assert.deepEqual(search.json.artifacts.map((a: { title: string }) => a.title), ['Notes']);
    } finally {
      await s.stop();
    }
  });
});

describe('terminal', () => {
  test('a shell runs in a tab, keeps running, and replays its output on reattach', { skip: process.platform === 'win32' && 'covered by the Windows smoke run' }, async () => {
    const s = await start();
    try {
      const created = await req(s.base, '/api/terminals', { body: { action: 'create', cols: 80, rows: 24 } });
      assert.equal(created.status, 200, created.text);
      const id = created.json.id;
      const ws = new WebSocket(`${s.base.replace('http', 'ws')}/api/terminal?id=${id}&cols=80&rows=24`, { headers: { Origin: s.base } } as any);
      let out = '';
      ws.onmessage = (e) => (out += String(e.data));
      await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
      ws.send('echo sf-$((40+2))\r');
      for (let i = 0; i < 100 && !/sf-42/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(out, /sf-42/);
      ws.close();
      // Reattaching replays what the shell printed.
      const again = new WebSocket(`${s.base.replace('http', 'ws')}/api/terminal?id=${id}`, { headers: { Origin: s.base } } as any);
      let replay = '';
      again.onmessage = (e) => (replay += String(e.data));
      await new Promise((r) => (again.onopen = r));
      for (let i = 0; i < 40 && !/sf-42/.test(replay); i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(replay, /sf-42/);
      again.close();
      assert.equal((await req(s.base, '/api/terminals')).json.terminals.length, 1);
      await req(s.base, `/api/terminals/${id}`, { body: { action: 'close' } });
      assert.equal((await req(s.base, '/api/terminals')).json.terminals.length, 0);
      // Another site can't attach.
      const t2 = (await req(s.base, '/api/terminals', { body: { action: 'create' } })).json.id;
      const evil = new WebSocket(`${s.base.replace('http', 'ws')}/api/terminal?id=${t2}`, { headers: { Origin: 'http://evil.example' } } as any);
      const refused = await new Promise((r) => {
        evil.onopen = () => r(false);
        evil.onerror = () => r(true);
      });
      assert.equal(refused, true);
    } finally {
      await s.stop();
    }
  });
});

describe('live agent reload', () => {
  test('a new or changed agent file shows up without a restart; a broken one keeps the rest', async () => {
    const s = await start({ watch: true });
    try {
      writeAgent(s.dir, { ...baseAgent('helper'), description: 'new' });
      let agents: string[] = [];
      for (let i = 0; i < 60 && !agents.includes('helper'); i++) {
        await new Promise((r) => setTimeout(r, 100));
        agents = (await req(s.base, '/api/agents')).json.agents.map((a: { id: string }) => a.id);
      }
      assert.ok(agents.includes('helper'));
      writeAgent(s.dir, { ...baseAgent('main'), description: 'changed' });
      let description = '';
      for (let i = 0; i < 60 && description !== 'changed'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        description = (await req(s.base, '/api/agent')).json.description;
      }
      assert.equal(description, 'changed');
      fs.writeFileSync(path.join(s.dir, 'agents', 'helper.json'), '{ broken');
      for (let i = 0; i < 60 && agents.includes('helper'); i++) {
        await new Promise((r) => setTimeout(r, 100));
        agents = (await req(s.base, '/api/agents')).json.agents.map((a: { id: string }) => a.id);
      }
      assert.deepEqual(agents, ['main'], 'the broken file is skipped; main stays');
    } finally {
      await s.stop();
    }
  });
});
