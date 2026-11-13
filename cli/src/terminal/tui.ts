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
 *
 * What a page shows in its sheets and side windows (threads, topics,
 * search, artifacts, changes, usage and context, settings, files) opens as
 * a pane over the chat (panes.ts), through the same API calls the pages make
 * (WebServer.request). Ctrl+↑ picks a message to reply to, react to, speak or copy.
 */

import readline from 'node:readline';
import { describeTree } from '@sfagents/core';
import type { LogBook, LogLine, WebServer } from '@sfagents/web';
import { bar, bytesText, clean, color, durationText, esc, percentText, stampText, timeText } from './ansi.js';
import {
  artifactPane,
  genuiPane,
  stepPane,
  agentEditorPane,
  agentsPane,
  workspacesPane,
  fullControlPane,
  artifactsPane,
  contextPane,
  diffsPane,
  filesPane,
  itemLines,
  numberedAnswer,
  questionLines,
  questionsPane,
  searchPane,
  settingsPane,
  threadPane,
  threadsPane,
  tokens,
  topicsPane,
  usageLines,
  type ArtifactInfo,
  type Attachment,
  type ChatItem,
  type Pane,
  type PaneHost,
  type Question,
  type RepoInfo,
  type Row,
  type SectionInfo,
  type UsageInfo,
} from './panes.js';
import { fit, textWidth, truncate, wrap } from './width.js';
import { drawView, ViewModel, type ViewDoc } from './genui-text.js';
import os from 'node:os';
import path from 'node:path';

type Item =
  | { kind: 'user'; id: string; seq?: number; time: string; text: string; attachments?: Array<{ name: string; size: number }>; replyTo?: string; view?: string }
  | { kind: 'assistant'; id: string; seq?: number; time: string; text: string; agent: string; replyTo?: string }
  | { kind: 'activity'; id: string; seq?: number; time: string; text: string; status?: string; thread?: string; agent?: string; artifact?: string }
  | { kind: 'notice'; id: string; seq?: number; time: string; text: string }
  | { kind: 'questions'; id: string; seq?: number; time: string; agent: string; questions: Question[]; answered: boolean };

interface Segment {
  kind: 'text' | 'activity' | 'user';
  /** A message the person sent while the run worked: it shows where the agent took it. */
  item?: Extract<Item, { kind: 'user' }>;
  id: string;
  text: string;
  status?: string;
  /** A step shown as something else (a message to the person). Text: a failed send. */
  hidden?: boolean;
  /** Text the model wrote outside message: not shown while the run works. */
  plain?: boolean;
  thread?: string;
  artifact?: string;
  /** Questions the agent asked the person in this step. */
  questions?: Question[];
  answered?: boolean;
  /** An inline reply's text: the message whose reply thread it belongs to. */
  replyTo?: string;
}

/** Something in the chat that Ctrl+↑ can pick: its lines, from the top. */
interface Pick {
  id: string;
  start: number;
  end: number;
  kind: 'user' | 'assistant' | 'activity' | 'questions';
  text: string;
  thread?: string;
  artifact?: string;
  /** A step of the agent's: its id for GET /api/activity (the whole command and its output). */
  step?: string;
  questions?: Question[];
  agent?: string;
  /** A message others replied to inline. */
  replies?: number;
}

interface ViewCache {
  rev: number;
  model?: ViewModel;
  errors?: string[];
}

/** The web interface's quick reactions (emoji.js). */
const QUICK = ['❤️', '👍', '👎', '😂', '‼️', '❓', '😭'];

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
  /** Send what else the process writes to the Logs tab (default true; tests turn it off). */
  captureOutput?: boolean;
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
  '  /attach <path>     attach a file to your next message (/detach drops them)',
  '  /answer            answer the agent’s questions option by option',
  '  /search <words>    search the messages and artifacts',
  '  /topics            the conversation’s topics: jump to one',
  '  /threads           the threads between agents',
  '  /artifacts         the artifacts: open, pin, save views',
  '  /changes           uncommitted changes in the agents’ repositories',
  '  /context           plan usage and what the working context holds',
  '  /files [folder]    the file manager',
  '  /agents            the agents: edit one, or make a new one (/edit-agent, /new-agent)',
  '  /full-control      session countdown, Stop, file journal and undo (/full-control stop)',
  '  /workspaces        the Git task workspaces: review, squash, push, undo a run',
  '  /settings          settings, providers and speech',
  '  /speak [stop]      speak the latest reply aloud on this computer (or stop)',
  '  /exit              quit SF Agents (the web interface stops too)',
  'Keys: Tab or F1–F3 switch tabs · the mouse wheel, PgUp/PgDn or Shift+↑↓ scroll (Shift+drag selects text) · Esc stops the reply · y/a/n answer an approval (with an empty composer) · Ctrl+K quits SF Agents (and the web interface) · Ctrl+C twice also quits',
  'Messages: Ctrl+↑ (or Alt+↑) picks one, then r replies, e reacts, s speaks it, c copies it, Enter opens its thread, artifact, view or questions (on a step: the whole command and its output), Esc goes back to typing',
  'Not here: screen mirroring and remote desktop (they need a picture) and terminal tabs (this is a terminal). Speak with push to talk: it types into this window too.',
];

