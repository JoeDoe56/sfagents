import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition, AgentNode } from '@sfagents/core';
import { switchNote, accessChanges } from '@sfagents/web';

const node = (id: string, definition: Partial<AgentDefinition>, grants: Array<[string, number]> = []): AgentNode =>
  ({ id, file: `/agents/${id}.json`, definition: { network: 'on', ...definition } as AgentDefinition, grants: new Map(grants) });

describe('agent switch note', () => {
  test('names both agents and models, and lists access changes', () => {
    const a = node('main', { name: 'Main', network: 'on', folders: ['/p'] }, [['worker', 1]]);
    const b = node('quick', { name: 'Quick', network: 'pkg', artifacts: { access: 'read' } });
    const note = switchNote({ node: a, model: 'claude-opus', account: 'Claude' }, { node: b, model: 'gpt-mini', account: 'OpenAI' });
    assert.ok(note);
    assert.match(note, /from Main \(model claude-opus via Claude\) to Quick \(model gpt-mini via OpenAI\)/);
    assert.match(note, /- network: on → pkg/);
    assert.match(note, /- host folders: \/p → none/);
    assert.match(note, /- agents you can message: worker → none/);
    assert.match(note, /- artifact access: create → read/);
    assert.doesNotMatch(note, /conversation access/);
  });

  test('same access says so', () => {
    const note = switchNote({ node: node('a', {}), model: 'm1', account: '' }, { node: node('b', {}), model: 'm2', account: '' });
    assert.match(note ?? '', /did not change/);
    assert.deepEqual(accessChanges(node('a', {}), node('b', {})), []);
  });

  test('switching back to the same agent and model gives no note', () => {
    const a = node('a', {});
    assert.equal(switchNote({ node: a, model: 'm', account: 'x' }, { node: a, model: 'm', account: 'x' }), undefined);
  });
});
