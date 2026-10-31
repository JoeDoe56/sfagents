import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Dictation, RUNTIME_RELEASE, coresFromCpuinfo, deviceFromList, isNoRoom, physicalCores, placementText, llamaLeftovers, glossaryContext, runtimeChoices, speechText, transcriptFromAnswer, trimReference, wavSeconds, type DictationStatus } from '@sfagents/web';
import { makeTempDir } from './helpers.js';

describe('text as Qwen3-TTS reads it', () => {
  const said = (s: string) => speechText(s);

  test('Markdown keeps its words: headings, emphasis, lists, quotes, tables', () => {
    assert.equal(said('## Summary\n\nThe **build** passed and _all_ tests are ~~red~~ green.'), 'Summary. The build passed and all tests are red green.');
    assert.equal(said('- First item\n- Second with `code_name`\n1. One\n2) Two'), 'First item. Second with code name. One. Two.');
    assert.equal(said('> **Note:** read this'), 'Note: read this.');
    assert.equal(said('| Model | VRAM |\n|---|:---:|\n| Qwen3-ASR | 2.5 GB |'), 'Model, VRAM. Qwen3-ASR, 2.5 GB.');
    assert.equal(said('***\nAfter a rule.\n\n- [x] Done\n- [ ] Open\n\nNote[^1].\n\n[^1]: The note.'), 'After a rule. Done. Open. Note. The note.');
    assert.equal(said('Title\n=====\nText'), 'Title. Text.');
  });

  test('code blocks are not read; inline code is', () => {
    assert.equal(said('Run this:\n\n```bash\nnpm run build\nnpm test\n```\n\nThen restart.'), 'Run this: Code omitted. Then restart.');
    assert.equal(said('Unclosed:\n```\nrm -rf /'), 'Unclosed: Code omitted.');
    assert.equal(said('Call `speak()` now.'), 'Call speak now.');
  });

  test('links, addresses and HTML become words', () => {
    assert.equal(said('See [the PR](https://github.com/x/y/pull/12) and ![a chart](c.png).'), 'See the PR and a chart.');
    assert.equal(said('Visit https://www.example.com/path?q=1. Or <https://docs.python.org/3/>.'), 'Visit example dot com. Or docs dot python dot org.');
    assert.equal(said('Line one<br>Line two &amp; three &lt;tag&gt; &#8212; done.'), 'Line one. Line two and three tag, done.');
  });

  test('emoji and stray characters go; symbols are said as words', () => {
    assert.equal(said('All green ✅ 🎉🎉 👍🏽!!!'), 'All green!');
    assert.equal(said('About ~2x faster -> 3–4 s, cost ≈ $5 & time ≤ 10 min, speed >= 1.5.'), 'About about 2 times faster to 3 to 4 s, cost about $5 and time at most 10 min, speed at least 1.5.');
    assert.equal(said('Issue #42: 2*3 is 6.'), 'Issue number 42: 2 times 3 is 6.');
    assert.equal(said('Released 2026-10-30, version 1.2-3.'), 'Released 2026-10-30, version 1.2-3.', 'dates and versions are not ranges');
    assert.equal(said('snake_case and my_var stay words; 5 * 3 = 15'), 'snake case and my var stay words; 5 times 3 equals 15.');
    assert.equal(said('Hello.\n\nHow are   you?'), 'Hello. How are you?');
    assert.equal(said('**'), '');
    assert.equal(said('A line wrapped\ninside a paragraph.'), 'A line wrapped inside a paragraph.');
  });

  test('dots, slashes and other characters are said the way a person says them', () => {
    assert.equal(said('I changed `web/src/dictation.ts` and Node.js, e.g. the parser.'), 'I changed web slash src slash dictation dot ts and Node dot js, for example the parser.');
    assert.equal(said('Mail me@example.com. It is 50% done at 22°C; 2+2 is 4 in C++ for R&D.'), 'Mail me at example dot com. It is 50 percent done at 22 degrees Celsius; 2 plus 2 is 4 in C plus plus for R and D.');
    assert.equal(said('Use and/or w/ care: version 0.9.3 costs $2.50, i.e. cheap. See .env and /api/speak.'), 'Use and or with care: version 0.9.3 costs $2.50, that is cheap. See dot env and slash api slash speak.');
  });
});

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

  test('the llama.cpp files are found by their exact names, so the new model (the same name in other letters) is not one', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'models'));
    fs.mkdirSync(path.join(dir, 'runtime'));
    fs.writeFileSync(path.join(dir, 'models', 'qwen3-asr-1.7b-q8_0.gguf'), 'new');
    fs.writeFileSync(path.join(dir, 'models', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'), 'old');
    const found = llamaLeftovers(dir).map((f) => path.relative(dir, f));
    assert.deepEqual(found.sort(), [path.join('models', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'), 'runtime'].sort());
  });

  test('the transcript is taken out of Qwen3-ASR answers that still have their markers', () => {
    assert.equal(transcriptFromAnswer('language English<asr_text>Hello there.'), 'Hello there.');
    assert.equal(transcriptFromAnswer('language German<asr_text> Guten Tag </asr_text>'), 'Guten Tag');
    assert.equal(transcriptFromAnswer('language None<asr_text>'), '');
    assert.equal(transcriptFromAnswer('plain text'), 'plain text');
  });

  test('the glossary becomes Qwen3-ASR context, and a reply a one-speaker script', () => {
    assert.equal(glossaryContext(' SF Agents, Qwen3 ,, Qwen3-TTS,Qwen3 '), 'SF Agents, Qwen3, Qwen3-TTS');
    assert.equal(glossaryContext(''), '');
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
// A GPU with this much room (GB) for the models audio.cpp estimates, as --min-free-memory-mb checks.
const room = fs.existsSync(new URL('./room.json', import.meta.url)) ? JSON.parse(fs.readFileSync(new URL('./room.json', import.meta.url), 'utf8')) : null;
if (room && backend !== 'cpu' && args.includes('--min-free-memory-mb')) {
  let used = 0;
  for (const id of loaded) {
    used += room.sizes[id];
    if (used + 0.5 > room.free) {
      console.error("audiocpp_server failed: cannot load model '" + id + "': estimated " + room.sizes[id] + ' GiB + 512 MiB headroom exceeds available ' + backend + ' memory (' + (room.free - used + room.sizes[id]) + ' GiB)');
      process.exit(1);
    }
  }
}
fs.appendFileSync(new URL('./started.txt', import.meta.url), backend + ' ' + [...loaded].join('+') + ' threads ' + config.threads + ' ' + args[args.indexOf('--threads') + 1] + '\\n');
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
      if (j.stream_format === 'audio') {
        // Ten pieces, 50 ms apart; a client that goes away stops it.
        if (!config.models.some((m) => m.id === j.model && m.mode === 'streaming')) return json(res, 500, { error: { message: 'speech streaming requires a model configured with mode=streaming' } });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        let n = 0;
        const timer = setInterval(() => {
          res.write('pcm' + n + ';');
          if (++n === 10) {
            clearInterval(timer);
            res.end();
          }
        }, 50);
        res.on('close', () => {
          if (n < 10) calls.push('tts stopped after ' + n);
          clearInterval(timer);
        });
        return;
      }
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
      ttsModel: { name: 'Qwen3-TTS/tts.gguf', size: 10, sha256: '' },
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
      // Gone before the download: on Windows the old model passes for the new one by name.
      assert.equal(fs.existsSync(path.join(dir, 'models', 'Qwen3-ASR-1.7B-Q8_0.gguf')), false);

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

  test('a dropped download is tried again from where it stopped, and dictation does not wait behind the voice model', async () => {
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
      assert.deepEqual(seen.filter((x) => x.startsWith('/asr')), ['/asr.gguf 0', '/asr.gguf 100000']);
      assert.deepEqual(seen.filter((x) => x.startsWith('/tts')), ['/tts.gguf 0']);
      assert.equal(most, 2, 'the two lanes at once');
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
      fs.mkdirSync(path.join(work, 'models'), { recursive: true });
      fs.writeFileSync(path.join(work, 'models', 'asr.gguf.lock'), String(other.pid));
      await assert.rejects(() => d.install(), /Another SF Agents/);
      other.kill();
      await new Promise((r) => other.once('exit', r));
      await d.install();
      assert.equal(d.status().state, 'ready');
      assert.equal(fs.existsSync(path.join(work, 'models', 'asr.gguf.lock')), false);
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
      settings: () => ({ glossary: 'SF Agents, Caleb' }),
      log: (l) => logs.push(l),
    });
    try {
      assert.equal(d.status().state, 'ready');
      const first = await d.start();
      assert.equal(d.status().state, 'running');
      assert.equal((d as unknown as { idle: unknown }).idle, null, 'no idle timer');
      (d as unknown as { servers: Array<{ child: { kill(): void } }> }).servers[0]!.child.kill();
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

describe('dictation that was not set up', { skip: process.platform !== 'linux' && 'the stand-in audiocpp_server is a shell script' }, () => {
  test('push-to-talk downloads what is missing and starts, instead of failing', async () => {
    const dir = makeTempDir();
    standIn(dir);
    fs.rmSync(path.join(dir, 'models', 'asr.gguf'));
    const server = http.createServer((_req, res) => res.end('a'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const d = new Dictation({ dir, keepLoaded: true, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }), ...SMALL, modelBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    try {
      assert.equal(d.status().state, 'missing');
      assert.equal(await d.transcribe(wav(16000)), 'hello from cpu, max 40');
      assert.equal(d.status().state, 'running');
    } finally {
      d.close();
      server.close();
    }
  });
});

describe('text to speech', { skip: process.platform !== 'linux' && 'the stand-in audiocpp_server is a shell script' }, () => {
  test('Qwen3-TTS speaks next to Qwen3-ASR, in the reference voice, with its transcript', async () => {
    const dir = makeTempDir();
    standIn(dir);
    let referenceText = '';
    const saved: string[] = [];
    const d = new Dictation({ dir, keepLoaded: true, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }), ...SMALL, settings: () => ({ referenceText }), onReferenceText: (t) => saved.push((referenceText = t)) });
    try {
      await d.start();
      await assert.rejects(() => d.speak('Hi.'), /not set up/);
      // Downloaded while the server runs: it is started again with Qwen3-TTS in its config.
      fs.writeFileSync(path.join(dir, 'models', 'tts.gguf'), 't');
      await assert.rejects(() => d.speak('Hi.'), /set a reference voice/, 'the Base model has no voice of its own');
      d.setReference(wav(8000));
      assert.equal(d.status().voice.reference, true);
      assert.throws(() => d.setReference(Buffer.from('not a wav file')), /WAV/);
      const out = await d.speak('Hello\nthere.');
      assert.equal(out.toString(), 'RIFF....WAVEHello there.');
      const log = await calls(d);
      const tts = log.find((c) => c.startsWith('tts'))!;
      assert.match(tts, /^tts qwen3-asr\+qwen3-tts /, 'both loaded');
      const req = JSON.parse(tts.slice(tts.indexOf('{')));
      assert.equal(req.voice_ref, path.join(dir, 'voice-ref.wav'));
      assert.equal(req.options.reference_text, 'hello from cpu, max 36', 'the clip, as Qwen3-ASR heard it');
      assert.equal(req.options.guidance_scale, undefined);
      assert.equal(d.status().voice.state, 'loaded');
      // The transcript is made once per clip.
      const asr = () => calls(d).then((c) => c.filter((x) => x.startsWith('asr')).length);
      const before = await asr();
      await d.speak('Again.');
      assert.equal(await asr(), before, 'not transcribed again');
      d.setReference(wav(16000));
      await d.speak('New clip.');
      assert.equal(await asr(), before + 1, 'a new clip is transcribed');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voice-ref.json'), 'utf8')).text, 'hello from cpu, max 40');
      assert.deepEqual(saved, ['hello from cpu, max 36', 'hello from cpu, max 40'], 'each new transcript becomes the setting');
      // The user's correction wins, until the clip changes or it is transcribed again.
      referenceText = 'What I really said.';
      await d.speak('Corrected.');
      const tts2 = (await calls(d)).filter((c) => c.startsWith('tts')).at(-1)!;
      assert.equal(JSON.parse(tts2.slice(tts2.indexOf('{'))).options.reference_text, 'What I really said.');
      assert.equal(d.status().voice.transcript, 'What I really said.');
      assert.equal(await d.transcribeReference(), 'hello from cpu, max 40');
      assert.equal(referenceText, 'hello from cpu, max 40', 'transcribed again: the setting is the new transcript');
      d.setReference(null);
      await assert.rejects(() => d.speak('Gone.'), /set a reference voice/);
      assert.equal(fs.existsSync(path.join(dir, 'voice-ref.wav')), false);
    } finally {
      d.close();
    }
  });

  test('a long reference clip is cut to 15 seconds at a pause; VibeVoice is removed', async () => {
    // 20 s of tone with a pause from 10 s to 10.2 s.
    const rate = 24000;
    const samples = Int16Array.from({ length: rate * 20 }, (_, i) => (i >= rate * 10 && i < rate * 10.2 ? 0 : Math.round(Math.sin(i / 7) * 6000)));
    const long = Buffer.concat([wav(0).subarray(0, 44), Buffer.from(samples.buffer)]);
    long.writeUInt32LE(rate, 24);
    long.writeUInt32LE(rate * 2, 28);
    long.writeUInt32LE(samples.length * 2, 40);
    const cut = trimReference(long, 15, 8);
    const seconds = (cut.length - 44) / 2 / rate;
    assert.ok(seconds >= 10 && seconds <= 10.2, `cut in the pause, at ${seconds} s`);
    assert.equal(cut.readUInt32LE(24), rate);
    assert.equal(trimReference(wav(16000 * 5), 15, 8).length, wav(16000 * 5).length, 'a short clip stays as it is');
    assert.equal(speechText('Hello.\n\nHow are   you?'), 'Hello. How are you?');

    const dir = makeTempDir();
    standIn(dir);
    fs.writeFileSync(path.join(dir, 'models', 'vibevoice-1.5b-q8_0.gguf'), 'old');
    const d = new Dictation({ dir, keepLoaded: true, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }), ...SMALL });
    try {
      await d.start();
      assert.equal(fs.existsSync(path.join(dir, 'models', 'vibevoice-1.5b-q8_0.gguf')), false, 'VibeVoice (3.2 GB) is gone');
      assert.equal(fs.existsSync(path.join(dir, 'models', 'asr.gguf')), true);
    } finally {
      d.close();
    }
  });
});

describe('speaking as it is made', { skip: process.platform !== 'linux' && 'the stand-in audiocpp_server is a shell script' }, () => {
  test('the audio comes in pieces as it is made; stopping stops the generation, and the next reply goes ahead', async () => {
    const dir = makeTempDir();
    standIn(dir);
    fs.writeFileSync(path.join(dir, 'models', 'tts.gguf'), 't');
    const d = new Dictation({ dir, keepLoaded: true, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: false }), ...SMALL });
    try {
      d.setReference(wav(8000));
      await d.start();
      const pieces: string[] = [];
      for await (const c of await d.speakStream('Hello.')) pieces.push(c.toString());
      assert.equal(pieces.join(''), 'pcm0;pcm1;pcm2;pcm3;pcm4;pcm5;pcm6;pcm7;pcm8;pcm9;');
      assert.ok(pieces.length > 1, 'more than one piece');
      const req = JSON.parse((await calls(d)).at(-1)!.replace(/^tts \S+ /, ''));
      assert.equal(req.response_format, 'pcm');
      assert.equal(d.status().voice.state, 'loaded');

      const stop = new AbortController();
      let got = 0;
      await assert.rejects(async () => {
        for await (const _ of await d.speakStream('Long.', stop.signal)) if (++got === 2) stop.abort();
      });
      for (let i = 0; i < 50 && !(await calls(d)).some((c) => c.startsWith('tts stopped')); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok((await calls(d)).some((c) => /^tts stopped after [23]$/.test(c)), 'the generation stopped');
      assert.equal((await d.speak('Next.')).toString(), 'RIFF....WAVENext.', 'not stuck behind the stopped one');
    } finally {
      d.close();
    }
  });
});

describe('where the models run', { skip: process.platform !== 'linux' && 'the stand-in audiocpp_server is a shell script' }, () => {
  /** A GPU build (the stand-in) on a GPU with this much room, and both models downloaded. */
  function gpu(free: number) {
    const dir = makeTempDir();
    standIn(dir);
    fs.writeFileSync(path.join(dir, 'models', 'tts.gguf'), 't');
    fs.writeFileSync(path.join(dir, 'voice.wav'), wav(8000));
    fs.writeFileSync(path.join(dir, 'audiocpp', 'cpu', 'room.json'), JSON.stringify({ free, sizes: { 'qwen3-asr': 2.8, 'qwen3-tts': 4.6 } }));
    fs.writeFileSync(path.join(dir, 'audiocpp.json'), JSON.stringify({ runtimes: { vulkan: { dir: 'audiocpp/cpu', tag: RUNTIME_RELEASE.tag } }, working: 'vulkan' }));
    const logs: string[] = [];
    const d = new Dictation({ dir, keepLoaded: true, hardware: () => ({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: true }), ...SMALL, log: (l) => logs.push(l) });
    const started = () => fs.readFileSync(path.join(dir, 'audiocpp', 'cpu', 'started.txt'), 'utf8').trim().split('\n');
    return { d, logs, started };
  }

  test('both on the GPU when they fit with room to spare', async () => {
    const { d, started } = gpu(9);
    try {
      await d.start();
      const threads = await physicalCores();
      assert.deepEqual(d.status().placement, { asr: 'gpu', tts: 'gpu', threads });
      assert.deepEqual(started(), [`vulkan qwen3-tts+qwen3-asr threads ${threads} ${threads}`], 'one server, a thread per physical core');
      assert.equal(await d.transcribe(wav(16000)), 'hello from vulkan, max 40');
      assert.equal(d.status().voice.state, 'loaded');
    } finally {
      d.close();
    }
  });

  test('else Qwen3-TTS on the GPU and Qwen3-ASR on the CPU, in a second server', async () => {
    const { d, logs, started } = gpu(6);
    try {
      await d.start();
      assert.equal(d.status().placement?.asr, 'cpu');
      assert.equal(d.status().placement?.tts, 'gpu');
      assert.deepEqual(started().map((l) => l.split(' threads')[0]), ['vulkan qwen3-tts', 'cpu qwen3-asr']);
      assert.ok(logs.some((l) => /Qwen3-TTS and Qwen3-ASR do not fit on the GPU/.test(l)), logs.join(' | '));
      assert.ok(logs.some((l) => /Speech to text: CPU \(\d+ threads?\) · Text to speech: GPU/.test(l)), logs.join(' | '));
      assert.equal(await d.transcribe(wav(16000)), 'hello from cpu, max 40');
      assert.equal((await d.speak('Hi.')).toString(), 'RIFF....WAVEHi.');
      // One stops: both start again together.
      (d as unknown as { servers: Array<{ child: { kill(): void } }> }).servers[1]!.child.kill();
      for (let i = 0; i < 100 && started().length < 4; i++) await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 100 && d.status().state !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(d.status().placement?.asr, 'cpu');
      assert.equal(await d.transcribe(wav(16000)), 'hello from cpu, max 40');
    } finally {
      d.close();
    }
  });

  test('else Qwen3-ASR on the GPU, and with no room for either, both on the CPU', async () => {
    const small = gpu(3.5);
    try {
      await small.d.start();
      assert.equal(small.d.status().placement?.asr, 'gpu');
      assert.equal(small.d.status().placement?.tts, 'cpu');
    } finally {
      small.d.close();
    }
    const none = gpu(1);
    try {
      await none.d.start();
      assert.equal(none.d.status().placement?.asr, 'cpu');
      assert.equal(none.d.status().placement?.tts, 'cpu');
      assert.match(none.started().at(-1)!, /^cpu qwen3-tts\+qwen3-asr /, 'one CPU server with both');
      assert.equal(await none.d.transcribe(wav(16000)), 'hello from cpu, max 40');
      const st = JSON.parse(fs.readFileSync(path.join(none.d.dir, 'audiocpp.json'), 'utf8'));
      assert.equal(st.working, 'vulkan', 'a GPU without room is not a broken build');
      assert.equal(st.failed, undefined);
    } finally {
      none.d.close();
    }
  });

  test('physical cores come from /proc/cpuinfo', () => {
    const block = (p: number, c: number) => `processor\t: 0\nphysical id\t: ${p}\ncore id\t\t: ${c}\n`;
    assert.equal(coresFromCpuinfo([block(0, 0), block(0, 0), block(0, 1), block(0, 1)].join('\n')), 2, 'hyperthreads are one core');
    assert.equal(coresFromCpuinfo([block(0, 0), block(1, 0)].join('\n')), 2, 'two sockets');
    assert.equal(coresFromCpuinfo('processor\t: 0\n'), null);
    assert.ok(isNoRoom("audiocpp_server failed: cannot load model 'vibevoice': estimated 4.63 GiB + 1024 MiB headroom exceeds available cuda memory (5.02 GiB)"));
    assert.ok(!isNoRoom('no Vulkan device'));
    assert.equal(placementText({ asr: 'cpu', tts: 'gpu', threads: 6 }, 'NVIDIA GeForce GTX 1660 SUPER'), 'Speech to text: CPU (6 threads) · Text to speech: GPU (NVIDIA GeForce GTX 1660 SUPER)');
  });
});
