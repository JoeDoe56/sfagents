/**
 * The SF Agents web server: serves the browser client, runs the root agent
 * against the persistent conversation, streams progress over Server-Sent
 * Events, and handles approvals, artifacts and up2k uploads.
 *
 * Security model: the server can run tools with the user's permissions, so
 * by default it listens on 127.0.0.1 only. Every request must carry a Host
 * header naming this server (DNS-rebinding protection); state-changing
 * requests must be JSON or up2k chunk posts (both force a CORS preflight,
 * which is never granted) and, when the browser sends an Origin, it must be
 * this server. Artifacts and uploads are served under a CSP sandbox so a
 * page the model wrote cannot call this API.
 */

import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentRuntime,
  AgentTerminateMode,
  ArtifactError,
  getErrorMessage,
  type AgentRunResult,
  type AgentSession,
  type AgentTree,
  type AttachmentRef,
  type ConfirmationDecision,
  type ConfirmationRequest,
  type ConversationService,
  type ProviderFactory,
  type RuntimeEvent,
} from '@sfagents/core';
import { Up2kError, Up2kStore, DEFAULT_MAX_UPLOAD_BYTES } from './up2k.js';
import { describeApproval, describeCall, displayArtifact, displayAttachment, displayItems, type DisplayApproval, type DisplayItem } from './display.js';

export const DEFAULT_PORT = 8093;
export const DEFAULT_HOST = '127.0.0.1';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 400_000;
const MAX_ATTACHMENTS = 20;

export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface WebServerOptions {
  tree: AgentTree;
  /** A persistent conversation (the server is its single writer while running). */
  conversation: ConversationService;
  port?: number;
  host?: string;
  /** Approve every tool call that would ask (sfagents web --yes). */
  approveAll?: boolean;
  /** Tests inject a scripted provider. */
  providerFactory?: ProviderFactory;
  publicDir?: string;
  maxUploadBytes?: number;
  log?: (line: string) => void;
}

interface LiveSegment {
  kind: 'text' | 'activity';
  id: string;
  text: string;
  status?: string;
}

interface LiveRun {
  id: string;
  controller: AbortController;
  segments: LiveSegment[];
}

interface PendingApproval {
  display: DisplayApproval;
  resolve: (decision: ConfirmationDecision) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Media types the browser may display inline (others download). */
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|svg\+xml|avif)|text\/|application\/(json|pdf|xml)|video\/(mp4|webm)|audio\/)/;

