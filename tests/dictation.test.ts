import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Dictation, RUNTIME_RELEASE, deviceFromList, glossaryContext, runtimeChoices, speakerScript, transcriptFromAnswer, wavSeconds, type DictationStatus, type SpeechSettings } from '@sfagents/web';
import { makeTempDir } from './helpers.js';

describe('dictation helpers', () => {
  test('runtime choices put the GPU builds first and always end with the CPU build', () => {
    const names = (c: ReturnType<typeof runtimeChoices>) => c.map((x) => x.backend);
    assert.deepEqual(names(runtimeChoices({ platform: 'darwin', arch: 'arm64', nvidia: false, vulkan: false })), ['metal']);
    assert.deepEqual(names(runtimeChoices({ platform: 'win32', arch: 'x64', nvidia: true, vulkan: true })), ['cuda', 'vulkan', 'cpu']);
    assert.deepEqual(names(runtimeChoices({ platform: 'win32', arch: 'x64', nvidia: false, vulkan: false })), ['cpu']);
    assert.deepEqual(names(runtimeChoices({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: true })), ['vulkan', 'cpu']);
    assert.deepEqual(names(runtimeChoices({ platform: 'linux', arch: 'x64', nvidia: true, vulkan: false })), ['vulkan', 'cpu'], 'NVIDIA on Linux runs the Vulkan build');
    const t = 'v0.9.2-drama3-base-small';
    const win = runtimeChoices({ platform: 'win32', arch: 'x64', nvidia: true, vulkan: true });
    assert.ok(win[0]!.asset.test(`audio-${t}-bin-windows-x64-cuda12.4.zip`));
    assert.ok(!win[0]!.asset.test(`audio-${t}-bin-windows-x64-cuda13.3.zip`), 'CUDA 12 runs on older drivers');
    assert.ok(win[0]!.extra!.test(`audio-${t}-cudart-windows-x64-cuda12.4.zip`));
    assert.ok(!win[0]!.asset.test(`audio-${t}-lib-windows-x64-cuda12.4.zip`), 'not the C library');
    assert.ok(win[1]!.asset.test(`audio-${t}-bin-windows-x64-vulkan-portable.zip`));
    assert.ok(win[2]!.asset.test(`audio-${t}-bin-windows-x64-cpu-portable.zip`));
    assert.ok(!win[2]!.asset.test(`audio-${t}-bin-windows-x64-cpu.zip`), 'the portable build');
    const linux = runtimeChoices({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: true });
    assert.ok(linux[0]!.asset.test(`audio-${t}-bin-ubuntu-x64-vulkan-portable.tar.gz`));
    assert.ok(linux[1]!.asset.test(`audio-${t}-bin-ubuntu-x64-cpu-portable.tar.gz`));
    assert.ok(runtimeChoices({ platform: 'darwin', arch: 'arm64', nvidia: false, vulkan: false })[0]!.asset.test(`audio-${t}-bin-macos-arm64-metal.tar.gz`));
  });

  test('the pinned release has every build the choices can pick, each with its SHA-256', () => {
    const hws = [
      { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' },
      { platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'x64' },
    ] as const;
    for (const hw of hws) {
      for (const c of runtimeChoices({ ...hw, nvidia: true, vulkan: true })) {
        for (const re of [c.asset, ...(c.extra ? [c.extra] : [])]) {
          const a = RUNTIME_RELEASE.assets.filter((x) => re.test(x.name));
          assert.equal(a.length, 1, `${hw.platform} ${c.backend} ${re}`);
          assert.match(a[0]!.sha256, /^[0-9a-f]{64}$/);
        }
      }
    }
  });

  test('the transcript is taken out of Qwen3-ASR answers that still have their markers', () => {
    assert.equal(transcriptFromAnswer('language English<asr_text>Hello there.'), 'Hello there.');
    assert.equal(transcriptFromAnswer('language German<asr_text> Guten Tag </asr_text>'), 'Guten Tag');
    assert.equal(transcriptFromAnswer('language None<asr_text>'), '');
    assert.equal(transcriptFromAnswer('plain text'), 'plain text');
  });

  test('the glossary becomes Qwen3-ASR context, and a reply a one-speaker script', () => {
    assert.equal(glossaryContext(' SF Agents, Qwen3 ,, VibeVoice,Qwen3 '), 'SF Agents, Qwen3, VibeVoice');
    assert.equal(glossaryContext(''), '');
    assert.equal(speakerScript('Hello.\n\nHow are   you?'), 'Speaker 1: Hello. How are you?');
  });

  test('the GPU is read from the device list', () => {
    const json = JSON.stringify({ schema_version: 1, devices: [
      { backend: 'cpu', name: 'CPU', description: 'AMD Ryzen 7', type: 'cpu' },
      { backend: 'cuda', name: 'CUDA0', description: 'NVIDIA GeForce GTX 1660 SUPER', type: 'gpu' },
      { backend: 'vulkan', name: 'Vulkan0', description: 'NVIDIA GeForce GTX 1660 SUPER (Vulkan)', type: 'gpu' },
    ] });
    assert.equal(deviceFromList(json, 'cuda'), 'NVIDIA GeForce GTX 1660 SUPER');
    assert.equal(deviceFromList(json, 'vulkan'), 'NVIDIA GeForce GTX 1660 SUPER (Vulkan)');
    assert.equal(deviceFromList('{"devices":[]}', 'cuda'), undefined);
    assert.equal(deviceFromList('not json', 'cuda'), undefined);
    // Builds without --json print text.
    const text = 'available_devices=2\nCPU:0 "Intel(R) Xeon(R)" [CPU]\nCUDA:0 "NVIDIA GeForce GTX 1660 SUPER" [GPU]\nselect with: --backend <cuda|cpu>\n';
    assert.equal(deviceFromList(text, 'cuda'), 'NVIDIA GeForce GTX 1660 SUPER');
    assert.equal(deviceFromList('CPU:0 "Intel(R) Xeon(R)" [CPU]\n', 'cpu'), undefined);
  });

  test('a WAV file knows its length', () => {
    assert.equal(wavSeconds(wav(16000)), 1);
  });
});

/** A 16 kHz mono WAV of silence. */
function wav(samples: number): Buffer {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

const FAKE_SERVER = `
import fs from 'node:fs';
import http from 'node:http';
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
const backend = args[args.indexOf('--backend') + 1];
const ids = config.models.map((m) => m.id);
const loaded = new Set(config.models.filter((m) => m.lazy === false).map((m) => m.id));
const calls = [];
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/health') return json(res, 200, { status: 'ok', backend });
    if (req.url === '/calls') return json(res, 200, calls);
    const j = JSON.parse(body || '{}');
    if (req.url === '/v1/tasks/unload_models') {
      for (const id of j.model_ids) loaded.delete(id);
      calls.push('unload ' + j.model_ids.join(','));
      return json(res, 200, { unloaded: j.model_ids, not_found: [] });
    }
    if (!ids.includes(j.model)) return json(res, 404, { error: { message: 'unknown model ' + j.model } });
    loaded.add(j.model);
    const resident = [...loaded].sort().join('+');
    if (req.url === '/v1/audio/transcriptions') {
      const audio = fs.readFileSync(j.audio);
      if (audio.toString('ascii', 0, 4) !== 'RIFF') return json(res, 400, { error: { message: 'not a wav' } });
      calls.push('asr ' + resident);
      return json(res, 200, { text: 'hello from ' + backend + ', max ' + j.options.max_tokens + (j.text ? ', context ' + j.text : '') });
    }
    if (req.url === '/v1/audio/speech') {
      calls.push('tts ' + resident + ' ' + JSON.stringify(j));
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end('RIFF....WAVE' + j.input);
    }
    json(res, 404, { error: 'not found' });
  });
}).listen(config.port, '127.0.0.1', () => console.error('server is listening'));
`;

/** A runtime folder with a stand-in audiocpp_server, and the model files (any size will do with size 1 below). */
function standIn(dir: string, script = ''): void {
  const bin = path.join(dir, 'audiocpp', 'cpu');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fake.mjs'), FAKE_SERVER);
  fs.writeFileSync(path.join(bin, 'audiocpp_server'), script || `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.mjs" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'asr.gguf'), 'a');
  fs.writeFileSync(path.join(dir, 'audiocpp.json'), JSON.stringify({ runtimes: { cpu: { dir: 'audiocpp/cpu', tag: RUNTIME_RELEASE.tag } } }));
}

const SMALL = { asrModel: { name: 'asr.gguf', size: 1, sha256: '' }, ttsModel: { name: 'tts.gguf', size: 1, sha256: '' } };

async function calls(d: Dictation): Promise<string[]> {
  const url = (d as unknown as { url: string }).url;
  return (await fetch(`${url}/calls`)).json() as Promise<string[]>;
}

describe('dictation install and fallback', { skip: process.platform !== 'linux' && 'the stand-in audiocpp_server is a shell script' }, () => {
  test('downloads (resuming), checks, falls back from a broken GPU build to the CPU build, transcribes, and removes the llama.cpp files', async () => {
    const work = makeTempDir();
    // Two audio.cpp "builds": the Vulkan one crashes at start, the CPU one works.
    const pack = (name: string, script: string) => {
      const d = path.join(work, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'fake.mjs'), FAKE_SERVER);
      fs.writeFileSync(path.join(d, 'audiocpp_server'), script);
      const out = path.join(work, `${name}.tar.gz`);
      assert.equal(spawnSync('tar', ['-czf', out, '-C', d, '.']).status, 0);
      return fs.readFileSync(out);
    };
    const vulkan = pack('vulkan', '#!/bin/sh\necho "no Vulkan device" >&2\nexit 3\n');
    const cpu = pack('cpu', `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.mjs" "$@"\n`);
    const model = crypto.randomBytes(300_000);
    const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
    const ranges: string[] = [];
    const server = http.createServer((req, res) => {
      const u = req.url ?? '';
      const send = (b: Buffer) => {
        const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''));
        if (m) {
          ranges.push(`${u} ${m[1]}`);
          res.writeHead(206, { 'Content-Length': b.length - Number(m[1]) });
          return res.end(b.subarray(Number(m[1])));
        }
        res.writeHead(200, { 'Content-Length': b.length });
        res.end(b);
      };
      if (u === '/dl/vulkan') return send(vulkan);
      if (u === '/dl/cpu') return send(cpu);
      if (u === '/models/Qwen3-ASR/asr.gguf') return send(model);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = path.join(work, 'home');
    // What the llama.cpp version left behind.
    fs.mkdirSync(path.join(dir, 'runtime', 'cpu'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'models', 'Qwen3-ASR-1.7B-Q8_0.gguf'), 'old');
    fs.writeFileSync(path.join(dir, 'runtime.json'), '{}');
    const states: DictationStatus[] = [];
    const d = new Dictation({
      dir,
      hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: true }),
      asrModel: { name: 'Qwen3-ASR/asr.gguf', size: model.length, sha256: sha(model) },
      ttsModel: { name: 'VibeVoice/tts.gguf', size: 10, sha256: '' },
      modelBaseUrl: `${base}/models`,
      runtimeRelease: { tag: 'v9.0.0', assets: [
        { name: 'audio-v9.0.0-bin-ubuntu-x64-vulkan-portable.tar.gz', url: `${base}/dl/vulkan`, sha256: sha(vulkan) },
        { name: 'audio-v9.0.0-bin-ubuntu-x64-cpu-portable.tar.gz', url: `${base}/dl/cpu`, sha256: sha(cpu) },
      ] },
      onChange: (s) => states.push(s),
    });
    try {
      assert.equal(d.status().state, 'missing');
      assert.ok(d.status().downloadSize > model.length);
      assert.equal(d.status().voice.state, 'missing');
      // Half of the model is already there from an interrupted download.
      fs.writeFileSync(path.join(dir, 'models', 'asr.gguf.part'), model.subarray(0, 100_000));
      await d.install();
      assert.equal(d.status().state, 'ready');
      assert.deepEqual(ranges, ['/models/Qwen3-ASR/asr.gguf 100000']);
      assert.ok(states.some((s) => s.state === 'installing' && s.progress?.label === 'Speech model'));
      assert.ok(fs.readFileSync(path.join(dir, 'models', 'asr.gguf')).equals(model));

      const text = await d.transcribe(wav(32000));
      assert.equal(text, 'hello from cpu, max 48', 'the CPU build ran, with the token cap for two seconds');
      const st = JSON.parse(fs.readFileSync(path.join(dir, 'audiocpp.json'), 'utf8'));
      assert.equal(st.working, 'cpu');
      assert.deepEqual(st.failed, ['vulkan'], 'the broken GPU build is not tried again');
      assert.equal(d.status().state, 'running');
      assert.equal(d.status().device, 'CPU');
      for (const f of ['runtime', 'runtime.json', 'models/Qwen3-ASR-1.7B-Q8_0.gguf']) assert.equal(fs.existsSync(path.join(dir, f)), false, `${f} removed`);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'the recordings are not kept');
      d.stop();
      assert.equal(d.status().state, 'ready');
    } finally {
      d.close();
      server.close();
    }
  });

  test('a dropped download is tried again from where it stopped, and the two models download one after the other', async () => {
    const work = makeTempDir();
    const model = crypto.randomBytes(200_000);
    const voice = crypto.randomBytes(50_000);
    const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
    const seen: string[] = [];
    let open = 0;
    let most = 0;
    let dropped = false;
    const server = http.createServer((req, res) => {
      const b = req.url === '/asr.gguf' ? model : voice;
      const from = Number(/bytes=(\d+)-/.exec(String(req.headers.range ?? ''))?.[1] ?? 0);
      seen.push(`${req.url} ${from}`);
      open++;
      most = Math.max(most, open);
      res.on('close', () => open--);
      if (req.url === '/asr.gguf' && !dropped) {
        // Half of it, then the connection drops.
        dropped = true;
        res.writeHead(200, { 'Content-Length': b.length });
        res.write(b.subarray(0, 100_000), () => setTimeout(() => res.socket?.resetAndDestroy(), 20));
        return;
      }
      res.writeHead(from ? 206 : 200, { 'Content-Length': b.length - from });
      setTimeout(() => res.end(b.subarray(from)), 30);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const d = new Dictation({
      dir: work,
      hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }),
      asrModel: { name: 'asr.gguf', size: model.length, sha256: sha(model) },
      ttsModel: { name: 'tts.gguf', size: voice.length, sha256: sha(voice) },
      modelBaseUrl: base,
      retryDelay: 10,
    });
    try {
      fs.writeFileSync(path.join(work, 'audiocpp.json'), JSON.stringify({ runtimes: { cpu: { dir: 'x', tag: 'v1' } } }));
      const both = Promise.all([d.install(), d.installVoice()]);
      assert.equal(d.status().voice.state, 'installing', 'shown as installing while it waits its turn');
      await both;
      assert.ok(fs.readFileSync(path.join(work, 'models', 'asr.gguf')).equals(model));
      assert.equal(d.status().voice.state, 'ready');
      assert.deepEqual(seen, ['/asr.gguf 0', '/asr.gguf 100000', '/tts.gguf 0']);
      assert.equal(most, 1, 'one at a time');
    } finally {
      d.close();
      server.close();
    }
  });

  test('a second SF Agents does not download into the same folder, and a stale lock is taken over', async () => {
    const work = makeTempDir();
    const server = http.createServer((_req, res) => res.end('m'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const d = new Dictation({ dir: work, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }), ...SMALL, asrModel: { name: 'asr.gguf', size: 1, sha256: '' }, modelBaseUrl: base });
    try {
      fs.writeFileSync(path.join(work, 'audiocpp.json'), JSON.stringify({ runtimes: { cpu: { dir: 'x', tag: 'v1' } } }));
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
      fs.writeFileSync(path.join(work, 'download.lock'), String(other.pid));
      await assert.rejects(() => d.install(), /Another SF Agents/);
      other.kill();
      await new Promise((r) => other.once('exit', r));
      await d.install();
      assert.equal(d.status().state, 'ready');
      assert.equal(fs.existsSync(path.join(work, 'download.lock')), false);
    } finally {
      d.close();
      server.close();
    }
  });

  test('a download that does not match its checksum is thrown away', async () => {
    const work = makeTempDir();
    const server = http.createServer((_req, res) => res.end('not the model'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const d = new Dictation({
      dir: work,
      hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }),
      asrModel: { name: 'asr.gguf', size: 13, sha256: '0'.repeat(64) },
      ttsModel: { name: 'tts.gguf', size: 13, sha256: '0'.repeat(64) },
      modelBaseUrl: base,
    });
    try {
      // Write a runtime record so only the model downloads.
      fs.writeFileSync(path.join(work, 'audiocpp.json'), JSON.stringify({ runtimes: { cpu: { dir: 'x', tag: 'v1' } } }));
      await assert.rejects(() => d.install(), /checksum/);
      assert.equal(d.status().state, 'error');
      assert.equal(fs.existsSync(path.join(work, 'models', 'asr.gguf.part')), false);
      await assert.rejects(() => d.installVoice(), /checksum/);
      assert.equal(d.status().voice.state, 'error');
    } finally {
      d.close();
      server.close();
    }
  });
});

