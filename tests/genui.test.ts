import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ArtifactError, ConversationService, loadAgentTree, parseConversation, runArtifactRequest, serializeConversation, validateGenui, type ChatMessage } from '@sfagents/core';
import { WebServer } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent, type Script } from './helpers.js';

const VIEW = {
  version: 1,
  title: 'Plans',
  state: { plan: 'pro', seats: 3 },
  data: { plans: [{ id: 'basic', name: 'Basic', price: 10 }, { id: 'pro', name: 'Pro', price: 25 }] },
  view: {
    type: 'layout',
    kind: 'card',
    title: 'Choose a plan',
    children: [
      { type: 'text', format: 'math', value: 'E = mc^2' },
      { type: 'control', kind: 'segmented', bind: { $: 'state.plan' }, options: [{ label: 'Basic', value: 'basic' }, { label: 'Pro', value: 'pro' }] },
      { type: 'control', kind: 'slider', label: 'Seats', bind: { $: 'state.seats' }, min: 1, max: 20 },
      { type: 'table', columns: [{ key: 'name', label: 'Plan', sortable: true }, { key: 'price', format: 'currency' }], rows: { $: 'data.plans' }, selectable: true, bind: { $: 'state.plan' } },
      { type: 'chart', kind: 'bar', data: { $: 'data.plans' }, x: 'name', series: [{ y: 'price', label: 'Price' }] },
      { type: 'layout', kind: 'popover', label: 'Details', children: [{ type: 'text', value: { $op: 'concat', args: ['Seats: ', { $: 'state.seats' }] } }] },
      { type: 'layout', kind: 'carousel', children: [{ type: 'text', value: 'One' }, { type: 'text', value: 'Two' }] },
      { type: 'text', value: { $: 'item.name' }, repeat: { $: 'data.plans' }, key: 'id', when: { $op: 'gt', args: [{ $: 'item.price' }, 5] } },
      { type: 'control', kind: 'button', label: 'Use it', style: 'primary', on: { click: [{ do: 'send', text: { $op: 'concat', args: ['Go with ', { $: 'state.plan' }] } }, { do: 'set', path: 'state.sent', value: true }] } },
    ],
  },
};

function project() {
  const dir = makeTempDir('sfagents-genui-');
  writeAgent(dir, { ...baseAgent('main') });
  fs.mkdirSync(path.join(dir, 'genui'));
  return dir;
}

function open(dir: string) {
  const tree = loadAgentTree(dir);
  return { tree, conversation: ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir }) };
}

/** A workspace that allows everything under `dir` (the checks are tested elsewhere). */
function workspace(dir: string) {
  return {
    check: (p: string) => {
      const resolvedPath = path.resolve(dir, p);
      return { ok: resolvedPath.startsWith(dir), resolvedPath };
    },
  } as unknown as Parameters<typeof runArtifactRequest>[1];
}

describe('GenUI: the format', () => {
  test('a view using every node type is valid', () => {
    assert.deepEqual(validateGenui(VIEW), []);
  });

  test('mistakes are named with where they are', () => {
    const bad = (view: unknown, extra: Record<string, unknown> = {}) => validateGenui({ version: 1, view, ...extra }).join('\n');
    assert.match(bad({ type: 'map' }), /view\.type: must be one of layout, text, control, table, chart \(not "map"\)/);
    assert.match(bad({ type: 'text', value: 'x', html: '<b>' }), /view\.html: a text has no "html"/);
    assert.match(bad({ type: 'text', value: { $: 'window.location' } }), /view\.value: "window\.location" is not a path/);
    assert.match(bad({ type: 'control', kind: 'text' }), /needs "bind"/);
    assert.match(bad({ type: 'control', kind: 'select', bind: { $: 'state.x' } }), /needs "options"/);
    assert.match(bad({ type: 'control', kind: 'button', on: { click: [{ do: 'open', url: 'javascript:alert(1)' }] } }), /only http:\/\/ and https:\/\/ links/);
    assert.match(bad({ type: 'control', kind: 'button', on: { click: [{ do: 'set', path: 'data.x', value: 1 }] } }), /must be a path in state/);
    assert.match(bad({ type: 'control', kind: 'button', on: { click: [{ do: 'shell', command: 'rm' }] } }), /\.do: must be one of set, toggle, send, copy, open/);
    assert.match(bad({ type: 'text', value: 'x', children: [] }), /only a layout has children/);
    assert.match(bad({ type: 'layout', kind: 'popover', children: [] }), /a popover needs "label"/);
    assert.match(bad({ type: 'text', value: 'x', on: { click: [] } }), /a text has no events/);
    assert.match(bad({ type: 'text', value: 'x' }, { script: 'x' }), /script: unknown field/);
    assert.match(validateGenui({ version: 2, view: { type: 'text', value: 'x' } }).join('\n'), /version: must be 1/);
    assert.match(validateGenui([]).join('\n'), /one JSON object/);
  });
});

