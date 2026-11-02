/**
 * The terminal interface's panes: what a page shows in its sheets and side
 * windows (agent threads, topics, search, artifacts, uncommitted changes,
 * usage and context, settings, the files), as lists to move through with
 * the arrow keys. Each pane reads and changes things through the same API
 * calls the pages make (WebServer.request, in-process).
 */

import { bar, bytesText, clean, color, percentText, stampText, timeText } from './ansi.js';
import { textWidth, truncate, wrap } from './width.js';
import { controlOptions, drawView, lookup, ViewModel, type ViewControl, type ViewDoc, type ViewEffects } from './genui-text.js';

/** One entry of a pane: a heading, some text, or something to pick. */
export interface Row {
  /** Already styled; the first line carries the selection mark. */
  lines: string[];
  /** Can be selected. */
  pick?: boolean;
  value?: unknown;
}

export interface Pane {
  title: string;
  /** The keys this pane takes, shown under it. */
  hint: string;
  rows(width: number): Row[];
  /** Enter on a row. */
  enter?(row: Row): void;
  /** Any other key (a printable character); true when the pane used it. */
  key?(ch: string, row: Row | undefined): boolean;
  /** A server event, for panes that follow something live. */
  event?(name: string, data: Record<string, unknown>): void;
  /** Index of the selected row. */
  selected: number;
  /** Top line, for panes with nothing to pick (text). */
  scroll: number;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
}

export interface ChatItem {
  kind: string;
  id: string;
  seq?: number;
  time: string;
  text?: string;
  agent?: string;
  status?: string;
  thread?: string;
  artifact?: string;
  replyTo?: string;
  attachments?: Attachment[];
  questions?: Question[];
  answered?: boolean;
}

export interface Question {
  question: string;
  options: string[];
  multiple?: boolean;
}

export interface ArtifactInfo {
  id: string;
  title: string;
  type: string;
  filename: string;
  mime?: string;
  rev: number;
  pinned: boolean;
  saved?: boolean;
  updated: string;
  url(): string;
  file?: string;
  missing?: boolean;
  target?: string;
}

export interface RepoInfo {
  id: string;
  name: string;
  path: string;
  branch: string;
  files: number;
  added: number;
  removed: number;
}

export interface SectionInfo {
  id: string;
  title: string;
  depth: number;
  first: { id: string; seq: number };
  messages: number;
  current: boolean;
}

/** What the panes need from the terminal interface. */
export interface PaneHost {
  /** A JSON API call; throws with the server's message when it fails. */
  api<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
  /** An API call's raw body (artifact files). */
  raw(path: string): Promise<{ body: Buffer; type: string }>;
  open(pane: Pane): void;
  /** Closes this pane (back to the one under it, or to the chat). */
  back(): void;
  /** Closes every pane. */
  closeAll(): void;
  redraw(): void;
  notice(text: string, level?: string): void;
  fail(error: unknown): void;
  /** Asks for a line of text in the composer. */
  ask(label: string, initial: string, done: (text: string) => void): void;
  /** Asks yes or no. */
  confirm(question: string, yes: () => void): void;
  attach(a: Attachment): void;
  /** Copies text to the clipboard (the terminal's escape). */
  copy(text: string): void;
  /** Shows a message in the chat (loading earlier messages if needed). */
  jump(id: string, seq: number): void;
  send(text: string): void;
  /** The web interface's address (for things only a page can show). */
  url(): string;
  artifacts(): ArtifactInfo[];
  diffs(): RepoInfo[];
  sections(): SectionInfo[];
}

const pane = (p: Partial<Pane> & Pick<Pane, 'title' | 'rows'>): Pane => ({ hint: '', selected: 0, scroll: 0, ...p });
const heading = (text: string): Row => ({ lines: ['', `  ${color.cyan(color.bold(text))}`] });
const note = (text: string, w: number): Row => ({ lines: wrap(text, Math.max(10, w - 4)).map((l) => `  ${color.dim(l)}`) });
const blank: Row = { lines: [''] };

/** A pane that loads its data, shows "Reading…" until then, and reloads on request. */
function loading<T>(host: PaneHost, spec: Partial<Pane> & { title: string; load: () => Promise<T>; view: (data: T, w: number) => Row[] }): Pane & { data?: T; reload(): void } {
  let error: string | undefined;
  const p = pane({
    ...spec,
    rows: (w) => (p.data !== undefined ? spec.view(p.data, w) : error ? [note(`Couldn’t read it: ${error}`, w)] : [note('Reading…', w)]),
  }) as Pane & { data?: T; reload(): void };
  p.reload = () => {
    spec.load().then(
      (data) => {
        p.data = data;
        error = undefined;
        host.redraw();
      },
      (e: unknown) => {
        error = e instanceof Error ? e.message : String(e);
        host.redraw();
      },
    );
  };
  p.reload();
  return p;
}

/** Text to read: arrows scroll it. */
export function textPane(title: string, lines: string[], hint = 'Esc goes back'): Pane {
  return pane({ title, hint, rows: () => lines.map((l) => ({ lines: [l] })) });
}

/** Wrapped plain text, as a pane. */
export function plainPane(title: string, text: string, hint?: string): Pane {
  return pane({ title, hint: hint ?? 'Esc goes back', rows: (w) => wrap(clean(text), Math.max(10, w - 4)).map((l) => ({ lines: [`  ${l}`] })) });
}

// ------------------------------------------------------------------ messages

/** Messages as the chat shows them, read-only (threads between agents, reply threads). */
export function itemLines(items: readonly ChatItem[], w: number, you = 'You'): string[] {
  const out: string[] = [];
  const width = Math.max(10, w - 4);
  for (const it of items) {
    if (it.kind === 'user') {
      out.push('', `${color.cyan(color.bold(clean(it.agent ?? you)))} ${color.dim(timeText(it.time))}`);
      out.push(...wrap(clean(it.text ?? ''), width).map((l) => `  ${l}`));
      for (const a of it.attachments ?? []) out.push(`  ${color.dim(`📎 ${clean(a.name)} (${bytesText(a.size)})`)}`);
    } else if (it.kind === 'assistant') {
      out.push('', `${color.magenta(color.bold(clean(it.agent ?? 'agent')))} ${color.dim(timeText(it.time))}`);
      out.push(...wrap(clean(it.text ?? ''), width).map((l) => `  ${l}`));
    } else if (it.kind === 'activity') {
      out.push(activityText(it, width));
    } else if (it.kind === 'questions') {
      out.push(...questionLines(it.agent ?? 'agent', it.questions ?? [], !!it.answered, width));
    } else if (it.text) {
      out.push(...wrap(clean(it.text), width).map((l) => `  ${color.yellow(l)}`));
    }
  }
  return out;
}

export function activityText(seg: { text?: string; status?: string }, w: number): string {
  const mark = seg.status === 'ok' ? color.green('✓') : seg.status === 'error' ? color.red('✗') : seg.status === 'denied' ? color.red('⊘') : seg.status === 'running' ? color.yellow('…') : color.dim('·');
  return `  ${mark} ${color.dim(truncate(clean(seg.text ?? '').replace(/\s+/g, ' '), w - 4))}`;
}

