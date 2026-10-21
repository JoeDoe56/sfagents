/**
 * The SF Agents web server: serves the browser client, runs the root agent
 * against the persistent conversation, streams progress over Server-Sent
 * Events, and handles approvals, artifacts, up2k uploads and the resource
 * monitor's readings.
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
  threadKey,
  type AgentRunResult,
  type AgentSession,
  type AgentNode,
  type AgentTree,
  type AttachmentRef,
  type ConfirmationDecision,
  type ConfirmationRequest,
  type ConversationService,
  type ProviderFactory,
  type RuntimeEvent,
} from '@sfagents/core';
import { Up2kError, Up2kStore, DEFAULT_MAX_UPLOAD_BYTES } from './up2k.js';
import { SystemMonitor, type SystemSource } from './system.js';
import { FileError, FileService, INLINE_MIME, type Conflict } from './files.js';
import { writeZip, zipSourcesFor } from './zip.js';
import { PerformanceMonitor } from './performance.js';
import { ProcessError, ProcessMonitor } from './processes.js';
import { LhmClient } from './lhm.js';
import { AgentSettingsStore, EFFORT_LEVELS, ModelWindows, parseEffort } from './agent-settings.js';
import { describeApproval, describeCall, displayArtifact, displayAttachment, displayItems, displaySections, type DisplayApproval, type DisplayItem } from './display.js';

export const DEFAULT_PORT = 8093;
export const DEFAULT_HOST = '127.0.0.1';

/** Explicit browser origin accepted when a reverse proxy preserves Host. */
export function parsePublicOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
    return url.origin;
  } catch {
    throw new Error('--public-origin must be an HTTP(S) origin without credentials, a path, query or fragment.');
  }
}
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 400_000;
const MAX_ATTACHMENTS = 20;
const MAX_ATTACH_FROM_FILES = 50 * 1024 * 1024;

export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface WebServerOptions {
  /** Ask Windows to elevate only the bundled, read-only sensor worker. */
  sensorAdmin?: boolean;
  tree: AgentTree;
  /** A persistent conversation (the server is its single writer while running). */
  conversation: ConversationService;
  port?: number;
  host?: string;
  /** Exact external origin; the listening address remains independently configured. */
  publicOrigin?: string;
  /** Approve every tool call that would ask (sfagents web --yes). */
  approveAll?: boolean;
  /** Tests inject a scripted provider. */
  providerFactory?: ProviderFactory;
  publicDir?: string;
  maxUploadBytes?: number;
  log?: (line: string) => void;
  /** Tests replace what the resource monitor reads from the machine. */
  systemSource?: SystemSource;
  /** Libre Hardware Monitor's web server for the resource monitor (default http://127.0.0.1:8085); null: do not use it. */
  lhmUrl?: string | null;
}

interface LiveSegment {
  kind: 'text' | 'activity';
  id: string;
  text: string;
  status?: string;
  /** A message to another agent: who, and their thread. */
  agent?: string;
  thread?: string;
  /** The artifact a call created or updated (set when it finishes). */
  artifact?: string;
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** Media types the browser may display inline (others download). */
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|svg\+xml|avif)|text\/|application\/(json|pdf|xml)|video\/(mp4|webm)|audio\/)/;

