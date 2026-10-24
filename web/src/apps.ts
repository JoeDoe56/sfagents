/**
 * Application artifacts: a web app the agent started on this computer
 * (a dev server on 127.0.0.1:<port>), served through SF Agents' own address
 * so any device that reaches SF Agents reaches the app too.
 *
 * The app lives under /apps/<id>/. Apps usually load absolute paths
 * (/src/main.ts, /@vite/client, /_next/…) and open live-reload sockets at
 * "/", so those are routed back to the app as well: a request belongs to an
 * app when its page (the Referer) is the app's, or when it is not one of SF
 * Agents' own paths and the browser last opened that app (a cookie set on
 * /apps/<id>/). Redirects and cookies the app sets are rewritten to match.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export const APP_COOKIE = 'sfagents_app';

export interface AppRoute {
  id: string;
  target: URL;
  /** Path and query to request from the app. */
  path: string;
  /** The request came in under /apps/<id>/ (the cookie is refreshed). */
  prefixed: boolean;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** What an app's files may need on their way through (Remote Desktop's page, remote-embed.ts). */
export interface AppHooks {
  /** A file SF Agents answers itself instead of the app. */
  local?: (route: AppRoute, pathname: string) => { type: string; body: string } | null;
  /** Changes a text file's contents; returns null to leave it as it is. */
  transform?: (route: AppRoute, pathname: string) => ((text: string) => string | null) | null;
  /** An app that owns these socket paths whatever the browser opened last. */
  claimUpgrade?: (pathname: string) => string | undefined;
}

/**
 * The app's security policy, as SF Agents serves it: it may be framed by SF
 * Agents (not by anyone else), and its sockets go to SF Agents' address.
 */
export function rewriteCsp(csp: string, host: string): string {
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const name = d.split(/\s+/)[0]!.toLowerCase();
      if (name === 'frame-ancestors') return "frame-ancestors 'self'";
      if (name === 'connect-src') return `connect-src 'self' ws://${host} wss://${host}`;
      return d;
    })
    .join('; ');
}

export class AppProxy {
  constructor(
    /** The app's address for an artifact id, if it is an application artifact. */
    private readonly target: (id: string) => string | undefined,
    /** Paths SF Agents itself serves ("/", "/api/…", its static files). */
    private readonly isOwnPath: (pathname: string) => boolean,
    private readonly hooks: AppHooks = {},
  ) {}