export { bytesText, durationText, percentText } from './ansi.js';

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
  /** GenUI views by artifact id → title: the terminal names them and points to the web interface. */
  private views = new Map<string, string>();
  private fullControl: { agent: string; expires: number } | null = null;
  private approvals: Approval[] = [];
  private readonly answered = new Map<string, string>();
  private reactions: Record<string, string> = {};
  private read: { id: string; time: string } | null = null;
  private notices: Array<{ id: number; text: string; level: string }> = [];
  private noticeSeq = 0;
  /** Messages waiting for the agent (Delivered), the same on every page. */
  private pending: Array<Extract<Item, { kind: 'user' }>> = [];
  private agentReactions: Record<string, string> = {};
  private lastPresence = 0;
  private artifacts: ArtifactInfo[] = [];
  /** GenUI views read for the chat, by artifact id. */
  private viewDocs = new Map<string, ViewCache>();
  private diffs: RepoInfo[] = [];
  private sections: SectionInfo[] = [];

  /** Sheets over the chat (threads, artifacts, settings…), the top one last. */
  private panes: Pane[] = [];
  /** A question in the composer (a pane's prompt): Enter answers it, Esc cancels. */
  private prompt: { label: string; done: (text: string) => void; saved: { text: string; cursor: number } } | null = null;
  private confirming: { question: string; yes: () => void } | null = null;
  /** The message picked with Ctrl+↑, or null while typing. */
  private picked: string | null = null;
  private picks: Pick[] = [];
  private replyTo: { id: string; who: string; text: string } | null = null;
  private attachments: Attachment[] = [];
  private usage: UsageInfo | null = null;
  private context: { used: number; budget: number } | null = null;
  private contextAt = 0;
  private loadingEarlier = false;

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
    if (this.options.captureOutput !== false) {
      this.captureOutput(process.stdout);
      this.captureOutput(process.stderr);
    }
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
    const fullControlTimer = setInterval(() => { if (this.fullControl) this.draw(); }, 1000);
    fullControlTimer.unref(); this.cleanups.push(() => clearInterval(fullControlTimer));

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
    // and mouse reports for the wheel (hold Shift to select text, in most terminals).
    this.rawWrite(`${esc('?1049h')}${esc('?2004h')}${esc('?1000h')}${esc('?1006h')}${esc('?25l')}`);
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
    this.rawWrite(`${esc('?1006l')}${esc('?1000l')}${esc('?2004l')}${esc('?25h')}${esc('?1049l')}`);
    this.resolveDone?.(code);
  }

  // ---------------------------------------------------------------- events

  private onEvent(event: string, raw: unknown): void {
    const data = (raw ?? {}) as Record<string, unknown>;
    for (const p of this.panes) p.event?.(event, data);
    switch (event) {
      case 'state': {
        const s = data as { agent: AgentInfo; items: Item[]; more: boolean; live: Tui['live']; approvals: Approval[]; reactions?: Record<string, string>; read?: Tui['read']; notices?: Array<string | { text: string; level?: string }> };
        this.fullControl = (data.fullControl as Tui['fullControl']) ?? null;
        this.agent = s.agent;
        this.items = s.items;
        this.more = s.more;
        this.live = s.live;
        this.approvals = s.approvals;
        this.reactions = s.reactions ?? {};
        this.read = s.read ?? null;
        this.pending = (s as { pending?: Tui['pending'] }).pending ?? [];
        this.agentReactions = (s as { agentReactions?: Record<string, string> }).agentReactions ?? {};
        this.setViews((s as { artifacts?: unknown }).artifacts);
        this.diffs = ((s as { diffs?: RepoInfo[] }).diffs ?? []) as RepoInfo[];
        this.sections = ((s as { sections?: SectionInfo[] }).sections ?? []) as SectionInfo[];
        for (const n of s.notices ?? []) typeof n === 'string' ? this.notice(n) : this.notice(n.text, n.level);
        break;
      }
      case 'pending':
        this.pending = (data.pending as Tui['pending']) ?? [];
        break;
      case 'artifacts':
        this.setViews(data.artifacts);
        break;
      case 'diffs':
        this.diffs = (data.repos as RepoInfo[]) ?? [];
        break;
      case 'sections':
        this.sections = (data.sections as SectionInfo[]) ?? [];
        break;
      case 'usage':
        this.usage = data as unknown as UsageInfo;
        break;
      case 'context': {
        const c = data as { used?: number; budget?: number };
        if (typeof c.used === 'number' && typeof c.budget === 'number') this.context = { used: c.used, budget: c.budget };
        break;
      }
      case 'signin':
        if (data.state === 'done') this.notice(`Signed in: “${String((data.provider as { name?: string } | null)?.name ?? '')}” is ready.`);
        else if (data.state === 'failed' && data.error !== 'Cancelled.') this.notice(`The sign-in didn’t finish: ${String(data.error ?? '')}`, 'error');
        break;
      case 'settings':
      case 'providers':
      case 'dictation':
      case 'threads':
      case 'files':
        break;
      case 'agent_reactions':
        this.agentReactions = (data.reactions as Record<string, string>) ?? {};
        break;
      case 'user': {
        const item = data.item as Item;
        if (typeof data.pending === 'string') this.pending = this.pending.filter((p) => p.id !== data.pending);
        // Taken while the agent works: it shows after the steps so far, as on the pages.
        const segment = data.segment as Segment | undefined;
        if (segment && this.live && this.live.id === data.run) {
          if (!this.live.segments.some((s) => s.id === segment.id)) this.live.segments.push(segment);
        } else if (!this.items.some((i) => i.id === item.id)) this.items.push(item);
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
        const plain = data.plain === true;
        if (last && last.kind === 'text' && !!last.plain === plain) last.text += String(data.text);
        else segs.push({ kind: 'text', id: `t${segs.length}`, text: String(data.text), ...(plain ? { plain: true } : {}) });
        // A reply is shown once it is finished, as on the pages.
        return;
      }
      case 'activity':
        if (!this.live || this.live.id !== data.run) return;
        this.live.segments.push(data.segment as Segment);
        break;
      case 'segment_hidden': {
        const seg = this.live && this.live.id === data.run ? this.live.segments.find((s) => s.id === data.id) : undefined;
        if (seg) seg.hidden = true;
        break;
      }
      case 'activity_end': {
        const seg = this.live && this.live.id === data.run ? this.live.segments.find((s) => s.id === data.id) : undefined;
        if (seg) seg.status = String(data.status);
        // The artifact or view it made shows under it, as on the pages.
        if (seg && typeof data.artifact === 'string') seg.artifact = data.artifact;
        break;
      }
      case 'full-control':
        this.fullControl = (data.status as Tui['fullControl']) ?? null; this.draw(); return;
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
        if (data.agentReactions) this.agentReactions = data.agentReactions as Record<string, string>;
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
    // Someone is at the terminal: the agent's latest message counts as read.
    if (Date.now() - this.lastPresence > 10_000) {
      this.lastPresence = Date.now();
      this.options.server.presence();
    }
    // Mouse reports (SGR: ESC [ < button ; column ; row M) arrive as separate keys: collect them.
    if (key.sequence === '\u001b[<') {
      this.mouse = '';
      return;
    }
    if (this.mouse !== null) {
      const ch = key.sequence ?? str ?? '';
      if (ch === 'M' || ch === 'm') {
        const button = Number(this.mouse.split(';')[0]);
        this.mouse = null;
        // The wheel (64 up, 65 down, with Shift, Alt or Ctrl bits): three lines a notch.
        if (ch === 'M' && (button & ~28) === 64) this.scrollBy(3);
        else if (ch === 'M' && (button & ~28) === 65) this.scrollBy(-3);
        return;
      }
      if (/^[\d;]$/.test(ch) && this.mouse.length < 32) {
        this.mouse += ch;
        return;
      }
      this.mouse = null;
    }
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
    // Ctrl+K: one press quits SF Agents, the web interface and everything it started
    // (after the paste check, so a pasted vertical tab does not).
    if (key.ctrl && name === 'k') return this.quit();
    // A yes-or-no question: y does it, anything else leaves things as they are.
    if (this.confirming) {
      const c = this.confirming;
      this.confirming = null;
      if (str && /^y$/i.test(str)) c.yes();
      else this.notice('Left as it was.');
      return this.schedule();
    }
    // Tabs.
    const number = key.meta && /^[1-3]$/.test(name) ? Number(name) : /^f[1-3]$/.test(name) ? Number(name.slice(1)) : 0;
    if (number) return this.setTab(TABS[number - 1]!);
    // In a form (the agent editor) Tab moves between fields instead.
    const form = this.tab === 'Chat' && !this.prompt && !!this.panes.at(-1)?.form;
    if (name === 'tab' && !form) return this.setTab(TABS[(TABS.indexOf(this.tab) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]!);
    // A pane over the chat takes the keys (unless it asked for text).
    if (this.tab === 'Chat' && this.panes.length && !this.prompt) return this.paneKey(str, key, name);
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
    // A message picked with Ctrl+↑: its keys.
    if (this.picked && !this.prompt && this.pickKey(str, key, name)) return;
    if ((key.ctrl || key.meta) && name === 'up' && !this.prompt) return this.pickNext(-1);
    // An approval waiting, and nothing typed: y, a or n answers it.
    const pending = this.approvals.find((a) => !this.answered.has(a.id));
    if (pending && !this.text && !this.prompt && str && /^[yan]$/i.test(str)) {
      const decision = { y: 'allow_once', a: 'allow_always', n: 'deny' }[str.toLowerCase() as 'y' | 'a' | 'n'] as 'allow_once' | 'allow_always' | 'deny';
      if (decision === 'allow_always' && ['full_control', 'host_action'].includes(pending.tool)) return;
      try {
        this.options.server.answer(pending.id, decision);
      } catch (error) {
        this.notice(error instanceof Error ? error.message : String(error), 'error');
      }
      return;
    }
    if (name === 'escape') {
      if (this.prompt) return this.endPrompt();
      if (this.replyTo) this.replyTo = null;
      else if (this.live) this.options.server.cancel();
      this.schedule();
      return;
    }
    if (name === 'return' || name === 'enter') {
      if (key.meta || key.shift) return this.insert('\n');
      const line = this.text;
      if (this.prompt) {
        const done = this.prompt.done;
        this.endPrompt();
        done(line);
        return this.schedule();
      }
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
    if (key.ctrl && name === 'w') return this.deleteWord();
    if (key.ctrl && name === 'l') return this.draw();
    if (name === 'up' || name === 'down') {
      if (!this.history.length || this.prompt) return;
      if (name === 'up') this.historyAt = this.historyAt < 0 ? this.history.length - 1 : Math.max(0, this.historyAt - 1);
      else this.historyAt = this.historyAt < 0 ? -1 : this.historyAt + 1 >= this.history.length ? -1 : this.historyAt + 1;
      this.text = this.historyAt < 0 ? '' : this.history[this.historyAt]!;
      this.cursor = this.text.length;
      return this.schedule();
    }
    if (str && !key.ctrl && !key.meta && str >= ' ') this.insert(str);
  }

  private pasting = false;
  /** A mouse report being read, or null. */
  private mouse: string | null = null;

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
      this.notice('Stopping the reply. Press Ctrl+C again, or Ctrl+K, to quit SF Agents.');
    } else if (this.text) {
      this.text = '';
      this.cursor = 0;
      this.schedule();
    } else this.notice('Press Ctrl+C again, or Ctrl+K, to quit SF Agents (the web interface stops too).');
  }

  // ---------------------------------------------------------------- panes

  private width(): number {
    return Math.max(20, this.output.columns || 80);
  }

  private paneKey(str: string | undefined, key: readline.Key, name: string): void {
    const pane = this.panes[this.panes.length - 1]!;
    const rows = pane.rows(this.width());
    const picks = rows.flatMap((r, i) => (r.pick ? [i] : []));
    const move = (d: number) => {
      if (!picks.length) pane.scroll = Math.max(0, Math.min(pane.scroll, 1_000_000) + d);
      else {
        const at = picks.indexOf(pane.selected);
        pane.selected = picks[Math.max(0, Math.min(picks.length - 1, (at < 0 ? 0 : at) + d))]!;
      }
      this.schedule();
    };
    const page = Math.max(1, this.viewHeight - 3);
    if (name === 'escape' || (str === 'q' && !key.ctrl)) return this.back();
    if (name === 'up' || str === 'k') return move(-1);
    if (name === 'down' || str === 'j') return move(1);
    if (name === 'pageup') return move(picks.length ? -Math.max(1, Math.floor(page / 2)) : -page);
    if (name === 'pagedown') return move(picks.length ? Math.max(1, Math.floor(page / 2)) : page);
    if (name === 'home') return move(-1_000_000);
    if (name === 'end') return move(1_000_000);
    const row = rows[pane.selected]?.pick ? rows[pane.selected] : undefined;
    if (name === 'tab') return move(key.shift ? -1 : 1);
    if (name === 'return' || name === 'enter') {
      if (row) pane.enter?.(row);
      return this.schedule();
    }
    // Ctrl+S saves a form (the agent editor).
    if (key.ctrl && name === 's') {
      if (pane.key?.('save', row)) return this.schedule();
      return;
    }
    if (name === 'right') {
      if (pane.key?.('right', row)) return this.schedule();
      return;
    }
    if (name === 'backspace' || name === 'left') {
      if (pane.key?.(name === 'left' ? 'left' : '\b', row)) return this.schedule();
      if (name === 'backspace') this.back();
      return;
    }
    const ch = name === 'space' ? ' ' : str;
    if (ch && !key.ctrl && !key.meta && pane.key?.(ch, row)) return this.schedule();
  }

  private openPane(pane: Pane): void {
    this.picked = null;
    this.panes.push(pane);
    this.setTab('Chat');
  }

  private back(): void {
    this.panes.pop();
    this.schedule();
  }

  /** What the panes use to reach the server and the person. */
  private readonly host: PaneHost = {
    api: (method, p, body) => this.api(method, p, body),
    raw: async (p) => {
      const r = await this.options.server.request('GET', `/api/${p}`);
      if (r.status >= 400) throw new Error(String(r.json.error ?? `HTTP ${r.status}`));
      return { body: r.body, type: r.type };
    },
    open: (pane) => this.openPane(pane),
    back: () => this.back(),
    closeAll: () => {
      this.panes = [];
      this.schedule();
    },
    redraw: () => this.schedule(),
    notice: (text, level) => this.notice(text, level),
    fail: (error) => this.notice(error instanceof Error ? error.message : String(error), 'error'),
    ask: (label, initial, done) => this.ask(label, initial, done),
    confirm: (question, yes) => {
      this.confirming = { question, yes };
      this.schedule();
    },
    copy: (text) => this.copy(text),
    attach: (a) => {
      if (!this.attachments.some((x) => x.id === a.id)) this.attachments.push(a);
      this.schedule();
    },
    jump: (id, seq) => void this.jump(id, seq),
    send: (text) => this.send(text),
    url: () => this.options.url,
    artifacts: () => this.artifacts,
    diffs: () => this.diffs,
    sections: () => this.sections,
  };

  private async api<T = Record<string, unknown>>(method: 'GET' | 'POST', p: string, body?: unknown): Promise<T> {
    const r = await this.options.server.request(method, `/api/${p}`, body);
    if (r.status >= 400) throw Object.assign(new Error(String(r.json.error ?? `HTTP ${r.status}`)), { status: r.status, body: r.json });
    return r.json as T;
  }

  /** Asks for a line of text in the composer; what was typed comes back after. */
  private ask(label: string, initial: string, done: (text: string) => void): void {
    if (this.prompt) this.endPrompt();
    this.prompt = { label, done, saved: { text: this.text, cursor: this.cursor } };
    this.text = initial;
    this.cursor = initial.length;
    this.schedule();
  }

  private endPrompt(): void {
    if (!this.prompt) return;
    this.text = this.prompt.saved.text;
    this.cursor = this.prompt.saved.cursor;
    this.prompt = null;
    this.schedule();
  }

  /** Shows a message in the chat, loading earlier messages until it is there. */
  private async jump(id: string, seq: number): Promise<void> {
    this.panes = [];
    const has = () => this.items.find((i) => i.id === id) ?? this.items.find((i) => (i.seq ?? 0) >= seq && (i.kind === 'user' || i.kind === 'assistant'));
    while (!this.items.some((i) => i.id === id) && this.more && (this.items[0]?.seq ?? 0) > seq) {
      if (!(await this.loadEarlier())) break;
    }
    const found = has();
    if (!found) return this.notice('That message isn’t in the conversation any more.', 'error');
    this.picked = found.id;
    this.schedule();
  }

  /** The page of messages before the first one shown; false when there are none. */
  private async loadEarlier(): Promise<boolean> {
    const first = this.items[0]?.seq;
    if (!this.more || this.loadingEarlier || first === undefined) return false;
    this.loadingEarlier = true;
    try {
      const r = await this.api<{ items: Item[]; more: boolean }>('GET', `messages?before=${first}`);
      const known = new Set(this.items.map((i) => i.id));
      this.items = [...r.items.filter((i) => !known.has(i.id)), ...this.items];
      this.more = r.more;
      return r.items.length > 0;
    } catch (error) {
      this.notice(error instanceof Error ? error.message : String(error), 'error');
      return false;
    } finally {
      this.loadingEarlier = false;
      this.schedule();
    }
  }

  // ---------------------------------------------------------------- picking messages

  /** Moves the pick up (-1) or down (+1); past the last message it goes back to typing. */
  private pickNext(d: number): void {
    const list = this.picks;
    if (!list.length) return this.notice('Nothing to pick yet.');
    const at = this.picked ? list.findIndex((p) => p.id === this.picked) : -1;
    if (at < 0) this.picked = list[list.length - 1]!.id;
    else if (at + d >= list.length) this.picked = null;
    else if (at + d < 0) {
      if (this.more) void this.loadEarlier();
    } else this.picked = list[at + d]!.id;
    this.schedule();
  }

  /** A key while a message is picked; false lets it through to the composer (picking ends). */
  private pickKey(str: string | undefined, key: readline.Key, name: string): boolean {
    const pick = this.picks.find((p) => p.id === this.picked);
    if (!pick) {
      this.picked = null;
      return false;
    }
    const message = pick.kind === 'user' || pick.kind === 'assistant';
    const done = () => {
      this.schedule();
      return true;
    };
    if (name === 'up' || (str === 'k' && !key.ctrl)) return (this.pickNext(-1), true);
    if (name === 'down' || (str === 'j' && !key.ctrl)) return (this.pickNext(1), true);
    if (name === 'escape') {
      this.picked = null;
      return done();
    }
    if (name === 'return' || name === 'enter') {
      if (pick.thread) this.openPane(threadPane(this.host, pick.thread));
      else if (pick.artifact) {
        const a = this.artifacts.find((x) => x.id === pick.artifact);
        if (a) this.openPane(a.type === 'genui' ? genuiPane(this.host, a) : artifactPane(this.host, a));
      } else if (pick.step) this.openPane(stepPane(this.host, pick.step, truncate(clean(pick.text).replace(/\s+/g, ' '), 60)));
      else if (pick.questions) this.openPane(questionsPane(this.host, pick.agent ?? 'The agent', pick.questions));
      else if (pick.replies) this.openPane(this.replyPane(pick.id));
      else if (message) this.startReply(pick);
      return done();
    }
    if (key.ctrl || key.meta) return false;
    switch (str) {
      case 'r':
        if (message) this.startReply(pick);
        return done();
      case 't':
        if (pick.replies) this.openPane(this.replyPane(pick.id));
        return done();
      case 'e':
        if (!message) return done();
        this.picked = null;
        this.ask(`React with ${QUICK.map((e, i) => `${i + 1} ${e}`).join('  ')} (or type an emoji; 0 removes):`, '', (text) => {
          const t = text.trim();
          const emoji = /^[1-9]$/.test(t) ? QUICK[Number(t) - 1] : t === '0' || t === '' ? null : t;
          if (emoji === undefined) return;
          this.api<{ reactions: Record<string, string> }>('POST', 'reactions', { id: pick.id, emoji }).then((r) => {
            this.reactions = r.reactions;
            this.schedule();
          }, this.host.fail);
        });
        return done();
      case 's':
        if (pick.kind === 'assistant') this.speak(pick.text, pick.agent);
        return done();
      case 'c':
        this.copy(pick.text);
        return done();
      case 'd':
        if (pick.step) this.openPane(stepPane(this.host, pick.step, truncate(clean(pick.text).replace(/\s+/g, ' '), 60)));
        return done();
      default:
        this.picked = null;
        return false;
    }
  }

  private startReply(pick: Pick): void {
    this.replyTo = { id: pick.id, who: pick.kind === 'user' ? 'You' : (pick.agent ?? 'the agent'), text: pick.text };
    this.picked = null;
  }

  /** An inline reply thread: the message and the replies to it. */
  private replyPane(root: string): Pane {
    const tui = this;
    return {
      title: 'Replies',
      hint: '↑↓ PgUp PgDn scroll · r replies in this thread · Esc goes back',
      selected: 0,
      scroll: Number.MAX_SAFE_INTEGER,
      rows(w: number): Row[] {
        const items = [...tui.items, ...tui.pending].filter((i) => (i.id === root || ('replyTo' in i && i.replyTo === root)) && (i.kind === 'user' || i.kind === 'assistant'));
        return itemLines(items as ChatItem[], w).map((l) => ({ lines: [l] }));
      },
      key(ch: string) {
        if (ch !== 'r') return false;
        const it = tui.items.find((i) => i.id === root);
        if (it && (it.kind === 'user' || it.kind === 'assistant')) tui.replyTo = { id: root, who: it.kind === 'user' ? 'You' : it.agent, text: it.text };
        tui.back();
        return true;
      },
    };
  }

  /** The questions waiting for an answer: those of the running reply, or the latest ones asked. */
  private openQuestions(): { agent: string; questions: Question[] } | null {
    for (const seg of [...(this.live?.segments ?? [])].reverse()) if (seg.questions?.length && !seg.answered) return { agent: this.agent?.id ?? 'The agent', questions: seg.questions };
    const last = [...this.items].reverse().find((i) => i.kind === 'questions' || i.kind === 'user');
    return last && last.kind === 'questions' && !last.answered ? { agent: last.agent, questions: last.questions } : null;
  }

  /** Speaks text aloud on this computer (Qwen3-TTS, through its speakers). */
  private speak(text: string, agent = this.agent?.id): void {
    if (!agent || !this.options.server.canSpeak(agent)) return this.notice('Enable Read Replies Aloud in this agent’s settings to read a response.');
    this.notice('Speaking… (/speak stop stops it)');
    this.options.server.speakAloud(text, agent).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.notice(`Couldn’t speak it: ${message}${/not set up|not installed|missing/i.test(message) ? ' /settings → Speech installs the voice.' : ''}`, 'error');
    });
  }

  /** Copies text with the terminal's clipboard escape (OSC 52), which most terminals take, over SSH too. */
  private copy(text: string): void {
    this.rawWrite(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`);
    this.notice('Copied (if this terminal allows it; otherwise Shift+drag selects text).');
  }

  private async attachPath(input: string): Promise<void> {
    let p = input.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!p) return this.notice('Which file? /attach ~/Documents/notes.txt', 'error');
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    try {
      const r = await this.api<{ attachment: Attachment }>('POST', 'files/attach', { path: p });
      this.host.attach(r.attachment);
      this.notice(`“${r.attachment.name}” will go with your next message.`);
    } catch (error) {
      this.notice(error instanceof Error ? error.message : String(error), 'error');
    }
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
    // Over a pane the wheel moves through it.
    if (this.tab === 'Chat' && this.panes.length) {
      const pane = this.panes[this.panes.length - 1]!;
      const rows = pane.rows(this.width());
      const picks = rows.flatMap((r, i) => (r.pick ? [i] : []));
      if (!picks.length) pane.scroll = Math.max(0, Math.min(pane.scroll, 1_000_000) - lines);
      else {
        const at = Math.max(0, picks.indexOf(pane.selected));
        pane.selected = picks[Math.max(0, Math.min(picks.length - 1, at - Math.sign(lines)))]!;
      }
      return this.schedule();
    }
    this.scroll[this.tab] = Math.max(0, Math.min(this.scroll[this.tab] + lines, 1_000_000));
    this.schedule();
  }

  private async refreshStatus(): Promise<void> {
    if (this.statusBusy) return;
    this.statusBusy = true;
    try {
      this.status = await this.options.server.status();
      // The plan's usage (the server reads it again at most once a minute) and the working context.
      const [usage, context] = await Promise.all([this.api<UsageInfo>('GET', 'agent/usage').catch(() => null), this.context && Date.now() - this.contextAt < 10_000 ? null : this.api<{ used: number; budget: number }>('GET', 'agent/context').catch(() => null)]);
      if (usage) this.usage = usage;
      if (context) {
        this.context = { used: context.used, budget: context.budget };
        this.contextAt = Date.now();
      }
    } catch (error) {
      this.options.logs.add(`status: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.statusBusy = false;
    }
    this.schedule();
  }

  // ---------------------------------------------------------------- sending and commands

  private submit(line: string): void {
    let text = line.replace(/\s+$/, '');
    if (!text.trim() && !this.attachments.length) return this.schedule();
    if (text.trim() && this.history[this.history.length - 1] !== text) this.history.push(text);
    if (text.startsWith('/') && !text.includes('\n')) return this.command(text.trim());
    // Numbers answer the agent's questions with its options ("2", or "1,3" where it takes several).
    const asked = this.replyTo ? null : this.openQuestions();
    if (asked) text = numberedAnswer(asked.questions, text) ?? text;
    this.send(text);
  }

  /** Sends a message, with the reply and attachments being written. */
  private send(text: string): void {
    // While the agent works the message waits, Delivered, and the agent reads it at its next step.
    const replyTo = this.replyTo;
    const attachments = this.attachments;
    this.scroll.Chat = 0;
    // Writing answers the questions asked so far (the server marks them too).
    for (const seg of this.live?.segments ?? []) if (seg.questions) seg.answered = true;
    if (!attachments.length) {
      try {
        this.options.server.sendMessage(text, replyTo ? { replyTo: replyTo.id } : {});
        this.replyTo = null;
      } catch (error) {
        this.notice(error instanceof Error ? error.message : String(error), 'error');
      }
      return this.schedule();
    }
    this.replyTo = null;
    this.attachments = [];
    this.api('POST', 'messages', { text, attachments: attachments.map((a) => a.id), ...(replyTo ? { replyTo: replyTo.id } : {}) }).catch((error: unknown) => {
      // Not sent: the reply and the files are back in the composer.
      this.replyTo ??= replyTo;
      if (!this.attachments.length) this.attachments = attachments;
      this.notice(error instanceof Error ? error.message : String(error), 'error');
    });
    this.schedule();
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
      case '/agents':
        return this.openPane(agentsPane(this.host));
      case '/full-control':
        if (arg === 'stop') { this.api('POST', 'full-control', { action: 'stop' }).catch((e) => this.notice(String(e), 'error')); return; }
        return this.openPane(fullControlPane(this.host));
      case '/workspaces':
        return this.openPane(workspacesPane(this.host));
      case '/new-agent':
        return this.openPane(agentEditorPane(this.host, undefined, () => {}));
      case '/edit-agent':
        return this.openPane(agentEditorPane(this.host, arg || this.agent?.id, () => {}));
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
      case '/attach':
        void this.attachPath(arg);
        return;
      case '/detach':
        this.attachments = [];
        return this.notice('No files attached.');
      case '/answer': {
        const asked = this.openQuestions();
        if (!asked) return this.notice('No questions are waiting for an answer.');
        return this.openPane(questionsPane(this.host, asked.agent, asked.questions));
      }
      case '/search':
        if (arg) return this.openPane(searchPane(this.host, arg));
        return this.ask('Search for:', '', (q) => q.trim() && this.openPane(searchPane(this.host, q.trim())));
      case '/topics':
      case '/sections':
        return this.openPane(topicsPane(this.host));
      case '/threads':
        return this.openPane(threadsPane(this.host));
      case '/artifacts':
        return this.openPane(artifactsPane(this.host));
      case '/changes':
      case '/diffs':
        return this.openPane(diffsPane(this.host));
      case '/context':
      case '/usage':
        return this.openPane(contextPane(this.host));
      case '/files':
        return this.openPane(filesPane(this.host, arg ? path.resolve(arg.replace(/^~(?=$|[\\/])/, os.homedir())) : undefined));
      case '/settings':
      case '/providers':
        return this.openPane(settingsPane(this.host));
      case '/speak': {
        if (arg === 'stop') return this.notice(server.stopSpeaking() ? 'Stopped speaking.' : 'Nothing is being spoken.');
        const last = [...this.items].reverse().find((i) => i.kind === 'assistant');
        if (!last || last.kind !== 'assistant') return this.notice('No reply to speak yet.');
        return this.speak(last.text, last.agent);
      }
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
    const paneOpen = this.tab === 'Chat' && this.panes.length > 0;
    const body = paneOpen ? [] : this.tab === 'Chat' ? this.chatLines(width) : this.tab === 'Logs' ? this.logView(width) : this.statusLines(width);
    // A picked message stays in view.
    const pick = !paneOpen && this.tab === 'Chat' && this.picked ? this.picks.find((p) => p.id === this.picked) : undefined;
    if (pick) {
      const fromBottom = body.length - 1 - pick.end; // lines below the pick's last line
      const need = Math.min(fromBottom, Math.max(0, body.length - pick.start - this.viewHeight));
      if (this.scroll.Chat > fromBottom) this.scroll.Chat = fromBottom;
      if (this.scroll.Chat < need) this.scroll.Chat = need;
    }
    // The visible window, from the bottom (or the top for Status), after scrolling.
    const max = Math.max(0, body.length - this.viewHeight);
    const offset = paneOpen ? 0 : Math.min(this.scroll[this.tab], max);
    // (Status keeps its place at the top until it has been read.)
    if (!paneOpen && (this.tab !== 'Status' || this.status)) this.scroll[this.tab] = offset;
    let shown: string[];
    if (paneOpen) shown = this.paneLines(width);
    else if (this.tab === 'Status') shown = body.slice(max - offset, max - offset + this.viewHeight);
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

  /** The pane on top, drawn in the chat's place: a title line, then its rows around the selection. */
  private paneLines(width: number): string[] {
    const pane = this.panes[this.panes.length - 1]!;
    const rows = pane.rows(width);
    const picks = rows.flatMap((r, i) => (r.pick ? [i] : []));
    if (picks.length && !rows[pane.selected]?.pick) pane.selected = picks.find((i) => i >= pane.selected) ?? picks[picks.length - 1]!;
    const lines: string[] = [];
    let start = -1;
    let end = -1;
    rows.forEach((r, i) => {
      if (picks.length && i === pane.selected) {
        start = lines.length;
        r.lines.forEach((l, j) => lines.push(j === 0 ? `${color.cyan(color.bold('›'))}${l.startsWith(' ') ? l.slice(1) : l}` : l));
        end = lines.length - 1;
      } else lines.push(...r.lines);
    });
    const h = Math.max(1, this.viewHeight - 1);
    const max = Math.max(0, lines.length - h);
    if (picks.length && start >= 0) {
      if (start < pane.scroll) pane.scroll = start;
      if (end >= pane.scroll + h) pane.scroll = Math.max(start - Math.max(0, h - (end - start + 1)), end - h + 1);
      // Headings just above the first pick stay in view.
      if (pane.selected === picks[0]) pane.scroll = 0;
    }
    pane.scroll = Math.max(0, Math.min(pane.scroll, max));
    const trail = this.panes.length > 1 ? color.dim(` ‹ ${this.panes.slice(0, -1).reverse().map((p) => clean(p.title)).join(' ‹ ')}`) : '';
    const where = lines.length > h ? color.dim(` ${Math.round((100 * (pane.scroll + h)) / lines.length)}%`) : '';
    const title = `${color.bold(color.cyan(` ${clean(pane.title)}`))}${trail}`;
    const head = `${truncate(title, Math.max(10, width - textWidth(where) - 1))}${where}`;
    const shown = lines.slice(pane.scroll, pane.scroll + h);
    while (shown.length < h) shown.push('');
    return [head, ...shown];
  }

  private footer(width: number): { lines: string[]; cursor?: { row: number; col: number } } {
    const rule = color.dim('─'.repeat(width));
    if (this.confirming) return { lines: [rule, `${color.yellow(color.bold(truncate(` ${clean(this.confirming.question)}`, width - 14)))} ${color.bold('[y]')} yes  ${color.dim('any key: no')}`] };
    if (this.tab !== 'Chat') {
      const hint = this.tab === 'Logs' ? `${this.logLines.length} lines · ↑↓ PgUp PgDn scroll · End follows · Tab switches tabs · Ctrl+K quits` : `${this.options.url} · refreshes every 2 seconds · Tab switches tabs · Ctrl+K quits`;
      return { lines: [rule, color.dim(truncate(` ${hint}`, width))] };
    }
    // Over a pane, notes show above its keys (the chat, where they usually go, is covered).
    const notes = this.panes.length ? this.notices.slice(-2).map((n) => (n.level === 'error' ? color.red : color.yellow)(truncate(` ${clean(n.text)}`, width))) : [];
    if (this.panes.length && !this.prompt) return { lines: [rule, ...notes, ...wrap(this.panes[this.panes.length - 1]!.hint, width - 2).slice(0, 2).map((l) => color.dim(` ${l}`))] };
    // Above the composer: what is being asked, the message being replied to, the files going with it.
    const above: string[] = [];
    above.push(...notes);
    if (this.prompt) above.push(color.yellow(truncate(` ${this.prompt.label}`, width - 1)));
    else {
      if (this.picked) {
        const pick = this.picks.find((p) => p.id === this.picked);
        const keys = pick?.kind === 'activity' ? ` Enter opens · d shows the command and output · c copy · ↑↓ move · Esc back to typing` : ` r reply · e react${pick?.kind === 'assistant' && this.options.server.canSpeak(pick.agent ?? this.agent?.id ?? '') ? ' · s speak' : ''} · c copy · Enter opens · ↑↓ move · Esc back to typing`;
        above.push(color.dim(truncate(keys, width)));
      }
      if (this.replyTo) above.push(`${color.cyan(' ↳ ')}${color.dim(truncate(`Replying to ${this.replyTo.who}: ${clean(this.replyTo.text).replace(/\s+/g, ' ')}`, width - 18))}${color.dim(' · Esc cancels')}`);
      if (this.attachments.length) above.push(color.dim(truncate(` 📎 ${this.attachments.map((a) => `${clean(a.name)} (${bytesText(a.size)})`).join(' · ')} · /detach drops them`, width)));
    }
    const prompt = '› ';
    const avail = Math.max(4, width - textWidth(prompt) - 1);
    // The composer shows several lines when the text has them (or is long), at most 5.
    const shownText = this.text.replace(/\n/g, '⏎\n');
    const lines = wrap(shownText, avail);
    // A sentinel keeps wrap from trimming spaces immediately before the cursor.
    const before = wrap(this.text.slice(0, this.cursor).replace(/\n/g, '⏎\n') + '│', avail);
    const curRow = before.length - 1;
    const curCol = Math.max(0, textWidth(before[curRow] ?? '') - 1);
    const first = Math.max(0, Math.min(curRow - 4, lines.length - 5));
    const visible = lines.slice(first, first + 5);
    const asked = this.openQuestions();
    const placeholder = this.prompt
      ? 'Enter answers · Esc cancels'
      : asked
        ? `Answer ${asked.agent} (a number picks an option) · Ctrl+↑ picks a message · /help`
        : this.live
          ? 'The agent reads what you send at its next step · Esc stops the reply'
          : `Message ${this.agent?.id ?? 'the agent'} · Ctrl+↑ picks a message · /help for commands`;
    const rendered = this.text
      ? visible.map((l, i) => `${i === 0 && first === 0 ? color.cyan(prompt) : '  '}${l}`)
      : [`${color.cyan(prompt)}${color.dim(truncate(placeholder, avail))}`];
    if (this.picked && !this.prompt) return { lines: [rule, ...above, ...rendered] };
    return { lines: [rule, ...above, ...rendered], cursor: { row: 1 + above.length + (this.text ? curRow - first : 0), col: textWidth(prompt) + (this.text ? curCol : 0) } };
  }

  private chatLines(width: number): string[] {
    const w = Math.max(10, width - 4);
    const out: string[] = [];
    const picks: Pick[] = [];
    const indent = (lines: string[], pad = '  ') => lines.map((l) => `${pad}${l}`);
    const root = (it: { replyTo?: string; id?: string }) => (it.replyTo && it.replyTo !== it.id ? color.dim('│ ') : '');
    if (this.more) out.push(color.dim('  … earlier messages: Ctrl+↑ past the first one loads them (or /search, /topics)'), '');
    let lastTime = 0;
    let lastUser: string | undefined;
    for (const it of [...this.items, ...(this.live?.segments ?? []).flatMap((s) => (s.item ? [s.item] : [])), ...this.pending]) if (it.kind === 'user') lastUser = it.id;
    const badge = (id: string) => {
      const r = [this.reactions[id], this.agentReactions[id]].filter(Boolean).join('');
      return r ? ` ${r}` : '';
    };
    // Inline replies: how many each message has, and where a run of them starts away from its message.
    const replies = new Map<string, number>();
    for (const it of [...this.items, ...this.pending]) if ('replyTo' in it && it.replyTo && it.replyTo !== it.id) replies.set(it.replyTo, (replies.get(it.replyTo) ?? 0) + 1);
    let openRoot: string | undefined;
    const quote = (it: Item) => {
      const r = 'replyTo' in it && it.replyTo && it.replyTo !== it.id ? it.replyTo : undefined;
      if (r && openRoot !== r) {
        const target = this.items.find((x) => x.id === r);
        const text = target && 'text' in target ? clean(target.text).replace(/\s+/g, ' ') : '';
        out.push('', color.dim(truncate(`╭ ↳ ${target?.kind === 'user' ? 'You' : target && 'agent' in target ? target.agent : ''}: ${text}`, w)));
      }
      openRoot = r ?? (replies.get(it.id) ? it.id : undefined);
    };
    const mark = (p: Omit<Pick, 'start' | 'end'>, from: number) => {
      // The blank line before a message isn't part of it.
      const start = out[from] === '' ? from + 1 : from;
      picks.push({ ...p, start, end: out.length - 1 });
    };
    const replyCount = (id: string, thread: string) => {
      const n = replies.get(id);
      if (n) out.push(`${thread}  ${color.dim(`${n} ${n === 1 ? 'reply' : 'replies'}`)}`);
    };
    for (const it of this.items) {
      const t = new Date(it.time).getTime();
      if ((it.kind === 'user' || it.kind === 'assistant') && Number.isFinite(t)) {
        if (!lastTime || t - lastTime > 60 * 60 * 1000) out.push('', color.dim(`  ── ${stampText(it.time)} ──`));
        lastTime = t;
      }
      const thread = root(it);
      const from = out.length;
      if (it.kind === 'user') {
        quote(it);
        const at = out.length;
        const from2 = it.view ? color.dim(` · from the view “${clean(this.views.get(it.view) ?? it.view)}”`) : '';
        out.push('', `${thread}${color.cyan(color.bold('You'))} ${color.dim(timeText(it.time))}${from2}${badge(it.id)}`);
        out.push(...indent(wrap(clean(it.text), w - textWidth(thread)), `${thread}  `));
        for (const a of it.attachments ?? []) out.push(`${thread}  ${color.dim(`📎 ${clean(a.name)} (${bytesText(a.size)})`)}`);
        if (it.id === lastUser) {
          const answered = this.items.some((x) => x.kind === 'assistant' && new Date(x.time).getTime() >= t);
          const receipt = answered ? '' : this.read?.id === it.id ? `Read ${timeText(this.read.time)}` : 'Delivered';
          if (receipt) out.push(`${thread}  ${color.dim(receipt)}`);
        }
        replyCount(it.id, thread);
        mark({ id: it.id, kind: 'user', text: it.text, replies: replies.get(it.id) }, at);
      } else if (it.kind === 'assistant') {
        quote(it);
        const at = out.length;
        out.push('', `${thread}${color.magenta(color.bold(it.agent))} ${color.dim(timeText(it.time))}${badge(it.id)}`);
        out.push(...indent(wrap(clean(it.text), w - textWidth(thread)), `${thread}  `));
        replyCount(it.id, thread);
        mark({ id: it.id, kind: 'assistant', text: it.text, agent: it.agent, replies: replies.get(it.id) }, at);
      } else if (it.kind === 'activity') {
        out.push(this.activityLine(it, w));
        if (it.status !== 'error' && it.status !== 'denied') out.push(...this.viewLines(it.artifact, w));
        if (it.thread) out.push(`    ${color.dim(truncate(`↪ a thread with ${clean(it.agent ?? 'another agent')}: Ctrl+↑, then Enter, opens it`, w - 4))}`);
        const art = !it.thread && it.artifact && this.artifacts.some((a) => a.id === it.artifact) ? it.artifact : undefined;
        mark({ id: it.id, kind: 'activity', text: it.text, thread: it.thread, artifact: art, step: it.id }, from);
      } else if (it.kind === 'questions') {
        out.push(...questionLines(it.agent, it.questions, it.answered, w));
        mark({ id: it.id, kind: 'questions', text: it.questions.map((q) => q.question).join('\n'), questions: it.answered ? undefined : it.questions, agent: it.agent }, from);
      } else {
        out.push(...indent(wrap(clean(it.text), w).map((l) => (/^Error/.test(it.text) ? color.red(l) : color.yellow(l)))));
      }
    }
    for (const p of this.pending) {
      const thread = root(p);
      quote(p);
      out.push('', `${thread}${color.cyan(color.bold('You'))} ${color.dim(timeText(p.time))}`);
      out.push(...indent(wrap(clean(p.text), w - textWidth(thread)), `${thread}  `));
      for (const a of p.attachments ?? []) out.push(`${thread}  ${color.dim(`📎 ${clean(a.name)} (${bytesText(a.size)})`)}`);
      if (p.id === lastUser) out.push(`${thread}  ${color.dim('Delivered')}`);
    }
    if (this.live) {
      const segs = this.live.segments;
      segs.forEach((seg, i) => {
        const from = out.length;
        if (seg.questions?.length) {
          out.push(...questionLines(this.agent?.id ?? 'The agent', seg.questions, !!seg.answered, w));
          mark({ id: `live:${seg.id}`, kind: 'questions', text: seg.questions.map((q) => q.question).join('\n'), questions: seg.answered ? undefined : seg.questions, agent: this.agent?.id }, from);
        }
        if (seg.kind === 'user' && seg.item) {
          const it = seg.item;
          const thread = root(it);
          quote(it);
          const at = out.length;
          out.push('', `${thread}${color.cyan(color.bold('You'))} ${color.dim(timeText(it.time))}${badge(it.id)}`);
          out.push(...indent(wrap(clean(it.text), w - textWidth(thread)), `${thread}  `));
          for (const a of it.attachments ?? []) out.push(`${thread}  ${color.dim(`📎 ${clean(a.name)} (${bytesText(a.size)})`)}`);
          if (it.id === lastUser) out.push(`${thread}  ${color.dim(this.read?.id === it.id ? `Read ${timeText(this.read.time)}` : 'Delivered')}`);
          mark({ id: it.id, kind: 'user', text: it.text, replies: replies.get(it.id) }, at);
        } else if (seg.kind === 'text') {
          // Finished text only (the reply arrives whole), as on the pages.
          if (i < segs.length - 1 && !seg.plain && !seg.hidden && seg.text.trim()) {
            // An inline reply hangs off its thread's line, as stored replies do.
            const bar = seg.replyTo ? color.dim('│ ') : '';
            out.push('', `${bar}${color.magenta(color.bold(this.agent?.id ?? 'agent'))}`, ...indent(wrap(clean(seg.text), w - textWidth(bar)), `${bar}  `));
          }
        } else if (!seg.hidden) {
          const at = out.length;
          out.push(this.activityLine(seg, w));
          if (seg.status !== 'error' && seg.status !== 'denied') out.push(...this.viewLines(seg.artifact, w));
          if (seg.thread) out.push(`    ${color.dim('↪ a thread between agents: Ctrl+↑, then Enter, opens it')}`);
          const art = !seg.thread && seg.artifact && this.artifacts.some((a) => a.id === seg.artifact) ? seg.artifact : undefined;
          mark({ id: `live:${seg.id}`, kind: 'activity', text: seg.text, thread: seg.thread, artifact: art, step: seg.id }, at);
        }
      });
      if (!this.approvals.length) out.push('', color.dim(`  ${this.agent?.id ?? 'The agent'} is working…`));
    }
    if (this.fullControl) {
      const seconds = Math.max(0, Math.ceil((this.fullControl.expires - Date.now()) / 1000));
      out.push(color.yellow(`  FULL CONTROL · ${this.fullControl.agent} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left · /full-control stop`));
    }
    for (const a of this.approvals) {
      const decision = this.answered.get(a.id);
      out.push('', color.yellow(color.bold(`  ? ${clean(a.agent)} wants to use ${clean(a.tool)}`)));
      out.push(...indent(wrap(clean(a.title), w - 2), '    '));
      if (a.detail) out.push(...indent(wrap(clean(a.detail), w - 2).slice(0, 12), '    ').map(color.dim));
      out.push(
        decision
          ? `    ${decision === 'deny' ? color.red('Denied') : color.green(decision === 'allow_always' ? 'Allowed always' : 'Allowed once')}`
          : ['full_control', 'host_action'].includes(a.tool) ? `    ${color.bold('[y]')} Allow once   ${color.bold('[n]')} Deny` : `    ${color.bold('[y]')} Allow once   ${color.bold('[a]')} Always allow   ${color.bold('[n]')} Deny`,
      );
    }
    if (this.infoLines.length) out.push('', ...this.infoLines.flatMap((l) => indent(wrap(l, w))).map(color.dim));
    for (const n of this.notices) out.push('', ...indent(wrap(clean(n.text), w)).map(n.level === 'error' ? color.red : color.yellow));
    if (!this.items.length && !this.live) out.push('', color.dim(`  No messages yet. Type below, or open ${this.options.url}`));
    out.push('');
    // The picked message: a bar down its left side.
    this.picks = picks;
    const picked = picks.find((p) => p.id === this.picked);
    if (this.picked && !picked) this.picked = null;
    if (picked) for (let i = picked.start; i <= picked.end; i++) out[i] = `${color.cyan('▌')}${out[i]!.startsWith(' ') ? out[i]!.slice(1) : out[i]}`;
    return out;
  }

  private setViews(list: unknown): void {
    if (!Array.isArray(list)) return;
    this.artifacts = list as ArtifactInfo[];
    this.views = new Map(list.filter((a) => a?.type === 'genui').map((a) => [String(a.id), String(a.title)]));
  }

  /** A GenUI view the agent showed, drawn as text (Ctrl+↑, then Enter, uses it). */
  private viewLines(id: string | undefined, w: number): string[] {
    const title = id ? this.views.get(id) : undefined;
    if (!id || title === undefined) return [];
    const a = this.artifacts.find((x) => x.id === id);
    let v = this.viewDocs.get(id);
    if (a && (!v || v.rev !== a.rev)) {
      // Read (again) once; the chat draws it when it arrives.
      const next: ViewCache = { rev: a.rev, model: v?.model };
      this.viewDocs.set(id, next);
      v = next;
      this.api<{ doc?: ViewDoc; errors?: string[] }>('GET', `artifacts/${encodeURIComponent(id)}/view`).then(
        (r) => {
          next.model = r.doc ? new ViewModel(r.doc) : undefined;
          next.errors = r.doc ? undefined : (r.errors ?? ['The view could not be read.']);
          this.schedule();
        },
        () => undefined,
      );
    }
    const out = [`    ${color.cyan('▦')} ${color.bold(truncate(clean(v?.model?.doc.title || title), w - 8))}`];
    const bar = color.dim('│');
    if (v?.errors) out.push(`    ${bar} ${color.red(truncate('This view has a mistake the agent has to fix.', w - 8))}`);
    else if (v?.model) {
      const lines = drawView(v.model, w - 8).flatMap((l) => l.lines);
      const MAX = 40;
      out.push(...lines.slice(0, MAX).map((l) => `    ${bar} ${l}`));
      if (lines.length > MAX) out.push(`    ${bar} ${color.dim(`… ${lines.length - MAX} more lines`)}`);
    } else out.push(`    ${bar} ${color.dim('Reading…')}`);
    out.push(`    ${color.dim(truncate('Ctrl+↑, then Enter, uses it', w - 4))}`);
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
    for (const [label, value] of usageLines(this.usage)) row(label, value);
    if (this.context) row('Context', `${bar(this.context.budget ? this.context.used / this.context.budget : null)} ${tokens(this.context.used)} of ${tokens(this.context.budget)} tokens ${color.dim('(/context breaks it down)')}`);
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
