/**
 * The host channel: while a sandboxed command of an agent with web access or
 * artifacts runs, a Unix socket (a named pipe on Windows) in a private folder
 * serves its `sf-web` and `sf-artifact` requests from the host, which holds
 * the Bright Data key, the network and the conversation. Each connection
 * carries one JSON request line ({argv, cwd, stdin?}) and gets one JSON
 * answer line. The host enforces the agent's grants (see host-commands.ts).
 *
 * The commands are small scripts run by this process's own Node binary
 * (mounted read-only into the sandbox as `sf-node`), so they work wherever
 * SF Agents does.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sfagentsHome } from '../settings/home.js';
import { getErrorMessage } from '../utils/errors.js';
import type { WebAccess } from '../web/brightdata.js';
import { HOST_COMMAND_NAMES, runHostCommand, type HostCommandReply, type HostCommands } from '../tools/host-commands.js';
import type { SandboxPolicy } from './sandbox.js';

export const DEFAULT_WEB_REQUESTS = 25;
/** Largest request line (an artifact's --content or --stdin is the big one). */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024 + 65_536;

/** An agent's web access for one run: shared by its commands, so the quota is per run. */
export interface WebGrant {
  access: WebAccess;
  remaining: number;
}

export interface HostChannel {
  readonly path: string;
  close(): Promise<void>;
}

interface HostRequest {
  argv: string[];
  cwd?: string;
  stdin?: string;
}

function parseRequest(line: string): HostRequest {
  const raw = JSON.parse(line) as Partial<HostRequest>;
  if (!Array.isArray(raw.argv) || !raw.argv.length || !raw.argv.every((a) => typeof a === 'string')) throw new Error('Malformed request.');
  return { argv: raw.argv, ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}), ...(typeof raw.stdin === 'string' ? { stdin: raw.stdin } : {}) };
}

async function answer(cmds: HostCommands, line: string, o: { callId?: string; signal: AbortSignal }): Promise<HostCommandReply> {
  let request: HostRequest;
  try {
    request = parseRequest(line);
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
  return runHostCommand(request.argv, cmds, { cwd: request.cwd, stdin: request.stdin, callId: o.callId, signal: o.signal });
}

/** Starts a channel for one command. */
export async function openHostChannel(cmds: HostCommands, o: { callId?: string; signal: AbortSignal }): Promise<HostChannel> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-host-')));
  fs.chmodSync(dir, 0o700);
  // The native broker grants just the selected sandbox account access to this
  // pipe before the command starts. No TCP/loopback exception is needed.
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\sfagents-host-${randomUUID()}` : path.join(dir, 'host.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) return socket.destroy();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      void answer(cmds, buffer.slice(0, end), o).then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    path: socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

/**
 * The client script for one of SF Agents' commands (sf-web, sf-artifact).
 * CommonJS, Node built-ins only: it runs inside the sandbox and hands its
 * arguments (and, with --stdin, what is piped in) to the host channel.
 */
export function hostCommandScript(name: string): string {
  return `#!/usr/bin/env sf-node
'use strict';
const net = require('node:net');
const NAME = ${JSON.stringify(name)};
const args = process.argv.slice(2);
const socketPath = process.env.SFAGENTS_HOST;
if (!socketPath) {
  process.stderr.write(NAME + ': no host channel (this agent may not use ' + NAME + ').\\n');
  process.exit(1);
}
function send(stdin) {
  const socket = net.createConnection(socketPath, () => socket.write(JSON.stringify({ argv: [NAME, ...args], cwd: process.cwd(), ...(stdin !== undefined ? { stdin } : {}) }) + '\\n'));
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => (data += chunk));
  socket.on('error', (error) => {
    process.stderr.write(NAME + ': ' + error.message + '\\n');
    process.exit(1);
  });
  socket.on('end', () => {
    let reply;
    try {
      reply = JSON.parse(data);
    } catch {
      process.stderr.write(NAME + ': no answer from the host.\\n');
      process.exit(1);
    }
    if (!reply.ok) {
      process.stderr.write(NAME + ': ' + reply.error + '\\n');
      process.exit(1);
    }
    process.stdout.write(reply.text.endsWith('\\n') ? reply.text : reply.text + '\\n');
    if (reply.truncated) process.stderr.write(NAME + ': the result was cut at 1 MB.\\n');
  });
}
if (args.includes('--stdin')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => send(input));
} else send();
`;
}

let toolsCache: SandboxPolicy['tools'] | undefined;

/** The files that put SF Agents' commands (and the Node binary they need) on the sandbox's PATH. */
export function hostCommandTools(): NonNullable<SandboxPolicy['tools']> {
  if (toolsCache) return toolsCache;
  const dir = path.join(sfagentsHome(), 'sandbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tools: Array<{ path: string; name: string }> = [{ path: fs.realpathSync(process.execPath), name: 'sf-node' }];
  for (const name of HOST_COMMAND_NAMES) {
    // .cjs: Node then needs no package.json lookup to know how to load it.
    const script = path.join(dir, `${name}.cjs`);
    const content = hostCommandScript(name);
    let current = '';
    try {
      current = fs.readFileSync(script, 'utf8');
    } catch {
      // first use
    }
    if (current !== content) {
      const tmp = `${script}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, { mode: 0o755 });
      fs.renameSync(tmp, script);
    }
    fs.chmodSync(script, 0o755);
    tools.push({ path: fs.realpathSync(script), name });
  }
  toolsCache = tools;
  return toolsCache;
}