/** An agent's questions, with numbered options. */
export function questionLines(agent: string, questions: readonly Question[], answered: boolean, w: number): string[] {
  const out = ['', color.yellow(color.bold(`  ? ${clean(agent)} asks`))];
  const width = Math.max(10, w - 6);
  questions.forEach((q, i) => {
    const num = questions.length > 1 ? `${i + 1}. ` : '';
    out.push(...wrap(`${num}${clean(q.question)}${q.multiple ? ' (pick any)' : ''}`, width).map((l) => `    ${color.bold(l)}`));
    q.options.forEach((o, j) => out.push(...wrap(`${j + 1}) ${clean(o)}`, width - 2).map((l, k) => `      ${k ? '   ' : ''}${answered ? color.dim(l) : l}`)));
  });
  out.push(
    answered
      ? `    ${color.dim('Answered')}`
      : `    ${color.dim(questions.length === 1 && questions[0]!.options.length ? `Send a number (${questions[0]!.multiple ? 'or several, like 1,3' : `1–${questions[0]!.options.length}`}) or your own answer · Ctrl+↑ then Enter to pick` : 'Ctrl+↑ then Enter to answer, or write your answer')}`,
  );
  return out;
}

/** The web interface's answer to questions (app.js): picks joined, one block per question. */
export function answerText(questions: readonly Question[], picks: ReadonlyArray<{ picked: Set<number>; other: string }>): string {
  return questions
    .map((q, i) => {
      const d = picks[i];
      const chosen = d ? [...[...d.picked].sort((a, b) => a - b).map((n) => q.options[n]!), ...(d.other.trim() ? [d.other.trim()] : [])] : [];
      const answer = chosen.join(', ') || '(no answer)';
      return questions.length === 1 ? answer : `${q.question}\n${answer}`;
    })
    .join('\n\n');
}

/**
 * A message of numbers answering questions: "2", "1,3" for one question, or
 * one number per question ("2 1") when each takes a single pick. Undefined
 * when the text is not that.
 */
export function numberedAnswer(questions: readonly Question[], text: string): string | undefined {
  if (!/^\s*\d+(\s*[,\s]\s*\d+)*\s*$/.test(text) || !questions.length) return undefined;
  const nums = text.trim().split(/[\s,]+/).map(Number);
  if (questions.length === 1) {
    const q = questions[0]!;
    if (!q.options.length || nums.some((n) => n < 1 || n > q.options.length) || (!q.multiple && nums.length > 1)) return undefined;
    return answerText(questions, [{ picked: new Set(nums.map((n) => n - 1)), other: '' }]);
  }
  if (nums.length !== questions.length || questions.some((q, i) => q.multiple || nums[i]! < 1 || nums[i]! > q.options.length)) return undefined;
  return answerText(
    questions,
    nums.map((n) => ({ picked: new Set([n - 1]), other: '' })),
  );
}

/** Answering questions option by option. */
export function questionsPane(host: PaneHost, agent: string, questions: readonly Question[]): Pane {
  const picks = questions.map(() => ({ picked: new Set<number>(), other: '' }));
  const toggle = (row: Row) => {
    const v = row.value as { q: number; o: number } | undefined;
    if (!v) return;
    const d = picks[v.q]!;
    if (v.o < 0) {
      host.ask(`Your answer to “${truncate(questions[v.q]!.question, 40)}”:`, d.other, (text) => {
        d.other = text;
        host.redraw();
      });
      return;
    }
    if (d.picked.has(v.o)) d.picked.delete(v.o);
    else {
      if (!questions[v.q]!.multiple) d.picked.clear();
      d.picked.add(v.o);
    }
    host.redraw();
  };
  const send = () => {
    host.send(answerText(questions, picks));
    host.back();
  };
  return pane({
    title: `${agent} asks`,
    hint: '↑↓ move · Enter or Space picks · s sends the answers · Esc goes back',
    rows: (w) => {
      const rows: Row[] = [];
      questions.forEach((q, i) => {
        rows.push({ lines: ['', ...wrap(`${questions.length > 1 ? `${i + 1}. ` : ''}${clean(q.question)}${q.multiple ? ' (pick any)' : ''}`, w - 4).map((l) => `  ${color.bold(l)}`)] });
        q.options.forEach((o, j) => {
          const on = picks[i]!.picked.has(j);
          const box = q.multiple ? (on ? '[x]' : '[ ]') : on ? '(•)' : '( )';
          rows.push({ pick: true, value: { q: i, o: j }, lines: [`  ${on ? color.green(box) : color.dim(box)} ${truncate(clean(o), w - 10)}`] });
        });
        const other = picks[i]!.other;
        rows.push({ pick: true, value: { q: i, o: -1 }, lines: [`  ${color.dim('  ✎')} ${other ? clean(other) : color.dim(q.options.length ? 'Something else…' : 'Your answer…')}`] });
      });
      rows.push(blank, { pick: true, value: 'send', lines: [`  ${color.bold(color.cyan('Send the answers'))}`] });
      return rows;
    },
    enter: (row) => (row.value === 'send' ? send() : toggle(row)),
    key: (ch, row) => {
      if (ch === ' ' && row) {
        if (row.value === 'send') send();
        else toggle(row);
        return true;
      }
      if (ch === 's') {
        send();
        return true;
      }
      return false;
    },
  });
}

// ------------------------------------------------------------------ threads

interface ThreadInfo {
  key: string;
  agents: [string, string];
  messages: number;
  updated?: string;
  busy: boolean;
}

/** The threads between agents. */
export function threadsPane(host: PaneHost): Pane {
  const p = loading(host, {
    title: 'Threads between agents',
    hint: '↑↓ move · Enter opens · Esc goes back',
    load: () => host.api<{ threads: ThreadInfo[] }>('GET', 'threads').then((r) => r.threads),
    view: (threads, w) =>
      threads.length
        ? [...threads]
            .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
            .map((t) => ({
              pick: true,
              value: t,
              lines: [
                `  ${color.bold(`${clean(t.agents[0])} ↔ ${clean(t.agents[1])}`)}${t.busy ? color.yellow(' ● working') : ''} ${color.dim(truncate(`· ${t.messages} message${t.messages === 1 ? '' : 's'}${t.updated ? ` · ${stampText(t.updated)}` : ''}`, Math.max(10, w - 30)))}`,
              ],
            }))
        : [note('The agents haven’t written to each other yet.', w)],
    enter: (row) => host.open(threadPane(host, (row.value as ThreadInfo).key)),
    event: (name) => {
      if (name === 'threads') p.reload();
    },
  });
  return p;
}

