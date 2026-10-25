/** Explicit integration suite: setup must already have been approved and run.
 * SFAGENTS_TEST_WINDOWS_SANDBOX=1 node scripts/run-tests.mjs windows-sandbox-native
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WindowsSandbox, buildSandboxPolicy, detectWindowsSandbox, openHostChannel, webTools, type SandboxPolicy } from '@sfagents/core';
import { REPO_ROOT } from './helpers.js';
const { runShellCommand } = await import(pathToFileURL(path.join(REPO_ROOT, 'core/dist/tools/shell.js')).href) as typeof import('../core/dist/tools/shell.js');

const enabled = process.platform === 'win32' && process.env['SFAGENTS_TEST_WINDOWS_SANDBOX'] === '1';
describe('Windows sandbox native isolation', { skip: !enabled && 'requires approved sandbox setup and SFAGENTS_TEST_WINDOWS_SANDBOX=1', timeout: 180_000 }, () => {
  let base: string;
  let workspace: string;
  let outside: string;
  let programData: string;
  let otherDrive: string | undefined;
  let policy: SandboxPolicy;
  const sandbox = new WindowsSandbox();

  before(async () => {
    const status = await detectWindowsSandbox();
    assert.equal(status.ok, true, !status.ok ? status.reason : '');
    base = fs.mkdtempSync(path.join(REPO_ROOT, '.tools', 'windows-sandbox-test-'));
    workspace = path.join(base, 'workspace with spaces');
    outside = path.join(base, 'outside.txt');
    fs.mkdirSync(workspace);
    fs.writeFileSync(outside, 'OUTSIDE-SECRET');
    programData = fs.mkdtempSync(path.join('C:\\ProgramData', 'sfagents-sandbox-test-'));
    fs.writeFileSync(path.join(programData, 'private.txt'), 'PROGRAMDATA-SECRET');
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (!fs.existsSync(drive)) continue;
      try {
        otherDrive = fs.mkdtempSync(path.join(drive, 'sfagents-sandbox-test-'));
        fs.writeFileSync(path.join(otherDrive, 'private.txt'), 'DRIVE-SECRET');
        break;
      } catch { /* a read-only or inaccessible drive cannot host the fixture */ }
    }
    fs.writeFileSync(path.join(workspace, '.env'), 'ENV-SECRET');
    fs.mkdirSync(path.join(workspace, '.sfagents'));
    fs.writeFileSync(path.join(workspace, '.sfagents', 'state.txt'), 'STATE-SECRET');
    fs.mkdirSync(path.join(workspace, 'agents'));
    fs.writeFileSync(path.join(workspace, 'agents', 'main.json'), '{}');
    const git = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
    policy = buildSandboxPolicy({ roots: [workspace], secretFiles: [path.join(workspace, '.env')], stateDirs: [path.join(workspace, '.sfagents')], agentsDir: path.join(workspace, 'agents'), protectedFiles: [path.join(workspace, 'mcp.json')] });
  });
  after(() => {
    if (base && path.dirname(base) === path.join(REPO_ROOT, '.tools') && path.basename(base).startsWith('windows-sandbox-test-')) fs.rmSync(base, { recursive: true, force: true });
    for (const p of [programData, otherDrive]) {
      if (p && path.isAbsolute(p) && path.basename(p).startsWith('sfagents-sandbox-test-') && (path.dirname(p) === 'C:\\ProgramData' || /^[D-Z]:\\$/i.test(path.dirname(p)))) fs.rmSync(p, { recursive: true, force: true });
    }
  });

  async function command(text: string, p = policy, timeoutMs = 30_000, signal = new AbortController().signal) {
    return runShellCommand(text, { cwd: workspace, env: process.env, timeoutMs, signal, sandbox: { sandbox, policy: p } });
  }
  let scriptId = 0;
  async function js(text: string, p = policy, timeoutMs = 30_000, signal = new AbortController().signal) {
    const file = path.join(workspace, `probe-${++scriptId}.cjs`);
    fs.writeFileSync(file, `const fs=require('node:fs'); const assert=require('node:assert/strict');\n${text}`);
    try { return await command(`"${process.execPath}" "${file}"`, p, timeoutMs, signal); }
    finally { fs.rmSync(file, { force: true }); }
  }
  const literal = JSON.stringify;
  function success(result: Awaited<ReturnType<typeof command>>) {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout;
  }
  function denied(result: Awaited<ReturnType<typeof command>>) {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.exitCode, 1, `Expected Node to deny the operation: ${result.stderr}`);
    assert.match(result.stderr, /EPERM|EACCES/, 'a startup failure or missing file does not prove isolation');
  }

  test('cmd quoting, Unicode, empty home, workspace writes, git status and commit', async () => {
    assert.match(success(await command('echo "quoted text" > "a b.txt" & type "a b.txt"')), /"quoted text"/);
    assert.match(success(await js(`fs.writeFileSync('unicode.txt','café 日本語'); console.log(fs.readFileSync('unicode.txt','utf8')); assert.notEqual(process.env.USERPROFILE,${literal(process.env['USERPROFILE']!)});`)), /café 日本語/);
    success(await command('git add "a b.txt" && git -c user.name=Sandbox -c user.email=sandbox@example.invalid commit -m smoke && git status --porcelain'));
  });

  test('secrets, host profile, ProgramData and system writes are blocked', async () => {
    const targets = [outside, path.join(workspace, '.env'), path.join(workspace, '.sfagents', 'state.txt'), path.join(programData, 'private.txt')];
    const script = targets.map(p => `assert.throws(()=>fs.readFileSync(${literal(p)}),e=>['EPERM','EACCES'].includes(e.code)); console.log('blocked');`).join('\n');
    const r = await js(script);
    success(r);
    assert.doesNotMatch(r.stdout + r.stderr, /ENV-SECRET|STATE-SECRET|OUTSIDE-SECRET|PROGRAMDATA-SECRET|ESCAPE/);
    assert.match(success(await js(`assert.throws(()=>fs.readdirSync(${literal(path.join(process.env['USERPROFILE']!, 'Documents'))}),e=>['EPERM','EACCES','ENOENT'].includes(e.code));console.log('blocked')`)), /blocked/);
    for (const root of ['C:\\Windows', 'C:\\Windows\\Temp', 'C:\\Windows\\tracing', 'C:\\Windows\\Tasks', 'C:\\Users\\sfagents_sandbox']) {
      denied(await js(`fs.writeFileSync(${literal(path.join(root,'sfagents-sandbox-escape.txt'))},'escape')`));
    }
    assert.equal(fs.existsSync('C:\\Windows\\sfagents-sandbox-escape.txt'), false);
  });

  test('files on another drive are hidden', async t => {
    if (!otherDrive) { t.skip('no other writable drive available for an isolation fixture'); return; }
    denied(await js(`fs.readFileSync(${literal(path.join(otherDrive, 'private.txt'))})`));
  });

  test('protected paths and their parents cannot be modified, removed or replaced', async () => {
    for (const p of ['agents\\main.json', 'mcp.json', '.git\\config', '.git\\hooks\\pre-commit']) {
      const r = await js(`fs.writeFileSync(${literal(p)},'evil')`);
      denied(r);
    }
    for (const p of ['agents', '.git', '.env', '.sfagents']) {
      const r = await js(`fs.renameSync(${literal(p)},'renamed-guard')`);
      denied(r);
    }
    assert.equal(fs.readFileSync(path.join(workspace, 'agents', 'main.json'), 'utf8'), '{}');
    assert.equal(fs.readFileSync(path.join(workspace, '.env'), 'utf8'), 'ENV-SECRET');
  });

  test('a helper inside the workspace cannot have its containing directory replaced', async () => {
    const runtime = path.join(base, 'runtime');
    fs.mkdirSync(runtime);
    const helper = path.join(runtime, 'sandbox.exe');
    fs.copyFileSync(sandbox.executable, helper);
    const probeFile = path.join(workspace, 'helper-guard.cjs');
    fs.writeFileSync(probeFile, `const fs=require('node:fs');const assert=require('node:assert/strict');fs.writeFileSync(${literal(path.join(runtime,'ordinary.txt'))},'allowed');assert.throws(()=>fs.renameSync(${literal(runtime)},${literal(runtime+'-replaced')}),e=>['EPERM','EACCES'].includes(e.code));console.log('helper guarded');`);
    try {
      const p = buildSandboxPolicy({ roots: [workspace, runtime] });
      const result = await runShellCommand(`"${process.execPath}" "${probeFile}"`, { cwd: workspace, env: process.env, timeoutMs: 30_000, signal: new AbortController().signal, sandbox: { sandbox: new WindowsSandbox(helper), policy: p } });
      assert.match(success(result), /helper guarded/);
      assert.equal(fs.existsSync(helper), true);
    } finally { fs.rmSync(probeFile, { force: true }); }
  });

  test('nested access rules support read-only, hidden and writable exceptions', async () => {
    fs.mkdirSync(path.join(workspace, 'shared'));
    fs.mkdirSync(path.join(workspace, 'shared', 'drop'));
    fs.writeFileSync(path.join(workspace, 'shared', 'read.txt'), 'shared');
    const p = { ...policy, rules: [...policy.rules, { path: path.join(workspace, 'shared'), access: 'read' as const }, { path: path.join(workspace, 'shared', 'drop'), access: 'write' as const }] };
    assert.match(success(await js(`console.log(fs.readFileSync('shared/read.txt','utf8'));fs.writeFileSync('shared/drop/ok.txt','ok')`, p)), /shared/);
    denied(await js(`fs.writeFileSync('shared/read.txt','evil')`, p));
    assert.equal(fs.readFileSync(path.join(workspace, 'shared', 'read.txt'), 'utf8'), 'shared');
    success(await js(`fs.writeFileSync('shared/read.txt','writable again')`));
    assert.equal(fs.readFileSync(path.join(workspace, 'shared', 'read.txt'), 'utf8'), 'writable again', 'recovery removes the previous policy\'s deny ACEs');
  });

  test('offline blocks loopback and Internet; network opt-in permits loopback', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer(s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => s.destroy()); s.end('connected'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const script = `const s=require('node:net').connect(${port},'127.0.0.1');s.setTimeout(3000,()=>{console.error('connection timed out');process.exit(1)});s.on('error',e=>{console.error(e.code);process.exit(1)});s.on('connect',()=>{console.log('connected');s.destroy()});`;
      const offline = await js(script);
      assert.equal(offline.exitCode, 1, offline.stderr);
      assert.match(offline.stderr, /EACCES|EPERM|timed out/);
      assert.match(success(await js(script, { ...policy, network: true })), /connected/);
      assert.notEqual((await command('curl.exe --max-time 5 -I https://example.com')).exitCode, 0);
      assert.match(success(await js(`const request=require('node:https').get('https://example.com',r=>{console.log('https '+r.statusCode);r.resume()});request.setTimeout(8000,()=>{request.destroy(new Error('HTTPS timed out'))});request.on('error',e=>{console.error(e);process.exit(1)});`, { ...policy, network: true })), /https 200/);
    } finally { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test('offline sf-web uses only the host pipe and enforces quota', async () => {
    const channel = await openHostChannel({ remaining: 1, access: { request: async (_op, arg) => `page:${arg}`, close: async () => {} } }, new AbortController().signal);
    try {
      const p = { ...policy, hostChannel: { path: channel.path }, tools: webTools() };
      assert.match(success(await command('sf-web search "kiln temperatures"', p)), /page:kiln temperatures/);
      const r = await command('sf-web search again', p);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.stderr, /used all/);
    } finally { await channel.close(); }
  });

  test('background children die when the command ends and after timeout or abort', async () => {
    const script = `require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('late.txt','late'),3000)"],{windowsHide:true,stdio:'ignore'}).unref();console.log('started');`;
    assert.match(success(await js(script)), /started/);
    await new Promise(resolve => setTimeout(resolve, 3500));
    assert.equal(fs.existsSync(path.join(workspace, 'late.txt')), false);
    const timed = await js("setTimeout(()=>fs.writeFileSync('timeout-late.txt','late'),10000)", policy, 7000);
    assert.equal(timed.timedOut, true);
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.equal(fs.existsSync(path.join(workspace, 'timeout-late.txt')), false);
    const controller = new AbortController();
    const running = js("setTimeout(()=>fs.writeFileSync('abort-late.txt','late'),10000)", policy, 30_000, controller.signal);
    setTimeout(() => controller.abort(), 7000).unref();
    assert.equal((await running).aborted, true);
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.equal(fs.existsSync(path.join(workspace, 'abort-late.txt')), false);
    assert.match(success(await command('echo recovered')), /recovered/);
  });

  test('killing SF Agents closes the job and recovers permissions', async () => {
    const script = `require('node:fs').writeFileSync('parent-started.txt','yes');setTimeout(()=>require('node:fs').writeFileSync('parent-late.txt','late'),4000);`;
    const wrapped = sandbox.wrap({ executable: process.execPath, args: ['-e', script], cwd: workspace, env: process.env }, policy);
    const source = path.join(base, 'parent.mjs');
    fs.writeFileSync(source, `import {spawn} from 'node:child_process'; const c=spawn(${JSON.stringify(wrapped.executable)},${JSON.stringify(wrapped.args)},{cwd:${JSON.stringify(workspace)},stdio:['ignore','ignore','inherit'],windowsHide:true}); c.on('error',e=>{process.stderr.write(e.message);process.exit(1)}); setInterval(()=>{},1000);`);
    const parent = spawn(process.execPath, [source], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errors = '';
    parent.stderr.on('data', (b: Buffer) => { errors += b.toString(); });
    try {
      const until = Date.now() + 15_000;
      while (!fs.existsSync(path.join(workspace, 'parent-started.txt')) && Date.now() < until && parent.exitCode === null) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(fs.existsSync(path.join(workspace, 'parent-started.txt')), true, errors);
      parent.kill('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 4500));
      assert.equal(fs.existsSync(path.join(workspace, 'parent-late.txt')), false);
    } finally {
      if (parent.exitCode === null) parent.kill('SIGKILL');
      wrapped.cleanup?.();
    }
  });
});