const SANDBOX_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; base-uri 'none'";
/**
 * Files from the computer open with no scripts at all (an HTML or SVG file
 * shows its markup and styles only). PDFs are left to the browser's viewer,
 * which a sandbox would block.
 */
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; font-src 'self' data:";

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
  private readonly publicOrigin?: string;
  private readonly publicHost?: string;
  private runPromise: Promise<void> | undefined;
  private readonly system: SystemMonitor;
  private readonly files: FileService;
  private readonly performance: PerformanceMonitor;
  private readonly processes: ProcessMonitor;
  private readonly startedAt = Date.now();
  private cpuMark = { at: Date.now(), usage: process.cpuUsage() };
  private readonly agentSettings: AgentSettingsStore;
  private readonly windows = new ModelWindows();

  constructor(private readonly options: WebServerOptions) {
    if (!options.conversation.dir || !options.conversation.file) throw new Error('The web interface needs a persistent conversation.');
    this.conversation = options.conversation;
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? DEFAULT_HOST;
    this.publicOrigin = options.publicOrigin === undefined ? undefined : parsePublicOrigin(options.publicOrigin);
    this.publicHost = this.publicOrigin === undefined ? undefined : new URL(this.publicOrigin).host;
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
    this.agentSettings = new AgentSettingsStore(options.conversation.dir);
    // The agent picked last time keeps replying (when it still exists).
    const saved = this.agentSettings.get().agent;
    this.selectAgent(saved && options.tree.byId.has(saved) ? saved : this.session.node.id, false);
    this.system = new SystemMonitor(options.systemSource, {
      ...(options.lhmUrl === undefined ? {} : { lhm: options.lhmUrl === null ? null : new LhmClient(options.lhmUrl) }),
      elevateWindowsSensors: options.sensorAdmin,
      log: this.log,
    });
    this.up2k = new Up2kStore(options.conversation.dir, options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
    this.files = new FileService({ stateDir: options.conversation.dir, projectDir: options.tree.configDir });
    this.performance = new PerformanceMonitor(this.system);
    this.processes = new ProcessMonitor(this.system.systemSource);
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
    await this.system.close();
    this.processes.close();
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
    if (host === this.publicHost) return true;
    if (this.host === '0.0.0.0' || this.host === '::') return true;
    const names = new Set(['localhost', '127.0.0.1', '[::1]', this.host.includes(':') ? `[${this.host}]` : this.host]);
    return [...names].some((n) => host === `${n}:${this.port}`);
  }

  private checkWrite(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    if (String(req.headers.host ?? '').toLowerCase() === this.publicHost) {
      if (origin !== this.publicOrigin) throw new HttpError(403, 'Cross-origin requests are not allowed.');
      return;
    }
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
    if (error instanceof ProcessError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof FileError) return sendJson(res, error.status, { error: error.message, ...(error.details && typeof error.details === 'object' ? error.details : {}) });
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
        case 'GET files':
          this.checkFetchSite(req);
          return this.getFiles(parts[1] ?? '', url, req, res);
        case 'POST files':
          return this.postFiles(parts[1] ?? '', parts[2], req, res);
        case 'GET system':
          this.checkFetchSite(req);
          return this.getSystem(parts[1], res);
        case 'POST system':
          return this.postSystem(parts[1] ?? '', req, res);
        case 'GET processes':
          this.checkFetchSite(req);
          if (parts[1]) return sendJson(res, 200, await this.processes.detail(parts[1]));
          return sendJson(res, 200, await this.processes.list());
        case 'POST processes': {
          const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
          if (parts[2] === 'end') return sendJson(res, 200, await this.processes.end(parts[1], { force: body.force === true, tree: body.tree === true }));
          if (parts[2] === 'priority') return sendJson(res, 200, this.processes.setPriority(parts[1], body.level));
          throw new HttpError(404, 'Not found.');
        }
        case 'GET agents':
          this.checkFetchSite(req);
          return sendJson(res, 200, this.agentsInfo());
        case 'GET threads': {
          this.checkFetchSite(req);
          if (!parts[1]) return sendJson(res, 200, { threads: this.runtime.threads.list() });
          const state = this.runtime.threads.read(parts[1]);
          if (!state) throw new HttpError(404, 'No such thread.');
          const info = this.runtime.threads.list().find((t) => t.key === parts[1]);
          return sendJson(res, 200, { thread: info, ...displayItems(state, { thread: true, limit: 2000 }) });
        }
        case 'GET agent':
          this.checkFetchSite(req);
          if (parts[1] === 'context') return sendJson(res, 200, await this.contextInfo());
          if (parts[1]) throw new HttpError(404, 'Not found.');
          return sendJson(res, 200, this.agentInfo());
        case 'POST agent': {
          const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
          if (body.action === 'reset-context') {
            // Later requests start from a fresh working context; the history stays stored.
            if (this.session.running || this.live) throw new HttpError(409, 'Wait for the current reply to finish.');
            this.session.resetContext();
            return sendJson(res, 200, await this.contextInfo());
          }
          // A new agent first, so a reasoning effort in the same request is that agent's.
          if (body.agent !== undefined) {
            if (typeof body.agent !== 'string' || !this.options.tree.byId.has(body.agent)) throw new HttpError(400, `No agent named "${String(body.agent)}".`);
            if (body.agent !== this.session.node.id && (this.session.running || this.live)) throw new HttpError(409, 'Wait for the current reply to finish before changing the agent.');
            this.selectAgent(body.agent);
          }
          if ('reasoning' in body) {
            let effort;
            try {
              effort = parseEffort(body.reasoning);
            } catch (error) {
              throw new HttpError(400, getErrorMessage(error));
            }
            const settings = this.agentSettings.get();
            const efforts = { ...(settings.efforts ?? {}) };
            if (effort) efforts[this.session.node.id] = effort;
            else delete efforts[this.session.node.id];
            this.agentSettings.set({ ...settings, efforts });
            this.session.reasoning = effort ?? undefined;
          }
          const info = this.agentInfo();
          this.broadcast('agent', info);
          return sendJson(res, 200, info);
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
          return sendJson(res, 200, { artifacts: this.displayArtifacts() });
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
          if (parts[1] === 'handshake') {
            const body = await readJson(req);
            const dest = body && typeof body === 'object' && 'dest' in body ? await this.files.uploadFolder((body as { dest: unknown }).dest) : undefined;
            return sendJson(res, 200, await this.up2k.handshake(body, dest));
          }
          if (parts[1] === 'chunk') {
            const wark = String(req.headers['x-up2k-wark'] ?? '');
            const hash = String(req.headers['x-up2k-hash'] ?? '');
            if (!wark || !hash) throw new HttpError(400, 'X-Up2k-Wark and X-Up2k-Hash are required.');
            const r = await this.up2k.receive(wark, hash, req);
            return sendJson(res, 200, { remaining: r.remaining, ...(r.attachment ? { attachment: displayAttachment(r.attachment) } : {}), ...(r.file ? { file: r.file } : {}) });
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

  /**
   * Reads of the computer's files and processes come only from this app's
   * own pages: a browser says where a request comes from in Sec-Fetch-Site,
   * so another site cannot even probe for a file with an <img> tag.
   */
  private checkFetchSite(req: IncomingMessage): void {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site requests are not allowed.');
  }

  // ---------------------------------------------------------------------------
  // System monitor windows

  private async getSystem(action: string | undefined, res: ServerResponse): Promise<void> {
    switch (action ?? '') {
      case '': {
        // Resource use for the monitor in the sheet.
        const snapshot = await this.system.read();
        this.performance.record(snapshot);
        return sendJson(res, 200, snapshot);
      }
      case 'detail':
        return sendJson(res, 200, await this.performance.detail());
      case 'users':
        return sendJson(res, 200, await this.processes.users());
      case 'services':
        return sendJson(res, 200, await this.processes.services());
      case 'startup':
        return sendJson(res, 200, await this.processes.startup());
      case 'sfagents':
        return sendJson(res, 200, this.selfInfo());
      default:
        throw new HttpError(404, 'Not found.');
    }
  }

  private async postSystem(action: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (action === 'services') return sendJson(res, 200, await this.processes.service(body.name, body.action, body.scope));
    if (action === 'startup') return sendJson(res, 200, await this.processes.setStartup(body.id, body.enabled === true));
    throw new HttpError(404, 'Not found.');
  }

  /** SF Agents' own process and conversation, for its window in the monitor. */
  private selfInfo() {
    const now = Date.now();
    const usage = process.cpuUsage(this.cpuMark.usage);
    const elapsed = Math.max(1, now - this.cpuMark.at) * 1000;
    const cpu = Math.min(1, (usage.user + usage.system) / elapsed / Math.max(1, (this.system.systemSource.cpus().length)));
    this.cpuMark = { at: now, usage: process.cpuUsage() };
    const memory = process.memoryUsage();
    const root = this.session.node.definition;
    const state = this.conversation.state;
    let size: number | null = null;
    try {
      size = this.conversation.file ? fs.statSync(this.conversation.file).size : null;
    } catch {
      size = null;
    }
    return {
      pid: process.pid,
      uptime: Math.round((now - this.startedAt) / 1000),
      cpu,
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external },
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      url: `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`,
      publicOrigin: this.publicOrigin ?? null,
      agent: { id: this.session.node.id, model: root.model, provider: root.provider, agents: this.options.tree.byId.size },
      conversation: {
        file: this.conversation.file,
        size,
        messages: state.messages.length,
        artifacts: this.conversation.artifacts().length,
        sections: displaySections(state).length,
      },
      running: this.live ? { id: this.live.id } : null,
      approvals: this.approvals.size,
      clients: this.clients.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Files

  private async getFiles(action: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = url.searchParams;
    const hidden = q.get('hidden') === '1';
    switch (action) {
      case 'locations': {
        const locations = await this.files.locations();
        const drives = (await this.system.read().catch(() => undefined))?.drives ?? [];
        return sendJson(res, 200, { ...locations, drives, platform: this.files.platform });
      }
      case 'list':
        return sendJson(res, 200, await this.files.list(q.get('path'), { hidden }));
      case 'info':
        return sendJson(res, 200, await this.files.info(q.get('path')));
      case 'size':
        return sendJson(res, 200, await this.files.folderSize(q.get('path')));
      case 'search':
        return sendJson(res, 200, await this.files.search(q.get('path'), q.get('q'), { hidden }));
      case 'text':
        return sendJson(res, 200, await this.files.readText(q.get('path')));
      case 'raw':
        return this.serveFile(await this.files.openForRead(q.get('path')), q.has('download'), req, res);
      case 'zip':
        return this.serveZip(q.getAll('path'), res);
      case 'jobs': {
        const job = this.files.job(q.get('id') ?? '');
        if (!job) throw new HttpError(404, 'No such job.');
        return sendJson(res, 200, job);
      }
      default:
        throw new HttpError(404, 'Not found.');
    }
  }

  private async postFiles(action: string, sub: string | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const conflict = (['ask', 'replace', 'keep', 'skip'].includes(String(body.conflict)) ? body.conflict : 'ask') as Conflict;
    const f = this.files;
    switch (action) {
      case 'mkdir':
        return sendJson(res, 200, await f.mkdir(body.dir, body.name));
      case 'create':
        return sendJson(res, 200, await f.createFile(body.dir, body.name, body.text ?? ''));
      case 'rename':
        return sendJson(res, 200, await f.rename(body.path, body.name));
      case 'text':
        return sendJson(res, 200, await f.writeText(body.path, body.text, body.modified, body.force === true));
      case 'copy':
        return sendJson(res, 200, await f.copy(body.paths, body.dest, conflict));
      case 'move':
        return sendJson(res, 200, await f.move(body.paths, body.dest, conflict));
      case 'duplicate':
        return sendJson(res, 200, await f.duplicate(body.paths));
      case 'trash':
        return sendJson(res, 200, await f.moveToTrash(body.paths));
      case 'delete':
        return sendJson(res, 200, await f.remove(body.paths));
      case 'restore':
        return sendJson(res, 200, await f.restore(body.paths));
      case 'empty-trash':
        return sendJson(res, 200, await f.emptyTrash());
      case 'compress':
        return sendJson(res, 200, await f.compress(body.paths, body.dest));
      case 'extract':
        return sendJson(res, 200, await f.extract(body.path, body.dest));
      case 'jobs':
        if (sub !== 'cancel') throw new HttpError(404, 'Not found.');
        return sendJson(res, 200, { cancelled: f.cancel(String(body.id ?? '')) });
      case 'attach': {
        // "Ask SF Agents": a copy of the file becomes an attachment for the composer.
        const file = await f.openForRead(body.path);
        if (file.size > MAX_ATTACH_FROM_FILES) throw new HttpError(413, 'The file is too large to attach (over 50 MB).');
        const ref = this.conversation.addUpload(path.basename(file.path), file.type.mime, await fs.promises.readFile(file.path));
        return sendJson(res, 200, { attachment: displayAttachment(ref) });
      }
      default:
        throw new HttpError(404, 'Not found.');
    }
  }

  /** Streams a file, with byte ranges (video and audio seek with them; Safari requires them). */
  private serveFile(file: { path: string; size: number; modified: number; type: { mime: string } }, download: boolean, req: IncomingMessage, res: ServerResponse): void {
    const name = path.basename(file.path);
    const inline = !download && INLINE_MIME.test(file.type.mime);
    const mime = file.type.mime;
    const type = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' ? `${mime}; charset=utf-8` : mime;
    const etag = `"${file.size.toString(36)}-${Math.floor(file.modified).toString(36)}"`;
    const headers: Record<string, string | number> = {
      'Content-Type': inline ? type : download ? 'application/octet-stream' : type,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...(mime === 'application/pdf' ? {} : { 'Content-Security-Policy': FILE_CSP }),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
      'Referrer-Policy': 'no-referrer',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': new Date(file.modified).toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && file.size > 0 && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), file.size - 1);
      } else {
        start = Math.max(0, file.size - Number(range[2]));
      }
      if (start > end || start >= file.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    }
    headers['Content-Length'] = file.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || file.size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file.path, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /** Streams a ZIP archive of files and folders (downloading a folder or a selection). */
  private async serveZip(input: string[], res: ServerResponse): Promise<void> {
    const paths = this.files.paths(input);
    for (const p of paths) await fs.promises.lstat(p).catch(() => {
      throw new FileError(`"${path.basename(p)}" no longer exists.`, 404);
    });
    const name = paths.length === 1 ? `${path.basename(paths[0]!) || 'Archive'}.zip` : 'Archive.zip';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('client went away'));
    });
    try {
      await writeZip(zipSourcesFor(paths, controller.signal), res, controller.signal);
      res.end();
    } catch {
      res.destroy();
    }
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

  /** Hands the conversation to `name`, with the reasoning effort chosen for it. */
  private selectAgent(name: string, save = true): void {
    this.session.setAgent(name);
    const settings = this.agentSettings.get();
    this.session.reasoning = settings.efforts?.[name];
    if (save && settings.agent !== name) this.agentSettings.set({ ...settings, agent: name });
  }

  private describeAgent(node: AgentNode) {
    const d = node.definition;
    return {
      id: node.id,
      name: d.name ?? node.id,
      description: d.description ?? '',
      model: d.model,
      provider: d.provider,
      configuredReasoning: d.reasoning ?? null,
      grants: [...node.grants].map(([agent, max]) => ({ agent, max })),
    };
  }

  /** The agent replying now and the session's reasoning effort (the send button's sheet). */
  private agentInfo() {
    const node = this.session.node;
    return {
      ...this.describeAgent(node),
      reasoning: this.session.reasoning ?? node.definition.reasoning ?? null,
      levels: EFFORT_LEVELS,
    };
  }

  /** Every agent of the project (for the sheet's agent menu), and files that were skipped. */
  private agentsInfo() {
    return {
      current: this.session.node.id,
      agents: [...this.options.tree.byId.values()].map((n) => ({ ...this.describeAgent(n), reasoning: this.agentSettings.get().efforts?.[n.id] ?? n.definition.reasoning ?? null })),
      skipped: this.options.tree.skipped,
      warnings: this.options.tree.warnings,
    };
  }

  /** What the next request would carry, part by part, with the model's own window when the provider lists it. */
  private async contextInfo() {
    const d = this.session.node.definition;
    // A custom provider factory (tests, embedding) may not talk to the configured provider at all.
    const lookup = this.options.providerFactory ? Promise.resolve(null) : this.windows.lookup(d).catch(() => null);
    const [usage, window] = await Promise.all([this.session.contextUsage(), lookup]);
    return { ...usage, model: d.model, modelWindow: window, running: this.session.running };
  }

  private snapshot() {
    const { items, more } = displayItems(this.conversation.state, { hideRun: this.live ? this.conversation.activeRootRun : undefined });
    return {
      agent: this.agentInfo(),
      threads: this.runtime.threads.list(),
      conversation: { file: this.conversation.file },
      items,
      more,
      artifacts: this.displayArtifacts(),
      sections: displaySections(this.conversation.state),
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

  private sectionSignature = '';

  private sectionsKey(): string {
    const state = this.conversation.state;
    return `${state.structureRevision}:${state.sections.size}`;
  }

  /** Sends the section index when the model changed the structure. */
  private publishSections(): void {
    const key = this.sectionsKey();
    if (key === this.sectionSignature) return;
    this.sectionSignature = key;
    this.broadcast('sections', { sections: displaySections(this.conversation.state) });
  }

  /** The conversation's artifacts as the page shows them (threads between agents are listed apart). */
  private displayArtifacts() {
    return this.conversation
      .artifacts()
      .filter((a) => a.type !== 'agent_transcript')
      .map((a) => displayArtifact(a, this.conversation.artifactFile(a.id)));
  }

  /** The threads between agents (the chat links to them; the sheet shows them). */
  private publishThreads(): void {
    this.broadcast('threads', { threads: this.runtime.threads.list() });
  }

  private publishArtifacts(force = false): void {
    const sig = this.signature();
    if (!force && sig === this.artifactSignature) return;
    this.artifactSignature = sig;
    this.broadcast('artifacts', { artifacts: this.displayArtifacts() });
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
      this.publishThreads();
      const { items, more } = displayItems(this.conversation.state);
      this.broadcast('run_end', {
        run: id,
        status: result?.status ?? AgentTerminateMode.ERROR,
        error: failure ? getErrorMessage(failure) : result?.error,
        items,
        more,
        sections: displaySections(this.conversation.state),
      });
      this.sectionSignature = this.sectionsKey();
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
        if (event.name === 'message_agent' && typeof event.args['agent'] === 'string') {
          // A message to another agent: the chat can open their thread, live.
          seg.agent = event.args['agent'];
          seg.thread = threadKey(event.agentPath[event.agentPath.length - 1]!, event.args['agent'], typeof event.args['thread'] === 'number' ? event.args['thread'] : 1);
        }
        if (event.name === 'update_artifact' && typeof event.args['id'] === 'string') seg.artifact = event.args['id'];
        live.segments.push(seg);
        this.broadcast('activity', { run: live.id, segment: seg });
        if (seg.thread) setTimeout(() => this.publishThreads(), 50);
        return;
      }
      case 'tool_result': {
        const id = `${event.agentPath.join('/')}:${event.callId}`;
        const seg = live.segments.find((s) => s.id === id);
        const status = event.ok ? 'ok' : event.errorType === 'execution_denied' ? 'denied' : 'error';
        if (seg) seg.status = status;
        // A new or changed artifact shows in the chat where it was made.
        let artifact: string | undefined;
        if (seg && event.ok && (event.name === 'create_artifact' || event.name === 'update_artifact')) {
          if (event.name === 'update_artifact') artifact = seg.artifact;
          else {
            // Call ids repeat across runs with some providers: the newest match is this call's.
            const made = this.conversation.artifacts().filter((a) => a.callId === event.callId).sort((a, b) => b.createdSeq - a.createdSeq)[0];
            artifact = made?.id;
          }
          if (artifact) seg.artifact = artifact;
        }
        this.broadcast('activity_end', { run: live.id, id, status, ...(artifact ? { artifact } : {}) });
        this.publishArtifacts();
        this.publishSections();
        if (event.name === 'message_agent') this.publishThreads();
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