describe('dictation kept loaded', { skip: process.platform !== 'linux' && 'the stand-in audiocpp_server is a shell script' }, () => {
  test('stays running without an idle stop, starts again when audiocpp_server exits, and sends the glossary', async () => {
    const dir = makeTempDir();
    standIn(dir);
    const logs: string[] = [];
    const d = new Dictation({
      dir,
      keepLoaded: true,
      hardware: () => ({ platform: 'linux', arch: process.arch, nvidia: false, vulkan: false }),
      ...SMALL,
      settings: () => ({ autoSwap: false, guidanceScale: 1.3, glossary: 'SF Agents, Caleb' }),
      log: (l) => logs.push(l),
    });
    try {
      assert.equal(d.status().state, 'ready');
      const first = await d.start();
      assert.equal(d.status().state, 'running');
      assert.equal((d as unknown as { idle: unknown }).idle, null, 'no idle timer');
      (d as unknown as { child: { kill(): void } }).child.kill();
      let again = '';
      for (let i = 0; i < 100 && !again; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (d.status().state === 'running') again = (d as unknown as { url: string }).url;
      }
      assert.ok(again, `started again (${logs.join(' | ')})`);
      assert.notEqual(again, first, 'on a new port');
      assert.ok(logs.some((l) => /starting it again/.test(l)));
      assert.equal(await d.transcribe(wav(16000)), 'hello from cpu, max 40, context SF Agents, Caleb');
    } finally {
      d.close();
    }
  });
});

