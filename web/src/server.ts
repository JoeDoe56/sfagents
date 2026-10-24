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
  OPENROUTER_BASE_URL,
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
  AccountState,
  AppSettings,
  credentialEnvNames,
  searchConversation,
  loadAgentTree,
  watchProject,
  type ProjectWatcher,
  ProviderRegistry,
  createDefaultProviderFactory,
} from '@sfagents/core';
import { ApiError, ProvidersApi } from './providers-api.js';
import { AppProxy } from './apps.js';
import { AuthError, WebAuth } from './auth.js';
import { Dictation } from './dictation.js';
import { TerminalError, TerminalManager } from './terminal.js';
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

const options_watch = (o: { watchAgents?: boolean }) => o.watchAgents !== false;

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
  /** Providers added in Settings (default: the per-user list, with keys in the OS keyring). */
  registry?: ProviderRegistry;
  /** Which account each agent is on (shared with the CLI process that started the server). */
  accounts?: AccountState;
  /** App settings (default: the per-user settings.json). */
  settings?: AppSettings;
  /** Reload the agent files and mcp.json when they change (default true). */
  watchAgents?: boolean;
  /**
   * The sign-in gate (token and passkeys). Default: on, with the token hash in
   * the OS keyring. `false` turns it off (tests and embedding only).
   */
  auth?: WebAuth | false;
  /** Speech to text for the mic button (default: llama.cpp + Qwen3-ASR, downloaded on first use). */
  dictation?: Dictation;
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

