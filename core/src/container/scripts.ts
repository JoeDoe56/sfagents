/**
 * The small programs SF Agents puts into its containers. They ship with SF
 * Agents rather than in the image, so they always match this version: the
 * bridge writes them into each agent's run folder (/run/sfa/bin inside the
 * agent's container) before the container starts.
 *
 * All are plain CommonJS (or sh) using Node built-ins only; the image has
 * Node. They are kept free of backticks so they can live in these strings.
 */

/**
 * Frame layout shared by the bridge and the host (see bridge.ts): a 9-byte
 * header (type, stream id as uint32 BE, payload length as uint32 BE), then
 * the payload. Streams the bridge opens have odd ids, the host's even ones.
 */
export const FRAME = { OPEN: 1, DATA: 2, END: 3, CLOSE: 4, CONTROL: 5 } as const;
export const FRAME_HEADER_BYTES = 9;
/** Largest payload either side sends in one frame. */
export const MAX_FRAME_PAYLOAD = 256 * 1024;

/**
 * The bridge: runs as root in the sfagents-bridge container (no network) and
 * talks to SF Agents over its standard input and output, which reach SF
 * Agents through `docker exec -i` (on Windows, through wsl.exe too). It needs
 * no port and no firewall rule on the host.
 *
 * For each agent it listens on <run>/agents/<id>/proxy.sock, which only that
 * agent's container has mounted (at /run/sfa). A connection there becomes a
 * stream to SF Agents labelled with the agent: the socket it came through is
 * its identity, so there is no token to steal. SF Agents opens streams the
 * other way to reach a server inside an agent's container (ports.sock).
 */
export const BRIDGE_SOURCE = String.raw`'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const RUN = process.env.SFA_RUN || '/run/sfagents/agents';
const OPEN = 1, DATA = 2, END = 3, CLOSE = 4, CONTROL = 5;
const MAX = 256 * 1024;
const AGENT_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const streams = new Map();
const servers = new Map();
let nextId = -1;
const out = process.stdout;
out.setMaxListeners(0);

function send(type, id, payload) {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let ok = true;
  for (let at = 0; at < body.length || at === 0; at += MAX) {
    const part = body.subarray(at, at + MAX);
    const head = Buffer.alloc(9);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(id >>> 0, 1);
    head.writeUInt32BE(part.length, 5);
    ok = out.write(Buffer.concat([head, part])) && ok;
    if (body.length === 0) break;
  }
  return ok;
}
function control(message) { send(CONTROL, 0, JSON.stringify(message)); }

function attach(id, socket) {
  streams.set(id, socket);
  socket.on('data', (data) => {
    if (!send(DATA, id, data)) {
      socket.pause();
      out.once('drain', () => socket.resume());
    }
  });
  socket.on('end', () => send(END, id));
  socket.on('error', () => socket.destroy());
  socket.on('close', () => { if (streams.delete(id)) send(CLOSE, id); });
}

function writeFiles(dir, files) {
  for (const [name, file] of Object.entries(files || {})) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    const target = path.join(dir, name);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, file.content, { mode: file.mode || 0o755 });
    fs.chmodSync(tmp, file.mode || 0o755);
    fs.renameSync(tmp, target);
  }
}

function addAgent(message) {
  const id = String(message.id || '');
  if (!AGENT_ID.test(id)) return control({ op: 'error', id, error: 'bad agent id' });
  const dir = path.join(RUN, id);
  for (const sub of ['', 'bin', 'exec']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  writeFiles(path.join(dir, 'bin'), message.files);
  // The agent (uid 1000) writes its pid files and its ports socket here.
  try {
    fs.chownSync(dir, 1000, 1000);
    fs.chownSync(path.join(dir, 'exec'), 1000, 1000);
  } catch {
    fs.chmodSync(dir, 0o777);
    fs.chmodSync(path.join(dir, 'exec'), 0o777);
  }
  if (servers.has(id)) return control({ op: 'agent-ready', id });
  const socketPath = path.join(dir, 'proxy.sock');
  try { fs.unlinkSync(socketPath); } catch {}
  const server = net.createServer((socket) => {
    nextId += 2;
    const sid = nextId;
    send(OPEN, sid, JSON.stringify({ agent: id, kind: 'proxy' }));
    attach(sid, socket);
  });
  server.on('error', (error) => control({ op: 'error', id, error: error.message }));
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o666);
    servers.set(id, server);
    control({ op: 'agent-ready', id });
  });
}

function removeAgent(message) {
  const server = servers.get(String(message.id));
  if (server) server.close();
  servers.delete(String(message.id));
}

function onFrame(type, id, payload) {
  if (type === CONTROL) {
    let message;
    try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (message.op === 'agent') return addAgent(message);
    if (message.op === 'remove-agent') return removeAgent(message);
    if (message.op === 'ping') return control({ op: 'pong', n: message.n });
    return;
  }
  if (type === OPEN) {
    let target;
    try { target = JSON.parse(payload.toString('utf8')); } catch { return send(CLOSE, id); }
    if (target.kind !== 'port' || !AGENT_ID.test(String(target.agent)) || !(target.port > 0 && target.port < 65536)) return send(CLOSE, id);
    const socket = net.connect(path.join(RUN, String(target.agent), 'ports.sock'));
    socket.write('PORT ' + Math.floor(target.port) + '\n');
    attach(id, socket);
    return;
  }
  const socket = streams.get(id);
  if (!socket) return;
  if (type === DATA) socket.write(payload);
  else if (type === END) socket.end();
  else if (type === CLOSE) { streams.delete(id); socket.destroy(); }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  while (buffer.length >= 9) {
    const length = buffer.readUInt32BE(5);
    if (buffer.length < 9 + length) break;
    const type = buffer.readUInt8(0);
    const id = buffer.readUInt32BE(1);
    const payload = buffer.subarray(9, 9 + length);
    buffer = buffer.subarray(9 + length);
    try { onFrame(type, id, payload); } catch (error) { control({ op: 'error', error: String(error && error.message || error) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (error) => control({ op: 'error', error: String(error && error.message || error) }));
control({ op: 'hello', version: 1 });
`;

