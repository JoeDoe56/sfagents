/**
 * The host channel: while a sandboxed command of an agent with web access
 * runs, a Unix socket in a private folder serves its `sf-web` requests from
 * the host, which holds the Bright Data key and the network. Each
 * connection carries one JSON request line and gets one JSON answer line.
 * The host enforces the agent's request quota, a size limit and a time limit.
 *
 * `sf-web` is a small script run by this process's own Node binary (mounted
 * read-only into the sandbox as `sf-node`), so it works wherever SF Agents does.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { sfagentsHome } from '../settings/home.js';
import { getErrorMessage } from '../utils/errors.js';
import type { WebAccess, WebOperation } from '../web/brightdata.js';
import type { SandboxPolicy } from './sandbox.js';

export const MAX_WEB_RESULT_BYTES = 1024 * 1024;
export const WEB_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_WEB_REQUESTS = 25;

/** An agent's web access for one run: shared by its commands, so the quota is per run. */
export interface WebGrant {
  access: WebAccess;
  remaining: number;
}

export interface HostChannel {
  readonly path: string;
  close(): Promise<void>;
}

interface WebRequest {
  op: WebOperation;
  arg: string;
}

function parseRequest(line: string): WebRequest {
  const raw = JSON.parse(line) as Partial<WebRequest>;
  if (raw.op !== 'search' && raw.op !== 'markdown' && raw.op !== 'html') throw new Error('Unknown request.');
  if (typeof raw.arg !== 'string' || !raw.arg.trim() || raw.arg.length > 4000) throw new Error('Missing or too long argument.');
  if (raw.op !== 'search') {
    let url: URL;
    try {
      url = new URL(raw.arg);
    } catch {
      throw new Error(`Not an address: ${raw.arg}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be fetched.');
  }
  return { op: raw.op, arg: raw.arg.trim() };
}

async function answer(grant: WebGrant, line: string, signal: AbortSignal): Promise<{ ok: true; text: string; truncated?: boolean } | { ok: false; error: string }> {
  try {
    const request = parseRequest(line);
    if (grant.remaining <= 0) return { ok: false, error: 'This run has used all of its web requests (limits.webRequests in the agent file).' };
    grant.remaining--;
    const timeout = AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS);
    const text = await grant.access.request(request.op, request.arg, AbortSignal.any([signal, timeout]));
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= MAX_WEB_RESULT_BYTES) return { ok: true, text };
    return { ok: true, text: bytes.subarray(0, MAX_WEB_RESULT_BYTES).toString('utf8'), truncated: true };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/** Starts a channel for one command. */
export async function openHostChannel(grant: WebGrant, signal: AbortSignal): Promise<HostChannel> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-host-')));
  fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, 'host.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_384) return socket.destroy();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      void answer(grant, buffer.slice(0, end), signal).then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
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

/** The `sf-web` command. CommonJS, Node built-ins only: it runs inside the sandbox. */
export const SF_WEB_SCRIPT = `#!/usr/bin/env sf-node
'use strict';
const net = require('node:net');
const [op, ...rest] = process.argv.slice(2);
const usage = 'Usage:\\n  sf-web search <query>   Google results (JSON)\\n  sf-web markdown <url>   a page as Markdown\\n  sf-web html <url>       a page as HTML\\n';
if (!['search', 'markdown', 'html'].includes(op) || !rest.length) {
  process.stderr.write(usage);
  process.exit(op === '-h' || op === '--help' ? 0 : 2);
}
const socketPath = process.env.SFAGENTS_HOST;
if (!socketPath) {
  process.stderr.write('sf-web: no host channel (this agent has no web access).\\n');
  process.exit(1);
}
const socket = net.createConnection(socketPath, () => socket.write(JSON.stringify({ op, arg: rest.join(' ') }) + '\\n'));
let data = '';
socket.setEncoding('utf8');
socket.on('data', (chunk) => (data += chunk));
socket.on('error', (error) => {
  process.stderr.write('sf-web: ' + error.message + '\\n');
  process.exit(1);
});
socket.on('end', () => {
  let reply;
  try {
    reply = JSON.parse(data);
  } catch {
    process.stderr.write('sf-web: no answer from the host.\\n');
    process.exit(1);
  }
  if (!reply.ok) {
    process.stderr.write('sf-web: ' + reply.error + '\\n');
    process.exit(1);
  }
  process.stdout.write(reply.text.endsWith('\\n') ? reply.text : reply.text + '\\n');
  if (reply.truncated) process.stderr.write('sf-web: the result was cut at 1 MB.\\n');
});
`;

let toolsCache: SandboxPolicy['tools'] | undefined;

/** The files that put `sf-web` (and the Node binary it needs) on the sandbox's PATH. */
export function webTools(): NonNullable<SandboxPolicy['tools']> {
  if (toolsCache) return toolsCache;
  const dir = path.join(sfagentsHome(), 'sandbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // .cjs: Node then needs no package.json lookup to know how to load it.
  const script = path.join(dir, 'sf-web.cjs');
  let current = '';
  try {
    current = fs.readFileSync(script, 'utf8');
  } catch {
    // first use
  }
  if (current !== SF_WEB_SCRIPT) {
    const tmp = `${script}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, SF_WEB_SCRIPT, { mode: 0o755 });
    fs.renameSync(tmp, script);
  }
  fs.chmodSync(script, 0o755);
  toolsCache = [
    { path: fs.realpathSync(process.execPath), name: 'sf-node' },
    { path: fs.realpathSync(script), name: 'sf-web' },
  ];
  return toolsCache;
}