/** One thread between agents, as its messages. */
export function threadPane(host: PaneHost, key: string): Pane {
  const p = loading(host, {
    title: 'Thread',
    hint: '↑↓ PgUp PgDn scroll · Esc goes back',
    load: async () => {
      const r = await host.api<{ thread?: ThreadInfo; items: ChatItem[] }>('GET', `threads/${encodeURIComponent(key)}`);
      if (r.thread) p.title = `${r.thread.agents[0]} ↔ ${r.thread.agents[1]}`;
      return r.items;
    },
    view: (items, w) => {
      const lines = itemLines(items, w);
      return (lines.length ? lines : ['', color.dim('  No messages yet.')]).map((l) => ({ lines: [l] }));
    },
    event: (name) => {
      if (name === 'threads') p.reload();
    },
  });
  // Opens at the end (the latest messages).
  p.scroll = Number.MAX_SAFE_INTEGER;
  return p;
}

// ------------------------------------------------------------------ topics and search

/** The conversation's topics (sections): Enter jumps to where one starts. */
export function topicsPane(host: PaneHost): Pane {
  return pane({
    title: 'Topics',
    hint: '↑↓ move · Enter jumps there · Esc goes back',
    rows: (w) => {
      const list = host.sections();
      if (!list.length) return [note('No topics yet: the agent names them as the conversation goes.', w)];
      return list.map((s) => ({
        pick: true,
        value: s,
        lines: [`  ${'  '.repeat(s.depth)}${s.current ? color.cyan('● ') : ''}${color.bold(truncate(clean(s.title), w - 20 - s.depth * 2))} ${color.dim(`${s.messages}`)}`],
      }));
    },
    enter: (row) => {
      const s = row.value as SectionInfo;
      host.jump(s.first.id, s.first.seq);
    },
    event: () => undefined,
  });
}

interface SearchResult {
  query: string;
  messages: Array<{ id: string; seq: number; role: string; agent?: string; time: string; excerpt: string; section: string | null }>;
  artifacts: Array<{ id: string; title: string; type: string; excerpt: string }>;
}

/** Messages and artifacts matching words. */
export function searchPane(host: PaneHost, query: string): Pane {
  return loading(host, {
    title: `Search: ${query}`,
    hint: '↑↓ move · Enter shows it · / searches again · Esc goes back',
    load: () => host.api<SearchResult>('GET', `search?q=${encodeURIComponent(query)}`),
    view: (r, w) => {
      const rows: Row[] = [];
      if (!r.messages.length && !r.artifacts.length) return [note(`Nothing matches “${query}”.`, w)];
      if (r.messages.length) rows.push(heading(`Messages (${r.messages.length})`));
      for (const m of r.messages) {
        const who = m.role === 'user' ? color.cyan('You') : color.magenta(clean(m.agent ?? 'agent'));
        rows.push({
          pick: true,
          value: { message: m },
          lines: [`  ${who} ${color.dim(`${stampText(m.time)}${m.section ? ` · ${clean(m.section)}` : ''}`)}`, ...wrap(clean(m.excerpt).replace(/\s+/g, ' '), w - 6).slice(0, 3).map((l) => `    ${l}`)],
        });
      }
      if (r.artifacts.length) rows.push(heading(`Artifacts (${r.artifacts.length})`));
      for (const a of r.artifacts) {
        rows.push({ pick: true, value: { artifact: a.id }, lines: [`  ${color.bold(truncate(clean(a.title), w - 20))} ${color.dim(a.type)}`, ...(a.excerpt ? [`    ${color.dim(truncate(clean(a.excerpt), w - 6))}`] : [])] });
      }
      return rows;
    },
    enter: (row) => {
      const v = row.value as { message?: { id: string; seq: number }; artifact?: string };
      if (v.message) host.jump(v.message.id, v.message.seq);
      else if (v.artifact) {
        const a = host.artifacts().find((x) => x.id === v.artifact);
        if (a) host.open(artifactPane(host, a));
      }
    },
    key: (ch) => {
      if (ch !== '/') return false;
      host.ask('Search for:', query, (q) => {
        if (!q.trim()) return;
        host.back();
        host.open(searchPane(host, q.trim()));
      });
      return true;
    },
  });
}

// ------------------------------------------------------------------ artifacts

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql))|\+xml$|\+json$/;

/** The conversation's artifacts: open, pin, save views. */
export function artifactsPane(host: PaneHost): Pane {
  return pane({
    title: 'Artifacts',
    hint: '↑↓ move · Enter opens · p pins or unpins · s saves or unsaves a view · Esc goes back',
    rows: (w) => {
      // As the page lists them: pinned first, then the rest, newest first; views the person did not save stay in the chat.
      const all = host.artifacts().filter((a) => a.type !== 'genui' || a.saved);
      const pinned = all.filter((a) => a.pinned);
      const rest = all.filter((a) => !a.pinned);
      const views = host.artifacts().filter((a) => a.type === 'genui' && !a.saved);
      if (!all.length && !views.length) return [note('No artifacts yet.', w)];
      const row = (a: ArtifactInfo): Row => ({
        pick: true,
        value: a,
        lines: [
          `  ${a.pinned ? color.yellow('📌') : '  '} ${a.missing ? color.dim(color.red(truncate(clean(a.title), w - 30))) : color.bold(truncate(clean(a.title), w - 30))} ${color.dim(`${a.type}${a.type === 'genui' ? ' view' : ''} · ${stampText(a.updated)}${a.missing ? ' · file missing' : ''}`)}`,
        ],
      });
      const rows: Row[] = [];
      if (pinned.length) rows.push(heading('Pinned'), ...pinned.map(row));
      if (rest.length) rows.push(heading(pinned.length ? 'Others' : 'All'), ...rest.map(row));
      if (views.length) rows.push(heading('Views in the chat (s saves one here)'), ...views.map(row));
      return rows;
    },
    enter: (row) => host.open(artifactPane(host, row.value as ArtifactInfo)),
    key: (ch, row) => {
      const a = row?.value as ArtifactInfo | undefined;
      if (!a) return false;
      if (ch === 'p') {
        host.api('POST', `artifacts/${encodeURIComponent(a.id)}/pin`, { pinned: !a.pinned }).then(() => host.notice(a.pinned ? `Unpinned “${a.title}”.` : `Pinned “${a.title}”.`), host.fail);
        return true;
      }
      if (ch === 's') {
        if (a.type !== 'genui') host.notice('Only views are saved; every other artifact is kept already.');
        else host.api('POST', `artifacts/${encodeURIComponent(a.id)}/save`, { saved: !a.saved }).then(() => host.notice(a.saved ? `“${a.title}” is no longer saved.` : `Saved “${a.title}” to the artifacts.`), host.fail);
        return true;
      }
      return false;
    },
  });
}