const SANDBOX_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; base-uri 'none'";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(type)) return Promise.reject(new HttpError(415, 'Expected Content-Type: application/json.'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export class WebServer {
  private readonly runtime: AgentRuntime;
  private readonly session: AgentSession;
  private readonly conversation: ConversationService;
  private readonly server: http.Server;
  private readonly up2k: Up2kStore;
  private readonly clients = new Set<ServerResponse>();
  private readonly approvals = new Map<string, PendingApproval>();
  private live: LiveRun | undefined;
  private artifactSignature = '';
  private readonly publicDir: string;
  private readonly log: (line: string) => void;
  private heartbeat: NodeJS.Timeout | undefined;
  private port: number;
  private readonly host: string;
  private runPromise: Promise<void> | undefined;

  constructor(private readonly options: WebServerOptions) {
    if (!options.conversation.dir || !options.conversation.file) throw new Error('The web interface needs a persistent conversation.');
    this.conversation = options.conversation;
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? DEFAULT_HOST;
    this.publicDir = options.publicDir ?? PUBLIC_DIR;
    this.log = options.log ?? (() => {});
    this.runtime = new AgentRuntime({
      tree: options.tree,
      conversation: options.conversation,
      approveAll: options.approveAll,
      providerFactory: options.providerFactory,
      confirm: (request, signal) => this.confirm(request, signal),
    });
    this.session = this.runtime.createSession();
    this.up2k = new Up2kStore(options.conversation.dir, options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
    this.artifactSignature = this.signature();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => this.fail(res, error));
    });
    // Long uploads and event streams must not be cut by Node's defaults.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
  }

  /** Starts listening; resolves with the URL to open. */
  async start(): Promise<string> {
    this.up2k.init();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.server.off('listening', onListening);
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(`Port ${this.port} on ${this.host} is already in use. Stop the other program or choose another port with --port.`)
            : error,
        );
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    if (address && typeof address === 'object') this.port = address.port;
    this.heartbeat = setInterval(() => this.broadcastRaw(': keep-alive\n\n'), 25_000);
    const shown = this.host === '0.0.0.0' || this.host === '::' ? 'localhost' : this.host.includes(':') ? `[${this.host}]` : this.host;
    return `http://${shown}:${this.port}/`;
  }

  get listeningPort(): number {
    return this.port;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.live?.controller.abort(new Error('server stopping'));
    for (const a of this.approvals.values()) a.resolve('deny');
    await this.runPromise?.catch(() => undefined);
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
    await this.up2k.close();
    await this.runtime.dispose();
  }

  // ---------------------------------------------------------------------------
  // Request handling

  private allowedHost(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!host) return false;
    if (this.host === '0.0.0.0' || this.host === '::') return true;
    const names = new Set(['localhost', '127.0.0.1', '[::1]', this.host.includes(':') ? `[${this.host}]` : this.host]);
    return [...names].some((n) => host === `${n}:${this.port}`);
  }

  private checkWrite(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw new HttpError(403, 'Cross-origin requests are not allowed.');
    }
    if (originHost !== String(req.headers.host ?? '').toLowerCase()) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }

  private fail(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof Up2kError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof ArtifactError) return sendJson(res, 404, { error: error.message });
    this.log(`web: ${getErrorMessage(error)}`);
    sendJson(res, 500, { error: getErrorMessage(error) });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowedHost(req)) throw new HttpError(421, 'Unexpected Host header.');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') this.checkWrite(req);

    if (p.startsWith('/api/')) {
      const parts = p.split('/').slice(2).map(decodeURIComponent);
      const route = `${method} ${parts[0]}`;
      switch (route) {
        case 'GET state':
          return sendJson(res, 200, this.snapshot());
        case 'GET messages': {
          const before = Number(url.searchParams.get('before'));
          return sendJson(res, 200, displayItems(this.conversation.state, { before: Number.isFinite(before) && before > 0 ? before : undefined, limit: 200 }));
        }
        case 'GET events':
          return this.openEvents(req, res);
        case 'POST messages':
          return this.postMessage(req, res);
        case 'POST cancel':
          await readJson(req);
          this.live?.controller.abort(new Error('cancelled by user'));
          return sendJson(res, 200, { ok: true });
        case 'POST approvals':
          return this.answerApproval(parts[1] ?? '', req, res);
        case 'GET artifacts':
          if (parts[1] && parts[2] === 'raw') return this.serveArtifact(parts[1], url, res);
          return sendJson(res, 200, { artifacts: this.conversation.artifacts().filter((a) => a.type !== 'agent_transcript').map(displayArtifact) });
        case 'POST artifacts': {
          if (!parts[1] || parts[2] !== 'pin') throw new HttpError(404, 'Not found.');
          const body = (await readJson(req)) as { pinned?: unknown };
          if (typeof body.pinned !== 'boolean') throw new HttpError(400, '"pinned" must be true or false.');
          this.conversation.setArtifactPinned(parts[1], body.pinned);
          this.publishArtifacts(true);
          return sendJson(res, 200, { ok: true });
        }
        case 'GET uploads':
          return this.serveUpload(parts[1] ?? '', res);
        case 'POST up2k': {
          if (parts[1] === 'handshake') return sendJson(res, 200, await this.up2k.handshake(await readJson(req)));
          if (parts[1] === 'chunk') {
            const wark = String(req.headers['x-up2k-wark'] ?? '');
            const hash = String(req.headers['x-up2k-hash'] ?? '');
            if (!wark || !hash) throw new HttpError(400, 'X-Up2k-Wark and X-Up2k-Hash are required.');
            const r = await this.up2k.receive(wark, hash, req);
            return sendJson(res, 200, { remaining: r.remaining, ...(r.attachment ? { attachment: displayAttachment(r.attachment) } : {}) });
          }
          throw new HttpError(404, 'Not found.');
        }
        default:
          throw new HttpError(404, 'Not found.');
      }
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    return this.serveStatic(p, req, res);
  }

  private serveStatic(p: string, req: IncomingMessage, res: ServerResponse): void {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(this.publicDir, rel);
    const inside = path.relative(this.publicDir, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new HttpError(404, 'Not found.');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Not found.');
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    const headers: Record<string, string | number> = {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      ETag: etag,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (rel === 'index.html') {
      headers['Content-Security-Policy'] =
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
      headers['Referrer-Policy'] = 'no-referrer';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  }

  private serveBytes(res: ServerResponse, data: Buffer, mime: string, filename: string, download: boolean): void {
    const inline = !download && INLINE_TYPES.test(mime);
    const type = mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml' ? `${mime}; charset=utf-8` : mime;
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Security-Policy': SANDBOX_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  }

  private serveArtifact(id: string, url: URL, res: ServerResponse): void {
    const rev = url.searchParams.get('rev');
    const content = this.conversation.artifactContent(id, rev ? Number(rev) : undefined);
    this.serveBytes(res, content.data, content.mime, content.filename, url.searchParams.has('download'));
  }

  private serveUpload(id: string, res: ServerResponse): void {
    const ref = this.findAttachment(id);
    if (!ref) throw new HttpError(404, 'No such upload.');
    const data = this.conversation.readAttachment(ref);
    if (!data) throw new HttpError(404, 'The uploaded file is missing.');
    this.serveBytes(res, data, ref.mime, ref.name, false);
  }

  private findAttachment(id: string): AttachmentRef | undefined {
    const fromUp2k = this.up2k.attachment(id);
    if (fromUp2k) return fromUp2k;
    for (const m of this.conversation.state.messages) for (const a of m.attachments ?? []) if (a.id === id) return a;
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // State and events

  private snapshot() {
    const root = this.options.tree.root.definition;
    const { items, more } = displayItems(this.conversation.state, { hideRun: this.live ? this.conversation.activeRootRun : undefined });
    return {
      agent: { id: root.id, model: root.model, provider: root.provider, description: root.description ?? '' },
      conversation: { file: this.conversation.file },
      items,
      more,
      artifacts: this.conversation.artifacts().filter((a) => a.type !== 'agent_transcript').map(displayArtifact),
      live: this.live ? { id: this.live.id, segments: this.live.segments } : null,
      approvals: [...this.approvals.values()].map((a) => a.display),
      notices: this.conversation.notices.filter((n) => n.kind === 'interrupted' || n.kind === 'recovered').map((n) => n.message),
      limits: { maxUploadBytes: this.up2k.maxBytes, maxAttachments: MAX_ATTACHMENTS, maxMessageChars: MAX_MESSAGE_CHARS },
    };
  }

  private openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private broadcastRaw(text: string): void {
    for (const c of this.clients) c.write(text);
  }

  private broadcast(event: string, data: unknown): void {
    this.broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private signature(): string {
    return this.conversation
      .artifacts()
      .map((a) => `${a.id}:${a.rev}:${a.pinned ? 1 : 0}`)
      .join(',');
  }

  private publishArtifacts(force = false): void {
    const sig = this.signature();
    if (!force && sig === this.artifactSignature) return;
    this.artifactSignature = sig;
    this.broadcast('artifacts', { artifacts: this.conversation.artifacts().filter((a) => a.type !== 'agent_transcript').map(displayArtifact) });
  }

  // ---------------------------------------------------------------------------
  // Runs

  private async postMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { text?: unknown; attachments?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    const ids = Array.isArray(body.attachments) ? body.attachments : [];
    if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(413, `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
    if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `At most ${MAX_ATTACHMENTS} attachments per message.`);
    const attachments: AttachmentRef[] = [];
    for (const id of ids) {
      const ref = typeof id === 'string' ? this.up2k.attachment(id) : undefined;
      if (!ref) throw new HttpError(400, `Unknown or unfinished upload "${String(id)}".`);
      attachments.push(ref);
    }
    if (!text.trim() && attachments.length === 0) throw new HttpError(400, 'The message is empty.');
    if (this.live) throw new HttpError(409, 'The agent is still working on the previous message.');
    const run = this.startRun(text, attachments);
    sendJson(res, 202, { run });
  }

  private startRun(text: string, attachments: AttachmentRef[]): string {
    const id = `w${randomBytes(6).toString('hex')}`;
    const live: LiveRun = { id, controller: new AbortController(), segments: [] };
    this.live = live;
    const it = this.session.send(text, { signal: live.controller.signal, attachments });
    // The generator records the user message synchronously on the first next().
    const first = it.next();
    const stored = [...this.conversation.state.messages].reverse().find((m) => m.role === 'user');
    if (stored) {
      const item: DisplayItem = { kind: 'user', id: stored.id, seq: stored.seq, time: stored.time, text: stored.content, attachments: (stored.attachments ?? []).map(displayAttachment) };
      this.broadcast('user', { run: id, item });
    }
    this.broadcast('run_start', { run: id });
    this.runPromise = (async () => {
      let result: AgentRunResult | undefined;
      let failure: unknown;
      try {
        let next = await first;
        while (!next.done) {
          this.onEvent(live, next.value);
          next = await it.next();
        }
        result = next.value;
      } catch (error) {
        failure = error;
      }
      this.live = undefined;
      this.publishArtifacts();
      const { items, more } = displayItems(this.conversation.state);
      this.broadcast('run_end', {
        run: id,
        status: result?.status ?? AgentTerminateMode.ERROR,
        error: failure ? getErrorMessage(failure) : result?.error,
        items,
        more,
      });
    })();
    return id;
  }

  private onEvent(live: LiveRun, event: RuntimeEvent): void {
    const root = event.agentPath.length === 1;
    switch (event.type) {
      case 'text': {
        if (!root) return;
        const last = live.segments[live.segments.length - 1];
        if (last?.kind === 'text') last.text += event.text;
        else live.segments.push({ kind: 'text', id: `t${live.segments.length}`, text: event.text });
        this.broadcast('delta', { run: live.id, text: event.text });
        return;
      }
      case 'tool_request': {
        const prefix = root ? '' : `${event.agentPath.slice(1).join(' › ')}: `;
        const seg: LiveSegment = { kind: 'activity', id: `${event.agentPath.join('/')}:${event.callId}`, text: prefix + describeCall(event.name, JSON.stringify(event.args)), status: 'running' };
        live.segments.push(seg);
        this.broadcast('activity', { run: live.id, segment: seg });
        return;
      }
      case 'tool_result': {
        const id = `${event.agentPath.join('/')}:${event.callId}`;
        const seg = live.segments.find((s) => s.id === id);
        const status = event.ok ? 'ok' : event.errorType === 'execution_denied' ? 'denied' : 'error';
        if (seg) seg.status = status;
        this.broadcast('activity_end', { run: live.id, id, status });
        this.publishArtifacts();
        return;
      }
      case 'warning':
      case 'error':
        if (root) this.broadcast('notice', { run: live.id, text: event.message, level: event.type });
        return;
      default:
        return;
    }
  }

  private confirm(request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationDecision> {
    return new Promise((resolve) => {
      const id = `p${randomBytes(6).toString('hex')}`;
      const display = describeApproval(id, request);
      const done = (decision: ConfirmationDecision) => {
        if (!this.approvals.has(id)) return;
        this.approvals.delete(id);
        signal.removeEventListener('abort', onAbort);
        this.broadcast('approval_done', { id, decision });
        resolve(decision);
      };
      const onAbort = () => done('deny');
      this.approvals.set(id, { display, resolve: done });
      signal.addEventListener('abort', onAbort, { once: true });
      this.broadcast('approval', { approval: display });
    });
  }

  private async answerApproval(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { decision?: unknown };
    const decision = body.decision;
    if (decision !== 'allow_once' && decision !== 'allow_always' && decision !== 'deny') throw new HttpError(400, '"decision" must be allow_once, allow_always or deny.');
    const pending = this.approvals.get(id);
    if (!pending) throw new HttpError(404, 'That approval is no longer pending.');
    pending.resolve(decision);
    sendJson(res, 200, { ok: true });
  }

  /** Waits for the current run to finish (tests). */
  async idle(): Promise<void> {
    await this.runPromise;
  }
}