describe('GenUI: sf-artifact, saving and records', () => {
  test('sf-artifact checks a view and refuses one with mistakes', () => {
    const dir = project();
    const { conversation } = open(dir);
    const ws = workspace(dir);
    assert.throws(
      () => runArtifactRequest(conversation, ws, { title: 'Broken', path: 'genui/broken.json', content: '{"version":1,"view":{"type":"map"}}' }, { cwd: dir }),
      (e: unknown) => e instanceof ArtifactError && /not a valid GenUI view[\s\S]*view\.type/.test(e.message),
    );
    assert.equal(conversation.artifacts().length, 0, 'nothing is shown until the view is valid');
    assert.match(runArtifactRequest(conversation, ws, { title: 'Plans', path: 'genui/plans.json', content: JSON.stringify(VIEW) }, { cwd: dir }), /Created artifact/);
    const v = conversation.artifacts()[0]!;
    assert.equal(v.type, 'genui');
    // After an edit, --id alone checks it again.
    fs.writeFileSync(path.join(dir, 'genui', 'plans.json'), '{"version":1,');
    assert.throws(() => runArtifactRequest(conversation, ws, { id: v.id }, { cwd: dir }), /not valid JSON/);
    fs.writeFileSync(path.join(dir, 'genui', 'plans.json'), JSON.stringify(VIEW));
    assert.match(runArtifactRequest(conversation, ws, { id: v.id }, { cwd: dir }), /is a valid GenUI view/);
    // Files outside genui/ are not views and are not checked.
    assert.match(runArtifactRequest(conversation, ws, { title: 'Data', path: 'data.json', content: '{"view":1}' }, { cwd: dir }), /Created artifact/);
    conversation.close();
  });

  test('a view is saved with its bookmark; pinning saves it, unsaving unpins; both survive reopening', () => {
    const dir = project();
    let { conversation } = open(dir);
    fs.writeFileSync(path.join(dir, 'genui', 'plans.json'), JSON.stringify(VIEW));
    const a = conversation.linkArtifact({ title: 'Plans', file: path.join(dir, 'genui', 'plans.json') });
    assert.equal(a.saved, false);
    conversation.setArtifactSaved(a.id, true);
    conversation.setArtifactSaved(a.id, true); // no record
    conversation.setArtifactPinned(a.id, true);
    conversation.close();
    ({ conversation } = open(dir));
    let v = conversation.state.artifactViews.get(a.id)!;
    assert.deepEqual([v.saved, v.pinned], [true, true]);
    conversation.setArtifactSaved(a.id, false);
    v = conversation.state.artifactViews.get(a.id)!;
    assert.deepEqual([v.saved, v.pinned], [false, false]);
    conversation.setArtifactPinned(a.id, true);
    assert.equal(conversation.state.artifactViews.get(a.id)!.saved, true, 'pinning a view saves it');
    assert.equal(conversation.state.records.filter((r) => r.kind === 'artifact_pin').length, 4);
    // The records round-trip through the Markdown.
    const text = serializeConversation(conversation.state.records);
    assert.match(text, /"saved":false/);
    const pins = parseConversation(text).records.filter((r) => r.kind === 'artifact_pin') as Array<{ pinned: boolean; saved?: boolean }>;
    assert.deepEqual(pins.map((r) => [r.pinned, r.saved]), [[false, true], [true, undefined], [false, false], [true, true]]);
    const doc = conversation.linkArtifact({ title: 'Doc', file: path.join(dir, 'genui', '..', 'agents', 'main.json') });
    assert.throws(() => conversation.setArtifactSaved(doc.id, true), /not a GenUI view/);
    conversation.close();
  });
});