/** One artifact: its text, or what it is and where. */
export function artifactPane(host: PaneHost, a: ArtifactInfo): Pane {
  // A view opens to be used.
  if (a.type === 'genui' && !a.missing) return genuiPane(host, a);
  const info = (w: number): Row[] =>
    [
      `${color.dim('Type')}     ${a.type}${a.mime ? color.dim(` (${a.mime})`) : ''}`,
      `${color.dim('Updated')}  ${stampText(a.updated)} ${color.dim(`· revision ${a.rev}`)}`,
      ...(a.file ? [`${color.dim('File')}     ${clean(a.file)}`] : []),
      ...(a.target ? [`${color.dim('App')}      ${clean(a.target)}`] : []),
      `${color.dim('Web')}      ${host.url().replace(/\/$/, '')}${a.url}`,
    ].map((l) => ({ lines: [`  ${truncate(l, w - 4)}`] }));
  return loading(host, {
    title: a.title,
    hint: '↑↓ PgUp PgDn scroll · p pins or unpins · Esc goes back',
    load: async (): Promise<string[] | null> => {
      if (a.missing) return null;
      if (a.type === 'app' || a.type === 'image') return null;
      if (a.mime && !TEXT_MIME.test(a.mime) && !/markdown|html|svg/.test(a.mime)) return null;
      const r = await host.raw(`artifacts/${encodeURIComponent(a.id)}/raw`);
      if (!TEXT_MIME.test(r.type.split(';')[0]!.trim()) && r.body.subarray(0, 8192).includes(0)) return null;
      return r.body.toString('utf8').split(/\r?\n/);
    },
    view: (text, w) => [
      ...info(w),
      blank,
      ...(text === null
        ? [note(a.missing ? 'The file was moved or deleted.' : 'This kind of artifact shows in the web interface.', w)]
        : text.flatMap((l) => wrap(clean(l), Math.max(10, w - 4)).map((x) => ({ lines: [`  ${x}`] })))),
    ],
    key: (ch) => {
      if (ch !== 'p') return false;
      const now = host.artifacts().find((x) => x.id === a.id) ?? a;
      host.api('POST', `artifacts/${encodeURIComponent(a.id)}/pin`, { pinned: !now.pinned }).then(() => host.notice(now.pinned ? 'Unpinned.' : 'Pinned.'), host.fail);
      return true;
    },
  });
}

// ------------------------------------------------------------------ uncommitted changes

interface DiffFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  patch: string;
  binary?: boolean;
}

const counts = (added: number, removed: number) => `${color.green(`+${added}`)} ${color.red(`−${removed}`)}`;

/** Repositories with uncommitted changes. */
export function diffsPane(host: PaneHost): Pane {
  return pane({
    title: 'Uncommitted changes',
    hint: '↑↓ move · Enter shows the files · Esc goes back',
    rows: (w) => {
      const repos = host.diffs();
      if (!repos.length) return [note('No repository in the agents’ folders has uncommitted changes.', w)];
      return repos.map((r) => ({
        pick: true,
        value: r,
        lines: [`  ${color.bold(clean(r.name))} ${color.dim(clean(r.branch))}  ${r.files} file${r.files === 1 ? '' : 's'}  ${counts(r.added, r.removed)}`, `    ${color.dim(truncate(clean(r.path), w - 6))}`],
      }));
    },
    enter: (row) => host.open(repoPane(host, row.value as RepoInfo)),
  });
}

function repoPane(host: PaneHost, repo: RepoInfo): Pane {
  const p = loading(host, {
    title: `${repo.name} (${repo.branch})`,
    hint: '↑↓ move · Enter shows the changes · Esc goes back',
    load: () => host.api<{ files: DiffFile[]; truncated: boolean }>('GET', `diffs/${encodeURIComponent(repo.id)}`),
    view: (r, w) => {
      if (!r.files.length) return [note('No changes now.', w)];
      const mark: Record<string, string> = { modified: color.yellow('M'), added: color.green('A'), deleted: color.red('D'), renamed: color.cyan('R'), untracked: color.green('?') };
      const rows: Row[] = r.files.map((f) => ({ pick: true, value: f, lines: [`  ${mark[f.status] ?? ' '} ${truncate(clean(f.path), w - 24)}  ${f.binary ? color.dim('binary') : counts(f.added, f.removed)}`] }));
      if (r.truncated) rows.push(note('Some files are left out: the changes are too large to show all.', w));
      return rows;
    },
    enter: (row) => {
      const f = row.value as DiffFile;
      host.open(textPane(f.path, f.binary || !f.patch ? ['', color.dim('  A binary file: no changes to show.')] : patchLines(f.patch)));
    },
    event: (name) => {
      if (name === 'diffs') p.reload();
    },
  });
  return p;
}

export function patchLines(patch: string): string[] {
  return patch.split('\n').map((l) => {
    const t = clean(l);
    if (/^(\+\+\+|---|diff |index )/.test(l)) return color.bold(color.dim(t));
    if (l.startsWith('@@')) return color.cyan(t);
    if (l.startsWith('+')) return color.green(t);
    if (l.startsWith('-')) return color.red(t);
    return t;
  });
}

// ------------------------------------------------------------------ usage and context

interface ContextInfo {
  budget: number;
  reserve: number;
  used: number;
  free: number;
  categories: Array<{ id: string; label: string; tokens: number; items?: Array<{ name: string; tokens: number; detail?: string }> }>;
  exchanges: { included: number; omitted: number; recentLimit: number; sinceReset: number };
  sections: { shown: number; total: number };
  problem?: string;
  model?: string;
  account?: string;
  modelWindow?: number | null;
  lastRequest?: { usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number }; at: number };
}

interface UsageWindow {
  usedPercent: number;
  resetsAt?: number;
}

export interface UsageInfo {
  account: string;
  kind: string | null;
  supported: boolean;
  usage: { fiveHour?: UsageWindow; weekly?: UsageWindow; plan?: string; limitReached?: boolean; updated: number } | null;
  error?: string;
}

export const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

function resetText(at: number | undefined): string {
  if (!at) return '';
  const ms = at - Date.now();
  if (ms <= 0) return 'resets now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `resets in ${h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`}`;
}

/** The plan's usage windows, one line each (empty when the provider reports none). */
export function usageLines(u: UsageInfo | null): Array<[string, string]> {
  if (!u) return [];
  if (!u.supported) return [['Plan usage', color.dim(u.kind ? `${u.kind} accounts don’t report it` : 'no provider')]];
  const out: Array<[string, string]> = [];
  const win = (label: string, w: UsageWindow | undefined) => w && out.push([label, `${bar(w.usedPercent / 100)} ${percentText(w.usedPercent / 100)} ${color.dim(resetText(w.resetsAt))}`]);
  win('5-hour limit', u.usage?.fiveHour);
  win('Weekly limit', u.usage?.weekly);
  if (u.usage?.limitReached) out.push(['Plan', color.red('at its limit now')]);
  if (!out.length) out.push(['Plan usage', color.dim(u.error ? `couldn’t read it: ${u.error}` : 'not reported yet (it shows after a reply)')]);
  return out;
}

