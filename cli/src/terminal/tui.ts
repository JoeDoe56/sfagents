/**
 * The full-screen terminal interface (`sfagents`, `sfagents start` and
 * `sfagents web` in a terminal). It is a client of the web server running in
 * the same process: it gets the same events a page gets and sends messages,
 * cancels and answers approvals through the same calls, so the terminal and
 * every open page always show the same conversation.
 *
 * Three tabs: Chat (the conversation and the composer), Logs (every line
 * SF Agents logs) and Status (what each part is doing, and the CPU and memory
 * it uses). Tab, F1–F3 or Alt+1–3 switch tabs.
 */

import readline from 'node:readline';
import { describeTree, stripAnsiAndControl } from '@sfagents/core';
import type { LogBook, LogLine, WebServer } from '@sfagents/web';
import { fit, textWidth, truncate, wrap } from './width.js';

type Item =
  | { kind: 'user'; id: string; time: string; text: string; attachments?: Array<{ name: string; size: number }>; replyTo?: string }
  | { kind: 'assistant'; id: string; time: string; text: string; agent: string; replyTo?: string }
  | { kind: 'activity'; id: string; time: string; text: string; status?: string; thread?: string; agent?: string; artifact?: string }
  | { kind: 'notice'; id: string; time: string; text: string };

interface Segment {
  kind: 'text' | 'activity';
  id: string;
  text: string;
  status?: string;
}

interface Approval {
  id: string;
  agent: string;
  tool: string;
  title: string;
  detail: string;
}

interface AgentInfo {
  id: string;
  model?: string;
  account?: string;
  reasoning?: string | null;
}

