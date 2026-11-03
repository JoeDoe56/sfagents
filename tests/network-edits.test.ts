import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import { AgentRuntime, ContainerManager, containerManager, containerIdFor, setContainerManagerForTesting, loadAgentTree, runHostCommand, availableHostCommands, handleProxyConnection, type AgentContainerSpec, type NetworkLevel, type HostCommands } from '@sfagents/core';
import { makeTempDir, writeAgent, baseAgent } from './helpers.js';

test('tools already built for a running agent use an edited network level on their next command', async () => {
  const dir = makeTempDir(); writeAgent(dir, baseAgent('main', { network: 'on' }));
  const previous = containerManager(); const seen: NetworkLevel[] = [];
  class InspectManager extends ContainerManager {
    override async prepare(spec: AgentContainerSpec): Promise<string> { seen.push(spec.level); throw new Error('Stop before executing the command.'); }
  }
  const manager = new InspectManager(); setContainerManagerForTesting(manager);
  const runtime = new AgentRuntime({ tree: loadAgentTree(dir) });
  try {
    const tools = await runtime.buildTools(runtime.tree.root, ['main'], () => {});
    const shell = tools.get('shell')!;
    await shell.build({ command: 'true' }).execute(new AbortController().signal);
    writeAgent(dir, baseAgent('main', { network: 'off' })); runtime.reload(loadAgentTree(dir));
    await shell.build({ command: 'true' }).execute(new AbortController().signal);
    assert.deepEqual(seen, ['on', 'off']);
  } finally { await runtime.dispose(); manager.bridge.stop(); setContainerManagerForTesting(previous); }
});

test('host web commands recheck the current setting without resetting their quota', async () => {
  let level: NetworkLevel = 'off'; let calls = 0;
  const commands: HostCommands = { networkLevel: () => level, web: { remaining: 2, access: { request: async () => { calls++; return 'ok'; }, async close() {} } } };
  const call = () => runHostCommand(['sfa-web', 'search', 'test'], commands, { signal: new AbortController().signal });
  assert.equal((await call()).ok, false); assert.equal(calls, 0); assert.equal(availableHostCommands(commands).includes('sfa-web'), false);
  level = 'on'; assert.equal((await call()).ok, true); assert.equal(calls, 1); assert.equal(commands.web!.remaining, 1);
  level = 'off'; assert.equal((await call()).ok, false); assert.equal(calls, 1); assert.equal(commands.web!.remaining, 1);
});

test('editing a network level closes previously authorized proxy tunnels without restarting the container', () => {
  const manager = new ContainerManager(); const tunnel = new PassThrough();
  // Simulate an already established tunnel, without contacting an external host or starting Docker.
  (manager as any).agents.set(containerIdFor('main'), { level: 'on', connections: new Set([tunnel]) });
  manager.setNetworkLevel('main', 'off');
  assert.equal(tunnel.destroyed, true);
  manager.bridge.stop();
});

test('editing a network level leaves local SF Agents command channels connected', async () => {
  const manager = new ContainerManager(); const cid = containerIdFor('main');
  const aToB = new PassThrough(); const bToA = new PassThrough();
  const client = Duplex.from({ readable: bToA, writable: aToB });
  const server = Duplex.from({ readable: aToB, writable: bToA });
  client.on('error', () => {}); server.on('error', () => {});
  (manager as any).agents.set(cid, { agentId: 'main', level: 'on', connections: new Set(), contexts: [] });
  const connected = new Promise<void>((resolve) => { (manager as any).hostChannel = () => resolve(); });
  try {
    (manager as any).onConnection(cid, server);
    client.write('CONNECT sfa-host:443 HTTP/1.1\r\nHost: sfa-host\r\n\r\n');
    await connected;
    manager.setNetworkLevel('main', 'off');
    assert.equal(server.destroyed, false);
  } finally { client.destroy(); server.destroy(); manager.bridge.stop(); }
});

test('a request revoked during DNS lookup never opens an outgoing socket', async () => {
  let finishLookup!: (addresses: string[]) => void; let connections = 0; let level: NetworkLevel = 'on';
  const stream = new PassThrough(); let response = '';
  handleProxyConnection('main', stream, {
    level: () => level, log() {}, hostChannel() {},
    lookup: () => new Promise((resolve) => { finishLookup = resolve; }),
    connect: () => { connections++; throw new Error('A revoked request connected.'); },
  });
  stream.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n');
  stream.on('data', (chunk: Buffer) => { response += chunk.toString(); });
  level = 'off'; finishLookup(['8.8.8.8']);
  stream.resume();
  await new Promise((resolve) => stream.once('end', resolve));
  assert.equal(connections, 0); assert.match(response, /403 Forbidden/);
});