/** About ten minutes of 16 kHz mono speech. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
  readonly registry: ProviderRegistry;
  private projectWatcher: ProjectWatcher | undefined;
  private fileWatch: NodeJS.Timeout | undefined;
  private readonly apps: AppProxy;
  readonly auth: WebAuth | null;
  readonly dictation: Dictation;
  private readonly terminals: TerminalManager;
  private readonly ownNames: Set<string>;
  private readonly mcpFile: string;
  readonly accounts: AccountState;
  private readonly providersApi: ProvidersApi;

  constructor(private readonly options: WebServerOptions) {
    if (!options.conversation.dir || !options.conversation.file) throw new Error('The web interface needs a persistent conversation.');
    this.conversation = options.conversation;
    this.port = options.port ?? DEFAULT_PORT;
    this.host = options.host ?? DEFAULT_HOST;
    this.publicOrigin = options.publicOrigin === undefined ? undefined : parsePublicOrigin(options.publicOrigin);
    this.publicHost = this.publicOrigin === undefined ? undefined : new URL(this.publicOrigin).host;
    this.publicDir = options.publicDir ?? PUBLIC_DIR;
    // The first path segments SF Agents serves itself; everything else may belong to an open app.
    this.ownNames = new Set(['', 'api', 'apps', ...(() => {
      try {
        return fs.readdirSync(this.publicDir);
      } catch {
        return [];
      }
    })()]);
    this.apps = new AppProxy(
      (id) => {
        const v = this.conversation.state.artifactViews.get(id);
        return v?.type === 'app' && v.url ? v.url : undefined;
      },
      (pathname) => this.ownNames.has(decodeURIComponent(pathname.split('/')[1] ?? '')),
    );
    this.log = options.log ?? (() => {});
    this.registry = options.registry ?? new ProviderRegistry();
    this.auth = options.auth === false ? null : (options.auth ?? new WebAuth());
    this.mcpFile = options.tree.mcp.file ?? path.join(options.tree.configDir, 'mcp.json');
    this.dictation =
      options.dictation ??
      new Dictation({
        hideEnv: credentialEnvNames([...options.tree.byId.values()].map((n) => n.definition)),
        log: (line) => this.log(line),
        onChange: (status) => this.broadcast('dictation', status),
      });
    this.terminals = new TerminalManager({
      cwd: options.tree.configDir,
      hideEnv: credentialEnvNames([...options.tree.byId.values()].map((n) => n.definition)),
      onChange: () => this.broadcast('terminals', { terminals: this.terminals.list() }),
      log: (line) => this.log(line),
    });
    this.accounts = options.accounts ?? new AccountState();
    this.runtime = new AgentRuntime({
      tree: options.tree,
      conversation: options.conversation,
      approveAll: options.approveAll,
      providerFactory: options.providerFactory ?? createDefaultProviderFactory({ registry: this.registry, accounts: this.accounts }),
      confirm: (request, signal) => this.confirm(request, signal),
    });
    this.session = this.runtime.createSession();
    this.agentSettings = new AgentSettingsStore(options.conversation.dir);
    for (const [agent, provider] of Object.entries(this.agentSettings.get().accounts ?? {})) this.accounts.set(agent, provider);
    this.accounts.onChange((agent, provider) => {
      const settings = this.agentSettings.get();
      if (settings.accounts?.[agent] !== provider) this.agentSettings.set({ ...settings, accounts: { ...(settings.accounts ?? {}), [agent]: provider } });
      if (agent === this.session.node.id) this.broadcast('agent', this.agentInfo());
    });
    this.providersApi = new ProvidersApi({
      registry: this.registry,
      settings: options.settings ?? new AppSettings(),
      running: { 'web.port': this.port, 'web.host': this.host },
      broadcast: (event, data) => {
        this.broadcast(event, data);
        if (event === 'providers') this.broadcast('agent', this.agentInfo());
      },
      log: this.log,
    });
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
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
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
    // Artifacts are the files themselves: when one changes on disk, the page updates.
    this.fileWatch = setInterval(() => {
      if (this.clients.size) this.publishArtifacts();
    }, 2000);
    this.fileWatch.unref?.();
    if (options_watch(this.options)) this.projectWatcher = watchProject({ configDir: this.runtime.tree.configDir, mcpFile: this.mcpFile, onChange: () => this.reloadAgents() });
    const shown = this.host === '0.0.0.0' || this.host === '::' ? 'localhost' : this.host.includes(':') ? `[${this.host}]` : this.host;
    return `http://${shown}:${this.port}/`;
  }

  get listeningPort(): number {
    return this.port;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.fileWatch) clearInterval(this.fileWatch);
    await this.system.close();
    this.processes.close();
    this.live?.controller.abort(new Error('server stopping'));
    for (const a of this.approvals.values()) a.resolve('deny');
    await this.runPromise?.catch(() => undefined);
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.terminals.dispose();
    this.dictation.close();
    for (const sock of this.upgraded) sock.destroy();
    this.upgraded.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
    await this.up2k.close();
    this.providersApi.close();
    this.projectWatcher?.close();
    this.terminals.dispose();
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
    if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof AuthError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof TerminalError) return sendJson(res, error.status, { error: error.message });
    this.log(`web: ${getErrorMessage(error)}`);
    sendJson(res, 500, { error: getErrorMessage(error) });
  }

  /** WebSocket upgrades: the terminal, and apps' live-reload sockets. */
  private readonly upgraded = new Set<import('node:stream').Duplex>();

  private upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    // Upgraded sockets are not closed by the HTTP server: track them for close().
    this.upgraded.add(socket);
    socket.on('close', () => this.upgraded.delete(socket));
    if (!this.allowedHost(req)) return void socket.destroy();
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Sockets need a signed-in device too (the cookie comes with the upgrade).
    if (this.auth && !this.auth.device(req)) return void socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if (url.pathname === '/api/terminal') {
      try {
        this.checkWrite(req);
      } catch {
        return void socket.destroy();
      }
      return this.terminals.upgrade(req, socket, head);
    }
    const app = this.apps.routeUpgrade(req);
    if (app) return this.apps.upgrade(req, socket, head, app);
    socket.destroy();
  }

  /** How the browser sees this server: the public origin behind a proxy, else the Host. */
  private browserOrigin(req: IncomingMessage): { origin: string; rpId: string; secure: boolean } {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (this.publicOrigin && host === this.publicHost) {
      const u = new URL(this.publicOrigin);
      return { origin: u.origin, rpId: u.hostname, secure: u.protocol === 'https:' };
    }
    const u = new URL(`http://${host || 'localhost'}`);
    return { origin: u.origin, rpId: u.hostname, secure: false };
  }

  /** Files the sign-in page needs before anyone is signed in. */
  private static readonly PUBLIC_FILES = /^\/(login\.html|login\.js|login\.css|webauthn\.js|icons\/[\w.-]+|manifest\.webmanifest|favicon\.ico|vendor\/sfgl\/fonts\/.*)$/;

  /** The sign-in gate: everything but the sign-in page needs a signed-in device. */
  private gate(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!this.auth) return true;
    const p = url.pathname;
    if (p.startsWith('/api/auth/') || WebServer.PUBLIC_FILES.test(p)) return true;
    if (this.auth.device(req)) return true;
    if (p.startsWith('/api/')) {
      sendJson(res, 401, { error: 'Sign in first.', signIn: '/login.html' });
      return false;
    }
    const accept = String(req.headers.accept ?? '');
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html' || accept.includes('text/html'))) {
      const next = p === '/' || p === '/index.html' ? '' : `?next=${encodeURIComponent(p + url.search)}`;
      res.writeHead(303, { Location: `/login.html${next}`, 'Cache-Control': 'no-store' });
      res.end();
      return false;
    }
    sendJson(res, 401, { error: 'Sign in first.' });
    return false;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.allowedHost(req)) throw new HttpError(421, 'Unexpected Host header.');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!this.gate(req, res, url)) return;
    const app = this.apps.route(req);
    if (app) return this.apps.handle(req, res, app);
    const p = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') this.checkWrite(req);
    if (p.startsWith('/api/auth/')) {
      if (!this.auth) throw new HttpError(404, 'Sign-in is off.');
      const action = p.slice('/api/auth/'.length);
      const ctx = this.browserOrigin(req);
      if (method === 'GET' && action === 'status') {
        this.checkFetchSite(req);
        return sendJson(res, 200, { ...this.auth.status(req, ctx.rpId), secureContext: ctx.secure || ctx.rpId === 'localhost' });
      }
      if (method === 'GET' && action === 'list') {
        this.checkFetchSite(req);
        if (!this.auth.device(req)) throw new HttpError(401, 'Sign in first.');
        return sendJson(res, 200, this.auth.list(ctx.rpId));
      }
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
      return sendJson(res, 200, await this.auth.handle(action, body, req, res, ctx));
    }

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
        case 'GET dictation':
          this.checkFetchSite(req);
          return sendJson(res, 200, this.dictation.status());
        case 'POST dictation': {
          const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
          if (body['action'] === 'install') {
            // Long: progress arrives as "dictation" events.
            this.dictation.install().catch((error) => this.log(`dictation: ${getErrorMessage(error)}`));
          } else if (body['action'] === 'start') {
            this.dictation.start().catch((error) => this.log(`dictation: ${getErrorMessage(error)}`));
          } else if (body['action'] === 'stop') {
            this.dictation.stop();
          } else throw new HttpError(400, 'Unknown action.');
          return sendJson(res, 200, this.dictation.status());
        }
        case 'POST transcribe': {
          const type = String(req.headers['content-type'] ?? '');
          if (!/^audio\/(wav|wave|x-wav)\b/i.test(type)) throw new HttpError(415, 'Expected Content-Type: audio/wav.');
          const wav = await readBody(req, MAX_AUDIO_BYTES);
          const language = url.searchParams.get('language') || undefined;
          try {
            return sendJson(res, 200, { text: await this.dictation.transcribe(wav, language) });
          } catch (error) {
            throw new HttpError(503, getErrorMessage(error));
          }
        }
        case 'GET settings':
          this.checkFetchSite(req);
          return sendJson(res, 200, this.providersApi.settings());
        case 'POST settings':
          return sendJson(res, 200, this.providersApi.saveSettings(((await readJson(req)) ?? {}) as Record<string, unknown>));
        case 'GET providers':
          this.checkFetchSite(req);
          return sendJson(res, 200, await this.providersApi.handle('GET', parts, {}));
        case 'POST providers':
          return sendJson(res, 200, await this.providersApi.handle('POST', parts, ((await readJson(req)) ?? {}) as Record<string, unknown>));
        case 'GET search':
          this.checkFetchSite(req);
          return sendJson(res, 200, this.search(url.searchParams.get('q') ?? ''));
        case 'GET terminals':
          this.checkFetchSite(req);
          return sendJson(res, 200, { terminals: this.terminals.list() });
        case 'POST terminals': {
          const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
          if (!parts[1]) {
            if (body.action !== 'create') throw new HttpError(400, '"action" must be "create".');
            return sendJson(res, 200, await this.terminals.create({ cols: Number(body.cols), rows: Number(body.rows), cwd: typeof body.cwd === 'string' ? body.cwd : undefined }));
          }
          if (body.action === 'close') this.terminals.close(parts[1]);
          else if (body.action === 'rename') this.terminals.rename(parts[1], body.title);
          else throw new HttpError(400, '"action" must be "close" or "rename".');
          return sendJson(res, 200, { terminals: this.terminals.list() });
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
            if (typeof body.agent !== 'string' || !this.runtime.tree.byId.has(body.agent)) throw new HttpError(400, `No agent named "${String(body.agent)}".`);
            if (body.agent !== this.session.node.id && (this.session.running || this.live)) throw new HttpError(409, 'Wait for the current reply to finish before changing the agent.');
            this.selectAgent(body.agent);
          }
          if (body.account !== undefined) {
            const choice = this.accountChoices(this.session.node).find((a) => typeof body.account === 'string' && a.name.toLowerCase() === body.account.toLowerCase());
            if (!choice) throw new HttpError(400, `"${String(body.account)}" is not a provider this agent can use.`);
            this.accounts.set(this.session.node.id, choice.name);
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
      agent: { id: this.session.node.id, model: root.model, provider: root.provider, agents: this.runtime.tree.byId.size },
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

  /**
   * The agent files or mcp.json changed: load them again and use them from the
   * next turn on. A broken edit keeps the previous agents and says why.
   */
  reloadAgents(): void {
    let tree: AgentTree;
    try {
      tree = loadAgentTree(this.runtime.tree.configDir, { mcpConfigFile: this.mcpFile });
    } catch (error) {
      this.broadcast('notice', { text: `The agent files could not be loaded, so the previous agents stay in use: ${getErrorMessage(error)}`, level: 'error' });
      return;
    }
    const before = this.runtime.tree;
    const previousAgent = this.session.node.id;
    const { mcpChanged } = this.runtime.reload(tree);
    const added = [...tree.byId.keys()].filter((k) => !before.byId.has(k));
    const removed = [...before.byId.keys()].filter((k) => !tree.byId.has(k));
    const newlySkipped = tree.skipped.filter((sk) => !before.skipped.some((b) => b.file === sk.file && b.error === sk.error));
    this.log(`web: agents reloaded (${tree.byId.size} agents${mcpChanged ? ', MCP servers restarted' : ''})`);
    const parts: string[] = [];
    if (added.length) parts.push(`added ${added.map((a) => `"${a}"`).join(', ')}`);
    if (removed.length) parts.push(`removed ${removed.map((a) => `"${a}"`).join(', ')}`);
    if (mcpChanged) parts.push('MCP servers reloaded');
    if (parts.length) this.broadcast('notice', { text: `Agents updated: ${parts.join('; ')}.`, level: 'info' });
    for (const sk of newlySkipped) this.broadcast('notice', { text: `${path.basename(sk.file)} was skipped: ${sk.error}`, level: 'error' });
    if (!tree.byId.has(previousAgent)) this.selectAgent(this.session.node.id);
    this.broadcast('agent', this.agentInfo());
    this.broadcast('agents', this.agentsInfo());
  }

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
      file: node.file,
      grants: [...node.grants].map(([agent, max]) => ({ agent, max })),
    };
  }

  /** The agent replying now and the session's reasoning effort (the send button's sheet). */
  /**
   * The accounts an agent can reply with: its own provider entries (failover
   * order), then the other added providers of the same kinds, which can be
   * picked by hand with the agent's model.
   */
  private accountChoices(node: AgentNode) {
    const d = node.definition;
    const entries = d.providers?.length ? d.providers : [{ provider: d.provider, model: d.model }];
    const out: Array<{ name: string; model: string; kind: string | null; listed: boolean; available: boolean }> = [];
    const kinds = new Set<string>();
    for (const e of entries) {
      const record = this.registry.find(e.provider);
      if (record) kinds.add(record.kind);
      const legacy = e.provider === 'openrouter' || e.provider === 'openai-compatible';
      out.push({ name: record?.name ?? e.provider, model: e.model, kind: record?.kind ?? (legacy ? e.provider : null), listed: true, available: !!record || legacy });
    }
    for (const r of this.registry.list()) {
      if (!kinds.has(r.kind) || out.some((o) => o.name.toLowerCase() === r.name.toLowerCase())) continue;
      out.push({ name: r.name, model: entries[0]!.model, kind: r.kind, listed: false, available: true });
    }
    return out;
  }

  private agentInfo() {
    const node = this.session.node;
    const accounts = this.accountChoices(node);
    const picked = this.accounts.get(node.id);
    const current = accounts.find((a) => a.name.toLowerCase() === picked?.toLowerCase()) ?? accounts[0]!;
    return {
      ...this.describeAgent(node),
      model: current.model,
      account: current.name,
      accounts,
      reasoning: this.session.reasoning ?? node.definition.reasoning ?? null,
      levels: EFFORT_LEVELS,
    };
  }

  /** Every agent of the project (for the sheet's agent menu), and files that were skipped. */
  private agentsInfo() {
    return {
      current: this.session.node.id,
      agents: [...this.runtime.tree.byId.values()].map((n) => ({ ...this.describeAgent(n), reasoning: this.agentSettings.get().efforts?.[n.id] ?? n.definition.reasoning ?? null })),
      skipped: this.runtime.tree.skipped,
      warnings: this.runtime.tree.warnings,
    };
  }

  /** What the next request would carry, part by part, with the model's own window when the provider lists it. */
  private async contextInfo() {
    const d = this.session.node.definition;
    // A custom provider factory (tests, embedding) may not talk to the configured provider at all.
    const account = this.agentInfo();
    const record = this.registry.find(account.account);
    const base = record?.kind === 'openrouter' ? OPENROUTER_BASE_URL : record?.kind === 'custom' ? record.baseUrl : undefined;
    const lookup =
      this.options.providerFactory || (record && !base) ? Promise.resolve(null) : this.windows.lookup({ ...d, model: account.model }, process.env, base).catch(() => null);
    const [usage, window] = await Promise.all([this.session.contextUsage(), lookup]);
    return { ...usage, model: account.model, account: account.account, modelWindow: window, running: this.session.running };
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

  /** Changes when an artifact is added, changed or pinned, or when the file it shows changes. */
  private signature(): string {
    return this.conversation
      .artifacts()
      .map((a) => {
        let v = '';
        if (a.file) {
          try {
            const st = fs.statSync(this.conversation.resolveArtifactFile(a.file));
            v = `${st.mtimeMs}:${st.size}`;
          } catch {
            v = 'missing';
          }
        }
        return `${a.id}:${a.rev}:${a.pinned ? 1 : 0}:${v}`;
      })
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

  /** The search sheet: words in the conversation's messages, and in the artifacts' titles and text. */
  private search(query: string) {
    const q = query.trim().slice(0, 200);
    if (!q) return { query: q, messages: [], artifacts: [] };
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const result = searchConversation(this.conversation.state, q, { pageSize: 50 });
    const messages = result.hits
      .filter((h) => h.role === 'user' || h.role === 'assistant')
      .map((h) => ({ id: h.messageId, seq: h.seq, role: h.role, agent: h.agent, time: h.time, excerpt: h.excerpt, section: h.sectionTitle ?? null }));
    const artifacts: Array<{ id: string; title: string; type: string; excerpt: string }> = [];
    for (const a of this.displayArtifacts()) {
      const title = a.title.toLowerCase();
      let text = '';
      if (a.type !== 'app' && a.type !== 'image') {
        try {
          const content = this.conversation.artifactContent(a.id);
          if (content.data.length < 2_000_000) text = content.data.toString('utf8');
        } catch {
          text = '';
        }
      }
      const lower = text.toLowerCase();
      if (!words.every((w) => title.includes(w) || lower.includes(w))) continue;
      const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((x, y) => x - y)[0];
      const excerpt = at === undefined ? '' : `${at > 60 ? '…' : ''}${text.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, ' ').trim()}…`;
      artifacts.push({ id: a.id, title: a.title, type: a.type, excerpt });
      if (artifacts.length >= 30) break;
    }
    return { query: q, messages, artifacts };
  }

  /** The conversation's artifacts as the page shows them (threads between agents are listed apart). */
  private displayArtifacts() {
    return this.conversation
      .artifacts()
      .filter((a) => a.type !== 'agent_transcript')
      .map((a) => {
        const file = this.conversation.artifactFile(a.id);
        let stat: fs.Stats | null = null;
        if (file) {
          try {
            stat = fs.statSync(file);
          } catch {
            stat = null;
          }
        }
        return displayArtifact(a, file, stat);
      });
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
        if (seg && event.ok && (event.name === 'create_artifact' || event.name === 'update_artifact' || event.name === 'create_app_artifact')) {
          if (event.name === 'update_artifact') artifact = seg.artifact;
          else {
            // The record this call wrote (an artifact, or an update when the file or app was shown before); call ids can repeat across runs.
            const records = this.conversation.state.records;
            for (let i = records.length - 1; i >= 0; i--) {
              const r = records[i]!;
              if (r.kind === 'artifact' && r.callId === event.callId) artifact = r.id;
              else if (r.kind === 'artifact_update' && r.callId === event.callId) artifact = r.artifact;
              if (artifact) break;
            }
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