/** What the next request carries, part by part, and the plan's limits. */
export function contextPane(host: PaneHost): Pane {
  const p = loading(host, {
    title: 'Usage and context',
    hint: '↑↓ PgUp PgDn scroll · r reads again · Esc goes back',
    load: async () => {
      const [context, usage] = await Promise.all([host.api<ContextInfo>('GET', 'agent/context'), host.api<UsageInfo>('GET', 'agent/usage?refresh=1').catch(() => null)]);
      return { context, usage };
    },
    view: ({ context: c, usage }, w) => {
      const out: string[] = [];
      const row = (label: string, value: string) => out.push(`  ${color.bold(label.padEnd(16))}${value}`);
      out.push('', `  ${color.cyan(color.bold('Plan'))}`);
      row('Account', clean(c.account || usage?.account || '—') + (usage?.usage?.plan ? color.dim(` (${usage.usage.plan})`) : ''));
      for (const [label, value] of usageLines(usage)) row(label, value);
      out.push('', `  ${color.cyan(color.bold('Working context'))}`);
      row('Model', `${clean(c.model ?? '—')}${c.modelWindow ? color.dim(` (a ${tokens(c.modelWindow)}-token window)`) : ''}`);
      row('In use', `${bar(c.budget ? c.used / c.budget : null, 20)} ${tokens(c.used)} of ${tokens(c.budget)} ${color.dim(`(${tokens(c.reserve)} kept for the turn)`)}`);
      row('Messages', `${c.exchanges.included} exchange${c.exchanges.included === 1 ? '' : 's'} included${c.exchanges.omitted ? `, ${c.exchanges.omitted} older ones left out (the agent can still look them up)` : ''}`);
      row('Topics', `${c.sections.shown} of ${c.sections.total} in the index`);
      if (c.lastRequest && (c.lastRequest.usage.promptTokens !== undefined || c.lastRequest.usage.completionTokens !== undefined)) {
        const u = c.lastRequest.usage;
        row('Last request', `${u.promptTokens !== undefined ? `${tokens(u.promptTokens)} in` : ''}${u.completionTokens !== undefined ? ` · ${tokens(u.completionTokens)} out` : ''}${u.cost ? ` · $${u.cost.toFixed(4)}` : ''} ${color.dim(timeText(new Date(c.lastRequest.at).toISOString()))}`);
      }
      if (c.problem) out.push('', ...wrap(c.problem, w - 4).map((l) => `  ${color.red(l)}`));
      out.push('', `  ${color.cyan(color.bold('By part'))}`);
      for (const cat of c.categories) {
        out.push(`  ${bar(c.budget ? cat.tokens / c.budget : null, 10)} ${color.bold(tokens(cat.tokens).padStart(6))}  ${clean(cat.label)}`);
        const items = [...(cat.items ?? [])].sort((x, y) => y.tokens - x.tokens);
        for (const it of items.slice(0, 12)) out.push(`  ${' '.repeat(10)} ${color.dim(`${tokens(it.tokens).padStart(6)}  ${truncate(clean(it.name), w - 24)}`)}`);
        if (items.length > 12) out.push(`  ${' '.repeat(18)} ${color.dim(`and ${items.length - 12} more`)}`);
      }
      return out.map((l) => ({ lines: [l] }));
    },
    key: (ch) => {
      if (ch !== 'r') return false;
      p.reload();
      return true;
    },
  });
  return p;
}

// ------------------------------------------------------------------ settings

interface Setting {
  key: string;
  label: string;
  hint: string;
  group: string;
  type: string;
  value: unknown;
  running: unknown;
  restart: boolean;
  min?: number;
  max?: number;
}

interface Provider {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  account: string | null;
}

interface Speech {
  state: string;
  device?: string;
  error?: string;
  progress?: { label?: string; done: number; total: number };
  voice: { state: string; error?: string };
}

const valueText = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === true ? 'on' : v === false ? 'off' : v === '' || v === null || v === undefined ? '—' : String(v));

