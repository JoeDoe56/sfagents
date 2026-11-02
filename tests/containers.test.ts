import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import './helpers.js';
import {
  BRIDGE_SOURCE,
  ContainerManager,
  CONTAINER_CAPS,
  FRAME,
  FrameReader,
  containerIdFor,
  containerToHostPath,
  encodeFrame,
  findSecretFiles,
  handleProxyConnection,
  hostToContainerPath,
  hostWorkspacesDir,
  isPrivateAddress,
  levelAllows,
  mergeWslConfig,
  networkLevelOf,
  rootMounts,
  type DockerCli,
  type DockerResult,
  type NetworkEvent,
} from '@sfagents/core';

/** Two connected in-memory streams: what one writes, the other reads. */
function streamPair(): [Duplex, Duplex] {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = Duplex.from({ readable: bToA, writable: aToB });
  const b = Duplex.from({ readable: aToB, writable: bToA });
  return [a, b];
}

function readAll(stream: Duplex): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    stream.on('data', (c: Buffer) => (text += c.toString('latin1')));
    stream.on('end', () => resolve(text));
    stream.on('close', () => resolve(text));
  });
}

describe('network levels', () => {
  test('are cumulative: off, pkg, git, on', () => {
    assert.equal(levelAllows('off', 'registry.npmjs.org', 443).allowed, false);
    assert.equal(levelAllows('pkg', 'registry.npmjs.org', 443).allowed, true);
    assert.equal(levelAllows('pkg', 'deb.debian.org', 80).allowed, true, 'apt uses plain HTTP');
    assert.equal(levelAllows('pkg', 'api.nuget.org', 443).allowed, true);
    assert.equal(levelAllows('pkg', 'x.nuget.org', 443).allowed, true, 'suffix entries cover subdomains');
    assert.equal(levelAllows('pkg', 'github.com', 443).allowed, false);
    assert.equal(levelAllows('git', 'github.com', 443).allowed, true);
    assert.equal(levelAllows('git', 'registry.npmjs.org', 443).allowed, true);
    assert.equal(levelAllows('pkg', 'raw.githubusercontent.com', 443).allowed, false, 'serves anyone\'s files');
    assert.equal(levelAllows('git', 'raw.githubusercontent.com', 443).allowed, true);
    assert.equal(levelAllows('git', 'example.com', 443).allowed, false);
    assert.equal(levelAllows('on', 'example.com', 8443).allowed, true);
  });

  test('pkg and git allow names on ports 80 and 443 only', () => {
    assert.equal(levelAllows('git', 'github.com', 22).allowed, false);
    assert.equal(levelAllows('pkg', '104.16.0.1', 443).allowed, false);
    assert.equal(levelAllows('pkg', 'registry.npmjs.org.evil.com', 443).allowed, false);
  });

  test('this computer and the local network are never reachable', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '100.100.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', '0.0.0.0']) {
      assert.equal(isPrivateAddress(a), true, a);
    }
    for (const a of ['104.16.0.1', '140.82.112.3', '2606:4700::1111', '2a00:1450:4001:80b::200e']) assert.equal(isPrivateAddress(a), false, a);
  });

  test('other spellings of local IPv6 addresses are refused too', () => {
    for (const a of ['0:0:0:0:0:0:0:1', '::ffff:7f00:1', '::ffff:c0a8:101', '::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::c0a8:101',
      '64:ff9b::8.8.8.8', '2002:c0a8:101::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', 'fe80::1%eth0', '0::0:1', 'not-an-ip']) {
      assert.equal(isPrivateAddress(a), true, a);
    }
    assert.equal(levelAllows('on', '::ffff:c0a8:101', 80).allowed, true, 'the level allows it; the address check refuses it');
  });

  test('older agent files map to levels', () => {
    assert.equal(networkLevelOf(true), 'on');
    assert.equal(networkLevelOf(false), 'pkg');
    assert.equal(networkLevelOf(undefined), 'pkg');
    assert.equal(networkLevelOf('git'), 'git');
  });
});