export interface TuiOptions {
  server: WebServer;
  logs: LogBook;
  /** The address the web interface is at. */
  url: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

const TABS = ['Chat', 'Logs', 'Status'] as const;
type Tab = (typeof TABS)[number];

const HELP = [
  'Commands:',
  '  /help              this help',
  '  /agent [name]      which agent replies, or hand the conversation to another',
  '  /effort [level]    the reasoning effort (low, medium, high, xhigh, max, or default)',
  '  /clear             reset the working context (the history is kept)',
  '  /tree              the agents and what each may use',
  '  /exit              quit SF Agents (the web interface stops too)',
  'Keys: Tab or F1–F3 switch tabs · PgUp/PgDn scroll · Esc stops the reply · y/a/n answer an approval (with an empty composer) · Ctrl+C twice quits',
];

const esc = (code: string) => `\u001b[${code}`;
const color = {
  dim: (s: string) => `${esc('2m')}${s}${esc('22m')}`,
  bold: (s: string) => `${esc('1m')}${s}${esc('22m')}`,
  inverse: (s: string) => `${esc('7m')}${s}${esc('27m')}`,
  red: (s: string) => `${esc('31m')}${s}${esc('39m')}`,
  green: (s: string) => `${esc('32m')}${s}${esc('39m')}`,
  yellow: (s: string) => `${esc('33m')}${s}${esc('39m')}`,
  blue: (s: string) => `${esc('34m')}${s}${esc('39m')}`,
  magenta: (s: string) => `${esc('35m')}${s}${esc('39m')}`,
  cyan: (s: string) => `${esc('36m')}${s}${esc('39m')}`,
};

const clean = (text: string) => stripAnsiAndControl(text).replace(/\t/g, '  ');

function timeText(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

function stampText(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = same(d, now) ? 'Today' : same(d, yesterday) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${timeText(iso)}`;
}

export function bytesText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function percentText(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return '—';
  const p = share * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
}

export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function bar(share: number | null | undefined, width = 12): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return color.dim('·'.repeat(width));
  const full = Math.round(Math.min(1, Math.max(0, share)) * width);
  const fill = '█'.repeat(full);
  const tint = share > 0.85 ? color.red : share > 0.6 ? color.yellow : color.green;
  return `${tint(fill)}${color.dim('░'.repeat(width - full))}`;
}

export class Tui {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly rawWrite: (text: string) => void;
  private tab: Tab = 'Chat';

  // The conversation, as the pages keep it (app.js).
  private agent: AgentInfo | null = null;
  private items: Item[] = [];
  private more = false;
  private live: { id: string; segments: Segment[]; replyTo?: string } | null = null;
  private approvals: Approval[] = [];
  private readonly answered = new Map<string, string>();
  private reactions: Record<string, string> = {};
  private read: { id: string; time: string } | null = null;
  private notices: Array<{ id: number; text: string; level: string }> = [];
  private noticeSeq = 0;
  private queued: string | null = null;

  // The composer.
  private text = '';
  private cursor = 0;
  private readonly history: string[] = [];
  private historyAt = -1;

  // Scrolling: lines from the bottom (0 follows the end).
  private readonly scroll: Record<Tab, number> = { Chat: 0, Logs: 0, Status: 1_000_000 /* the top */ };
  private logLines: LogLine[] = [];
  private unreadErrors = 0;
  private status: Awaited<ReturnType<WebServer['status']>> | null = null;
  private statusTimer: NodeJS.Timeout | undefined;
  private statusBusy = false;

  private lastCtrlC = 0;
  private drawPending = false;
  private closed = false;
  private resolveDone: ((code: number) => void) | undefined;
  private readonly cleanups: Array<() => void> = [];
  private viewHeight = 10;

  constructor(private readonly options: TuiOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    const original = this.output.write.bind(this.output) as (text: string) => boolean;
    this.rawWrite = (text) => void original(text);
  }

  /** Runs until the person quits; resolves with the exit code. */
  run(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.resolveDone = resolve;
      this.open();
    });
  }

  private open(): void {
    const { server, logs } = this.options;
    // Anything else written to the terminal while the interface is up (warnings from
    // libraries, debug output) goes to the Logs tab instead of over the screen.
    this.captureOutput(process.stdout);
    this.captureOutput(process.stderr);
    this.logLines = logs.lines();
    this.cleanups.push(
      logs.onLine((line) => {
        this.logLines.push(line);
        if (this.logLines.length > 5000) this.logLines.splice(0, this.logLines.length - 5000);
        if (this.tab !== 'Logs') {
          if (line.level === 'error') this.unreadErrors++;
        } else if (this.scroll.Logs) this.scroll.Logs++;
        this.schedule();
      }),
    );
    this.cleanups.push(server.subscribe((event, data) => this.onEvent(event, data)));

    readline.emitKeypressEvents(this.input);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    const onKey = (str: string | undefined, key: readline.Key | undefined) => this.onKey(str, key ?? {});
    this.input.on('keypress', onKey);
    this.cleanups.push(() => this.input.off('keypress', onKey));
    const onResize = () => this.draw();
    this.output.on('resize', onResize);
    this.cleanups.push(() => this.output.off('resize', onResize));
    const onSignal = () => this.quit();
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.on('SIGINT', onSignal);
    this.cleanups.push(() => {
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      process.off('SIGINT', onSignal);
    });
    // The alternate screen (the shell's scrollback comes back on quit), bracketed paste.
    this.rawWrite(`${esc('?1049h')}${esc('?2004h')}${esc('?25l')}`);
    this.draw();
  }

  private captureOutput(stream: NodeJS.WriteStream): void {
    const original = stream.write;
    let pending = '';
    stream.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      if (stream === this.output && this.drawing) return original.call(stream, chunk as string, encoding as BufferEncoding, cb as () => void);
      pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) this.options.logs.add(l);
      const done = typeof encoding === 'function' ? encoding : cb;
      if (typeof done === 'function') (done as () => void)();
      return true;
    }) as typeof stream.write;
    this.cleanups.push(() => {
      stream.write = original;
      if (pending.trim()) this.options.logs.add(pending);
    });
  }

  private drawing = false;

  /** Leaves the interface and gives the terminal back. */
  quit(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    for (const c of this.cleanups.reverse()) c();
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.rawWrite(`${esc('?2004l')}${esc('?25h')}${esc('?1049l')}`);
    this.resolveDone?.(code);
  }

  // ---------------------------------------------------------------- events

  private onEvent(event: string, raw: unknown): void {
    const data = raw as Record<string, unknown>;
    switch (event) {
      case 'state': {
        const s = data as { agent: AgentInfo; items: Item[]; more: boolean; live: Tui['live']; approvals: Approval[]; reactions?: Record<string, string>; read?: Tui['read']; notices?: Array<string | { text: string; level?: string }> };
        this.agent = s.agent;
        this.items = s.items;
        this.more = s.more;
        this.live = s.live;
        this.approvals = s.approvals;
        this.reactions = s.reactions ?? {};
        this.read = s.read ?? null;
        for (const n of s.notices ?? []) typeof n === 'string' ? this.notice(n) : this.notice(n.text, n.level);
        break;
      }
      case 'user': {
        const item = data.item as Item;
        if (!this.items.some((i) => i.id === item.id)) this.items.push(item);
        this.scroll.Chat = 0;
        break;
      }
      case 'run_start':
        this.live = { id: String(data.run), segments: [], ...(typeof data.replyTo === 'string' ? { replyTo: data.replyTo } : {}) };
        break;
      case 'delta': {
        if (!this.live || this.live.id !== data.run) return;
        const segs = this.live.segments;
        const last = segs[segs.length - 1];
        if (last && last.kind === 'text') last.text += String(data.text);
        else segs.push({ kind: 'text', id: `t${segs.length}`, text: String(data.text) });
        // A reply is shown once it is finished, as on the pages.
        return;
      }
      case 'activity':
        if (!this.live || this.live.id !== data.run) return;
        this.live.segments.push(data.segment as Segment);
        break;
      case 'activity_end': {
        const seg = this.live && this.live.id === data.run ? this.live.segments.find((s) => s.id === data.id) : undefined;
        if (seg) seg.status = String(data.status);
        break;
      }
      case 'approval': {
        const a = data.approval as Approval;
        if (!this.approvals.some((x) => x.id === a.id)) this.approvals.push(a);
        this.bell();
        break;
      }
      case 'approval_done': {
        const id = String(data.id);
        this.answered.set(id, String(data.decision));
        setTimeout(() => {
          this.approvals = this.approvals.filter((a) => a.id !== id);
          this.answered.delete(id);
          this.schedule();
        }, 1200);
        break;
      }
      case 'agent':
        this.agent = { ...(this.agent ?? {}), ...(data as unknown as AgentInfo) };
        break;
      case 'notice':
        this.notice(String(data.text), String(data.level ?? ''));
        break;
      case 'reactions':
        this.reactions = (data.reactions as Record<string, string>) ?? {};
        break;
      case 'read':
        this.read = data as unknown as Tui['read'];
        break;
      case 'run_end': {
        this.live = null;
        this.items = data.items as Item[];
        this.more = data.more === true;
        this.approvals = [];
        if (typeof data.error === 'string' && data.error && data.status !== 'ERROR') this.notice(data.error);
        if (this.queued) {
          const next = this.queued;
          this.queued = null;
          setImmediate(() => this.submit(next));
        }
        break;
      }
      default:
        return;
    }
    this.schedule();
  }

  private readonly recentNotices = new Map<string, number>();
  private notice(text: string, level = ''): void {
    // The same note again within ten minutes is not shown twice (as on the pages).
    const now = Date.now();
    if (now - (this.recentNotices.get(text) ?? 0) < 10 * 60 * 1000) return;
    this.recentNotices.set(text, now);
    const n = { id: ++this.noticeSeq, text: text.length > 400 ? `${text.slice(0, 399)}…` : text, level };
    this.notices.push(n);
    setTimeout(() => {
      this.notices = this.notices.filter((x) => x !== n);
      this.schedule();
    }, 8000).unref?.();
    this.schedule();
  }

  private bell(): void {
    if (!this.closed) this.rawWrite('\u0007');
  }

  // ---------------------------------------------------------------- keys

  private onKey(str: string | undefined, key: readline.Key): void {
    if (this.closed) return;
    const name = key.name ?? '';
    if (key.ctrl && name === 'c') return this.ctrlC();
    if (key.ctrl && name === 'd' && !this.text) return this.quit();
    if (name === 'paste-start') {
      this.pasting = true;
      return;
    }
    if (name === 'paste-end') {
      this.pasting = false;
      return;
    }
    if (this.pasting) {
      this.insert(name === 'return' || name === 'enter' ? '\n' : (str ?? ''));
      return;
    }
    // Tabs.
    const number = key.meta && /^[1-3]$/.test(name) ? Number(name) : /^f[1-3]$/.test(name) ? Number(name.slice(1)) : 0;
    if (number) return this.setTab(TABS[number - 1]!);
    if (name === 'tab') return this.setTab(TABS[(TABS.indexOf(this.tab) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]!);
    // Scrolling.
    const page = Math.max(1, this.viewHeight - 2);
    if (name === 'pageup') return this.scrollBy(page);
    if (name === 'pagedown') return this.scrollBy(-page);
    if (key.shift && name === 'up') return this.scrollBy(1);
    if (key.shift && name === 'down') return this.scrollBy(-1);
    if (this.tab !== 'Chat') {
      if (name === 'up' || str === 'k') return this.scrollBy(1);
      if (name === 'down' || str === 'j') return this.scrollBy(-1);
      if (name === 'home' || str === 'g') return this.scrollBy(Number.MAX_SAFE_INTEGER);
      if (name === 'end' || str === 'G') return this.scrollBy(-Number.MAX_SAFE_INTEGER);
      if (str === 'q') return this.setTab('Chat');
      return;
    }
    // An approval waiting, and nothing typed: y, a or n answers it.
    const pending = this.approvals.find((a) => !this.answered.has(a.id));
    if (pending && !this.text && str && /^[yan]$/i.test(str)) {
      const decision = { y: 'allow_once', a: 'allow_always', n: 'deny' }[str.toLowerCase() as 'y' | 'a' | 'n'] as 'allow_once' | 'allow_always' | 'deny';
      try {
        this.options.server.answer(pending.id, decision);
      } catch (error) {
        this.notice(error instanceof Error ? error.message : String(error), 'error');
      }
      return;
    }
    if (name === 'escape') {
      if (this.live) this.options.server.cancel();
      else if (this.queued) this.queued = null;
      this.schedule();
      return;
    }
    if (name === 'return' || name === 'enter') {
      if (key.meta || key.shift) return this.insert('\n');
      const line = this.text;
      this.text = '';
      this.cursor = 0;
      this.historyAt = -1;
      this.submit(line);
      return;
    }
    if (name === 'backspace') {
      if (key.meta || key.ctrl) return this.deleteWord();
      if (this.cursor > 0) {
        const before = [...this.text.slice(0, this.cursor)];
        const removed = before.pop()!;
        this.text = before.join('') + this.text.slice(this.cursor);
        this.cursor -= removed.length;
      }
      return this.schedule();
    }
    if (name === 'delete') {
      if (this.cursor < this.text.length) {
        const ch = String.fromCodePoint(this.text.codePointAt(this.cursor)!);
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + ch.length);
      }
      return this.schedule();
    }
    if (name === 'left' || (key.ctrl && name === 'b')) {
      if (this.cursor > 0) this.cursor -= [...this.text.slice(0, this.cursor)].pop()!.length;
      return this.schedule();
    }
    if (name === 'right' || (key.ctrl && name === 'f')) {
      if (this.cursor < this.text.length) this.cursor += String.fromCodePoint(this.text.codePointAt(this.cursor)!).length;
      return this.schedule();
    }
    if (name === 'home' || (key.ctrl && name === 'a')) {
      this.cursor = 0;
      return this.schedule();
    }
    if (name === 'end' || (key.ctrl && name === 'e')) {
      this.cursor = this.text.length;
      return this.schedule();
    }
    if (key.ctrl && name === 'u') {
      this.text = this.text.slice(this.cursor);
      this.cursor = 0;
      return this.schedule();
    }
    if (key.ctrl && name === 'k') {
      this.text = this.text.slice(0, this.cursor);
      return this.schedule();
    }
    if (key.ctrl && name === 'w') return this.deleteWord();
    if (key.ctrl && name === 'l') return this.draw();
    if (name === 'up' || name === 'down') {
      if (!this.history.length) return;
      if (name === 'up') this.historyAt = this.historyAt < 0 ? this.history.length - 1 : Math.max(0, this.historyAt - 1);
      else this.historyAt = this.historyAt < 0 ? -1 : this.historyAt + 1 >= this.history.length ? -1 : this.historyAt + 1;
      this.text = this.historyAt < 0 ? '' : this.history[this.historyAt]!;
      this.cursor = this.text.length;
      return this.schedule();
    }
    if (str && !key.ctrl && !key.meta && str >= ' ') this.insert(str);
  }

  private pasting = false;

  private insert(s: string): void {
    const text = s.replace(/\r\n?/g, '\n');
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    this.schedule();
  }

  private deleteWord(): void {
    const before = this.text.slice(0, this.cursor).replace(/\S+\s*$|\s+$/, '');
    this.text = before + this.text.slice(this.cursor);
    this.cursor = before.length;
    this.schedule();
  }

  private ctrlC(): void {
    const now = Date.now();
    if (now - this.lastCtrlC < 1500) return this.quit();
    this.lastCtrlC = now;
    if (this.live) {
      this.options.server.cancel();
      this.notice('Stopping the reply. Press Ctrl+C again to quit SF Agents.');
    } else if (this.text) {
      this.text = '';
      this.cursor = 0;
      this.schedule();
    } else this.notice('Press Ctrl+C again to quit SF Agents (the web interface stops too).');
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    if (tab === 'Logs') this.unreadErrors = 0;
    if (tab === 'Status') {
      void this.refreshStatus();
      if (!this.statusTimer) this.statusTimer = setInterval(() => this.tab === 'Status' && void this.refreshStatus(), 2000);
    } else if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.draw();
  }

  private scrollBy(lines: number): void {
    this.scroll[this.tab] = Math.max(0, Math.min(this.scroll[this.tab] + lines, 1_000_000));
    this.schedule();
  }

  private async refreshStatus(): Promise<void> {
    if (this.statusBusy) return;
    this.statusBusy = true;
    try {
      this.status = await this.options.server.status();
    } catch (error) {
      this.options.logs.add(`status: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.statusBusy = false;
    }
    this.schedule();
  }

