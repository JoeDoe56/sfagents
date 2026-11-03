import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FullControlManager, RollbackJournal, AgentRuntime, ConversationService, loadAgentTree, UiService, AppSettings, ProviderRegistry, MemorySecretStore, runHostShell, withStepContext } from '@sfagents/core';
import { WebServer } from '@sfagents/web';
import { makeTempDir, baseAgent, writeAgent, scriptedFactory } from './helpers.js';

function setup(confirm: 'allow_once' | 'allow_always' | 'deny' = 'allow_once') {
  const folder = makeTempDir(); const owner = {};
  const manager = new FullControlManager({ minutes: () => 1, confirm: async () => confirm, journal: new RollbackJournal(path.join(makeTempDir(), 'journal')) });
  const plan = { reason: 'Test', plan: 'Edit one file', folders: [folder] };
  return { manager, folder, owner, plan, signal: new AbortController().signal };
}

test('only one main run, explicit one-time approval, and a bounded lifetime unlock the host', async (t) => {
  const s = setup();
  await assert.rejects(s.manager.request(s.owner, ['main', 'child'], false, s.plan, s.signal), /Only the main/);
  assert.throws(() => s.manager.require(s.owner), /No full-control/);
  const denied = setup('allow_always');
  assert.match(await denied.manager.request(denied.owner, ['main'], true, denied.plan, denied.signal), /denied/);
  assert.equal(denied.manager.status(), null);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await s.manager.request(s.owner, ['main'], true, s.plan, s.signal);
  const lease = s.manager.require(s.owner);
  assert.throws(() => s.manager.require({}), /No full-control/);
  assert.match(s.manager.context(s.owner), /1m 0s/);
  await assert.rejects(s.manager.request({}, ['other'], true, s.plan, s.signal), /already active/);
  t.mock.timers.tick(60_001);
  assert.equal(lease.aborted, true);
  assert.equal(s.manager.status(), null);
  assert.equal(s.manager.journal.list()[0]?.reason, 'time limit');
});

test('stop and idle revoke a session, and rollback detects later edits before changing anything', async () => {
  const s = setup();
  const old = path.join(s.folder, 'old.txt'); const added = path.join(s.folder, 'new.txt'); const deleted = path.join(s.folder, 'deleted.txt');
  fs.writeFileSync(old, 'before'); fs.writeFileSync(deleted, 'restore'); fs.writeFileSync(path.join(s.folder, '.env'), 'never-copy-this');
  await s.manager.request(s.owner, ['main'], true, s.plan, s.signal);
  const lease = s.manager.require(s.owner); const id = s.manager.status()!.id;
  fs.writeFileSync(old, 'after'); fs.writeFileSync(added, 'added'); fs.unlinkSync(deleted);
  s.manager.endRun({}); assert.equal(lease.aborted, false);
  s.manager.endRun(s.owner); assert.equal(lease.aborted, true);
  assert.equal(s.manager.journal.diff(id).length, 3);
  assert.equal(s.manager.journal.read(id).before.some((f) => f.path.endsWith('.env')), false);
  fs.writeFileSync(old, 'later edit');
  assert.throws(() => s.manager.journal.undo(id), /Changed since/);
  assert.equal(fs.readFileSync(added, 'utf8'), 'added');
  fs.writeFileSync(old, 'after'); s.manager.journal.undo(id);
  assert.equal(fs.readFileSync(old, 'utf8'), 'before');
  assert.equal(fs.existsSync(added), false); assert.equal(fs.readFileSync(deleted, 'utf8'), 'restore');
});