function request(base: string, pathname: string, method = 'GET', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { Host: u.host, 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('GenUI: the web server', () => {
  test('views are read checked, keep the person’s state in the file, save, and send messages marked as from them', async () => {
    const dir = project();
    const { tree, conversation } = open(dir);
    const file = path.join(dir, 'genui', 'plans.json');
    fs.writeFileSync(file, JSON.stringify(VIEW));
    const a = conversation.linkArtifact({ title: 'Plans', file });
    fs.writeFileSync(path.join(dir, 'genui', 'broken.json'), '{"version":1,"view":{"type":"map"}}');
    const broken = conversation.linkArtifact({ title: 'Broken', file: path.join(dir, 'genui', 'broken.json') });
    const seen: ChatMessage[][] = [];
    const script: Script = (req) => {
      seen.push([...req.messages]);
      return { text: 'Pro it is.' };
    };
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(script).factory, watchAgents: false, auth: false });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const view = await request(base, `/api/artifacts/${a.id}/view`);
      assert.equal(view.status, 200);
      assert.deepEqual((view.json.doc as { state: unknown }).state, { plan: 'pro', seats: 3 });
      const bad = await request(base, `/api/artifacts/${broken.id}/view`);
      assert.equal(bad.json.doc, undefined);
      assert.match(String((bad.json.errors as string[])[0]), /view\.type/);
      assert.equal((await request(base, '/api/artifacts/a999/view')).status, 404);

      // The person's changes go into the file, and nothing else in it changes.
      assert.equal((await request(base, `/api/artifacts/${a.id}/state`, 'POST', { state: { plan: 'basic', seats: 7 } })).status, 200);
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(written.state, { plan: 'basic', seats: 7 });
      assert.deepEqual(written.view, VIEW.view);
      assert.equal((await request(base, `/api/artifacts/${a.id}/state`, 'POST', { state: [1] })).status, 400);
      assert.equal((await request(base, `/api/artifacts/${a.id}/state`, 'POST', { state: { 'bad-name': 1 } })).status, 400);

      // The bookmark.
      assert.equal((await request(base, `/api/artifacts/${a.id}/save`, 'POST', { saved: true })).status, 200);
      const list = (await request(base, '/api/artifacts')).json.artifacts as Array<{ id: string; saved?: boolean }>;
      assert.equal(list.find((x) => x.id === a.id)!.saved, true);

      // A button's message: stored as from the view, with its state, and the model is told.
      assert.equal((await request(base, '/api/messages', 'POST', { text: 'Go with basic', view: a.id })).status, 202);
      assert.equal((await request(base, '/api/messages', 'POST', { text: 'x', view: 'a999' })).status, 404);
      for (let i = 0; i < 80 && !conversation.state.messages.some((m) => m.role === 'assistant'); i++) await new Promise((r) => setTimeout(r, 50));
      const user = conversation.state.messages.find((m) => m.role === 'user')!;
      assert.equal(user.view, a.id);
      assert.equal(user.viewState, '{"plan":"basic","seats":7}');
      const said = JSON.stringify(seen[0]);
      assert.match(said, new RegExp(`\\[Sent from the GenUI view ${a.id} \\\\"Plans\\\\" with one of its buttons\\. Its state then: \\{\\\\"plan\\\\":\\\\"basic\\\\",\\\\"seats\\\\":7\\}\\]`));
      assert.match(said, /Go with basic/);
      const items = (await request(base, '/api/state')).json.items as Array<{ kind: string; view?: string }> | undefined;
      if (items) assert.equal(items.find((x) => x.kind === 'user')!.view, a.id);
      // The guidance tells the agent how to write views.
      assert.match((seen[0]![0] as { content: string }).content, /<genui_guidance>/);
    } finally {
      await server.close();
      conversation.close();
    }
  });
});