  // ---------------------------------------------------------------- sending and commands

  private submit(line: string): void {
    const text = line.replace(/\s+$/, '');
    if (!text.trim()) return this.schedule();
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (text.startsWith('/') && !text.includes('\n')) return this.command(text.trim());
    if (this.live) {
      this.queued = text;
      this.notice('Queued: it is sent when the current reply finishes (Esc removes it).');
      return;
    }
    try {
      this.options.server.sendMessage(text);
      this.scroll.Chat = 0;
    } catch (error) {
      this.notice(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private command(line: string): void {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    const server = this.options.server;
    const fail = (error: unknown) => this.notice(error instanceof Error ? error.message : String(error), 'error');
    switch (cmd) {
      case '/exit':
      case '/quit':
        return this.quit();
      case '/help':
        return this.info(HELP);
      case '/tree':
        return this.info(describeTree(server.tree).split('\n'));
      case '/agent': {
        if (!arg) {
          const names = server.agents().agents.map((a) => a.id);
          return this.info([`"${this.agent?.id ?? '?'}" replies. Agents: ${names.join(', ')}`]);
        }
        try {
          const info = server.configureAgent({ agent: arg });
          this.info([`"${info.id}" (${info.account || 'no provider yet'}${info.model ? `, ${info.model}` : ''}) replies from now on.`]);
        } catch (error) {
          fail(error);
        }
        return;
      }
      case '/effort':
      case '/reasoning': {
        try {
          const info = server.configureAgent({ reasoning: !arg || arg === 'default' ? null : arg });
          this.info([`Reasoning effort: ${info.reasoning ?? 'the agent’s default'}.`]);
        } catch (error) {
          fail(error);
        }
        return;
      }
      case '/clear':
        server.resetContext().then(
          () => this.info(['Working context reset. Earlier messages stay in the conversation and can still be retrieved.']),
          fail,
        );
        return;
      default:
        this.notice(`Unknown command ${cmd}. /help lists them.`, 'error');
    }
  }

  /** Lines shown in the chat until the next message (this terminal only, like a page's sheet). */
  private infoLines: string[] = [];
  private info(lines: string[]): void {
    this.infoLines = lines.map(clean);
    this.scroll.Chat = 0;
    this.schedule();
  }

  // ---------------------------------------------------------------- drawing

  private schedule(): void {
    if (this.drawPending || this.closed) return;
    this.drawPending = true;
    setTimeout(() => {
      this.drawPending = false;
      this.draw();
    }, 16);
  }

  private draw(): void {
    if (this.closed) return;
    const width = Math.max(20, this.output.columns || 80);
    const height = Math.max(8, this.output.rows || 24);
    const footer = this.footer(width);
    this.viewHeight = height - 1 - footer.lines.length;
    const body = this.tab === 'Chat' ? this.chatLines(width) : this.tab === 'Logs' ? this.logView(width) : this.statusLines(width);
    // The visible window, from the bottom (or the top for Status), after scrolling.
    const max = Math.max(0, body.length - this.viewHeight);
    const offset = Math.min(this.scroll[this.tab], max);
    // (Status keeps its place at the top until it has been read.)
    if (this.tab !== 'Status' || this.status) this.scroll[this.tab] = offset;
    let shown: string[];
    if (this.tab === 'Status') shown = body.slice(max - offset, max - offset + this.viewHeight);
    else shown = body.slice(Math.max(0, body.length - this.viewHeight - offset), body.length - offset);
    while (shown.length < this.viewHeight) this.tab === 'Status' ? shown.push('') : shown.unshift('');
    const frame = [this.tabBar(width, offset), ...shown.map((l) => fit(l, width)), ...footer.lines];
    let out = `${esc('?25l')}${esc('H')}`;
    out += frame.map((l) => `${l}${esc('0m')}${esc('K')}`).join('\r\n');
    if (footer.cursor) out += `${esc(`${height - footer.lines.length + footer.cursor.row + 1};${footer.cursor.col + 1}H`)}${esc('?25h')}`;
    this.drawing = true;
    try {
      this.rawWrite(out);
    } finally {
      this.drawing = false;
    }
  }

  private tabBar(width: number, offset: number): string {
    const tabs = TABS.map((t, i) => {
      let label = ` ${i + 1} ${t}`;
      if (t === 'Logs' && this.unreadErrors) label += ` ${this.unreadErrors > 99 ? '99+' : this.unreadErrors}!`;
      label += ' ';
      return t === this.tab ? color.inverse(color.bold(label)) : t === 'Logs' && this.unreadErrors ? color.red(label) : label;
    }).join(' ');
    const state = this.live ? color.yellow('● replying') : this.approvals.some((a) => !this.answered.has(a.id)) ? color.yellow('● waiting for you') : color.green('● idle');
    const scrolled = offset && this.tab !== 'Status' ? color.dim(` ↑${offset}`) : '';
    const right = `${this.agent?.id ?? ''}  ${state}${scrolled} `;
    const left = `${color.bold(' SF Agents ')} ${tabs}`;
    const gap = width - textWidth(left) - textWidth(right);
    return gap >= 1 ? `${left}${' '.repeat(gap)}${right}` : left;
  }

  private footer(width: number): { lines: string[]; cursor?: { row: number; col: number } } {
    const rule = color.dim('─'.repeat(width));
    if (this.tab !== 'Chat') {
      const hint = this.tab === 'Logs' ? `${this.logLines.length} lines · ↑↓ PgUp PgDn scroll · End follows · Tab switches tabs` : `${this.options.url} · refreshes every 2 seconds · Tab switches tabs`;
      return { lines: [rule, color.dim(truncate(` ${hint}`, width))] };
    }
    const prompt = '› ';
    const avail = Math.max(4, width - textWidth(prompt) - 1);
    // The composer shows several lines when the text has them (or is long), at most 5.
    const shownText = this.text.replace(/\n/g, '⏎\n');
    const lines = wrap(shownText, avail);
    const before = wrap(this.text.slice(0, this.cursor).replace(/\n/g, '⏎\n'), avail);
    const curRow = before.length - 1;
    const curCol = textWidth(before[curRow] ?? '');
    const first = Math.max(0, Math.min(curRow - 4, lines.length - 5));
    const visible = lines.slice(first, first + 5);
    const placeholder = this.live ? 'Type to queue a message · Esc stops the reply' : `Message ${this.agent?.id ?? 'the agent'} · /help for commands`;
    const rendered = this.text
      ? visible.map((l, i) => `${i === 0 && first === 0 ? color.cyan(prompt) : '  '}${l}`)
      : [`${color.cyan(prompt)}${color.dim(truncate(placeholder, avail))}`];
    return { lines: [rule, ...rendered], cursor: { row: 1 + (this.text ? curRow - first : 0), col: textWidth(prompt) + (this.text ? curCol : 0) } };
  }

  private chatLines(width: number): string[] {
    const w = Math.max(10, width - 4);
    const out: string[] = [];
    const indent = (lines: string[], pad = '  ') => lines.map((l) => `${pad}${l}`);
    const root = (it: { replyTo?: string; id?: string }) => (it.replyTo && it.replyTo !== it.id ? color.dim('│ ') : '');
    if (this.more) out.push(color.dim('  … earlier messages are in the web interface and `sfagents conversation`'), '');
    let lastTime = 0;
    let lastUser: string | undefined;
    for (const it of this.items) if (it.kind === 'user') lastUser = it.id;
    for (const it of this.items) {
      const t = new Date(it.time).getTime();
      if ((it.kind === 'user' || it.kind === 'assistant') && Number.isFinite(t)) {
        if (!lastTime || t - lastTime > 60 * 60 * 1000) out.push('', color.dim(`  ── ${stampText(it.time)} ──`));
        lastTime = t;
      }
      const thread = root(it);
      if (it.kind === 'user') {
        out.push('', `${thread}${color.cyan(color.bold('You'))} ${color.dim(timeText(it.time))}${this.reactions[it.id] ? ` ${this.reactions[it.id]}` : ''}`);
        out.push(...indent(wrap(clean(it.text), w - textWidth(thread)), `${thread}  `));
        for (const a of it.attachments ?? []) out.push(`${thread}  ${color.dim(`📎 ${clean(a.name)} (${bytesText(a.size)})`)}`);
        if (it.id === lastUser) {
          const answered = this.items.some((x) => x.kind === 'assistant' && new Date(x.time).getTime() >= t);
          const receipt = answered ? '' : this.read?.id === it.id ? `Read ${timeText(this.read.time)}` : 'Delivered';
          if (receipt) out.push(`${thread}  ${color.dim(receipt)}`);
        }
      } else if (it.kind === 'assistant') {
        out.push('', `${thread}${color.magenta(color.bold(it.agent))} ${color.dim(timeText(it.time))}${this.reactions[it.id] ? ` ${this.reactions[it.id]}` : ''}`);
        out.push(...indent(wrap(clean(it.text), w - textWidth(thread)), `${thread}  `));
      } else if (it.kind === 'activity') {
        out.push(this.activityLine(it, w));
      } else {
        out.push(...indent(wrap(clean(it.text), w).map((l) => (/^Error/.test(it.text) ? color.red(l) : color.yellow(l)))));
      }
    }
    if (this.live) {
      const segs = this.live.segments;
      segs.forEach((seg, i) => {
        if (seg.kind === 'text') {
          // Finished text only (the reply arrives whole), as on the pages.
          if (i < segs.length - 1 && seg.text.trim()) out.push('', color.magenta(color.bold(this.agent?.id ?? 'agent')), ...indent(wrap(clean(seg.text), w)));
        } else out.push(this.activityLine(seg, w));
      });
      if (!this.approvals.length) out.push('', color.dim(`  ${this.agent?.id ?? 'The agent'} is working…`));
    }
    for (const a of this.approvals) {
      const decision = this.answered.get(a.id);
      out.push('', color.yellow(color.bold(`  ? ${clean(a.agent)} wants to use ${clean(a.tool)}`)));
      out.push(...indent(wrap(clean(a.title), w - 2), '    '));
      if (a.detail) out.push(...indent(wrap(clean(a.detail), w - 2).slice(0, 12), '    ').map(color.dim));
      out.push(
        decision
          ? `    ${decision === 'deny' ? color.red('Denied') : color.green(decision === 'allow_always' ? 'Allowed always' : 'Allowed once')}`
          : `    ${color.bold('[y]')} Allow once   ${color.bold('[a]')} Always allow   ${color.bold('[n]')} Deny`,
      );
    }
    if (this.queued) out.push('', color.dim(`  Queued: ${truncate(clean(this.queued).replace(/\s+/g, ' '), w - 10)}`));
    if (this.infoLines.length) out.push('', ...this.infoLines.flatMap((l) => indent(wrap(l, w))).map(color.dim));
    for (const n of this.notices) out.push('', ...indent(wrap(clean(n.text), w)).map(n.level === 'error' ? color.red : color.yellow));
    if (!this.items.length && !this.live) out.push('', color.dim(`  No messages yet. Type below, or open ${this.options.url}`));
    out.push('');
    return out;
  }

  private activityLine(seg: { text: string; status?: string; thread?: string }, w: number): string {
    const mark = seg.status === 'ok' ? color.green('✓') : seg.status === 'error' ? color.red('✗') : seg.status === 'denied' ? color.red('⊘') : seg.status === 'running' ? color.yellow('…') : color.dim('·');
    return `  ${mark} ${color.dim(truncate(clean(seg.text).replace(/\s+/g, ' '), w - 4))}`;
  }

  private logView(width: number): string[] {
    const w = Math.max(10, width - 10);
    const out: string[] = [];
    for (const l of this.logLines) {
      const time = new Date(l.time).toLocaleTimeString(undefined, { hour12: false });
      const tint = l.level === 'error' ? color.red : l.level === 'warning' ? color.yellow : (s: string) => s;
      wrap(clean(l.text), w).forEach((part, i) => out.push(`${color.dim(i ? ' '.repeat(time.length) : time)}  ${tint(part)}`));
    }
    if (!out.length) out.push(color.dim('  Nothing logged yet.'));
    return out;
  }

  private statusLines(width: number): string[] {
    const s = this.status;
    if (!s) return ['', color.dim('  Reading…')];
    const out: string[] = [];
    const label = (t: string) => color.bold(t.padEnd(18));
    const row = (t: string, v: string) => out.push(`  ${label(t)}${v}`);
    const ok = (v: string) => color.green(v);
    const warn = (v: string) => color.yellow(v);
    const bad = (v: string) => color.red(v);
    const section = (t: string) => out.push('', `  ${color.cyan(color.bold(t))}`);

    section('SF Agents');
    row('Status', s.run ? warn(`replying (${s.run.segments} step${s.run.segments === 1 ? '' : 's'} so far)`) : s.approvals ? warn(`waiting for ${s.approvals} approval${s.approvals === 1 ? '' : 's'}`) : ok('idle'));
    row('CPU', `${bar(s.self.cpu)} ${percentText(s.self.cpu)}`);
    row('Memory', `${bytesText(s.self.memory.rss)} ${color.dim(`(JavaScript ${bytesText(s.self.memory.heapUsed)} of ${bytesText(s.self.memory.heapTotal)})`)}`);
    row('Running for', durationText(s.self.uptime));
    row('Process', `${s.self.pid} · Node.js ${s.self.node} · ${s.self.platform} ${s.self.arch}`);

    section('Web interface');
    row('Address', s.web.url);
    row('Public origins', s.web.publicOrigins.length ? s.web.publicOrigins.join(', ') : color.dim('none'));
    row('Open', `${s.web.pages} page${s.web.pages === 1 ? '' : 's'} · ${s.web.terminals} terminal${s.web.terminals === 1 ? '' : 's'}`);
    row('Sign-in', s.web.signIn === 'on' ? ok('required') : warn('off'));

    section('Agent');
    row('Replying', `${s.self.agent.id} ${color.dim(`(${s.self.agent.agents} agent${s.self.agent.agents === 1 ? '' : 's'} in the tree)`)}`);
    row('Account', s.account || warn('no provider yet (Settings → Providers)'));
    row('Model', String(this.agent?.model ?? s.self.agent.model ?? '—'));
    const c = s.self.conversation;
    row('Conversation', `${c.messages} messages · ${c.artifacts} artifacts · ${c.sections} sections · ${bytesText(c.size)}`);
    row('MCP servers', s.mcp.length ? s.mcp.map((m) => `${m.name} ${m.started ? ok('running') : color.dim('starts when used')}`).join(' · ') : color.dim('none'));

    section('Components');
    const d = s.dictation;
    const dState = d.state === 'running' ? ok(`running${d.device ? ` on ${d.device}` : ''}`) : d.state === 'error' ? bad(`error: ${d.error ?? ''}`) : d.state === 'installing' || d.state === 'starting' ? warn(`${d.state}${d.progress ? ` ${Math.round((100 * d.progress.done) / Math.max(1, d.progress.total))}%` : ''}`) : color.dim(d.state);
    row('Speech to text', dState);
    const v = d.voice;
    row('Text to speech', v.state === 'loaded' || v.state === 'speaking' ? ok(v.state) : v.state === 'error' ? bad(`error: ${v.error ?? ''}`) : v.state === 'installing' ? warn('installing') : color.dim(v.state));
    const p = s.pushToTalk;
    row('Push to talk', p.state === 'unavailable' ? bad(`unavailable${p.error ? `: ${p.error}` : ''}`) : p.state === 'off' ? color.dim('off') : `${ok(p.state)} ${color.dim(`(${p.hotkey})`)}`);
    const sc = s.screen;
    row('Screen mirroring', sc.state === 'ready' ? ok('ready') : sc.state === 'installing' ? warn(`installing${sc.progress ? ` (${sc.progress.label})` : ''}`) : sc.state === 'error' || sc.state === 'unavailable' ? bad(`${sc.state}${sc.error ? `: ${sc.error}` : ''}`) : color.dim(sc.state));
    row('Shells', `${s.shells} open`);

    const sys = s.system;
    if (sys) {
      section('This computer');
      row('CPU', `${bar(sys.cpu.usage)} ${percentText(sys.cpu.usage)}${sys.cpu.temperature !== null ? ` · ${Math.round(sys.cpu.temperature)}°C` : ''} ${color.dim(`(${sys.cpu.threads} threads)`)}`);
      const mem = sys.memory.total ? sys.memory.used / sys.memory.total : null;
      row('Memory', `${bar(mem)} ${bytesText(sys.memory.used)} of ${bytesText(sys.memory.total)}`);
      if (sys.gpu) {
        const gm = sys.gpu.memory;
        row('GPU', `${bar(sys.gpu.usage)} ${percentText(sys.gpu.usage)}${gm ? ` · ${bytesText(gm.used)} of ${bytesText(gm.total)}` : ''}${sys.gpu.temperature !== null ? ` · ${Math.round(sys.gpu.temperature)}°C` : ''} ${color.dim(truncate(sys.gpu.name, 30))}`);
      }
      if (sys.network) row('Network', `↓ ${bytesText(sys.network.down)}/s  ↑ ${bytesText(sys.network.up)}/s`);
    }

    section('Processes');
    out.push(color.dim(`  ${'PID'.padStart(7)}  ${'CPU'.padStart(6)}  ${'MEMORY'.padStart(9)}  NAME`));
    out.push(`  ${String(s.self.pid).padStart(7)}  ${percentText(s.self.cpu).padStart(6)}  ${bytesText(s.self.memory.rss).padStart(9)}  SF Agents ${color.dim('(this process)')}`);
    {
      for (const ch of s.children) {
        out.push(`  ${String(ch.pid).padStart(7)}  ${percentText(ch.cpu).padStart(6)}  ${bytesText(ch.memory).padStart(9)}  ${'  '.repeat(ch.depth + 1)}${truncate(clean(ch.name), Math.max(8, width - 34 - ch.depth * 2))}`);
      }
    }
    out.push('');
    return out;
  }
}

/** Opens the terminal interface; resolves with the exit code when the person quits. */
export function startTui(options: TuiOptions): Promise<number> {
  return new Tui(options).run();
}