describe('the proxy SF Agents runs for agent containers', () => {
  const run = async (request: string, level: 'off' | 'pkg' | 'git' | 'on', o: { lookup?: string[] } = {}) => {
    const [agentSide, proxySide] = streamPair();
    const events: NetworkEvent[] = [];
    const upstreamData: string[] = [];
    let hostChannel: string | undefined;
    handleProxyConnection('c1', proxySide, {
      level: () => level,
      command: () => 'npm install',
      log: (e) => events.push(e),
      hostChannel: (_agent, stream, head) => {
        hostChannel = head.toString();
        stream.end('host reply\n');
      },
      lookup: async () => o.lookup ?? ['93.184.216.34'],
      connect: () => {
        const [ours, theirs] = streamPair();
        theirs.on('data', (c: Buffer) => upstreamData.push(c.toString('latin1')));
        setImmediate(() => {
          ours.emit('connect');
          theirs.end('HTTP/1.1 200 OK\r\n\r\nupstream body');
        });
        (ours as unknown as net.Socket).setTimeout = () => ours as unknown as net.Socket;
        return ours as unknown as net.Socket;
      },
    });
    const reply = readAll(agentSide);
    agentSide.write(request);
    return { reply: await reply, events, upstreamData, hostChannel: () => hostChannel };
  };

  test('tunnels an allowed CONNECT and logs it with the command', async () => {
    const r = await run('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n', 'pkg');
    assert.match(r.reply, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(r.reply, /upstream body/);
    assert.deepEqual(r.events, [{ agent: 'c1', host: 'registry.npmjs.org', port: 443, allowed: true, command: 'npm install' }]);
  });

  test('refuses what the level does not allow', async () => {
    const r = await run('CONNECT github.com:443 HTTP/1.1\r\n\r\n', 'pkg');
    assert.match(r.reply, /^HTTP\/1\.1 403 Forbidden/);
    assert.equal(r.events[0]!.allowed, false);
    assert.match(r.events[0]!.reason!, /level pkg/);
    const off = await run('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n', 'off');
    assert.match(off.reply, /^HTTP\/1\.1 403/);
  });

  test('refuses names that resolve to the local network, even at level on', async () => {
    const r = await run('CONNECT router.example:443 HTTP/1.1\r\n\r\n', 'on', { lookup: ['192.168.1.1'] });
    assert.match(r.reply, /^HTTP\/1\.1 403/);
    assert.match(r.events[0]!.reason!, /local network/);
  });

  test('forwards plain HTTP in origin form without proxy headers', async () => {
    const r = await run('GET http://deb.debian.org/debian/dists/trixie/Release HTTP/1.1\r\nHost: deb.debian.org\r\nProxy-Authorization: x\r\nConnection: keep-alive\r\n\r\n', 'pkg');
    assert.match(r.reply, /upstream body/);
    const sent = r.upstreamData.join('');
    assert.match(sent, /^GET \/debian\/dists\/trixie\/Release HTTP\/1\.1\r\n/);
    assert.doesNotMatch(sent, /Proxy-Authorization/i);
    assert.match(sent, /Connection: close/);
  });

  test('sfa-host reaches SF Agents at every level', async () => {
    const r = await run('CONNECT sfa-host:1 HTTP/1.1\r\n\r\n{"argv":["sfa-web"]}\n', 'off');
    assert.match(r.reply, /^HTTP\/1\.1 200/);
    assert.match(r.reply, /host reply/);
    assert.equal(r.hostChannel(), '{"argv":["sfa-web"]}\n');
    assert.deepEqual(r.events, []);
  });
});

describe('container paths', () => {
  test('roots are named by their last folder, numbered when two share it', () => {
    const mounts = rootMounts(['/home/c/projects/site', '/srv/site', '/x/My Notes']);
    assert.deepEqual(mounts.map((m) => m.containerPath), ['/roots/site', '/roots/site-2', '/roots/My_Notes']);
  });

  test('map between this computer and the container both ways', () => {
    const mounts = rootMounts(['/home/c/projects/site']);
    assert.equal(hostToContainerPath('/home/c/projects/site/src/a.ts', mounts), '/roots/site/src/a.ts');
    assert.equal(hostToContainerPath('/home/c/other', mounts), undefined);
    assert.equal(containerToHostPath('/roots/site/src/a.ts', mounts), path.join('/home/c/projects/site', 'src', 'a.ts'));
    assert.equal(containerToHostPath('/workspaces/sfgl/README.md', mounts), path.join(hostWorkspacesDir(), 'sfgl', 'README.md'));
    assert.equal(containerToHostPath('/etc/passwd', mounts), undefined);
    assert.equal(containerToHostPath('/workspaces/../etc/passwd', mounts), undefined);
  });

  test('container ids are stable, readable and safe', () => {
    assert.equal(containerIdFor('Main Agent.json'), containerIdFor('Main Agent.json'));
    assert.match(containerIdFor('Main Agent.json'), /^main-agent-[0-9a-f]{8}$/);
    assert.notEqual(containerIdFor('a.json'), containerIdFor('A.json'));
  });

  test('secret files are found, examples and build output are not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
    for (const f of ['.env', '.env.local', '.env.example', 'app/.npmrc', 'keys/server.pem', 'keys/id_ed25519', 'keys/id_ed25519.pub', 'node_modules/x/.env', 'README.md']) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), 'x');
    }
    const found = findSecretFiles(root).map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
    assert.deepEqual(found, ['.env', '.env.local', 'app/.npmrc', 'keys/id_ed25519', 'keys/server.pem']);
  });
});

