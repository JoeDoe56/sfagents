import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NetworkLog } from '@sfagents/core';
import { makeTempDir } from './helpers.js';

test('the Network log keeps entries per agent and reads them back after a restart', () => {
  const file = path.join(makeTempDir(), 'network.jsonl');
  const log = new NetworkLog(file);
  const seen: string[] = [];
  log.onEntry((e) => seen.push(e.host));
  log.add({ agent: 'main', command: 'npm install', host: 'registry.npmjs.org', port: 443, allowed: true });
  log.add({ agent: 'other', host: 'example.com', port: 443, allowed: false, reason: 'not a package registry' });
  assert.deepEqual(log.entries('main').map((e) => e.host), ['registry.npmjs.org']);
  assert.equal(log.entries().length, 2);
  assert.deepEqual(seen, ['registry.npmjs.org', 'example.com']);
  fs.appendFileSync(file, '{"torn');
  const again = new NetworkLog(file);
  assert.deepEqual(again.entries().map((e) => [e.agent, e.allowed, e.reason]), [
    ['main', true, undefined],
    ['other', false, 'not a package registry'],
  ]);
});
