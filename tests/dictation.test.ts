import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Dictation, deviceFromLog, runtimeChoices, transcriptFromAnswer, wavSeconds, type DictationStatus } from '@sfagents/web';
import { makeTempDir } from './helpers.js';

describe('dictation helpers', () => {
  test('runtime choices put the GPU builds first and always end with the CPU build', () => {
    const names = (c: ReturnType<typeof runtimeChoices>) => c.map((x) => x.backend);
    assert.deepEqual(names(runtimeChoices({ platform: 'darwin', arch: 'arm64', nvidia: false, vulkan: false })), ['metal']);
    assert.deepEqual(names(runtimeChoices({ platform: 'win32', arch: 'x64', nvidia: true, vulkan: true })), ['cuda', 'vulkan', 'cpu']);
    assert.deepEqual(names(runtimeChoices({ platform: 'win32', arch: 'x64', nvidia: false, vulkan: false })), ['cpu']);
    assert.deepEqual(names(runtimeChoices({ platform: 'linux', arch: 'x64', nvidia: false, vulkan: true })), ['vulkan', 'cpu']);
    const win = runtimeChoices({ platform: 'win32', arch: 'x64', nvidia: true, vulkan: true });
    assert.ok(win[0]!.asset.test('llama-b11846-bin-win-cuda-12.4-x64.zip'));
    assert.ok(!win[0]!.asset.test('llama-b11846-bin-win-cuda-13.4-x64.zip'), 'CUDA 12 runs on older drivers');
    assert.ok(win[0]!.extra!.test('cudart-llama-bin-win-cuda-12.4-x64.zip'));
    assert.ok(win[1]!.asset.test('llama-b11846-bin-win-vulkan-x64.zip'));
    assert.ok(win[2]!.asset.test('llama-b11846-bin-win-cpu-x64.zip'));
    const linux = runtimeChoices({ platform: 'linux', arch: 'x64', nvidia: true, vulkan: true });
    assert.ok(linux[0]!.asset.test('llama-b11846-bin-ubuntu-cuda-12.8-x64.tar.gz'));
    assert.ok(linux[0]!.extra!.test('cudart-llama-b11846-bin-ubuntu-cuda-12.8-x64.tar.gz'));
    assert.ok(linux[1]!.asset.test('llama-b11846-bin-ubuntu-vulkan-x64.tar.gz'));
    assert.ok(linux[2]!.asset.test('llama-b11846-bin-ubuntu-x64.tar.gz'));
    assert.ok(!linux[2]!.asset.test('llama-b11846-bin-ubuntu-vulkan-x64.tar.gz'));
    assert.ok(runtimeChoices({ platform: 'darwin', arch: 'arm64', nvidia: false, vulkan: false })[0]!.asset.test('llama-b11846-bin-macos-arm64.tar.gz'));
  });

  test('the transcript is taken out of Qwen3-ASR answers', () => {
    assert.equal(transcriptFromAnswer('language English<asr_text>Hello there.'), 'Hello there.');
    assert.equal(transcriptFromAnswer('language German<asr_text> Guten Tag </asr_text>'), 'Guten Tag');
    assert.equal(transcriptFromAnswer('language None<asr_text>'), '');
    assert.equal(transcriptFromAnswer('plain text'), 'plain text');
  });

  test('the device a GPU build found is read from its log', () => {
    assert.equal(deviceFromLog('load_tensors: using device Vulkan0 (AMD Radeon RX 7900 XTX) - 24560 MiB free'), 'AMD Radeon RX 7900 XTX');
    assert.equal(deviceFromLog('ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 4090, compute capability 8.9'), 'NVIDIA GeForce RTX 4090');
    assert.equal(deviceFromLog('nothing here'), undefined);
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
import http from 'node:http';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const seen = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/health') return res.end('{"status":"ok"}');
    const j = JSON.parse(body);
    const audio = j.messages[0].content.find((c) => c.type === 'input_audio');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'language English<asr_text>' + (audio.input_audio.format === 'wav' ? 'hello from ' + args[args.indexOf('-ngl') + 1] + ' layers, max ' + j.max_tokens : 'wrong') } }] }));
  });
}).listen(port, '127.0.0.1', () => console.error('server is listening'));
`;

describe('dictation install and fallback', { skip: process.platform !== 'linux' && 'the stand-in llama-server is a shell script' }, () => {
  test('downloads (resuming), checks, falls back from a broken GPU build to the CPU build, and transcribes', async () => {
    const work = makeTempDir();
    // Two llama.cpp "builds": the Vulkan one crashes at start, the CPU one works.
    const pack = (name: string, script: string) => {
      const d = path.join(work, name, 'llama-b100');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'fake.mjs'), FAKE_SERVER);
      fs.writeFileSync(path.join(d, 'llama-server'), script);
      const out = path.join(work, `${name}.tar.gz`);
      assert.equal(spawnSync('tar', ['-czf', out, '-C', path.join(work, name), 'llama-b100']).status, 0);
      return fs.readFileSync(out);
    };
    const vulkan = pack('vulkan', '#!/bin/sh\necho "no Vulkan device" >&2\nexit 3\n');
    const cpu = pack('cpu', `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.mjs" "$@"\n`);
    const model = crypto.randomBytes(300_000);
    const mmproj = crypto.randomBytes(50_000);
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
      if (u === '/releases') {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        res.setHeader('Content-Type', 'application/json');
        return res.end(
          JSON.stringify([
            { tag_name: 'b100', assets: [
              { name: 'llama-b100-bin-ubuntu-vulkan-x64.tar.gz', browser_download_url: `${base}/dl/vulkan`, size: vulkan.length, digest: `sha256:${sha(vulkan)}` },
              { name: 'llama-b100-bin-ubuntu-vulkan-arm64.tar.gz', browser_download_url: `${base}/dl/vulkan`, size: vulkan.length, digest: `sha256:${sha(vulkan)}` },
              { name: 'llama-b100-bin-ubuntu-x64.tar.gz', browser_download_url: `${base}/dl/cpu`, size: cpu.length, digest: `sha256:${sha(cpu)}` },
              { name: 'llama-b100-bin-ubuntu-arm64.tar.gz', browser_download_url: `${base}/dl/cpu`, size: cpu.length, digest: `sha256:${sha(cpu)}` },
            ] },
          ]),
        );
      }
      if (u === '/dl/vulkan') return send(vulkan);
      if (u === '/dl/cpu') return send(cpu);
      if (u === '/models/model.gguf') return send(model);
      if (u === '/models/mmproj.gguf') return send(mmproj);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = path.join(work, 'home');
    const states: DictationStatus[] = [];
    const d = new Dictation({
      dir,
      hardware: () => ({ platform: 'linux', arch: process.arch, nvidia: false, vulkan: true }),
      models: [
        { name: 'model.gguf', size: model.length, sha256: sha(model) },
        { name: 'mmproj.gguf', size: mmproj.length, sha256: sha(mmproj) },
      ],
      modelBaseUrl: `${base}/models`,
      releasesUrl: `${base}/releases`,
      onChange: (s) => states.push(s),
    });
    try {
      assert.equal(d.status().state, 'missing');
      assert.ok(d.status().downloadSize > model.length);
      // Half of the model is already there from an interrupted download.
      fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'models', 'model.gguf.part'), model.subarray(0, 100_000));
      await d.install();
      assert.equal(d.status().state, 'ready');
      assert.deepEqual(ranges, ['/models/model.gguf 100000']);
      assert.ok(states.some((s) => s.state === 'installing' && s.progress?.label === 'Speech model'));
      assert.ok(fs.readFileSync(path.join(dir, 'models', 'model.gguf')).equals(model));

      const text = await d.transcribe(wav(32000));
      assert.equal(text, 'hello from 0 layers, max 48', 'the CPU build ran, with the token cap for two seconds');
      const st = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
      assert.equal(st.working, 'cpu');
      assert.deepEqual(st.failed, ['vulkan'], 'the broken GPU build is not tried again');
      assert.equal(d.status().state, 'running');
      assert.equal(d.status().device, 'CPU');
      d.stop();
      assert.equal(d.status().state, 'ready');
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
      models: [
        { name: 'model.gguf', size: 13, sha256: '0'.repeat(64) },
        { name: 'mmproj.gguf', size: 13, sha256: '0'.repeat(64) },
      ],
      modelBaseUrl: base,
      releasesUrl: `${base}/nothing`,
    });
    try {
      // Write a runtime record so only the model downloads.
      fs.writeFileSync(path.join(work, 'runtime.json'), JSON.stringify({ runtimes: { cpu: { dir: 'x', tag: 'b1' } } }));
      await assert.rejects(() => d.install(), /checksum/);
      assert.equal(d.status().state, 'error');
      assert.equal(fs.existsSync(path.join(work, 'models', 'model.gguf.part')), false);
    } finally {
      d.close();
      server.close();
    }
  });
});

describe('dictation kept loaded', { skip: process.platform !== 'linux' && 'the stand-in llama-server is a shell script' }, () => {
  test('stays running without an idle stop, and starts again when llama-server exits', async () => {
    const dir = makeTempDir();
    const bin = path.join(dir, 'runtime', 'cpu');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'fake.mjs'), FAKE_SERVER);
    fs.writeFileSync(path.join(bin, 'llama-server'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.mjs" "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'models'));
    fs.writeFileSync(path.join(dir, 'models', 'model.gguf'), 'm');
    fs.writeFileSync(path.join(dir, 'models', 'mmproj.gguf'), 'p');
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ runtimes: { cpu: { dir: 'runtime/cpu', tag: 'b1' } } }));
    const logs: string[] = [];
    const d = new Dictation({
      dir,
      keepLoaded: true,
      hardware: () => ({ platform: 'linux', arch: process.arch, nvidia: false, vulkan: false }),
      models: [
        { name: 'model.gguf', size: 1, sha256: '' },
        { name: 'mmproj.gguf', size: 1, sha256: '' },
      ],
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
      assert.equal(await d.transcribe(wav(16000)), 'hello from 0 layers, max 40');
    } finally {
      d.close();
    }
  });
});
