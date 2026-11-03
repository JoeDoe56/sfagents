import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AgentRuntime,
  ConversationService,
  hostWorkspacesDir,
  loadAgentTree,
  type AnyDeclarativeTool,
  type ChatMessage,
  type ToolResult,
  type UserContentPart,
} from '@sfagents/core';
import { baseAgent, makeTempDir, NO_CONTAINER_TESTS, scriptedFactory, writeAgent } from './helpers.js';

const has = (cmd: string) => {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const SKIP = NO_CONTAINER_TESTS || (!['ffmpeg', 'convert', 'montage', 'compare', 'pdftoppm'].every(has) && 'needs ffmpeg, ImageMagick and poppler (they are in the agent image)');

const runtimes: AgentRuntime[] = [];
after(async () => {
  await Promise.all(runtimes.map((r) => r.dispose()));
});

async function tools(agent: Record<string, unknown> = {}, transcribe?: (wav: Buffer) => Promise<string>): Promise<Map<string, AnyDeclarativeTool>> {
  const dir = makeTempDir();
  writeAgent(dir, baseAgent('main', agent));
  const tree = loadAgentTree(dir);
  const runtime = new AgentRuntime({ tree, providerFactory: () => { throw new Error('unused'); }, ...(transcribe ? { transcribe } : {}) });
  runtimes.push(runtime);
  return runtime.buildTools(tree.root, ['main'], () => {});
}

const sh = (t: Map<string, AnyDeclarativeTool>, command: string): Promise<ToolResult> => t.get('shell')!.build({ command }).execute(new AbortController().signal);
const stdout = (r: ToolResult) => /Stdout: ([\s\S]*?)\nStderr:/.exec(r.llmContent)?.[1] ?? '';
const stderr = (r: ToolResult) => /Stderr: ([\s\S]*?)\nExit Code:/.exec(r.llmContent)?.[1] ?? '';
const size = (data: Buffer) => {
  // PNG: width and height at 16; JPEG: the first SOFn marker.
  if (data[0] === 0x89) return [data.readUInt32BE(16), data.readUInt32BE(20)];
  for (let i = 2; i < data.length; ) {
    const marker = data[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)];
    i += 2 + data.readUInt16BE(i + 2);
  }
  return [0, 0];
};

