/**
 * The terminal: real shells in pseudo-terminals (node-pty), kept running on
 * the computer whether or not a page shows them, in tabs any device can
 * attach to. Output is kept (the last 512 KB per tab) and replayed when a
 * page attaches, so reloading or switching devices loses nothing.
 *
 *   GET  /api/terminals                       the tabs
 *   POST /api/terminals {action: "create"}    a new tab → {id}
 *   POST /api/terminals/<id> {action: "close" | "rename", title?}
 *   WS   /api/terminal?id=<id>&cols=&rows=    attach: text frames are output;
 *        input is text frames; control messages start with "\0" + JSON
 *        ({"t":"resize","cols":80,"rows":24}; from the server {"t":"exit","code":0}
 *        and {"t":"title","title":"…"}).
 *
 * The WebSocket framing (RFC 6455) is implemented here; no dependency.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const MAX_SCROLLBACK = 512 * 1024;
const MAX_TABS = 20;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface Pty {
  pid: number;
  onData(cb: (d: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export class TerminalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ WebSocket

/** One server-side WebSocket connection (text frames, ping/pong, close). */
export class WebSocketConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  onText: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(private readonly socket: Duplex) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  static accept(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | null {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return null;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new WebSocketConnection(socket);
    if (head.length) ws.receive(head);
    return ws;
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(16 * 1024 * 1024)) return this.close(1009);
        len = Number(big);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buffer = this.buffer.subarray(offset + maskLen + len);
      if (!masked) return this.close(1002); // clients must mask
      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const data = Buffer.concat(this.fragments);
          this.fragments = [];
          this.onText(data.toString('utf8'));
        }
      }
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = len;
    else if (len < 65536) {
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text: string): void {
    this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this.frame(0x8, p);
    this.closed = true;
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed && !this.socket.destroyed) this.socket.destroy();
    this.closed = true;
    const cb = this.onClose;
    this.onClose = () => {};
    cb();
  }
}

// ------------------------------------------------------------------ sessions

interface Session {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  created: string;
  pty: Pty;
  scrollback: string;
  exited: { code: number } | null;
  clients: Set<WebSocketConnection>;
  cols: number;
  rows: number;
}

