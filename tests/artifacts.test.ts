import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  ArtifactError,
  ConfigError,
  ConversationService,
  estimateMessages,
  IMAGE_TOKEN_ESTIMATE,
  loadAgentTree,
  parseConversation,
  readConversation,
  safeFilename,
  serializeConversation,
  type ChatMessage,
  type FunctionDeclaration,
} from '@sfagents/core';
import { baseAgent, lastToolContent, makeTempDir, runCli, scriptedFactory, writeJson, type Script, writeAgent, catFile, useAnySandbox } from './helpers.js';

const realSandbox = await useAnySandbox();

function project(agent: Record<string, unknown> = {}, files: Record<string, unknown> = {}) {
  const dir = makeTempDir();
  writeAgent(dir, { ...baseAgent('main'), ...agent });
  for (const [f, v] of Object.entries(files)) writeJson(path.join(dir, f), v);
  return dir;
}

function open(dir: string) {
  const tree = loadAgentTree(dir);
  return { tree, conversation: ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir }) };
}

describe('artifacts: storage and records', () => {
  test('create, update, pin and reopen; every revision is kept', () => {
    const dir = project();
    let { conversation } = open(dir);
    const a = conversation.createArtifact({ title: 'Launch plan', filename: 'plan.md', content: '# Plan v1' });
    assert.equal(a.type, 'document');
    assert.equal(a.mime, 'text/markdown');
    assert.equal(a.rev, 1);
    const b = conversation.createArtifact({ title: 'Logo', filename: 'logo.svg', content: '<svg/>' });
    assert.equal(b.type, 'image');
    const updated = conversation.updateArtifact(a.id, { content: '# Plan v2', title: 'Launch plan (final)' });
    assert.equal(updated.rev, 2);
    conversation.setArtifactPinned(b.id, true);
    conversation.setArtifactPinned(b.id, true); // no-op, no record
    conversation.close();

    ({ conversation } = open(dir));
    const views = conversation.artifacts();
    assert.deepEqual(views.map((v) => [v.id, v.title, v.rev, v.pinned]), [
      [a.id, 'Launch plan (final)', 2, false],
      [b.id, 'Logo', 1, true],
    ]);
    assert.equal(conversation.artifactContent(a.id).data.toString(), '# Plan v2');
    assert.equal(conversation.artifactContent(a.id, 1).data.toString(), '# Plan v1');
    assert.equal(conversation.state.records.filter((r) => r.kind === 'artifact_pin').length, 1);
    assert.ok(fs.existsSync(path.join(dir, '.sfagents', 'artifacts', a.id, 'r1', 'plan.md')));
    assert.ok(fs.existsSync(path.join(dir, '.sfagents', 'artifacts', a.id, 'r2', 'plan.md')));
    assert.throws(() => conversation.updateArtifact('a999', { content: 'x' }), ArtifactError);
    assert.throws(() => conversation.artifactContent(a.id, 3), /revisions 1 to 2/);
    conversation.close();
  });

  test('conversation artifacts lists the latest revision and pins', async () => {
    const dir = project();
    const { conversation } = open(dir);
    const a = conversation.createArtifact({ title: 'Plan', filename: 'plan.md', content: 'v1' });
    conversation.updateArtifact(a.id, { content: 'v2' });
    conversation.setArtifactPinned(a.id, true);
    conversation.close();
    const r = await runCli(['conversation', 'artifacts'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${a.id}  document  Plan  rev 2  pinned  artifacts/${a.id}/r2/plan.md`));
  });

  test('records round-trip and invalid revisions or pins are rejected', () => {
    const dir = project();
    const { conversation } = open(dir);
    const a = conversation.createArtifact({ title: 'T', filename: 'x.txt', content: 'x' });
    conversation.updateArtifact(a.id, { content: 'y' });
    conversation.setArtifactPinned(a.id, true);
    const text = fs.readFileSync(conversation.file!, 'utf8');
    conversation.close();
    const parsed = parseConversation(text);
    assert.equal(serializeConversation(parsed.records).length > 0, true);
    assert.match(text, /<!-- sfa:artifact_update \{.*"rev":2/);
    assert.match(text, /<!-- sfa:artifact_pin \{.*"pinned":true/);
    // A skipped revision and a pin of an unknown artifact are semantic errors.
    const bad = text + `\n<!-- sfa:artifact_update {"seq":${parsed.records.length + 1},"time":"2026-01-01T00:00:00Z","artifact":"${a.id}","rev":5} -->\n`;
    fs.writeFileSync(conversation.file!, bad);
    assert.throws(() => readConversation(conversation.file!), /revision 5 does not follow revision 2/);
  });

  test('file names are sanitized and stay inside the state directory', () => {
    assert.equal(safeFilename('../../etc/passwd'), 'passwd');
    assert.equal(safeFilename('..\\..\\evil.md'), 'evil.md');
    assert.equal(safeFilename('a:b*c?.txt'), 'a_b_c_.txt');
    assert.equal(safeFilename('CON.txt'), '_CON.txt');
    assert.equal(safeFilename('...'), 'artifact.txt');
    const dir = project();
    const { conversation } = open(dir);
    const v = conversation.createArtifact({ title: 'x', filename: '../../outside.md', content: 'x' });
    assert.equal(v.path, `artifacts/${v.id}/r1/outside.md`);
    assert.equal(fs.existsSync(path.join(dir, 'outside.md')), false);
    assert.equal(conversation.readManaged('../agent.json'), undefined);
    conversation.close();
  });
});

describe('artifacts: model tools and grants', () => {
  test('artifacts are the files themselves: created with or without content, they follow the file', async () => {
    const dir = project({ tools: { allow: [] } });
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'existing.csv'), 'a,b\n1,2\n');
    const { tree, conversation } = open(dir);
    const script: Script = (req, call) => {
      const id = conversation.artifacts().find((v) => v.title.startsWith('Haiku'))?.id;
      switch (call) {
        case 0:
          return { toolCalls: [{ name: 'create_artifact', args: { title: 'Haiku', path: 'haiku.md', content: 'old pond' } }] };
        case 1:
          return { toolCalls: [{ name: 'create_artifact', args: { title: 'Numbers', path: 'docs/existing.csv' } }] };
        case 2:
          return { text: `Done: ${lastToolContent(req)}` };
        case 3:
          return { toolCalls: [{ name: 'create_artifact', args: { id, content: 'old pond\nfrog jumps in' } }] };
        case 4:
          return { toolCalls: [{ name: 'create_artifact', args: { id, title: 'Haiku (two lines)' } }] };
        case 5:
          return { toolCalls: [{ name: 'create_artifact', args: { title: 'Outside', path: '../elsewhere.md', content: 'x' } }] };
        default:
          return { text: 'ok' };
      }
    };
    const { factory, providers } = scriptedFactory(script);
    const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
    const session = runtime.createSession();
    const r1 = await session.run('Write a haiku and show the numbers');
    assert.match(r1.text, /Created artifact a\d+ "Numbers" shows docs\/existing.csv/);
    // The file is written where the agent said, and nothing is copied.
    assert.equal(fs.readFileSync(path.join(dir, 'haiku.md'), 'utf8'), 'old pond');
    assert.equal(fs.existsSync(path.join(dir, '.sfagents', 'artifacts')), false, 'no managed copies');
    const haiku = conversation.artifacts().find((v) => v.title === 'Haiku')!;
    assert.deepEqual([haiku.file, haiku.type, haiku.rev], ['haiku.md', 'document', 1]);
    const numbers = conversation.artifacts().find((v) => v.title === 'Numbers')!;
    assert.deepEqual([numbers.file, numbers.type], ['docs/existing.csv', 'data']);
    // create_artifact with "id" writes the artifact's file and retitles it.
    await session.run('Add a second line');
    const requests = providers.get('main')!.requests;
    assert.equal(fs.readFileSync(path.join(dir, 'haiku.md'), 'utf8'), 'old pond\nfrog jumps in');
    assert.match(JSON.stringify(requests[4]!.messages), /Wrote the file of artifact/);
    const v = conversation.artifacts().find((x) => x.id === haiku.id)!;
    assert.deepEqual([v.title, v.rev, v.file], ['Haiku (two lines)', 2, 'haiku.md']);
    const firstTools = (requests[0]!.request.tools as FunctionDeclaration[]).map((t) => t.name);
    for (const n of ['create_artifact', 'create_app_artifact']) assert.ok(firstTools.includes(n), n);
    for (const n of ['update_artifact', 'list_artifacts', 'read_artifact']) assert.ok(!firstTools.includes(n), n);
    assert.match((requests[0]!.messages[0] as { content: string }).content, /<artifacts_guidance>/);
    assert.match((requests[3]!.messages[0] as { content: string }).content, new RegExp(`<artifacts>[\\s\\S]*\\[${haiku.id}\\] Haiku — haiku.md, document`));
    // Outside the agent's workspace: refused.
    await session.run('Write elsewhere');
    assert.match(JSON.stringify(requests[requests.length - 1]!.messages), /outside this agent's permitted workspace roots/);
    assert.equal(fs.existsSync(path.join(dir, '..', 'elsewhere.md')), false);
    const record = conversation.state.artifactById.get(haiku.id)!;
    assert.ok(record.callId && record.message, 'artifact records link to the requesting call and message');
    await runtime.dispose();
    conversation.close();
  });

  test('a folder is an artifact too: it opens in the file manager and has no content to read', async () => {
    const dir = project({ tools: { allow: [] } });
    fs.mkdirSync(path.join(dir, 'site', 'css'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<h1>hi</h1>');
    const { tree, conversation } = open(dir);
    const script: Script = (req, call) => {
      const id = conversation.artifacts().find((v) => v.title === 'Site')?.id;
      if (call === 0) return { toolCalls: [{ name: 'create_artifact', args: { title: 'Site', path: 'site' } }] };
      if (call === 1) return { toolCalls: [{ name: 'create_artifact', args: { id, path: 'site/index.html' } }, { name: 'create_artifact', args: { title: 'Bad', path: 'site/css', content: 'x' } }] };
      return { text: JSON.stringify((req.messages.filter((m) => m.role === 'tool') as Array<{ content: string }>).map((m) => m.content)) };
    };
    const { factory } = scriptedFactory(script);
    const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
    const r = await runtime.createSession().run('show the site folder');
    const site = conversation.artifacts().find((v) => v.title === 'Site')!;
    assert.deepEqual([site.type, site.file, site.mime], ['folder', 'site', 'inode/directory']);
    assert.match(r.text, /opens the folder in the file manager/);
    // A folder artifact cannot become a file one, and content cannot be written to a folder.
    assert.match(r.text, /shows a folder; create a new artifact/);
    assert.match(r.text, /EISDIR|is a directory|folder/i);
    assert.equal(conversation.artifacts().filter((v) => v.title === 'Bad').length, 0);
    assert.throws(() => conversation.artifactContent(site.id), /is a folder/);
    await runtime.dispose();
    conversation.close();
  });

  test('create_artifact writes without asking, inside the workspace rules; app artifacts record the address', async () => {
    const dir = project({ tools: { allow: [] } });
    const { tree, conversation } = open(dir);
    let asked = 0;
    const script: Script = (_req, call) =>
      call === 0
        ? {
            toolCalls: [
              { name: 'create_artifact', args: { title: 'Plan', path: 'plan.md', content: '# Plan' } },
              { name: 'create_app_artifact', args: { title: 'Prototype', port: 5173 } },
              { name: 'create_artifact', args: { title: 'Sneaky', path: 'agents/sneaky.json', content: '{}' } },
            ],
          }
        : { text: 'ok' };
    const runtime = new AgentRuntime({ tree, providerFactory: scriptedFactory(script).factory, conversation, confirm: async () => (asked++, 'allow_once') });
    await runtime.createSession().run('go');
    assert.equal(asked, 0, 'the workspace rules are the boundary');
    assert.equal(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), '# Plan');
    assert.equal(fs.existsSync(path.join(dir, 'agents', 'sneaky.json')), false, 'the agents folder is read-only');
    const app = conversation.artifacts().find((v) => v.type === 'app')!;
    assert.equal(app.url, 'http://127.0.0.1:5173/');
    assert.throws(() => conversation.artifactContent(app.id), /is an application/);
    await runtime.dispose();
    conversation.close();
    // Reopening keeps the file and the address.
    const again = open(dir).conversation;
    assert.deepEqual(again.artifacts().map((v) => [v.title, v.file ?? v.url]).sort(), [['Plan', 'plan.md'], ['Prototype', 'http://127.0.0.1:5173/']]);
    again.close();
  });

  test('agents in a thread have no artifact tools by default; "read" only sees the index', async () => {
    const dir = project({}, { 'agents/helper.json': baseAgent('helper') });
    const tree = loadAgentTree(dir);
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const runtime = new AgentRuntime({ tree, providerFactory: scriptedFactory(() => ({ text: 'x' })).factory, conversation });
    const inThread = await runtime.buildTools(tree.byId.get('helper')!, ['main', 'helper'], () => {}, undefined, conversation, 'thread');
    assert.equal([...inThread.keys()].some((k) => k.includes('artifact')), false);
    const asMain = await runtime.buildTools(tree.byId.get('helper')!, ['helper'], () => {}, undefined, conversation, 'main');
    assert.ok(asMain.has('create_artifact'), 'the same agent replying in the conversation creates artifacts');
    await runtime.dispose();
    conversation.close();

    const ro = project({ artifacts: { access: 'read' } });
    const t2 = loadAgentTree(ro);
    const c2 = ConversationService.open(path.join(ro, '.sfagents', 'conversation.md'), { configDir: t2.configDir });
    const rt2 = new AgentRuntime({ tree: t2, providerFactory: scriptedFactory(() => ({ text: 'x' })).factory, conversation: c2 });
    const names = [...(await rt2.buildTools(t2.root, ['main'], () => {}, undefined, c2)).keys()];
    assert.equal(names.some((k) => k.includes('artifact')), false);
    // ...but it still sees the index, and reads the files with the shell.
    fs.writeFileSync(path.join(ro, 'notes.md'), '# Notes');
    c2.linkArtifact({ title: 'Notes', file: path.join(ro, 'notes.md') });
    const seen = scriptedFactory(() => ({ text: 'ok' }));
    const rt3 = new AgentRuntime({ tree: t2, providerFactory: seen.factory, conversation: c2 });
    await rt3.createSession().run('what artifacts are there?');
    assert.match((seen.providers.get('main')!.requests[0]!.messages[0] as { content: string }).content, /<artifacts>[\s\S]*Notes — notes.md/);
    await rt3.dispose();
    await rt2.dispose();
    c2.close();

    const bad = project({ artifacts: { access: 'write' } }, { 'agents/ok.json': baseAgent('ok') });
    assert.match(loadAgentTree(bad).skipped[0]!.error, /must be "none", "read" or "create"/);
  });

  test('shell commands cannot reach artifact files', { skip: !realSandbox && 'no OS sandbox on this machine' }, async () => {
    const dir = project({ tools: { allow: ['shell'] } });
    const { tree, conversation } = open(dir);
    const v = conversation.createArtifact({ title: 'secret-ish', filename: 'n.md', content: 'hidden' });
    const target = path.join(dir, '.sfagents', v.path!);
    const script: Script = (req, call) => (call === 0 ? { toolCalls: [{ name: 'shell', args: { command: catFile(target) } }] } : { text: lastToolContent(req) ?? '' });
    const runtime = new AgentRuntime({ tree, providerFactory: scriptedFactory(script).factory, conversation });
    const r = await runtime.createSession().run('read it');
    assert.doesNotMatch(r.text, /hidden/);
    await runtime.dispose();
    conversation.close();
  });
});

describe('attachments', () => {
  test('images become image parts, text files are inlined, others are named; replay survives reopen', async () => {
    const dir = project();
    let { tree, conversation } = open(dir);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const img = conversation.addUpload('photo.png', 'image/png', png);
    const txt = conversation.addUpload('notes.txt', 'text/plain', Buffer.from('remember the milk'));
    const bin = conversation.addUpload('data.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 3]));
    const seen: ChatMessage[][] = [];
    const runtime = new AgentRuntime({
      tree,
      providerFactory: scriptedFactory((req) => {
        seen.push(req.messages as ChatMessage[]);
        return { text: 'seen' };
      }).factory,
      conversation,
    });
    await runtime.createSession().run('What is in these?', { attachments: [img, txt, bin] });
    const user = seen[0]!.find((m) => m.role === 'user')!;
    assert.ok(Array.isArray(user.content));
    const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    assert.equal(parts[0]!.type, 'text');
    assert.match(parts[0]!.text!, /What is in these\?/);
    assert.match(parts[0]!.text!, /<attachment name="notes.txt" type="text\/plain">\nremember the milk\n<\/attachment>/);
    assert.match(parts[0]!.text!, /"data.bin" .* cannot be shown to you/);
    assert.equal(parts[1]!.image_url!.url, `data:image/png;base64,${png.toString('base64')}`);
    // The stored body is unchanged; the attachments are references.
    const stored = conversation.state.messages.find((m) => m.role === 'user')!;
    assert.equal(stored.content, 'What is in these?');
    assert.deepEqual(stored.attachments!.map((a) => a.name), ['photo.png', 'notes.txt', 'data.bin']);
    await runtime.dispose();
    conversation.close();

    ({ tree, conversation } = open(dir));
    const history = conversation.history({ provider: 'openrouter', model: 'test/model' });
    assert.ok(Array.isArray(history[0]!.content));
    conversation.close();
  });

  test('image parts are estimated at a fixed cost, not their base64 size', () => {
    const big = 'A'.repeat(400_000);
    const tokens = estimateMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }] }]);
    assert.ok(tokens < IMAGE_TOKEN_ESTIMATE + 100, String(tokens));
  });
});