/**
 * sfa-init: what an agent container runs (under tini). It joins the agent's
 * two sockets to the container's loopback: 127.0.0.1:3128 (sfa-proxy, every
 * tool's HTTP(S)_PROXY) goes out through proxy.sock, and SF Agents reaches a
 * server the agent runs through ports.sock ("PORT <n>" then the bytes).
 */
export const INIT_SOURCE = String.raw`'use strict';
const net = require('node:net');
const fs = require('node:fs');
const RUN = '/run/sfa';
const proxy = net.createServer((client) => {
  const upstream = net.connect(RUN + '/proxy.sock');
  client.pipe(upstream).pipe(client);
  const done = () => { client.destroy(); upstream.destroy(); };
  client.on('error', done);
  upstream.on('error', done);
});
proxy.on('error', (error) => { console.error('sfa-init: proxy: ' + error.message); process.exitCode = 1; });
proxy.listen(3128, '127.0.0.1');

function connectLocal(port, done) {
  const tryHost = (hosts) => {
    const socket = net.connect(port, hosts[0]);
    socket.once('connect', () => done(socket));
    socket.once('error', () => { socket.destroy(); if (hosts.length > 1) tryHost(hosts.slice(1)); else done(undefined); });
  };
  tryHost(['127.0.0.1', '::1']);
}
const portsPath = RUN + '/ports.sock';
try { fs.unlinkSync(portsPath); } catch {}
const ports = net.createServer((client) => {
  let head = Buffer.alloc(0);
  client.on('error', () => client.destroy());
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf(10);
    if (end < 0) { if (head.length > 64) client.destroy(); return; }
    client.off('data', onData);
    client.pause();
    const m = /^PORT (\d{1,5})$/.exec(head.subarray(0, end).toString('latin1').trim());
    const rest = head.subarray(end + 1);
    if (!m) return client.destroy();
    connectLocal(Number(m[1]), (socket) => {
      if (!socket) return client.destroy();
      if (rest.length) socket.write(rest);
      socket.on('error', () => client.destroy());
      client.on('close', () => socket.destroy());
      client.pipe(socket).pipe(client);
      client.resume();
    });
  };
  client.on('data', onData);
});
ports.on('error', (error) => console.error('sfa-init: ports: ' + error.message));
ports.listen(portsPath);
setInterval(() => {}, 1 << 30);
`;