/** Settings, providers and speech, as on the page's Settings sheet. */
export function settingsPane(host: PaneHost): Pane {
  type Data = { settings: Setting[]; file: string; version?: string; providers: { providers: Provider[]; keyring: { available: boolean; label: string; reason?: string }; suggestions: Record<string, string>; web: { brightData: boolean } }; speech: Speech };
  const load = async (): Promise<Data> => {
    const [s, providers, speech] = await Promise.all([
      host.api<{ settings: Setting[]; file: string; version?: string }>('GET', 'settings'),
      host.api<Data['providers']>('GET', 'providers'),
      host.api<Speech>('GET', 'dictation'),
    ]);
    return { ...s, providers, speech };
  };
  const p = loading(host, {
    title: 'Settings',
    hint: '↑↓ move · Enter changes or opens · Esc goes back',
    load,
    view: (d, w) => {
      const rows: Row[] = [];
      rows.push(heading('Providers'));
      for (const pr of d.providers.providers) {
        rows.push({ pick: true, value: { provider: pr }, lines: [`  ${color.bold(clean(pr.name))} ${color.dim(`${pr.kindLabel}${pr.account ? ` · ${clean(pr.account)}` : ''}`)}`] });
      }
      if (!d.providers.keyring.available) rows.push(note(`The keyring (${d.providers.keyring.label}) isn’t available: ${d.providers.keyring.reason ?? ''}`, w));
      rows.push(
        { pick: true, value: { add: 'openai' }, lines: [`  ${color.cyan('+')} Sign in with ChatGPT`] },
        { pick: true, value: { add: 'anthropic' }, lines: [`  ${color.cyan('+')} Sign in with Claude`] },
        { pick: true, value: { add: 'openrouter' }, lines: [`  ${color.cyan('+')} Add an OpenRouter key`] },
        { pick: true, value: { add: 'custom' }, lines: [`  ${color.cyan('+')} Add an OpenAI-compatible endpoint`] },
        { pick: true, value: { web: true }, lines: [`  ${color.bold('Bright Data key')} ${color.dim(d.providers.web.brightData ? 'set (for sfa-web)' : 'not set (sfa-web needs it)')}`] },
      );
      rows.push(heading('Speech'));
      const s = d.speech;
      const pct = s.progress ? ` ${Math.round((100 * s.progress.done) / Math.max(1, s.progress.total))}%` : '';
      rows.push({ pick: true, value: { speech: 'stt' }, lines: [`  ${color.bold('Speech to text'.padEnd(22))}${s.state === 'running' ? color.green(`running${s.device ? ` on ${s.device}` : ''}`) : s.state === 'error' ? color.red(`error: ${s.error ?? ''}`) : `${s.state}${pct}`} ${color.dim(s.state === 'running' ? '(Enter stops it)' : s.state === 'missing' ? '(Enter installs it)' : s.state === 'ready' || s.state === 'error' ? '(Enter starts it)' : '')}`] });
      rows.push({ pick: true, value: { speech: 'tts' }, lines: [`  ${color.bold('Text to speech voice'.padEnd(22))}${s.voice.state === 'error' ? color.red(`error: ${s.voice.error ?? ''}`) : s.voice.state} ${color.dim(s.voice.state === 'missing' ? '(Enter installs it)' : '')}`] });
      let group = '';
      for (const st of d.settings) {
        if (st.group !== group) rows.push(heading((group = st.group)));
        const pending = st.restart && JSON.stringify(st.running) !== JSON.stringify(st.value);
        rows.push({
          pick: true,
          value: { setting: st },
          lines: [`  ${color.bold(st.label.padEnd(22))}${truncate(clean(valueText(st.value)), Math.max(8, w - 40))}${pending ? color.yellow(' (after a restart)') : ''}`, ...wrap(st.hint, w - 8).map((l) => `    ${color.dim(l)}`)],
        });
      }
      rows.push(note(`Saved in ${d.file}${d.version ? ` · SF Agents ${d.version}` : ''}`, w));
      return rows;
    },
    enter: (row) => {
      const v = row.value as { provider?: Provider; add?: string; web?: boolean; speech?: string; setting?: Setting };
      if (v.setting) return editSetting(v.setting);
      if (v.provider) return host.open(providerPane(host, v.provider, () => p.reload()));
      if (v.add) return addProvider(v.add);
      if (v.web) {
        host.ask('Bright Data API key (empty removes it):', '', (key) => {
          host.api('POST', 'providers/web', key.trim() ? { apiKey: key.trim() } : { action: 'remove' }).then(() => {
            host.notice(key.trim() ? 'Saved the Bright Data key.' : 'Removed the Bright Data key.');
            p.reload();
          }, host.fail);
        });
        return;
      }
      if (v.speech && p.data) {
        const s = p.data.speech;
        const action = v.speech === 'tts' ? (s.voice.state === 'missing' ? 'install-voice' : null) : s.state === 'running' ? 'stop' : s.state === 'missing' ? 'install' : 'start';
        if (!action) return host.notice('The voice is installed. Speak a reply with Ctrl+↑, then s.');
        host.api('POST', 'dictation', { action }).then(() => {
          host.notice(action === 'stop' ? 'Speech to text stopped.' : action === 'start' ? 'Starting speech to text…' : 'Installing… (the Status tab shows the progress)');
          p.reload();
        }, host.fail);
      }
    },
    event: (name) => {
      if (name === 'settings' || name === 'providers' || name === 'dictation') p.reload();
      if (name === 'signin') p.reload();
    },
  });
  const save = (key: string, value: unknown) =>
    host.api('POST', 'settings', { values: { [key]: value } }).then(() => {
      host.notice('Saved.');
      p.reload();
    }, host.fail);
  const editSetting = (st: Setting) => {
    if (st.type === 'boolean') return void save(st.key, st.value !== true);
    const current = Array.isArray(st.value) ? st.value.join(', ') : st.value === null || st.value === undefined ? '' : String(st.value);
    const shown = st.type === 'folders' && Array.isArray(st.value) ? st.value.join('; ') : current;
    host.ask(`${st.label}${st.type === 'origins' ? ' (separate with commas)' : st.type === 'folders' ? ' (separate with semicolons)' : ''}:`, shown, (text) => {
      const t = text.trim();
      const value = st.type === 'origins' ? (t ? t.split(/[\s,]+/).filter(Boolean) : []) : st.type === 'folders' ? (t ? t.split(';').map((f) => f.trim()).filter(Boolean) : []) : st.type === 'number' || st.type === 'port' ? Number(t) : t;
      void save(st.key, value);
    });
  };
  const addProvider = (kind: string) => {
    const suggested = p.data?.providers.suggestions[kind] ?? '';
    host.ask('Name for this provider:', suggested, (name) => {
      if (kind === 'openai' || kind === 'anthropic') {
        host.api<{ opened: boolean }>('POST', 'providers/signin', { kind, name: name.trim() }).then(
          (r) => host.notice(r.opened ? 'Finish signing in in the browser on this computer.' : `Couldn’t open a browser on this computer. Sign in from the web interface: ${host.url()}`),
          host.fail,
        );
        return;
      }
      const finish = (baseUrl: string | undefined) =>
        host.ask('API key:', '', (apiKey) => {
          host.api('POST', 'providers', { kind, name: name.trim(), apiKey: apiKey.trim(), ...(baseUrl ? { baseUrl } : {}) }).then(() => {
            host.notice(`Added “${name.trim()}”.`);
            p.reload();
          }, host.fail);
        });
      if (kind === 'custom') host.ask('Base URL (like http://localhost:11434/v1):', '', (url) => finish(url.trim()));
      else finish(undefined);
    });
  };
  return p;
}

function providerPane(host: PaneHost, pr: Provider, changed: () => void): Pane {
  return pane({
    title: pr.name,
    hint: 'r renames · d removes · Esc goes back',
    rows: (w) => [
      blank,
      { lines: [`  ${color.dim('Kind')}     ${pr.kindLabel}`] },
      ...(pr.account ? [{ lines: [`  ${color.dim('Account')}  ${clean(pr.account)}`] }] : []),
      blank,
      { pick: true, value: 'rename', lines: [`  Rename`] },
      { pick: true, value: 'remove', lines: [`  ${color.red('Remove')}`] },
      note('An agent picks its provider with /agent and its own settings; the web interface’s agent menu does too.', w),
    ],
    enter: (row) => act(String(row.value)),
    key: (ch) => (ch === 'r' ? (act('rename'), true) : ch === 'd' ? (act('remove'), true) : false),
  });
  function act(what: string) {
    if (what === 'rename') {
      host.ask('New name:', pr.name, (name) => {
        host.api('POST', `providers/${encodeURIComponent(pr.id)}`, { action: 'rename', name: name.trim() }).then(() => {
          host.notice('Renamed.');
          changed();
          host.back();
        }, host.fail);
      });
    } else if (what === 'remove') {
      host.confirm(`Remove “${pr.name}”? Its sign-in or key is deleted.`, () => {
        host.api('POST', `providers/${encodeURIComponent(pr.id)}`, { action: 'remove' }).then(() => {
          host.notice(`Removed “${pr.name}”.`);
          changed();
          host.back();
        }, host.fail);
      });
    }
  }
}

// ------------------------------------------------------------------ files

interface FileEntry {
  name: string;
  path: string;
  kind: string;
  type: string;
  size: number | null;
  items?: number | null;
  modified: number;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
}

