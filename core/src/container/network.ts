/**
 * Network levels for agent containers, and the proxy that enforces them.
 *
 * Agent containers have no network of their own (`--network none`). Every
 * connection leaves through the agent's proxy socket, over the bridge, to
 * this code in SF Agents, which knows the agent from the socket it came
 * through. It allows what the agent's level allows, opens the connection from
 * this computer, and logs every request. The levels are cumulative:
 *
 *   off  nothing
 *   pkg  package registries and toolchain downloads
 *   git  pkg, plus Git hosts
 *   on   everything except this computer and the local network
 *
 * The name sfa-host is SF Agents itself: SF Agents' commands (sfa-web,
 * sfa-artifact, sfa-git) reach it at every level.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export const NETWORK_LEVELS = ['off', 'pkg', 'git', 'on'] as const;
export type NetworkLevel = (typeof NETWORK_LEVELS)[number];

export function isNetworkLevel(value: unknown): value is NetworkLevel {
  return typeof value === 'string' && (NETWORK_LEVELS as readonly string[]).includes(value);
}

/** An agent file's workspace.network as a level: true (older form) is "on", and false or nothing is "pkg". */
export function networkLevelOf(value: boolean | NetworkLevel | undefined): NetworkLevel {
  if (value === true) return 'on';
  if (isNetworkLevel(value)) return value;
  return 'pkg';
}

/** What each level adds, for the agent editor and the shell tool's description. */
export const NETWORK_LEVEL_TEXT: Record<NetworkLevel, string> = {
  off: 'no network',
  pkg: 'package registries and toolchain downloads only (npm, PyPI, crates.io, Go, NuGet, Maven, RubyGems, Packagist, LuaRocks, CTAN, Debian, rustup, .NET, Playwright)',
  git: 'package registries plus GitHub, GitLab, Codeberg and Bitbucket',
  on: 'the whole internet (not this computer or the local network)',
};

/** Exact names, or ".suffix" for a domain and everything under it. */
export const PACKAGE_HOSTS: readonly string[] = [
  // JavaScript
  'registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'npm.pkg.github.com', 'nodejs.org',
  'jsr.io', 'npm.jsr.io', 'deno.land', 'dl.deno.land', 'bun.sh',
  // Python
  'pypi.org', 'files.pythonhosted.org', 'download.pytorch.org',
  // Rust
  'crates.io', 'index.crates.io', 'static.crates.io', 'static.rust-lang.org', 'sh.rustup.rs',
  // Go
  'proxy.golang.org', 'sum.golang.org', 'index.golang.org', 'go.dev', 'dl.google.com',
  // .NET
  'api.nuget.org', 'globalcdn.nuget.org', '.nuget.org', 'dotnetcli.azureedge.net', 'builds.dotnet.microsoft.com', 'dot.net', 'dotnet.microsoft.com',
  // Java
  'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'plugins-artifacts.gradle.org', 'services.gradle.org', 'downloads.gradle.org',
  // Ruby, PHP, Lua
  'rubygems.org', 'index.rubygems.org', 'packagist.org', 'repo.packagist.org', 'getcomposer.org', 'luarocks.org',
  // TeX
  'ctan.org', 'mirrors.ctan.org', '.ctan.org',
  // Debian and Wine
  'deb.debian.org', 'security.debian.org', 'dl.winehq.org',
  // Playwright browsers
  'playwright.azureedge.net', 'playwright-akamai.azureedge.net', 'playwright-verizon.azureedge.net', 'cdn.playwright.dev',
];

export const GIT_HOSTS: readonly string[] = [
  'github.com', 'codeload.github.com', 'api.github.com', 'gist.github.com',
  'gitlab.com', 'codeberg.org', 'bitbucket.org',
  // They serve anyone's files, so they are not at level pkg.
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com', 'storage.googleapis.com',
];

/** The name SF Agents' own commands connect to. */
export const HOST_CHANNEL_NAME = 'sfa-host';

function matches(host: string, list: readonly string[]): boolean {
  return list.some((entry) => (entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry));
}

export interface Decision {
  allowed: boolean;
  reason?: string;
}

/** Whether `level` allows `host:port` (before the address check). */
export function levelAllows(level: NetworkLevel, host: string, port: number): Decision {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (level === 'off') return { allowed: false, reason: 'this agent has no network (level off)' };
  if (level === 'on') return { allowed: true };
  if (net.isIP(h) || !/^[a-z0-9.-]+$/.test(h)) return { allowed: false, reason: `level ${level} allows host names only, not addresses` };
  if (port !== 443 && port !== 80) return { allowed: false, reason: `level ${level} allows ports 80 and 443 only` };
  if (matches(h, PACKAGE_HOSTS)) return { allowed: true };
  if (level === 'git' && matches(h, GIT_HOSTS)) return { allowed: true };
  return { allowed: false, reason: level === 'pkg' ? 'not a package registry (level pkg)' : 'not a package registry or Git host (level git)' };
}

/**
 * Addresses no agent may reach at any level: this computer, the local
 * network, link-local, carrier-grade NAT (Tailscale) and the like.
 */
