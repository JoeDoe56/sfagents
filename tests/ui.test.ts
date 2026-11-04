import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UiService, runUiCommand, riskyControl, type UiAdapter, type UiDecider, type UiGrant, type DecisionAnswer } from '@sfagents/core';

const control = { id: '1', name: 'Editor', role: 'text', actions: ['set_value'], value: '' };
const signal = () => new AbortController().signal;

test('the decision loop only types supplied values, verifies changes and verifies DONE', async () => {
  let text = ''; const operations: Record<string, unknown>[] = [];
  const adapter: UiAdapter = { request: async (p) => {
    operations.push(p);
    if (p.op === 'act') { text = String(p.value); return { text: 'ok' }; }
    return { controls: [{ ...control, value: text }] };
  } };
  let calls = 0;
  const decider: UiDecider = { decide: async (_s, q): Promise<Record<string, DecisionAnswer>> => {
    calls++;
    if (q.done) return { done: { noul: .99 } };
    if (q.action) return { action: { choice: 'set_value', confidence: .99 } };
    return { control: { choice: text ? 'DONE' : '1', confidence: .99 } };
  } };
  const service = new UiService(decider);
  const result = await service.task(adapter, 'app', 'Type exact text', { Editor: 'Exact user text' }, async () => true, signal());
  assert.equal(JSON.parse(result.text).status, 'done'); assert.equal(text, 'Exact user text'); assert.equal(calls, 4);
  assert.equal(operations.find((p) => p.op === 'act')?.expectedName, 'Editor');
});

test('uncertain choices retry with a screenshot then hand back without acting', async () => {
  let calls = 0; const imageCounts: number[] = [];
  const adapter: UiAdapter = { request: async (p) => { assert.notEqual(p.op, 'act'); return p.op === 'screenshot' ? { image: { mime: 'image/png', data: 'AA==' } } : { controls: [control] }; } };
  const service = new UiService({ decide: async (_s, _q, images) => { calls++; imageCounts.push(images.length); return { control: { choice: '1', confidence: .5 } }; } });
  const result = await service.task(adapter, 'app', 'test', {}, async () => true, signal());
  assert.equal(JSON.parse(result.text).status, 'handoff'); assert.equal(calls, 2); assert.deepEqual(imageCounts, [0, 1]); assert.ok(result.image);
});

test('the agent\'s own container never asks; host passwords and risky buttons ask, and denied actions do not execute', async () => {
  assert.equal(riskyControl({ ...control, name: 'Publish' }), true);
  let actions = 0; let approvals = 0;
  const adapter: UiAdapter = { request: async (p) => p.op === 'act' || p.op === 'click' ? (actions++, { text: 'ok' }) : { controls: [{ ...control, password: true }] } };
  const service = new UiService({ decide: async () => ({}) });
  const grant: UiGrant = { container: adapter, service };
  const typed = await runUiCommand(grant, ['act', 'app', '1', 'set_value', 'test-password'], { signal: signal() });
  assert.equal(typed.ok, true); assert.equal(actions, 1);
  const clicked = await runUiCommand(grant, ['click', 'app', '10', '20'], { signal: signal() });
  assert.equal(clicked.ok, true); assert.equal(actions, 2);
  const denied = await service.act(adapter, { app: 'app', id: '1', action: 'set_value', value: 'secret-value' }, async (q) => { approvals++; assert.doesNotMatch(q, /secret-value/); return false; }, signal()).then(() => true, () => false);
  assert.equal(denied, false); assert.equal(approvals, 1); assert.equal(actions, 2);
  const host = await runUiCommand(grant, ['--host', 'tree', 'app'], { signal: signal() });
  assert.equal(host.ok, false);
  const container = await runUiCommand(grant, ['tree', 'app'], { signal: signal() }); assert.equal(container.ok, true);
});

test('unsupported model actions, missing text values and no-op loops never invent actions or text', async () => {
  let actions = 0;
  const adapter: UiAdapter = { request: async (p) => { if (p.op === 'act') actions++; return { controls: [control] }; } };
  const service = new UiService({ decide: async (_s, q): Promise<Record<string, DecisionAnswer>> => q.action ? { action: { choice: 'set_value', confidence: 1 } } : { control: { choice: '1', confidence: 1 } } });
  const result = await service.task(adapter, 'app', 'type', {}, async () => true, signal());
  assert.match(result.text, /Provide text through/); assert.equal(actions, 0);
  const unknown = await new UiService({ decide: async () => ({ control: { choice: 'bogus', confidence: 1 } }) }).task(adapter, 'app', 'test', {}, async () => true, signal());
  assert.equal(JSON.parse(unknown.text).status, 'handoff'); assert.equal(actions, 0);
});

test('native errors, including an empty error string, cannot be reported as successful actions', async () => {
  const service = new UiService({ decide: async () => ({}) });
  const adapter: UiAdapter = { request: async (p) => p.op === 'act' ? { error: '' } : { controls: [control] } };
  await assert.rejects(service.act(adapter, { app: 'app', id: '1', action: 'set_value', value: 'x' }, async () => true, signal()), /Native UI operation failed/);
});