/** The file manager: folders, text files, attach, rename, new folder, trash, copy and move. */
export function filesPane(host: PaneHost, start?: string): Pane {
  let at = start;
  let hidden = false;
  let clipboard: { mode: 'copy' | 'move'; paths: string[] } | null = null;
  const p = loading(host, {
    title: 'Files',
    hint: '↑↓ move · Enter opens · ← or Backspace up · a attaches · r renames · n new folder · d trash · y copy · x cut · v paste · g go to · . hidden · Esc closes',
    load: async () => {
      if (!at) at = (await host.api<{ home: string }>('GET', 'files/locations')).home;
      const r = await host.api<Listing>('GET', `files/list?path=${encodeURIComponent(at)}${hidden ? '&hidden=1' : ''}`);
      p.title = r.path;
      return r;
    },
    view: (r, w) => {
      const rows: Row[] = [];
      if (r.parent) rows.push({ pick: true, value: { up: r.parent }, lines: [`  ${color.dim('↰ ..')}`] });
      const sorted = [...r.entries].sort((a, b) => (a.kind === 'folder') === (b.kind === 'folder') ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.kind === 'folder' ? -1 : 1);
      const nameWidth = Math.max(10, w - 34);
      for (const e of sorted) {
        const folder = e.kind === 'folder';
        const size = folder ? (typeof e.items === 'number' ? `${e.items} item${e.items === 1 ? '' : 's'}` : '') : bytesText(e.size);
        const when = new Date(e.modified).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
        const name = truncate(`${folder ? '📁 ' : '   '}${clean(e.name)}${folder ? '/' : ''}`, nameWidth);
        rows.push({ pick: true, value: e, lines: [`  ${folder ? color.bold(name) : name}${' '.repeat(Math.max(1, nameWidth - textWidth(name) + 1))}${color.dim(size.padStart(10))}  ${color.dim(when)}`] });
      }
      if (!r.entries.length) rows.push(note('This folder is empty.', w));
      if (r.truncated) rows.push(note('Only the first items are listed.', w));
      if (clipboard) rows.push(note(`${clipboard.paths.length} item${clipboard.paths.length === 1 ? '' : 's'} to ${clipboard.mode}: v pastes them here.`, w));
      return rows;
    },
    enter: (row) => {
      const v = row.value as FileEntry & { up?: string };
      if (v.up) return go(v.up);
      if (v.kind === 'folder') return go(v.path);
      host.api<{ text: string }>('GET', `files/text?path=${encodeURIComponent(v.path)}`).then(
        (r) => host.open(pane({ title: v.path, hint: '↑↓ PgUp PgDn scroll · a attaches it · Esc goes back', rows: (w) => r.text.split(/\r?\n/).flatMap((l) => wrap(clean(l), Math.max(10, w - 4)).map((x) => ({ lines: [`  ${x}`] }))), key: (ch) => (ch === 'a' ? (attach(v), true) : false) })),
        (e: unknown) => host.notice(`${e instanceof Error ? e.message : String(e)} It opens in the web interface’s Files window.`, 'error'),
      );
    },
    key: (ch, row) => {
      const e = row?.value as (FileEntry & { up?: string }) | undefined;
      const entry = e && !e.up ? e : undefined;
      const here = p.data?.path;
      switch (ch) {
        case '\b':
        case 'left':
          if (p.data?.parent) go(p.data.parent);
          return true;
        case '.':
          hidden = !hidden;
          p.reload();
          host.notice(hidden ? 'Showing hidden files.' : 'Hiding hidden files.');
          return true;
        case 'g':
          host.ask('Go to folder:', here ?? '', (to) => to.trim() && go(to.trim()));
          return true;
        case 'a':
          if (entry && entry.kind !== 'folder') attach(entry);
          else host.notice('Pick a file to attach.');
          return true;
        case 'r':
          if (entry) host.ask(`Rename “${entry.name}” to:`, entry.name, (name) => name.trim() && name !== entry.name && call('rename', { path: entry.path, name: name.trim() }, 'Renamed.'));
          return true;
        case 'n':
          if (here) host.ask('New folder name:', '', (name) => name.trim() && call('mkdir', { dir: here, name: name.trim() }, 'Folder made.'));
          return true;
        case 'd':
          if (entry) host.confirm(`Move “${entry.name}” to the trash?`, () => call('trash', { paths: [entry.path] }, 'Moved to the trash.'));
          return true;
        case 'y':
        case 'x':
          if (entry) {
            clipboard = { mode: ch === 'y' ? 'copy' : 'move', paths: [entry.path] };
            host.notice(`${ch === 'y' ? 'Copy' : 'Move'} “${entry.name}”: go to a folder and press v.`);
            host.redraw();
          }
          return true;
        case 'v':
          if (clipboard && here) {
            const c = clipboard;
            clipboard = null;
            call(c.mode, { paths: c.paths, dest: here, conflict: 'keep' }, c.mode === 'copy' ? 'Copied.' : 'Moved.');
          }
          return true;
        default:
          return false;
      }
    },
    event: (name) => {
      if (name === 'files') p.reload();
    },
  });
  function go(to: string) {
    at = to;
    p.selected = 0;
    p.data = undefined;
    p.reload();
    host.redraw();
  }
  function call(action: string, body: Record<string, unknown>, done: string) {
    host.api('POST', `files/${action}`, body).then(() => {
      host.notice(done);
      p.reload();
    }, host.fail);
  }
  function attach(e: FileEntry) {
    host.api<{ attachment: Attachment }>('POST', 'files/attach', { path: e.path }).then((r) => {
      host.attach(r.attachment);
      host.notice(`“${e.name}” was added to your message.`);
    }, host.fail);
  }
  return p;
}

// ------------------------------------------------------------------ GenUI views