test('Stop cancels a running host command, including its process tree', async () => {
  const s = setup(); await s.manager.request(s.owner, ['main'], true, s.plan, s.signal);
  const lease = s.manager.require(s.owner); const started = Date.now();
  const timer = setTimeout(() => s.manager.stop(), 150);
  try {
    const out = await runHostShell(process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', s.folder, undefined, lease, []);
    assert.match(out, /session stopped/);
    assert.ok(Date.now() - started < 10_000, 'the command must not run to its original timeout');
  } finally { clearTimeout(timer); s.manager.stop(); }
});

test('message requests are never auto-approved by --yes; a completed main run ends the lease', async () => {
  const folder = makeTempDir(); writeAgent(folder, baseAgent('main'));
  const tree = loadAgentTree(folder); const conversation = ConversationService.memory(folder);
  let approvals = 0;
  const factory = scriptedFactory((_req, n) => n === 0 ? { toolCalls: [{ name: 'message', args: { action: 'full_control', reason: 'test', plan: 'inspect temp folder', folders: [folder] } }] } : { text: 'done' });
  const manager = new FullControlManager({ minutes: () => 1, confirm: async () => { approvals++; return 'allow_once'; }, journal: new RollbackJournal(path.join(makeTempDir(), 'journal')) });
  const runtime = new AgentRuntime({ tree, conversation, approveAll: true, providerFactory: factory.factory, fullControl: manager });
  try {
    for await (const _e of runtime.createSession().send('test')) { /* drain */ }
    assert.equal(approvals, 1);
    assert.equal(manager.status(), null);
    assert.equal(manager.journal.list()[0]?.reason, 'agent idle');
  } finally { await runtime.dispose(); }
});

test('web approval, banner events, host shell, file review and undo work together', async () => {
  const folder = makeTempDir(); writeAgent(folder, baseAgent('main'));
  const tree = loadAgentTree(folder);
  const conversation = ConversationService.open(path.join(folder, '.sfagents', 'conversation.md'), { configDir: folder });
  const home = makeTempDir(); const file = path.join(folder, 'host-result.txt');
  const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(true) });
  const states: Array<unknown> = [];
  const factory = scriptedFactory((_r, n) => n === 0 ? { toolCalls: [{ name: 'message', args: { action: 'full_control', reason: 'Test host file', plan: 'Write a disposable test file', folders: [folder] } }] }
    : n === 1 ? { toolCalls: [{ name: 'shell', args: { target: 'host', command: process.platform === 'win32' ? `[IO.File]::WriteAllText('${file.replace(/'/g, "''")}','hello')` : `printf hello > '${file.replace(/'/g, "'\\''")}'` } }] } : { text: 'done' });
  const server = new WebServer({ tree, conversation, port: 0, auth: false, enablePushToTalk: false, providerFactory: factory.factory, registry, settings: new AppSettings(home), ui: new UiService({ decide: async () => ({}) }) });
  const unsubscribe = server.subscribe((event, data: any) => {
    if (event === 'approval' && data.approval.tool === 'full_control') setImmediate(() => server.answer(data.approval.id, 'allow_once'));
    if (event === 'full-control') states.push(data.status);
  });
  try {
    await server.start(); server.sendMessage('Run the host test'); await server.idle();
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
    assert.equal(states.length, 2); assert.equal(states[1], null);
    const status = (await server.request('GET', '/api/full-control')).json as any;
    const id = status.journals[0].id;
    const diff = (await server.request('GET', `/api/full-control-diff?id=${id}`)).json as any;
    assert.equal(diff.files.some((f: any) => f.path.includes('conversation.md')), false, 'history is never part of rollback');
    assert.ok(diff.files.some((f: any) => f.path === file && f.afterText === 'hello'));
    assert.equal((await server.request('POST', '/api/full-control', { action: 'undo', id })).status, 200);
    assert.equal(fs.existsSync(file), false);
  } finally { unsubscribe(); await server.close(); conversation.close(); registry.close(); }
});

test('the countdown goes on the newest message, so the system prompt stays the same between steps', () => {
  const messages = [{ role: 'system' as const, content: 'prompt' }, { role: 'user' as const, content: 'hi' }, { role: 'tool' as const, tool_call_id: 'a', content: 'out' }];
  const first = withStepContext(messages, 'Network level now: on', 'Full control: 4m 59s left.');
  const second = withStepContext(messages, 'Network level now: on', 'Full control: 4m 30s left.');
  assert.equal(first[0]!.content, second[0]!.content);
  assert.match(String(first.at(-1)!.content), /4m 59s left/);
  assert.equal(messages[2]!.content, 'out', 'stored messages are not changed');
  assert.equal(withStepContext(messages, 'x').at(-1)!.content, 'out');
});
