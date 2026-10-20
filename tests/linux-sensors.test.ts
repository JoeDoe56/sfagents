import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LinuxSensorClient, SystemMonitor, lhmReadings, type LhmSensor, type SystemSource } from '@sfagents/web';
import { REPO_ROOT } from './helpers.js';

test('Linux uses the shared managed transport, including cleanup and failure fallback', async () => {
  for (const mode of ['ok', 'malformed', 'crash', 'hang']) {
    const reader = new LinuxSensorClient({ command: process.execPath, args: [path.join(REPO_ROOT, 'tests/fixtures/windows-sensors.mjs'), mode], timeoutMs: 1000, retryMs: 0 });
    let pid = 0;
    try {
      const readings = await reader.read();
      if (mode === 'ok') {
        assert.ok(readings);
        pid = Number(readings[0]!.hardware);
        assert.equal((await reader.read())?.[0]?.hardware, String(pid));
        assert.equal(reader.processes, 42);
      } else {
        assert.equal(readings, null);
        assert.match(reader.hint ?? '', /Linux/);
      }
    } finally { await reader.close(); }
    if (pid) assert.throws(() => process.kill(pid, 0));
  }
});

test('the bundled Linux upstream files match their pinned provenance', () => {
  const vendor = path.join(REPO_ROOT, 'web/native/linux/vendor');
  const pin = JSON.parse(fs.readFileSync(path.join(vendor, 'UPSTREAM.json'), 'utf8')) as { commit: string; files: Record<string, string> };
  assert.equal(pin.commit, 'd6646e75f617d61527911a7d446dc0cfce8b6932');
  for (const [name, hash] of Object.entries(pin.files)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(vendor, name))).digest('hex'), hash, name);
  }
});

test('BMC system power is used without double-counting its average or PSU total', () => {
  const sensor = (hw: string, name: string, value: number): LhmSensor => ({ hardwareId: hw, hardware: hw, id: `${hw}/power/${name}`, name, type: 'Power', value });
  const sensors = [sensor('/intelcpu/0', 'CPU Package', 50), sensor('/lpc/bmc', 'System Total', 320), sensor('/lpc/bmc', 'System Average', 310)];
  assert.deepEqual(lhmReadings(sensors).power, { watts: 320, kind: 'total' });
  sensors.push(sensor('/psu/0', 'Input Power', 330));
  assert.deepEqual(lhmReadings(sensors).power, { watts: 330, kind: 'input' });
  assert.equal(lhmReadings([sensor('/lpc/bmc', 'CPU Power', 50)]).power, null);
});

test('Linux LHM augments native utilization, AMD GPU, disk and network readings', async () => {
  let ticks = 0;
  const source: SystemSource = {
    platform: 'linux',
    readFile(file) {
      if (file === '/proc/cpuinfo') return 'physical id : 0\ncore id : 0\n\nphysical id : 0\ncore id : 1\n';
      if (file === '/proc/diskstats') return `8 0 sda 1 0 ${ticks * 2} ${ticks} 1 0 ${ticks} ${ticks} 0 0 0`;
      if (file === '/proc/net/dev') return `eth0: ${ticks * 100} 0 0 0 0 0 0 0 ${ticks * 50} 0 0 0 0 0 0 0`;
      if (file.endsWith('gpu_busy_percent')) return '25';
      if (file.endsWith('product_name')) return 'AMD native GPU';
      return null;
    },
    readLink: () => null, listDir: dir => dir === '/sys/class/drm' ? ['card0'] : dir === '/proc' ? ['1', '2'] : [],
    statfs: () => null, run: async () => null,
    cpus: () => { ticks += 100; return [{ model: 'Real Linux CPU', speed: 1000, times: { user: ticks, idle: ticks, nice: 0, irq: 0, sys: 0 } }]; },
    totalmem: () => 100, freemem: () => 40, uptime: () => 100, hostname: () => 'linux',
  };
  const sensors: LhmSensor[] = [
    { hardwareId: '/intelcpu/0', hardware: 'CPU #0', id: '/intelcpu/0/temperature/0', name: 'CPU Package', type: 'Temperature', value: 65 },
    { hardwareId: '/intelcpu/0', hardware: 'CPU #0', id: '/intelcpu/0/load/0', name: 'CPU Total', type: 'Load', value: 99 },
  ];
  let closed = false;
  const monitor = new SystemMonitor(source, { lhm: { read: async () => sensors, close: async () => { closed = true; } } });
  try {
    const snapshot = await monitor.read();
    assert.equal(snapshot.source, 'lhm');
    assert.equal(snapshot.cpu.usage, 0.5); // true utilization, not upstream load average
    assert.equal(snapshot.cpu.temperature, 65);
    assert.equal(snapshot.cpu.model, 'Real Linux CPU');
    assert.equal(snapshot.cpu.cores, 2);
    assert.equal(snapshot.gpu?.name, 'AMD native GPU');
    assert.equal(snapshot.gpu?.usage, 0.25);
    assert.ok(snapshot.disk!.readRate > 0);
    assert.ok(snapshot.network!.down > 0);
    assert.equal(snapshot.processes, 2);
  } finally { await monitor.close(); }
  assert.equal(closed, true);
});

test('the bundled Linux runtime returns real memory and process counts', { skip: process.platform !== 'linux' }, async () => {
  const reader = new LinuxSensorClient();
  try {
    const sensors = await reader.read();
    assert.ok(sensors, reader.hint ?? 'No Linux readings');
    const memory = lhmReadings(sensors).memory;
    assert.ok(memory && memory.total > 0 && memory.used >= 0 && memory.used <= memory.total);
    assert.ok(reader.processes !== null && reader.processes > 0);
  } finally { await reader.close(); }
});