/** A GenUI view to use: ↑↓ move between its controls, Enter presses, toggles, chooses or types. */
export function genuiPane(host: PaneHost, a: ArtifactInfo): Pane {
  let model: ViewModel | undefined;
  let errors: string[] | undefined;
  let failed: string | undefined;
  let rev = a.rev;
  let saving = 0;
  const load = () =>
    host.api<{ doc?: ViewDoc; errors?: string[] }>('GET', `artifacts/${encodeURIComponent(a.id)}/view`).then(
      (r) => {
        errors = r.doc ? undefined : r.errors?.length ? r.errors : ['The view could not be read.'];
        const ui = model?.ui;
        model = r.doc ? new ViewModel(r.doc) : undefined;
        if (model && ui) for (const [k, v] of ui) model.ui.set(k, v);
        failed = undefined;
        host.redraw();
      },
      (e: unknown) => {
        failed = e instanceof Error ? e.message : String(e);
        host.redraw();
      },
    );
  void load();
  const fx: ViewEffects = {
    send: (text) => {
      host.api('POST', 'messages', { text, view: a.id }).then(() => host.notice(`Sent from the view: ${truncate(text, 60)}`), host.fail);
    },
    copy: (text) => host.copy(text),
    open: (url) => host.notice(`The view links to ${url}`),
  };
  const save = () => {
    if (!model) return;
    saving++;
    host
      .api('POST', `artifacts/${encodeURIComponent(a.id)}/state`, { state: model.state })
      .catch(host.fail)
      .finally(() => saving--);
  };
  const changed = (touched: boolean) => {
    if (touched) save();
    host.redraw();
  };
  const ui = (c: ViewControl) => model!.ui.get(c.path) ?? {};
  const setUi = (c: ViewControl, patch: Record<string, unknown>) => {
    model!.ui.set(c.path, { ...ui(c), ...patch });
    host.redraw();
  };
  const current = (c: ViewControl) => (c.node.bind?.$ ? lookup(c.node.bind.$, c.scope as unknown as Record<string, unknown>) : undefined);
  /** Moves a control by one: the next tab, slide or page, or a step of a number. */
  const step = (c: ViewControl, by: number) => {
    const n = c.node;
    if (c.kind === 'tabs') return setUi(c, { tab: ((ui(c).tab ?? 0) + by + c.count!) % c.count! });
    if (c.kind === 'carousel') return setUi(c, { slide: ((ui(c).slide ?? 0) + by + c.count!) % c.count! });
    if (c.kind === 'pages') return setUi(c, { page: ((ui(c).page ?? 0) + by + c.count!) % c.count! });
    if (c.kind === 'control' && (n.kind === 'slider' || n.kind === 'number')) {
      const min = typeof n.min === 'number' ? n.min : n.kind === 'slider' ? 0 : -Infinity;
      const max = typeof n.max === 'number' ? n.max : n.kind === 'slider' ? 100 : Infinity;
      const d = typeof n.step === 'number' && n.step > 0 ? n.step : 1;
      const now = Number(current(c));
      const next = Math.min(max, Math.max(min, (Number.isFinite(now) ? now : Number.isFinite(min) ? min : 0) + by * d));
      return changed(model!.setBound(n, c.scope, Number(next.toFixed(10)), fx));
    }
    if (c.kind === 'control' && (n.kind === 'radio' || n.kind === 'segmented' || n.kind === 'select')) {
      const opts = controlOptions(n, c.scope);
      if (!opts.length) return;
      const at = opts.findIndex((o) => o.value === current(c) || String(o.value) === String(current(c)));
      return changed(model!.setBound(n, c.scope, opts[(at + by + opts.length) % opts.length]!.value, fx));
    }
  };
  const use = (c: ViewControl) => {
    const n = c.node;
    switch (c.kind) {
      case 'tabs':
      case 'carousel':
      case 'pages':
        return step(c, 1);
      case 'popover':
        return setUi(c, { open: !ui(c).open });
      case 'submit':
        return changed(model!.run(n, 'submit', c.scope, { value: JSON.parse(JSON.stringify(model!.state)) }, fx));
      case 'row': {
        const { key, value } = c.row!;
        let touched = false;
        if (n.bind?.$) {
          model!.setBound({ bind: n.bind }, c.scope, key, fx);
          touched = true;
        } else setUi(c, { selected: key });
        if (n.on?.select) touched = model!.run(n, 'select', c.scope, { value: key, id: key, row: value }, fx) || touched;
        return changed(touched);
      }
    }
    switch (n.kind) {
      case 'button':
        return changed(model!.run(n, 'click', c.scope, { value: current(c) }, fx));
      case 'checkbox':
      case 'switch':
        return changed(model!.setBound(n, c.scope, !current(c), fx));
      case 'select':
      case 'radio':
      case 'segmented': {
        const opts = controlOptions(n, c.scope);
        host.open(
          pane({
            title: String(n.label ?? 'Choose'),
            hint: '↑↓ move · Enter chooses · Esc goes back',
            selected: Math.max(0, opts.findIndex((o) => String(o.value) === String(current(c)))),
            rows: (w) => opts.map((o) => ({ pick: true, value: o.value, lines: [`  ${String(o.value) === String(current(c)) ? color.green('(•)') : color.dim('( )')} ${truncate(clean(o.label), w - 8)}`] })),
            enter: (row) => {
              host.back();
              changed(model!.setBound(n, c.scope, row.value, fx));
            },
          }),
        );
        return;
      }
      default: {
        // text, textarea, number, date, slider: typed in the composer.
        const now = current(c);
        const label = String(n.label ?? (n.kind === 'date' ? 'Date (YYYY-MM-DD)' : 'Value'));
        host.ask(`${truncate(clean(label), 40)}:`, now === undefined || now === null ? '' : String(now), (typed) => {
          const numeric = n.kind === 'number' || n.kind === 'slider';
          if (numeric && typed.trim() !== '' && !Number.isFinite(Number(typed))) return host.notice('That is not a number.', 'error');
          const value = numeric ? (typed.trim() === '' ? null : Number(typed)) : typed;
          changed(model!.setBound(n, c.scope, value, fx));
        });
      }
    }
  };
  return pane({
    title: a.title,
    hint: '↑↓ move · Enter uses it · + − change by a step · r reloads · Esc goes back',
    rows: (w) => {
      if (failed) return [note(`Couldn’t read the view: ${failed}`, w)];
      if (errors) return [note('This view has a mistake the agent has to fix:', w), ...errors.slice(0, 12).map((e) => ({ lines: [`  ${color.red('•')} ${truncate(clean(e), w - 6)}`] }))];
      if (!model) return [note('Reading…', w)];
      const lines = drawView(model, w - 4);
      return [blank, ...lines.map((l) => ({ lines: l.lines.map((x) => `  ${x}`), ...(l.control ? { pick: true, value: l.control } : {}) })), blank];
    },
    enter: (row) => row.value && model && use(row.value as ViewControl),
    key: (ch, row) => {
      if (ch === 'r') {
        void load();
        return true;
      }
      const c = row?.value as ViewControl | undefined;
      if (!c || !model) return false;
      if (ch === '+' || ch === '=' || ch === 'l') return (step(c, 1), true);
      if (ch === '-' || ch === 'h') return (step(c, -1), true);
      if (ch === ' ') return (use(c), true);
      return false;
    },
    event: (name, data) => {
      if (name !== 'artifacts' || !Array.isArray(data.artifacts)) return;
      const now = (data.artifacts as ArtifactInfo[]).find((x) => x.id === a.id);
      // The file changed (the agent rewrote it): read it again, unless this pane is saving.
      if (now && now.rev !== rev) {
        rev = now.rev;
        if (!saving) void load();
      }
    },
  });
}

// ------------------------------------------------------------------ one step

interface StepDetail {
  tool: string;
  command?: string;
  args: Record<string, unknown>;
  output: string;
  status: string;
}

const STATUS: Record<string, string> = { ok: '', error: ' · failed', denied: ' · not allowed', cancelled: ' · cancelled', running: ' · running', not_started: ' · not run' };

/** One of the agent's steps: the whole command (or call) and its output. */
export function stepPane(host: PaneHost, id: string, title = 'Step'): Pane {
  const p = loading(host, {
    title,
    hint: '↑↓ PgUp PgDn scroll · c copies the command · Esc goes back',
    load: () => host.api<StepDetail>('GET', `activity/${encodeURIComponent(id)}`),
    view: (d, w) => {
      const width = Math.max(10, w - 6);
      const block = (label: string, text: string): Row[] => [
        heading(label),
        ...text.split(/\r?\n/).flatMap((l) => (l ? wrap(clean(l), width) : [''])).map((l) => ({ lines: [`    ${l}`] })),
      ];
      const rest = Object.fromEntries(Object.entries(d.args).filter(([k]) => k !== 'command'));
      return [
        { lines: [`  ${color.dim(`${d.tool}${STATUS[d.status] ?? ` · ${d.status}`}`)}`] },
        ...(d.command !== undefined ? block('Command', d.command) : []),
        ...(Object.keys(rest).length ? block(d.command !== undefined ? 'Options' : 'Arguments', JSON.stringify(rest, null, 2)) : []),
        ...block('Output', d.output || '(no output)'),
        blank,
      ];
    },
    key: (ch) => {
      if (ch !== 'c' || !p.data) return false;
      host.copy(p.data.command ?? JSON.stringify(p.data.args, null, 2));
      return true;
    },
    event: (name) => {
      // A step still running: read it again when one ends.
      if (name === 'activity_end' && p.data?.status === 'running') p.reload();
    },
  });
  return p;
}