  route(req: IncomingMessage): AppRoute | null {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/apps\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const t = this.target(id);
      if (!t) return null;
      const target = new URL(t);
      // "/apps/a1" → the app's first page; "/apps/a1/x" → "/x".
      const rest = m[2] && m[2] !== '/' ? m[2] : target.pathname || '/';
      return { id, target, path: `${rest}${url.search}`, prefixed: true };
    }
    let refererPath = '';
    try {
      refererPath = req.headers.referer ? new URL(req.headers.referer).pathname : '';
    } catch {
      refererPath = '';
    }
    const fromApp = /^\/apps\/([^/]+)\//.exec(refererPath);
    if (fromApp) {
      const id = decodeURIComponent(fromApp[1]!);
      const t = this.target(id);
      if (t) return { id, target: new URL(t), path: `${url.pathname}${url.search}`, prefixed: false };
    }
    const id = cookieValue(req.headers.cookie, APP_COOKIE);
    const t = id ? this.target(id) : undefined;
    if (!id || !t) return null;
    const appReferer = refererPath !== '' && !this.isOwnPath(refererPath);
    if (!this.isOwnPath(url.pathname) || appReferer) return { id, target: new URL(t), path: `${url.pathname}${url.search}`, prefixed: false };
    return null;
  }

  /**
   * WebSocket upgrades: SF Agents' only socket is the terminal, so any other
   * upgrade from a browser that opened an app (live reload at "/") is the app's.
   */
  routeUpgrade(req: IncomingMessage): AppRoute | null {
    const claimed = this.hooks.claimUpgrade?.(new URL(req.url ?? '/', 'http://x').pathname);
    const ct = claimed ? this.target(claimed) : undefined;
    if (claimed && ct) {
      const u = new URL(req.url ?? '/', 'http://x');
      return { id: claimed, target: new URL(ct), path: `${u.pathname}${u.search}`, prefixed: false };
    }
    const direct = this.route(req);
    if (direct) return direct;
    const id = cookieValue(req.headers.cookie, APP_COOKIE);
    const t = id ? this.target(id) : undefined;
    if (!id || !t) return null;
    const url = new URL(req.url ?? '/', 'http://x');
    return { id, target: new URL(t), path: `${url.pathname}${url.search}`, prefixed: false };
  }

  private headers(req: IncomingMessage, route: AppRoute): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: route.target.host };
    // The app sees itself as the origin it runs on.
    if (headers.origin) headers.origin = route.target.origin;
    if (typeof headers.referer === 'string') {
      try {
        const r = new URL(headers.referer);
        headers.referer = `${route.target.origin}${r.pathname.replace(/^\/apps\/[^/]+/, '') || '/'}${r.search}`;
      } catch {
        delete headers.referer;
      }
    }
    // SF Agents' own cookie is not the app's business.
    if (typeof headers.cookie === 'string') {
      const rest = headers.cookie
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith(`${APP_COOKIE}=`))
        .join('; ');
      if (rest) headers.cookie = rest;
      else delete headers.cookie;
    }
    return headers;
  }

  handle(req: IncomingMessage, res: ServerResponse, route: AppRoute): void {
    const pathname = new URL(route.path, 'http://x').pathname;
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    const local = isGet ? this.hooks.local?.(route, pathname) : null;
    if (local) {
      const body = Buffer.from(local.body);
      res.writeHead(200, { 'Content-Type': local.type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const transform = isGet ? this.hooks.transform?.(route, pathname) : null;
    const reqHeaders = this.headers(req, route);
    if (transform) {
      // Plain text, whole, so it can be changed; and not from the browser's cache.
      reqHeaders['accept-encoding'] = 'identity';
      delete reqHeaders['if-none-match'];
      delete reqHeaders['if-modified-since'];
    }
    const upstream = http.request(
      // No connection pooling: a dev server that restarts must not leave stale sockets.
      { host: route.target.hostname, port: route.target.port || 80, method: req.method, path: route.path, headers: reqHeaders, agent: false },
      (up) => {
        const headers = { ...up.headers };
        const csp = headers['content-security-policy'];
        if (typeof csp === 'string') headers['content-security-policy'] = rewriteCsp(csp, String(req.headers.host ?? ''));
        // The app's HTTPS policy is not SF Agents' to set.
        delete headers['strict-transport-security'];
        const loc = headers.location;
        if (typeof loc === 'string') {
          try {
            const u = new URL(loc, route.target);
            if (u.origin === route.target.origin) headers.location = `/apps/${encodeURIComponent(route.id)}${u.pathname}${u.search}${u.hash}`;
          } catch {
            // leave it
          }
        }
        // Cookies the app sets apply to this origin.
        if (Array.isArray(headers['set-cookie'])) headers['set-cookie'] = headers['set-cookie'].map((c) => c.replace(/;\s*domain=[^;]*/i, ''));
        if (route.prefixed) {
          const ours = `${APP_COOKIE}=${encodeURIComponent(route.id)}; Path=/; SameSite=Strict`;
          headers['set-cookie'] = [...(Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : []), ours];
        }
        // The app may be framed by SF Agents.
        delete headers['x-frame-options'];
        if (transform && up.statusCode === 200 && !headers['content-encoding']) {
          const chunks: Buffer[] = [];
          up.on('data', (c: Buffer) => chunks.push(c));
          up.on('end', () => {
            const original = Buffer.concat(chunks);
            const changed = transform(original.toString('utf8'));
            const body = changed === null ? original : Buffer.from(changed);
            delete headers['etag'];
            delete headers['transfer-encoding'];
            delete headers['last-modified'];
            headers['content-length'] = String(body.length);
            headers['cache-control'] = 'no-cache';
            res.writeHead(200, headers);
            res.end(req.method === 'HEAD' ? undefined : body);
          });
          up.on('error', () => res.destroy());
          return;
        }
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Not running</title><body style="font:17px system-ui;margin:40px;background:#000;color:#fff"><h2 style="font-weight:600">The app isn't running</h2><p style="color:#8e8e93">Nothing answers at ${route.target.host}. Start it again (or ask the agent to), then reload.</p></body>`,
      );
    });
    req.pipe(upstream);
  }

  /** Live-reload sockets and other WebSocket upgrades: a byte pipe to the app. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, route: AppRoute): void {
    const upstream = net.connect(Number(route.target.port || 80), route.target.hostname, () => {
      const headers = this.headers(req, route);
      const lines = [`${req.method} ${route.path} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }
}
