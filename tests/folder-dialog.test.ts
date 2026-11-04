import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppSettings, ConversationService, MemorySecretStore, ProviderRegistry, loadAgentTree } from '@sfagents/core';
import { pickNativeFolder, runFolderDialog, WebServer } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent } from './helpers.js';

const signal = () => new AbortController().signal;
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

test('native folder selection returns absolute paths on Windows, macOS, GTK and KDE', async () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const calls: Array<[string, string[]]> = [];
    const folder = platform === 'win32' ? 'C:\\Projects\\My project' : '/home/user/My project';
    const result = await pickNativeFolder(signal(), { platform, directoryExists: () => true, run: async (command, args) => {
      calls.push([command, args]); return ok(platform === 'win32' ? JSON.stringify({ folder }) : folder + '\n');
    } });
    assert.equal(result, folder);
    assert.equal(calls[0]![0], platform === 'win32' ? 'powershell.exe' : platform === 'darwin' ? 'osascript' : 'zenity');
    if (platform === 'win32') assert.ok(calls[0]![1].includes('-STA'));
    if (platform === 'linux') assert.ok(calls[0]![1].includes('--directory'));
  }
  const calls: string[] = [];
  assert.equal(await pickNativeFolder(signal(), { platform: 'linux', directoryExists: () => true, run: async (command) => {
    calls.push(command); if (command === 'zenity') throw Object.assign(new Error('not installed'), { code: 'ENOENT' });
    return ok('/home/user/KDE folder\n');
  } }), '/home/user/KDE folder');
  assert.deepEqual(calls, ['zenity', 'kdialog']);
});

test('cancellation returns no folder; missing tools, invalid paths and unavailable folders give useful errors', async () => {
  const canceled = [
    ['win32', ok('{"folder":null}')],
    ['darwin', { code: 1, stdout: '', stderr: 'User canceled. (-128)' }],
    ['linux', { code: 1, stdout: '', stderr: '' }],
  ] as const;
  for (const [platform, result] of canceled) assert.equal(await pickNativeFolder(signal(), { platform, run: async () => result }), null);
  await assert.rejects(pickNativeFolder(signal(), { platform: 'linux', run: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /zenity.*kdialog/);
  await assert.rejects(pickNativeFolder(signal(), { platform: 'linux', run: async () => ok('relative\n') }), /full filesystem path/);
  await assert.rejects(pickNativeFolder(signal(), { platform: 'linux', run: async () => ok('/missing\n'), directoryExists: () => false }), /no longer available/);
  await assert.rejects(pickNativeFolder(signal(), { platform: 'linux', run: async () => ({ code: 1, stdout: '', stderr: 'cannot open display' }) }), /No graphical desktop/);
  const stopped = AbortSignal.abort(new Error('Stopped'));
  await assert.rejects(pickNativeFolder(stopped, { run: async () => { throw new Error('Should not start.'); } }), /Stopped/);
});

test('aborting a picker stops its owned helper process', async () => {
  const file = path.join(makeTempDir(), 'picker.pid');
  const controller = new AbortController();
  const pending = runFolderDialog(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', file], controller.signal);
  const rejected = assert.rejects(pending, /Stopped/);
  for (let i = 0; i < 200 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    assert.equal(fs.existsSync(file), true);
    const pid = Number(fs.readFileSync(file, 'utf8'));
    controller.abort(new Error('Stopped'));
    await rejected;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 200 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(alive(), false);
  } finally { controller.abort(new Error('Stopped')); await rejected; }
});

test('the native-folder API opens one dialog, returns cancel without changing agents, and aborts on shutdown', async () => {
  const dir = makeTempDir(); const home = makeTempDir(); const chosen = makeTempDir('Chosen folder-');
  writeAgent(dir, baseAgent('main')); const tree = loadAgentTree(dir);
  const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: dir });
  const registry = new ProviderRegistry({ dir: home, secrets: new MemorySecretStore(true) });
  let entered!: () => void; let release!: (folder: string | null) => void; let aborted = false;
  let opened = new Promise<void>((resolve) => { entered = resolve; });
  let choose: (s: AbortSignal) => Promise<string | null> = () => new Promise((resolve) => { release = resolve; entered(); });
  const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory,
    registry, settings: new AppSettings(home), auth: false, watchAgents: false, enablePushToTalk: false, pickFolder: (s) => choose(s) });
  const base = (await server.start()).replace(/\/$/, '');
  const pick = () => fetch(base + '/api/agent-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  try {
    const first = pick(); await opened;
    assert.equal((await pick()).status, 409);
    release(chosen); assert.deepEqual(await (await first).json(), { folder: chosen });
    choose = async () => null; assert.deepEqual(await (await pick()).json(), { folder: null });
    const form = await (await fetch(base + '/api/agent-editor?agent=main')).json() as { form: { folders: string[] } };
    assert.deepEqual(form.form.folders, []);
    opened = new Promise<void>((resolve) => { entered = resolve; });
    choose = (s) => new Promise((_resolve, reject) => { s.addEventListener('abort', () => { aborted = true; reject(new Error('Stopped')); }, { once: true }); entered(); });
    const pending = pick().catch(() => null); await opened; await server.close(); await pending;
    assert.equal(aborted, true);
  } finally { await server.close(); conversation.close(); registry.close(); }
});