describe('.wslconfig', () => {
  test('adds what is missing and keeps what Caleb set', () => {
    const before = '[wsl2]\r\nmemory=8GB\r\nnetworkingMode=mirrored\r\n';
    const { text, changed } = mergeWslConfig(before, { wsl2: { memory: '16GB', swap: '8GB' }, experimental: { autoMemoryReclaim: 'gradual' } });
    assert.match(text, /memory=8GB/);
    assert.match(text, /networkingMode=mirrored/);
    assert.match(text, /\[wsl2\]\r\nmemory=8GB\r\nnetworkingMode=mirrored\r\nswap=8GB/);
    assert.match(text, /\[experimental\]\r\nautoMemoryReclaim=gradual/);
    assert.deepEqual(changed, ['[wsl2] swap=8GB', '[experimental] autoMemoryReclaim=gradual']);
    const forced = mergeWslConfig(before, { wsl2: { memory: '16GB' } }, true);
    assert.match(forced.text, /memory=16GB/);
  });
});

describe('the container bridge', () => {
  test('frames survive being split and joined', () => {
    const frames: Array<[number, number, string]> = [];
    const reader = new FrameReader((type, id, payload) => frames.push([type, id, payload.toString()]));
    const bytes = Buffer.concat([...encodeFrame(FRAME.OPEN, 1, '{"a":1}'), ...encodeFrame(FRAME.DATA, 1, 'hello'), ...encodeFrame(FRAME.END, 1)]);
    for (let i = 0; i < bytes.length; i += 3) reader.push(bytes.subarray(i, i + 3));
    assert.deepEqual(frames, [[FRAME.OPEN, 1, '{"a":1}'], [FRAME.DATA, 1, 'hello'], [FRAME.END, 1, '']]);
  });

  test('the bridge program carries an agent socket connection to SF Agents and back', { skip: process.platform === 'win32' }, async () => {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
    const child = spawn(process.execPath, ['-e', BRIDGE_SOURCE], { env: { ...process.env, SFA_RUN: run }, stdio: ['pipe', 'pipe', 'inherit'] });
    const received: Array<[number, number, Buffer]> = [];
    const waiters: Array<() => void> = [];
    const reader = new FrameReader((type, id, payload) => {
      received.push([type, id, payload]);
      for (const w of waiters.splice(0)) w();
    });
    child.stdout.on('data', (c: Buffer) => reader.push(c));
    const until = async (pred: () => boolean) => {
      while (!pred()) await new Promise<void>((r) => waiters.push(r));
    };
    try {
      await until(() => received.some(([t, , p]) => t === FRAME.CONTROL && p.toString().includes('hello')));
      for (const f of encodeFrame(FRAME.CONTROL, 0, JSON.stringify({ op: 'agent', id: 'a1', files: { 'sfa-x': { content: '#!/bin/sh\necho x\n' } } }))) child.stdin.write(f);
      await until(() => received.some(([t, , p]) => t === FRAME.CONTROL && p.toString().includes('agent-ready')));
      assert.equal(fs.readFileSync(path.join(run, 'a1', 'bin', 'sfa-x'), 'utf8'), '#!/bin/sh\necho x\n');
      // The container connects to its proxy socket and sends a request.
      const socket = net.connect(path.join(run, 'a1', 'proxy.sock'));
      socket.write('CONNECT sfa-host:1 HTTP/1.1\r\n\r\n');
      await until(() => received.some(([t]) => t === FRAME.DATA));
      const open = received.find(([t]) => t === FRAME.OPEN)!;
      assert.deepEqual(JSON.parse(open[2].toString()), { agent: 'a1', kind: 'proxy' });
      assert.equal(received.find(([t]) => t === FRAME.DATA)![2].toString(), 'CONNECT sfa-host:1 HTTP/1.1\r\n\r\n');
      // SF Agents answers on the same stream.
      const reply = new Promise<string>((resolve) => socket.once('data', (d) => resolve(d.toString())));
      for (const f of encodeFrame(FRAME.DATA, open[1], 'HTTP/1.1 200 OK\r\n\r\n')) child.stdin.write(f);
      assert.equal(await reply, 'HTTP/1.1 200 OK\r\n\r\n');
      socket.destroy();
    } finally {
      child.stdin.end();
      child.kill();
    }
  });
});