/**
 * sfa-exec <job> (command in SFA_COMMAND): runs a shell command in its own session and
 * records the session's id, so SF Agents can stop the command and everything
 * it started (sfa-kill). Stopping the docker exec client alone would leave
 * them running in the container.
 */
export const EXEC_SOURCE = String.raw`#!/bin/sh
# The command arrives in SFA_COMMAND, not as an argument, so it never shows in
# the process list (where "pkill -f <pattern>" would match and kill it).
job="$1"
# The folder is checked here: docker exec -w with a missing folder fails
# before anything runs, with only exit code 127.
if [ -n "$SFA_CWD" ]; then
  cd "$SFA_CWD" 2>/dev/null || { echo "The directory $SFA_CWD does not exist in the container (create it first, e.g. mkdir -p, or run from /workspaces)." >&2; exit 1; }
fi
unset SFA_CWD
exec setsid -w bash -c '
  echo $$ > "/run/sfa/exec/$0.pid"
  trap "rm -f /run/sfa/exec/$0.pid" EXIT
  PATH="/run/sfa/bin:$PATH" bash -l -c "PATH=/run/sfa/bin:\$PATH; __sfa_c=\$SFA_COMMAND; unset SFA_COMMAND; eval \"\$__sfa_c\""
' "$job"
`;

/** sfa-kill <job>: stops a command sfa-exec started, with everything it started. */
export const KILL_SOURCE = String.raw`#!/bin/bash
file="/run/sfa/exec/$1.pid"
[ -f "$file" ] || exit 0
pid="$(cat "$file")"
kill -TERM -- "-$pid" 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 -- "-$pid" 2>/dev/null || { rm -f "$file"; exit 0; }
  sleep 0.2
done
kill -KILL -- "-$pid" 2>/dev/null
rm -f "$file"
`;

/**
 * The client half of SF Agents' commands (sfa-web, sfa-artifact, sfa-git):
 * it asks SF Agents through the agent's proxy socket, as a CONNECT to the
 * name sfa-host, then sends one JSON line ({argv, cwd, stdin?}) and prints the
 * one JSON line it gets back. SF Agents knows the agent from the socket and
 * checks what it may do.
 */
export const CLIENT_SOURCE = String.raw`'use strict';
const net = require('node:net');
/** Asks SF Agents once: resolves with its reply ({ok, text} or {ok: false, error}). */
function request(argv, stdin) {
  return new Promise((resolve) => {
    const name = argv[0];
    const socket = net.connect('/run/sfa/proxy.sock');
    let state = 'head';
    let data = Buffer.alloc(0);
    socket.on('connect', () => socket.write('CONNECT sfa-host:1 HTTP/1.1\r\nHost: sfa-host:1\r\n\r\n'));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (state !== 'head') return;
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = data.subarray(0, end).toString('latin1').split('\r\n')[0];
      data = data.subarray(end + 4);
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        state = 'done';
        socket.destroy();
        return resolve({ ok: false, error: 'SF Agents refused: ' + status });
      }
      state = 'body';
      socket.write(JSON.stringify({ argv, cwd: process.cwd(), ...(stdin !== undefined ? { stdin } : {}) }) + '\n');
    });
    socket.on('error', (error) => {
      if (state !== 'done') resolve({ ok: false, error: 'cannot reach SF Agents: ' + error.message });
      state = 'done';
    });
    socket.on('end', () => {
      if (state === 'done') return;
      state = 'done';
      try { resolve(JSON.parse(data.toString('utf8'))); } catch { resolve({ ok: false, error: 'no answer from SF Agents.' }); }
    });
  });
}
function run(name) {
  const args = process.argv.slice(2);
  const send = async (stdin) => {
    const reply = await request([name].concat(args), stdin);
    if (!reply.ok) {
      process.stderr.write(name + ': ' + reply.error + '\n');
      process.exit(1);
    }
    process.stdout.write(reply.text.endsWith('\n') ? reply.text : reply.text + '\n');
    if (reply.truncated) process.stderr.write(name + ': the result was cut at 1 MB.\n');
  };
  if (args.includes('--stdin')) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => send(input));
  } else send();
}
module.exports = run;
module.exports.request = request;
`;

/** One SF Agents command's launcher in /run/sfa/bin. */
export function clientLauncher(name: string): string {
  return `#!/usr/bin/env node\nrequire('/run/sfa/bin/sfa-client.cjs')(${JSON.stringify(name)});\n`;
}
