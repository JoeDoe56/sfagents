import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { descendantsOf, killProcessTree, parseProcessList } from '@sfagents/core';

test('descendantsOf walks the whole tree and spares what keep matches', () => {
  const rows = parseProcessList(
    ['  1     0 init', '100     1 node sfagents', '200   100 audiocpp_server --port 1', '300   200 worker', '400   100 helper.exe --vdisplay-off', '500   400 conhost', '600     1 other'].join('\n'),
  );
  assert.deepEqual(descendantsOf(rows, 100).map((p) => p.pid), [200, 400, 300, 500]);
  assert.deepEqual(descendantsOf(rows, 100, (c) => c.includes('--vdisplay-off')).map((p) => p.pid), [200, 300]);
});

test('killProcessTree stops children and grandchildren', { skip: process.platform === 'win32' }, async () => {
  // A child that starts a grandchild, both ignoring SIGTERM, both sleeping.
  const script = "process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const exited = new Promise((r) => child.once('exit', r));
  const stopped = await killProcessTree();
  assert.ok(stopped.length >= 2, `stopped ${stopped.length}`);
  await exited;
  await new Promise((r) => setTimeout(r, 200));
  // Nothing is left under this process (zombies waiting to be reaped do not count).
  const left = execFileSync('ps', ['-A', '-o', 'pid=,stat='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => stopped.some((p) => new RegExp(`^\\s*${p.pid}\\s+[^Z]`).test(l)));
  assert.deepEqual(left, []);
});
