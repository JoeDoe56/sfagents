import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lhmReadings, type LhmSensor } from '@sfagents/web';
import { REPO_ROOT } from './helpers.js';

function power(hardwareId: string, name: string, value: number): LhmSensor {
  return { hardwareId, hardware: hardwareId, id: `${hardwareId}/power/${name}`, name, type: 'Power', value };
}

test('system wattage uses a PSU total without double-counting rails, CPU or GPU', () => {
  const sensors = [power('/intelcpu/0', 'CPU Package', 40), power('/gpu-nvidia/0', 'GPU Package', 70)];
  assert.equal(lhmReadings(sensors).power, null);
  sensors.push(power('/psu/corsair/0', '+12V', 100), power('/psu/corsair/0', '+5V', 20), power('/psu/corsair/0', 'Total watts', 145));
  assert.deepEqual(lhmReadings(sensors).power, { watts: 145, kind: 'total' });
  sensors.push(power('/psu/corsair/0', 'Input Power', 160));
  assert.deepEqual(lhmReadings(sensors).power, { watts: 160, kind: 'input' });
});

test('an output-only PSU reports its measured output, and separate PSUs are summed', () => {
  const sensors = [power('/psu/msi/0', 'PSU Out', 110), power('/psu/msi/1', 'PSU Out', 120)];
  assert.deepEqual(lhmReadings(sensors).power, { watts: 230, kind: 'output' });
});

test('the Processes cell shows a count and watts, with an honest unavailable state', async () => {
  const { describeStats } = await import(pathToFileURL(path.join(REPO_ROOT, 'web/public/monitor.js')).href);
  const known = describeStats({ processes: 315, power: { watts: 145.7, kind: 'input' } }).processes;
  assert.equal(known.num, '315');
  assert.equal(known.unit, '');
  assert.equal(known.lines[0].text, '146 W');
  const unavailable = describeStats({ processes: null, power: null }).processes;
  assert.equal(unavailable.num, '—');
  assert.equal(unavailable.lines[0].text, '— W');
});
