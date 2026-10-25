import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WindowsSandbox, detectWindowsSandbox, windowsSandboxPath, buildSandboxPolicy } from '@sfagents/core';
import { makeTempDir } from './helpers.js';

describe('Windows sandbox adapter (any host)', () => {
  test('wrap serializes prepared policy, preserves argv, and omits host secrets', () => {
    const dir = makeTempDir('sfagents-windows-policy-');
    fs.mkdirSync(path.join(dir, '.git'));
    const policy = buildSandboxPolicy({ roots: [dir], secretFiles: [path.join(dir, '.env')], protectedFiles: [path.join(dir, 'mcp.json')], agentsDir: path.join(dir, 'agents'), network: true, hostChannel: { path: String.raw`\\.\pipe\sfagents-web-test` } });
    const wrapped = new WindowsSandbox('helper with spaces.exe').wrap({ executable: 'shell with spaces.exe', args: ['-Command', 'echo "quoted" > "a b.txt"'], cwd: dir, env: { Path: 'C:\\Windows', LANG: 'en_US.UTF-8', USERPROFILE: 'host-profile', NODE_OPTIONS: '--require=evil', PRIVATE_TOKEN: 'host-secret' } }, policy);
    const file = wrapped.args[2]!;
    try {
      assert.equal(wrapped.executable, 'helper with spaces.exe');
      assert.deepEqual(wrapped.args, ['run', '--policy', file, '--', 'shell with spaces.exe', '-Command', 'echo "quoted" > "a b.txt"']);
      const raw = fs.readFileSync(file, 'utf8');
      const saved = JSON.parse(raw);
      assert.equal(saved.version, 1);
      assert.equal(saved.cwd, dir);
      assert.equal(saved.network, true);
      assert.equal(saved.hostChannel.path, policy.hostChannel!.path);
      assert.deepEqual(saved.env, { Path: 'C:\\Windows', LANG: 'en_US.UTF-8' });
      assert.doesNotMatch(raw, /host-secret|host-profile|NODE_OPTIONS/);
      assert.ok(saved.rules.some((r: { path: string; access: string }) => r.path === path.join(dir, '.git', 'hooks') && r.access === 'read'));
      for (const guarded of ['.env', 'mcp.json', 'agents', '.git/hooks', '.git/config', '.git/modules']) assert.equal(fs.existsSync(path.join(dir, guarded)), true, guarded);
      assert.equal(wrapped.cwd, dir);
      assert.equal(typeof wrapped.cleanup, 'function');
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  });

  test('missing helper refuses commands with a build instruction', async () => {
    const status = await detectWindowsSandbox(path.join(makeTempDir(), 'missing.exe'));
    assert.equal(status.ok, false);
    if (!status.ok) assert.match(status.reason, /build:sandbox.*refused/);
  });

  test('native helper identifies its protocol and fails closed before setup', { skip: process.platform !== 'win32' || !fs.existsSync(windowsSandboxPath()) }, () => {
    const helper = windowsSandboxPath();
    const version = spawnSync(helper, ['version'], { encoding: 'utf8', windowsHide: true });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /protocol 1/);
    const isolated = makeTempDir('sfagents-sandbox-unconfigured-');
    const probe = spawnSync(helper, ['probe'], { env: { ...process.env, LOCALAPPDATA: isolated }, encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 125);
    assert.match(probe.stderr, /not set up/);
    assert.equal(fs.existsSync(path.join(isolated, 'SF Agents')), false);
  });
});