describe('sfa-view', { skip: SKIP }, () => {
  let media: string;
  let rel: string;
  before(() => {
    rel = `view-${process.pid}-${Date.now()}`;
    media = path.join(hostWorkspacesDir(), rel);
    fs.mkdirSync(media, { recursive: true });
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: media, stdio: 'ignore' });
    run('convert', ['-size', '2400x1200', 'gradient:red-blue', 'big.png']);
    run('convert', ['-size', '200x100', 'xc:white', 'a.png']);
    run('convert', ['-size', '200x100', 'xc:white', '-fill', 'black', '-draw', 'rectangle 10,10 60,40', 'b.png']);
    // 8 seconds: a test card with a cut to a color at 4 s, and a tone.
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4', '-f', 'lavfi', '-i', 'color=c=green:size=320x240:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-map', '2:a', '-shortest', 'clip.mp4']);
    try {
      run('convert', ['a.png', 'b.png', 'doc.pdf']);
    } catch {
      // ImageMagick's policy may forbid writing PDFs; the pdf test then skips
    }
  });

  test('image: shown to the model, downscaled to fit; the output says what each image is', async () => {
    const t = await tools();
    const r = await sh(t, `cd ${rel} && sfa-view image big.png a.png`);
    assert.match(stdout(r), /Image 1: big\.png\nImage 2: a\.png\n\(The images follow this result\.\)/);
    assert.equal(r.images?.length, 2);
    assert.equal(r.images![0]!.mime, 'image/png');
    assert.deepEqual(size(r.images![0]!.data), [1568, 784]);
    assert.deepEqual(size(r.images![1]!.data), [200, 100], 'small images keep their size');
    assert.equal(r.images![0]!.label, 'big.png');
    assert.match(t.get('shell')!.description, /sfa-view image shot\.png/);
  });

  test('info, sheet, frames and crop on a video', async () => {
    const t = await tools();
    const info = await sh(t, `cd ${rel} && sfa-view info clip.mp4`);
    assert.match(stdout(info), /Duration: 0:08/);
    assert.match(stdout(info), /Video: 320x240, 10\.00 fps/);
    assert.match(stdout(info), /Audio: aac/);
    assert.match(stdout(info), /Scene changes \(\d+\): .*0:04/);
    assert.equal(info.images, undefined);

    const sheet = await sh(t, `cd ${rel} && sfa-view sheet clip.mp4 --every 1s --grid 4x2`);
    assert.equal(sheet.images?.length, 1, stderr(sheet));
    assert.match(stdout(sheet), /8 frames from 0:00 to 0:08/);
    assert.match(stdout(sheet), /Sheet 1 of 1: 8 frames, 0:00 to 0:07/);
    assert.equal(sheet.images![0]!.mime, 'image/jpeg');

    const frames = await sh(t, `cd ${rel} && sfa-view frames clip.mp4 --at 1,0:05.5`);
    assert.equal(frames.images?.length, 2, stderr(frames));
    assert.match(stdout(frames), /clip\.mp4 at 0:05\.5/);

    const crop = await sh(t, `cd ${rel} && sfa-view crop clip.mp4@2 10,10,100,50 --zoom 2`);
    assert.equal(crop.images?.length, 1, stderr(crop));
    assert.deepEqual(size(crop.images![0]!.data), [200, 100]);
  });

  test('diff shows both side by side and the changed pixels', async () => {
    const t = await tools();
    const r = await sh(t, `cd ${rel} && sfa-view diff a.png b.png`);
    assert.equal(r.images?.length, 2, stderr(r));
    assert.match(stdout(r), /^\d+ pixels differ\./);
    assert.ok(Number(/^(\d+)/.exec(stdout(r))![1]) > 1000);
  });

  test('pdf pages become images', async (ctx) => {
    if (!fs.existsSync(path.join(media, 'doc.pdf'))) return ctx.skip('ImageMagick may not write PDFs here');
    const t = await tools();
    const r = await sh(t, `cd ${rel} && sfa-view pdf doc.pdf --pages 1-2; sfa-view pdf doc.pdf --pages 5`);
    assert.equal(r.images?.length, 2, stderr(r));
    assert.match(stdout(r), /doc\.pdf page 2 of 2/);
    assert.match(stderr(r), /--pages is outside 1-2/);
  });

  test('transcript goes through SF Agents\' speech to text, 30 seconds at a time', async () => {
    const heard: number[] = [];
    const t = await tools({}, async (wav) => (heard.push(wav.length), 'a steady tone'));
    const r = await sh(t, `cd ${rel} && sfa-view transcript clip.mp4`);
    assert.equal(stdout(r).trim(), '[0:00] a steady tone', stderr(r));
    assert.equal(heard.length, 1);
    assert.ok(heard[0]! > 16000 * 2 * 7, 'about 8 seconds of 16 kHz mono');
    const none = await sh(await tools(), `cd ${rel} && sfa-view transcript clip.mp4`);
    assert.match(stderr(none), /Speech to text is not available/);
  });

  test('the per-call image limit refuses before the work, with a hint', async () => {
    const t = await tools({ limits: { viewImages: 2 } });
    const r = await sh(t, `cd ${rel} && sfa-view image a.png b.png big.png; sfa-view sheet clip.mp4 --every 0.2s --grid 2x2; sfa-view image a.png b.png; sfa-view image a.png`);
    assert.match(stderr(r), /That is 3 images, and this call may show 2 more/);
    assert.match(stderr(r), /40 frames, 10 sheets of 2x2, and this call may show 2 more images/);
    assert.match(stderr(r), /That is 1 images, and this call may show 0 more/);
    assert.equal(r.images?.length, 2, 'only the call that fit');
  });

  test('the model gets the images right after the results, and again when the conversation is replayed', async () => {
    const dir = makeTempDir();
    writeAgent(dir, baseAgent('main'));
    const tree = loadAgentTree(dir);
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const { factory, providers } = scriptedFactory((_req, n) =>
      n === 0 ? { toolCalls: [{ name: 'shell', args: { command: `cd ${rel} && sfa-view image a.png` } }, { name: 'shell', args: { command: 'echo hi' } }] } : { text: 'a white box' },
    );
    const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
    runtimes.push(runtime);
    await runtime.createSession().run('look at a.png');
    await runtime.createSession().run('and again?');
    const requests = providers.get('main')!.requests;
    for (const req of [requests[1]!, requests[2]!]) {
      const messages = req.messages as ChatMessage[];
      const tools = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
      const images = messages[tools.at(-1)! + 1]!;
      assert.equal(images.role, 'user');
      const parts = images.content as UserContentPart[];
      assert.match((parts[0] as { text: string }).text, /^\[Images from your tool call, in order:\n1\. a\.png \(call /);
      assert.equal(parts.filter((p) => p.type === 'image_url').length, 1);
      assert.match((parts[1] as { image_url: { url: string } }).image_url.url, /^data:image\/png;base64,/);
    }
    conversation.close();
  });
});