/** The user's shell: $SHELL (a login shell) on Unix; PowerShell 7, else Windows PowerShell, on Windows. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = (env['PATH'] ?? '').split(';').map((d) => path.join(d, 'pwsh.exe')).find((f) => fs.existsSync(f));
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  const shell = env['SHELL'] && fs.existsSync(env['SHELL']) ? env['SHELL'] : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file: shell, args: path.basename(shell) === 'sh' ? [] : ['-l'] };
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private pty: Promise<typeof import('node-pty')> | null = null;
  private counter = 0;

  constructor(
    private readonly options: {
      cwd: string;
      /** Environment variable names removed from shells (provider keys). */
      hideEnv?: readonly string[];
      onChange?: () => void;
      log?: (line: string) => void;
    },
  ) {}

  private loadPty(): Promise<typeof import('node-pty')> {
    this.pty ??= import('node-pty').catch((error: unknown) => {
      this.pty = null;
      throw new TerminalError(503, `The terminal module (node-pty) did not load: ${(error as Error).message}. Reinstall SF Agents' dependencies.`);
    });
    return this.pty;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, shell: path.basename(s.shell), created: s.created, exited: s.exited, attached: s.clients.size }));
  }

  async create(input: { cwd?: string; cols?: number; rows?: number } = {}): Promise<{ id: string }> {
    if (this.sessions.size >= MAX_TABS) throw new TerminalError(409, `At most ${MAX_TABS} terminal tabs; close one first.`);
    const pty = await this.loadPty();
    const shell = defaultShell();
    let cwd = input.cwd && fs.existsSync(input.cwd) && fs.statSync(input.cwd).isDirectory() ? input.cwd : this.options.cwd;
    if (!fs.existsSync(cwd)) cwd = os.homedir();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !this.options.hideEnv?.includes(k)) env[k] = v;
    env['TERM'] = 'xterm-256color';
    env['COLORTERM'] = 'truecolor';
    env['SFAGENTS_TERMINAL'] = '1';
    const cols = clamp(input.cols, 20, 500, 100);
    const rows = clamp(input.rows, 5, 300, 30);
    const p = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd, env, ...(process.platform === 'win32' ? { useConpty: true } : {}) }) as unknown as Pty;
    const id = crypto.randomBytes(6).toString('hex');
    this.counter++;
    const session: Session = { id, title: `Terminal ${this.counter}`, cwd, shell: shell.file, created: new Date().toISOString(), pty: p, scrollback: '', exited: null, clients: new Set(), cols, rows };
    p.onData((d) => {
      session.scrollback = (session.scrollback + d).slice(-MAX_SCROLLBACK);
      for (const c of session.clients) c.send(d);
      // OSC 0/2 window titles ("user@host: ~/dir").
      const t = /\x1b\][02];([^\x07\x1b]{1,120})(?:\x07|\x1b\\)/.exec(d);
      if (t && t[1] !== session.title) {
        session.title = t[1]!;
        for (const c of session.clients) c.send(`\0${JSON.stringify({ t: 'title', title: session.title })}`);
        this.options.onChange?.();
      }
    });
    p.onExit(({ exitCode }) => {
      session.exited = { code: exitCode };
      for (const c of session.clients) c.send(`\0${JSON.stringify({ t: 'exit', code: exitCode })}`);
      this.options.onChange?.();
    });
    this.sessions.set(id, session);
    this.options.log?.(`web: terminal ${id} started (${path.basename(shell.file)} in ${cwd})`);
    this.options.onChange?.();
    return { id };
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new TerminalError(404, 'No such terminal.');
    if (!s.exited) {
      try {
        s.pty.kill();
      } catch {
        // already gone
      }
    }
    for (const c of s.clients) c.close();
    this.sessions.delete(id);
    this.options.onChange?.();
  }

  rename(id: string, title: unknown): void {
    const s = this.sessions.get(id);
    if (!s) throw new TerminalError(404, 'No such terminal.');
    const t = typeof title === 'string' ? title.trim().slice(0, 60) : '';
    if (!t) throw new TerminalError(400, 'A name is required.');
    s.title = t;
    this.options.onChange?.();
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const s = this.sessions.get(url.searchParams.get('id') ?? '');
    if (!s) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const ws = WebSocketConnection.accept(req, socket, head);
    if (!ws) return;
    s.clients.add(ws);
    const cols = clamp(Number(url.searchParams.get('cols')), 20, 500, s.cols);
    const rows = clamp(Number(url.searchParams.get('rows')), 5, 300, s.rows);
    this.resize(s, cols, rows);
    if (s.scrollback) ws.send(s.scrollback);
    if (s.exited) ws.send(`\0${JSON.stringify({ t: 'exit', code: s.exited.code })}`);
    ws.onText = (text) => {
      if (text.startsWith('\0')) {
        try {
          const msg = JSON.parse(text.slice(1)) as { t?: string; cols?: number; rows?: number };
          if (msg.t === 'resize') this.resize(s, clamp(msg.cols, 20, 500, s.cols), clamp(msg.rows, 5, 300, s.rows));
        } catch {
          // ignore malformed control messages
        }
        return;
      }
      if (!s.exited) s.pty.write(text);
    };
    ws.onClose = () => {
      s.clients.delete(ws);
      this.options.onChange?.();
    };
    this.options.onChange?.();
  }

  private resize(s: Session, cols: number, rows: number): void {
    if (s.exited || (cols === s.cols && rows === s.rows)) return;
    s.cols = cols;
    s.rows = rows;
    try {
      s.pty.resize(cols, rows);
    } catch {
      // exited meanwhile
    }
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) {
      try {
        this.close(id);
      } catch {
        // gone
      }
    }
  }
}

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
}