/** The eight 16-bit groups of an IPv6 address, or undefined if it is not one. */
export function ipv6Groups(address: string): number[] | undefined {
  if (net.isIP(address) !== 6 || address.includes('%')) return undefined;
  let x = address.toLowerCase();
  // A trailing dotted IPv4 part becomes two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(x);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    x = `${x.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [left, right] = x.split('::') as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(left);
  const tail = right === undefined ? [] : parse(right);
  const groups = right === undefined ? head : [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

/**
 * Whether an address is this computer, the local network or anything else
 * that is not an ordinary public address. Agents never reach those. IPv6 is
 * judged on its expanded form, and only global unicast (2000::/3) counts as
 * public, minus the ranges that carry an IPv4 address (6to4, Teredo) or are
 * reserved; IPv4-mapped, -compatible and NAT64 forms are therefore refused
 * too. Anything that does not parse is treated as private.
 */
export function isPrivateAddress(address: string): boolean {
  const v = net.isIP(address);
  if (v === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (v === 6) {
    const g = ipv6Groups(address);
    if (!g) return true;
    if ((g[0]! & 0xe000) !== 0x2000) return true; // not global unicast
    if (g[0] === 0x2002) return true; // 6to4
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
    if (g[0] === 0x2001 && g[1]! < 0x200) return true; // other IETF special purpose
    return false;
  }
  return true;
}

export interface NetworkEvent {
  agent: string;
  host: string;
  port: number;
  allowed: boolean;
  reason?: string;
  command?: string;
}

export interface ProxyHandlers {
  /** The agent's level now (it can change between requests). */
  level(agent: string): NetworkLevel;
  /** The command the agent is running, for the log. */
  command?(agent: string): string | undefined;
  log(event: NetworkEvent): void;
  /** A connection to sfa-host: SF Agents' commands. */
  hostChannel(agent: string, stream: Duplex, head: Buffer): void;
  /** Address lookup (tests replace it). */
  lookup?(host: string): Promise<string[]>;
  /** Opens the outgoing connection (tests replace it). */
  connect?(address: string, port: number): net.Socket;
}

const MAX_HEAD_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

async function defaultLookup(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  const results = await dns.lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** Handles one connection from an agent's proxy socket. */
export function handleProxyConnection(agent: string, stream: Duplex, handlers: ProxyHandlers): void {
  let head = Buffer.alloc(0);
  stream.on('error', () => stream.destroy());
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      if (head.length > MAX_HEAD_BYTES) stream.destroy();
      return;
    }
    stream.off('data', onData);
    stream.pause();
    void route(agent, stream, head.subarray(0, end + 4), head.subarray(end + 4), handlers);
  };
  stream.on('data', onData);
}

function reply(stream: Duplex, status: string, text = ''): void {
  stream.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

async function route(agent: string, stream: Duplex, headBytes: Buffer, rest: Buffer, h: ProxyHandlers): Promise<void> {
  const lines = headBytes.toString('latin1').split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
  const command = h.command?.(agent);
  const record = (host: string, port: number, allowed: boolean, reason?: string) =>
    h.log({ agent, host, port, allowed, ...(reason ? { reason } : {}), ...(command ? { command } : {}) });
  if (!m) return reply(stream, '400 Bad Request');
  const [, method, target] = m as unknown as [string, string, string];
  let host: string;
  let port: number;
  let forward: Buffer | undefined;
  if (method === 'CONNECT') {
    const t = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target);
    if (!t) return reply(stream, '400 Bad Request');
    host = t[1]!.toLowerCase();
    port = Number(t[2]);
    if (host === HOST_CHANNEL_NAME) {
      stream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      stream.resume();
      h.hostChannel(agent, stream, rest);
      return;
    }
  } else {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return reply(stream, '400 Bad Request', 'SF Agents: send requests through the proxy with an absolute http:// URL, or CONNECT for https.\n');
    }
    if (url.protocol !== 'http:') return reply(stream, '400 Bad Request', 'SF Agents: use CONNECT for https.\n');
    host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    port = Number(url.port || 80);
    // Forward in origin form, one request per connection.
    const headers = lines.slice(1).filter((l) => l && !/^(proxy-|connection:|keep-alive:)/i.test(l));
    forward = Buffer.from(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`, 'latin1');
  }
  if (!(port > 0 && port < 65536)) return reply(stream, '400 Bad Request');
  const level = h.level(agent);
  const decision = levelAllows(level, host, port);
  if (!decision.allowed) {
    record(host, port, false, decision.reason);
    return reply(stream, '403 Forbidden', `SF Agents: ${host}:${port} is blocked: ${decision.reason}.\n`);
  }
  let addresses: string[];
  try {
    addresses = await (h.lookup ?? defaultLookup)(host);
  } catch (error) {
    record(host, port, false, `name lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return reply(stream, '502 Bad Gateway', `SF Agents: cannot resolve ${host}.\n`);
  }
  const address = addresses.find((a) => !isPrivateAddress(a));
  if (!address) {
    record(host, port, false, 'resolves to this computer or the local network');
    return reply(stream, '403 Forbidden', `SF Agents: ${host} is on this computer or the local network, which agents cannot reach.\n`);
  }
  const upstream = (h.connect ?? ((a, p) => net.connect({ host: a, port: p })))(address, port);
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('timed out')));
  let connected = false;
  upstream.once('connect', () => {
    connected = true;
    upstream.setTimeout(0);
    record(host, port, true);
    if (forward) upstream.write(forward);
    else stream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length) upstream.write(rest);
    stream.pipe(upstream);
    upstream.pipe(stream);
    stream.resume();
  });
  upstream.on('error', (error) => {
    if (!connected) {
      record(host, port, false, `connection failed: ${error.message}`);
      reply(stream, '502 Bad Gateway', `SF Agents: cannot connect to ${host}:${port}: ${error.message}\n`);
    } else stream.destroy();
  });
  stream.on('close', () => upstream.destroy());
  // Ending (not destroying) lets data already queued for the agent go out first.
  upstream.on('close', () => {
    if (!stream.writableEnded) stream.end();
  });
}