describe('text to speech', { skip: process.platform !== 'linux' && 'the stand-in audiocpp_server is a shell script' }, () => {
  test('VibeVoice speaks next to Qwen3-ASR, in the reference voice, with the guidance scale', async () => {
    const dir = makeTempDir();
    standIn(dir);
    const d = new Dictation({ dir, keepLoaded: true, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }), ...SMALL, settings: () => ({ autoSwap: false, guidanceScale: 2.4, glossary: '' }) });
    try {
      await d.start();
      await assert.rejects(() => d.speak('Hi.'), /not set up/);
      // Downloaded while the server runs: it is started again with VibeVoice in its config.
      fs.writeFileSync(path.join(dir, 'models', 'tts.gguf'), 't');
      d.setReference(wav(8000));
      assert.equal(d.status().voice.reference, true);
      assert.throws(() => d.setReference(Buffer.from('not a wav file')), /WAV/);
      const out = await d.speak('Hello\nthere.');
      assert.equal(out.toString(), 'RIFF....WAVESpeaker 1: Hello there.');
      const log = await calls(d);
      const tts = log.find((c) => c.startsWith('tts'))!;
      assert.match(tts, /^tts qwen3-asr\+vibevoice /, 'both loaded');
      const req = JSON.parse(tts.slice(tts.indexOf('{')));
      assert.equal(req.options.guidance_scale, 2.4);
      assert.equal(req.options.voice_samples, d.voicePath);
      assert.ok(!log.some((c) => c.startsWith('unload')), 'nothing unloaded without the swap');
      assert.equal(d.status().voice.state, 'loaded');
      d.setReference(null);
      await d.speak('Again.');
      const last = (await calls(d)).at(-1)!;
      assert.equal(JSON.parse(last.slice(last.indexOf('{'))).options.voice_samples, undefined, 'no clip, no voice_samples');
    } finally {
      d.close();
    }
  });

  test('with the automatic swap, Qwen3-ASR leaves while VibeVoice speaks, comes back after, and dictation waits for it', async () => {
    const dir = makeTempDir();
    standIn(dir);
    fs.writeFileSync(path.join(dir, 'models', 'tts.gguf'), 't');
    let settings: SpeechSettings = { autoSwap: true, guidanceScale: 9, glossary: '' };
    const d = new Dictation({ dir, keepLoaded: true, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }), ...SMALL, settings: () => settings });
    try {
      await d.start();
      const speaking = d.speak('One.');
      // Dictation that comes in while VibeVoice speaks.
      while (d.status().voice.state !== 'speaking') await new Promise((r) => setTimeout(r, 1));
      const dictated = d.transcribe(wav(16000));
      await speaking;
      assert.equal(await dictated, 'hello from cpu, max 40');
      const log = (await calls(d)).slice(1); // after the load at start
      const tts = log.findIndex((c) => c.startsWith('tts'));
      assert.deepEqual(log.slice(0, tts), ['unload qwen3-asr']);
      assert.match(log[tts]!, /^tts vibevoice /, 'VibeVoice alone');
      assert.equal(JSON.parse(log[tts]!.slice(log[tts]!.indexOf('{'))).options.guidance_scale, 3, 'clamped to 3');
      assert.deepEqual(log.slice(tts + 1), ['unload vibevoice', 'asr qwen3-asr', 'asr qwen3-asr'], 'Qwen3-ASR back at once, then the dictation');
      assert.equal(d.status().voice.state, 'ready');

      // Turning the swap on unloads a VibeVoice left loaded.
      settings = { ...settings, autoSwap: false };
      await d.speak('Two.');
      assert.equal(d.status().voice.state, 'loaded');
      settings = { ...settings, autoSwap: true };
      d.applySettings();
      for (let i = 0; i < 50 && d.status().voice.state === 'loaded'; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(d.status().voice.state, 'ready');
      assert.equal((await calls(d)).at(-1), 'unload vibevoice');
    } finally {
      d.close();
    }
  });
});