/** Records docker calls and answers them from a script. */
class FakeDocker implements DockerCli {
  calls: string[][] = [];
  containers = new Map<string, { label: string; running: boolean }>();
  argv(args: readonly string[]) {
    return { executable: 'docker', args: [...args] };
  }
  spawn(): never {
    throw new Error('not in this test');
  }
  async run(args: readonly string[]): Promise<DockerResult> {
    this.calls.push([...args]);
    const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'image') return ok('sha256:x');
    if (args[0] === 'container' && args[1] === 'inspect') {
      const c = this.containers.get(args.at(-1)!);
      return c ? ok(`${c.label} ${c.running}`) : { code: 1, stdout: '', stderr: 'No such container' };
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1]!;
      const label = args[args.indexOf('--label') + 1]!.replace('sfagents.spec=', '');
      this.containers.set(name, { label, running: false });
      return ok();
    }
    if (args[0] === 'start') {
      this.containers.get(args[1]!)!.running = true;
      return ok();
    }
    if (args[0] === 'rm') {
      this.containers.delete(args.at(-1)!);
      return ok();
    }
    return ok();
  }
}

describe('agent containers', { skip: process.platform === 'win32' }, () => {
  const setup = () => {
    const cli = new FakeDocker();
    const manager = new ContainerManager({ cli, image: 'sfagents-agent:test' });
    // The bridge is tested above; here it only has to accept agents.
    manager.bridge.addAgent = async () => {};
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    return { cli, manager, root };
  };

  test('have no network, few capabilities, read-only folders and hidden secrets', async () => {
    const { cli, manager, root } = setup();
    const name = await manager.prepare({ agentId: 'main.json', level: 'pkg', roots: [root] });
    const create = cli.calls.find((c) => c[0] === 'create')!;
    const flags = create.join(' ');
    assert.equal(name, `sfa-${containerIdFor('main.json')}`);
    assert.match(flags, /--network none/);
    assert.match(flags, /--cap-drop ALL/);
    for (const cap of CONTAINER_CAPS) assert.ok(create.includes(cap), cap);
    assert.ok(!create.includes('NET_ADMIN') && !create.includes('NET_RAW') && !create.includes('SYS_ADMIN'));
    assert.doesNotMatch(flags, /--privileged|docker\.sock/);
    const base = path.basename(root);
    assert.ok(create.includes(`type=bind,src=${root},dst=/roots/${base},readonly`));
    assert.ok(create.includes(`type=bind,src=/dev/null,dst=/roots/${base}/.env,readonly`));
    assert.ok(create.some((a) => a.includes('volume-subpath=agents/')));
    assert.deepEqual(create.slice(-3), ['sfagents-agent:test', 'node', '/run/sfa/bin/sfa-init.cjs']);
  });

  test('are reused while nothing changes, recreated when the folders do, and the level changes live', async () => {
    const { cli, manager, root } = setup();
    await manager.prepare({ agentId: 'main.json', level: 'pkg', roots: [root] });
    await manager.prepare({ agentId: 'main.json', level: 'on', roots: [root] });
    assert.equal(cli.calls.filter((c) => c[0] === 'create').length, 1, 'a level change keeps the container');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
    await manager.prepare({ agentId: 'main.json', level: 'on', roots: [root, other] });
    assert.equal(cli.calls.filter((c) => c[0] === 'create').length, 2);
    assert.ok(cli.calls.some((c) => c[0] === 'rm'));
  });
});
