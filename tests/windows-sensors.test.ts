import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { WindowsSensorClient, sensorEnvironment, SystemMonitor, lhmReadings, type SystemSource } from '@sfagents/web';
import { REPO_ROOT } from './helpers.js';

const fixture = path.join(REPO_ROOT, 'tests/fixtures/windows-sensors.mjs');
function client(mode = 'ok') {
  return new WindowsSensorClient({ command: process.execPath, args: [fixture, mode], timeoutMs: 1500, retryMs: 0 });
}

test('the embedded reader reuses one process, shares concurrent requests, and closes it', async () => {
  const reader = client();
  let pid = 0;
  try {
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    assert.equal(a, b);
    assert.equal(a?.[0]?.value, 1);
    pid = Number(a?.[0]?.hardware);
    const c = await reader.read();
    assert.equal(c?.[0]?.hardware, String(pid));
    assert.equal(c?.[0]?.value, 2);
    assert.equal(reader.hint, null);
    assert.equal(reader.processes, 42);
  } finally { await reader.close(); }
  assert.throws(() => process.kill(pid, 0));
  assert.equal(await reader.read(), null);
});

test('the helper receives system paths but no agent secrets or injected Node options', async () => {
  assert.deepEqual(sensorEnvironment({ PATH: 'bin', SystemRoot: 'Windows', OPENROUTER_API_KEY: 'secret', NODE_OPTIONS: 'unsafe', CUSTOM_TOKEN: 'secret' }), { PATH: 'bin', SystemRoot: 'Windows' });
  const before = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-secret';
  const reader = client();
  try { await reader.read(); assert.equal(reader.hint, null); }
  finally {
    await reader.close();
    if (before === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before;
  }
});

test('malformed responses, process failure and timeouts fall back without hanging', async () => {
  for (const mode of ['malformed', 'crash', 'hang']) {
    const reader = client(mode);
    try {
      assert.equal(await reader.read(), null, mode);
      assert.ok(reader.hint, mode);
    } finally { await reader.close(); }
  }
});

test('closing cancels an in-flight read', async () => {
  const reader = client('hang');
  const pending = reader.read();
  await reader.close();
  assert.equal(await pending, null);
});

test('native-only Linux and macOS monitoring works without a helper', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const source: SystemSource = {
      platform, readFile: () => null, readLink: () => null, listDir: dir => dir === '/proc' ? ['1', '42', 'self', 'net'] : [], statfs: () => null,
      run: async command => command === 'ps' ? '  1\n 42\n' : null, cpus: () => [], totalmem: () => 100, freemem: () => 40, uptime: () => 100, hostname: () => platform,
    };
    const monitor = new SystemMonitor(source, { lhm: null });
    try {
      const snapshot = await monitor.read();
      assert.equal(snapshot.source, 'os');
      assert.equal(snapshot.hint, null);
      assert.deepEqual(snapshot.memory, { used: 60, total: 100 });
      assert.equal(snapshot.processes, 2);
      assert.equal(snapshot.power, null);
    } finally { await monitor.close(); }
  }
});

test('the bundled Windows library reports RAM in bytes, matching the operating system', { skip: process.platform !== 'win32' }, async () => {
  const reader = new WindowsSensorClient();
  try {
    const sensors = await reader.read();
    assert.ok(sensors, reader.hint ?? 'No native sensor readings');
    const memory = lhmReadings(sensors).memory;
    assert.ok(memory);
    assert.ok(Math.abs(memory.total - os.totalmem()) / os.totalmem() < 0.001, JSON.stringify(memory));
    assert.ok(memory.used > 0 && memory.used <= memory.total);
    assert.ok(reader.processes !== null && reader.processes > 0);
  } finally { await reader.close(); }
});
