/**
 * The package and Git proxy: lets sandboxed commands of an agent whose network
 * is off reach package registries (npm, PyPI) and Git hosts over HTTPS, and
 * nothing else. It runs in SF Agents on a loopback port in the dynamic range
 * (the only loopback ports the offline sandbox may connect to) and tunnels
 * `CONNECT host:443` for allowed host names only; plain HTTP is refused. The
 * host name is the one the client asked for, resolved here, so a command
 * cannot reach an arbitrary address through it. Every request is logged per
 * agent (time, command, host, allowed or blocked) for the agent sheet.
 *
 * Commands find it through HTTPS_PROXY / HTTP_PROXY, which npm, pip, Git
 * (curl) and most HTTP clients honor. Each agent's proxy URL carries its own
 * random credential, so log entries are attributed to the right agent and
 * other local programs cannot use the proxy.
 */

import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Host names (and their subdomains, where marked) commands may reach. */
export const PACKAGE_HOSTS: readonly string[] = [
  // npm, Yarn, pnpm
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'npm.pkg.github.com',
  // PyPI
  'pypi.org',
  'files.pythonhosted.org',
  // Git over HTTPS (and GitHub release/archive downloads)
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
];

export interface NetworkLogEntry {
  time: string;
  agent: string;
  /** The command that made the request, when known. */
  command?: string;
  host: string;
  port: number;
  allowed: boolean;
  reason?: string;
}

const MAX_LOG = 500;
const CONNECT_TIMEOUT_MS = 15_000;

export function hostAllowed(host: string, port: number, hosts: readonly string[] = PACKAGE_HOSTS): boolean {
  if (port !== 443) return false;
  const h = host.toLowerCase().replace(/\.$/, '');
  // A name, not an address: the proxy resolves it itself.
  if (net.isIP(h) || !/^[a-z0-9.-]+$/.test(h)) return false;
  return hosts.includes(h);
}

/** Splits "host:port" (with [v6] brackets) from a CONNECT target. */
export function parseTarget(target: string): { host: string; port: number } | undefined {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target.trim());
  if (!m) return undefined;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return undefined;
  return { host: m[1]!, port };
}

interface Grant {
  agent: string;
  /** The command currently running for the agent, for the log. */
  command?: string;
}

export class PackageProxy {
  private server?: http.Server;
  private listening?: Promise<number>;
  private grants = new Map<string, Grant>();
  private log: NetworkLogEntry[] = [];
  private listeners = new Set<(entry: NetworkLogEntry) => void>();

  constructor(private readonly hosts: readonly string[] = PACKAGE_HOSTS) {}

  /** Starts listening (once) and resolves with the port. */
  start(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Only CONNECT tunnels (HTTPS). Plain HTTP would let a command read
        // or send anything through an allowed name.
        const grant = this.authorize(req.headers['proxy-authorization']);
        const host = safeHost(req.headers.host);
        this.record(grant, host, 80, false, 'plain HTTP is not allowed; use https');
        res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }).end('SF Agents: only HTTPS to package registries and Git hosts is allowed.\n');
      });
      server.on('connect', (req, client: net.Socket, head: Buffer) => this.connect(req, client, head));
      server.on('clientError', (_e, socket) => socket.destroy());
      server.once('error', reject);
      // Port 0: Windows hands out a dynamic port (49152-65535), the range the
      // offline sandbox may connect to over loopback.
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        server.unref();
        this.server = server;
        resolve((server.address() as net.AddressInfo).port);
      });
    });
    return this.listening;
  }

  /** The proxy URL for an agent's commands (with its credential). */
  async urlFor(agent: string): Promise<string> {
    const port = await this.start();
    let token = [...this.grants.entries()].find(([, g]) => g.agent === agent)?.[0];
    if (!token) {
      token = randomBytes(18).toString('base64url');
      this.grants.set(token, { agent });
    }
    return `http://sfagents:${token}@127.0.0.1:${port}`;
  }

  /** Notes the command an agent is running, for its log entries. */
  setCommand(agent: string, command: string | undefined): void {
    for (const g of this.grants.values()) if (g.agent === agent) g.command = command;
  }

  entries(agent?: string): NetworkLogEntry[] {
    return agent ? this.log.filter((e) => e.agent === agent) : [...this.log];
  }

  onEntry(listener: (entry: NetworkLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authorize(header: string | undefined): Grant | undefined {
    const m = /^Basic\s+(\S+)$/i.exec(header ?? '');
    if (!m) return undefined;
    const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
    const token = decoded.slice(decoded.indexOf(':') + 1);
    for (const [known, grant] of this.grants) {
      const a = Buffer.from(known);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return grant;
    }
    return undefined;
  }

  private record(grant: Grant | undefined, host: string, port: number, allowed: boolean, reason?: string) {
    const entry: NetworkLogEntry = {
      time: new Date().toISOString(),
      agent: grant?.agent ?? '(unknown)',
      ...(grant?.command ? { command: grant.command } : {}),
      host,
      port,
      allowed,
      ...(reason ? { reason } : {}),
    };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    for (const l of this.listeners) l(entry);
  }

  private connect(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    client.on('error', () => client.destroy());
    const grant = this.authorize(req.headers['proxy-authorization']);
    const target = parseTarget(req.url ?? '');
    const refuse = (status: string, reason: string) => {
      this.record(grant, target?.host ?? safeHost(req.url), target?.port ?? 0, false, reason);
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n${status.startsWith('407') ? 'Proxy-Authenticate: Basic realm="sfagents"\r\n' : ''}Content-Length: 0\r\n\r\n`);
    };
    if (!grant) return refuse('407 Proxy Authentication Required', 'no SF Agents proxy credential');
    if (!target) return refuse('400 Bad Request', 'malformed target');
    if (!hostAllowed(target.host, target.port, this.hosts)) {
      return refuse('403 Forbidden', target.port === 443 ? 'host is not a package registry or Git host' : 'only port 443');
    }
    const upstream = net.connect({ host: target.host, port: target.port });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('timed out')));
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(0);
      this.record(grant, target.host, target.port, true);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (error) => {
      if (!connected && client.writable) {
        this.record(grant, target.host, target.port, false, `connection failed: ${error.message}`);
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } else {
        client.destroy();
      }
    });
    client.on('close', () => upstream.destroy());
  }
}

function safeHost(value: string | undefined): string {
  return String(value ?? '').replace(/[^\w.:[\]-]/g, '').slice(0, 255) || '(none)';
}

let shared: PackageProxy | undefined;

/** The proxy SF Agents' commands share. */
export function packageProxy(): PackageProxy {
  shared ??= new PackageProxy();
  return shared;
}
