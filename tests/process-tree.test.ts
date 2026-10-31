import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { descendantsOf, isLeftover, isSandboxRun, killProcessTree, orphansOf, parseProcessList } from '@sfagents/core';

test('descendantsOf walks the whole tree and spares what keep matches', () => {
  const rows = parseProcessList(
    ['  1     0 init', '100     1 node sfagents', '200   100 audiocpp_server --port 1', '300   200 worker', '400   100 helper.exe --vdisplay-off', '500   400 conhost', '600     1 other'].join('\n'),
  );
  assert.deepEqual(descendantsOf(rows, 100).map((p) => p.pid), [200, 400, 300, 500]);
  assert.deepEqual(descendantsOf(rows, 100, (c) => c.includes('--vdisplay-off')).map((p) => p.pid), [200, 300]);
});

test('sandboxed commands left behind by an earlier SF Agents are found; ones with a live parent are not', () => {
  const rows = parseProcessList(
    [
      '  1     0 init',
      '100     1 node sfagents',
      '200   100 "C:\\sfagents\\core\\native\\bin\\win-x64\\sfagents-sandbox.exe" run --policy C:\\Temp\\sfagents-policy-a\\policy.json -- cmd.exe',
      '300  9999 "C:\\sfagents\\core\\native\\bin\\win-x64\\sfagents-sandbox.exe" run --policy C:\\Temp\\sfagents-policy-b\\policy.json -- cmd.exe',
      '310   300 cmd.exe',
      '400  9999 sfagents-sandbox.exe probe',
      '500  9999 notepad.exe',
    ].join('\n'),
  );
  assert.deepEqual(orphansOf(rows, isSandboxRun).map((p) => p.pid), [300]);
  assert.equal(isSandboxRun('/opt/sfagents/sfagents-sandbox run --policy p.json -- sh'), true);
  assert.equal(isSandboxRun('sfagents-sandbox.exe recover'), false);
});

test('SF Agents\' own helpers count as leftovers; nothing else does', () => {
  const home = 'C:\\Users\\me\\AppData\\Roaming\\SF Agents';
  for (const c of [
    '"C:\\sfagents\\core\\native\\bin\\win-x64\\sfagents-sandbox.exe" run --policy p.json -- cmd.exe',
    'C:\\sfagents\\web\\native\\bin\\win-x64\\SfAgents.Input.exe --broker sfagents-input-1',
    'C:\\sfagents\\web\\native\\bin\\win-x64\\SfAgents.Sensors.exe --broker sfagents-sensors-1',
    '/usr/bin/node /opt/sfagents/web/dist/keyboard-worker.js',
    'C:\\Program Files\\SF Agents\\sfagents-screen.exe --port 1',
    `"${home}\\dictation\\audiocpp\\cuda\\audiocpp_server.exe" --config "${home}\\dictation\\server-gpu.json" --no-ui`,
  ]) assert.equal(isLeftover(c, home), true, c);
  for (const c of [
    '"node" "C:\\sfagents\\cli\\bin\\sfagents.js" web',
    'C:\\Temp\\bench\\audiocpp_server.exe --config C:\\Temp\\bench\\server.json',
    'sfagents-sandbox.exe recover',
    'notepad.exe',
  ]) assert.equal(isLeftover(c, home), false, c);
  // A helper whose SF Agents is still running has its parent: not an orphan.
  const rows = parseProcessList(['100     1 node sfagents', `200   100 ${home}\\dictation\\audiocpp\\cuda\\audiocpp_server.exe --config "${home}\\dictation\\server-cpu.json"`, '300  9999 C:\\x\\SfAgents.Input.exe --broker p'].join('\n'));
  assert.deepEqual(orphansOf(rows, (c) => isLeftover(c, home)).map((p) => p.pid), [300]);
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
