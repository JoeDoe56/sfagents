import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { ConversationService, loadAgentTree } from '@sfagents/core';
import { LogBook, WebServer } from '@sfagents/web';
import { Tui } from '@sfagents/cli/dist/terminal/tui.js';
import { answerText, numberedAnswer } from '@sfagents/cli/dist/terminal/panes.js';
import { drawView, ViewModel } from '@sfagents/cli/dist/terminal/genui-text.js';
import { baseAgent, makeTempDir, scriptedFactory, writeAgent, type Script } from './helpers.js';

/** A terminal for the interface: keys go in, frames come out (the last one is the screen). */
class Terminal {
  readonly input = new PassThrough() as unknown as NodeJS.ReadStream;
  private out = '';
  readonly output: NodeJS.WriteStream;

  constructor(columns = 110, rows = 40) {
    const w = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        this.out += String(chunk);
        if (this.out.length > 2_000_000) this.out = this.out.slice(-500_000);
        cb();
      },
    });
    this.output = Object.assign(w, { columns, rows, isTTY: false }) as unknown as NodeJS.WriteStream;
  }

  /** The screen now, as plain text lines. */
  screen(): string {
    const frame = this.out.slice(this.out.lastIndexOf('\u001b[H') + 3);
    return frame
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
      .replace(/\u001b\[[0-9;?<]*[A-Za-z]/g, '')
      .split('\r\n')
      .map((l) => l.trimEnd())
      .join('\n');
  }

  async keys(...seqs: string[]): Promise<void> {
    for (const s of seqs) {
      (this.input as unknown as PassThrough).write(s);
      // A lone Esc is told from the start of a sequence by a pause.
      await wait(s === '\u001b' ? 650 : 40);
    }
    await wait(60);
  }

  async type(text: string): Promise<void> {
    await this.keys(text, '\r');
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CTRL_UP = '\u001b[1;5A';
const DOWN = '\u001b[B';

async function until<T>(what: string, check: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(25);
  }
}

describe('terminal interface', () => {
  test('numbers answer an agent’s questions as the web page does', () => {
    const one = [{ question: 'Which color?', options: ['red', 'blue', 'green'] }];
    assert.equal(numberedAnswer(one, '2'), 'blue');
    assert.equal(numberedAnswer(one, '1,3'), undefined); // one pick only
    assert.equal(numberedAnswer([{ ...one[0]!, multiple: true }], '3, 1'), 'red, green');
    assert.equal(numberedAnswer(one, '4'), undefined);
    assert.equal(numberedAnswer(one, 'blue please'), undefined);
    const two = [one[0]!, { question: 'Size?', options: ['S', 'M'] }];
    assert.equal(numberedAnswer(two, '3 2'), 'Which color?\ngreen\n\nSize?\nM');
    assert.equal(numberedAnswer(two, '3'), undefined);
    assert.equal(answerText(two, [{ picked: new Set([0]), other: '' }, { picked: new Set(), other: 'XL' }]), 'Which color?\nred\n\nSize?\nXL');
    assert.equal(answerText([{ question: 'Notes?', options: [] }], [{ picked: new Set(), other: '' }]), '(no answer)');
  });

  test('questions, replies, reactions, attachments and the panes work from the keyboard', async () => {
    const dir = makeTempDir('sfagents-tui-');
    writeAgent(dir, { ...baseAgent('main') });
    const tree = loadAgentTree(dir);
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const notes = path.join(dir, 'notes.txt');
    fs.writeFileSync(notes, 'Fence paint: blue, two coats.\n');
    const artifact = conversation.linkArtifact({ title: 'Paint plan', file: notes });
    const script: Script = (req, call) => {
      if (call === 0) return { toolCalls: [{ name: 'message', args: { to: 'user', text: 'One thing first.', questions: [{ question: 'Which color?', options: ['red', 'blue'] }], wait: false } }] };
      if (call === 1) return { text: 'Waiting for you.' };
      const last = req.messages[req.messages.length - 1] as { content: unknown };
      return { text: `Got: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}` };
    };
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(script).factory, watchAgents: false, auth: false });
    const url = await server.start();
    const term = new Terminal();
    const tui = new Tui({ server, logs: new LogBook(), url, input: term.input, output: term.output, captureOutput: false });
    const done = tui.run();
    const users = () => conversation.state.messages.filter((m) => m.role === 'user' && !m.event);
    try {
      await term.type('paint the fence');
      await until('the questions', () => term.screen().includes('2) blue') && /main asks/.test(term.screen()));
      assert.match(term.screen(), /Send a number/);

      // "2" answers with the option.
      await until('the first reply to end', () => conversation.state.messages.some((m) => m.role === 'assistant' && m.content === 'Waiting for you.'));
      await wait(100);
      await term.type('2');
      await until('the answer', () => users().length === 2);
      assert.equal(users()[1]!.content, 'blue');
      await until('the reply', () => term.screen().includes('Got: blue'));
      assert.match(term.screen(), /Answered/);

      // Ctrl+↑ picks the latest reply; e reacts with the second quick reaction.
      await term.keys(CTRL_UP);
      assert.match(term.screen(), /r reply · e react/);
      await term.keys('e');
      assert.match(term.screen(), /React with 1 ❤️/);
      await term.type('2');
      const reply = conversation.state.messages.filter((m) => m.role === 'assistant' && m.content.startsWith('Got: blue')).pop()!;
      const state = await server.request('GET', '/api/state');
      assert.equal((state.json.reactions as Record<string, string>)[reply.id], '👍');

      // The agent is told about the reaction, and answers.
      await until('the answer to the reaction', () => term.screen().includes('The person reacted 👍') && term.screen().includes('● idle'));

      // r replies to the latest message, inline.
      const latest = conversation.state.messages.filter((m) => m.role === 'assistant' && m.content.includes('The person reacted')).pop()!;
      await term.keys(CTRL_UP, 'r');
      assert.match(term.screen(), /Replying to main: Got: \[SF Agents\]/);
      await term.type('thanks');
      await until('the reply message', () => users().length === 3);
      assert.equal(users()[2]!.replyTo, latest.id);
      await until('the reply thread', () => term.screen().includes('2 replies') && term.screen().includes('│   thanks'));

      // /attach puts a file on the next message.
      await term.type(`/attach ${notes}`);
      await until('the attachment', () => term.screen().includes('📎 notes.txt'));
      await term.type('see the file');
      await until('the message with the file', () => users().length === 4);
      assert.equal(users()[3]!.attachments?.length, 1);
      assert.equal(users()[3]!.attachments?.[0]?.name, 'notes.txt');

      // The artifacts: open one, pin it.
      await term.type('/artifacts');
      await until('the artifacts pane', () => term.screen().includes('Paint plan'));
      await term.keys('p');
      await until('the pin', () => conversation.artifacts().find((a) => a.id === artifact.id)?.pinned === true);
      await term.keys('\r');
      await until('the artifact text', () => term.screen().includes('Fence paint: blue, two coats.'));
      await term.keys('\u001b', '\u001b');
      assert.doesNotMatch(term.screen(), /Esc goes back/);

      // Search finds the message and jumps to it.
      await term.type('/search fence');
      await until('the search results', () => term.screen().includes('Messages (2)') && term.screen().includes('Artifacts (1)'));
      await term.keys(DOWN, '\r');
      await until('the jump', () => /▌You[^\n]*\n▌ *paint the fence/.test(term.screen()));
      await term.keys('\u001b');

      // The other panes open and say what they show.
      const panes: Array<[string, RegExp]> = [
        ['/settings', /Providers[\s\S]*Speech[\s\S]*Web server/],
        ['/context', /Working context[\s\S]*By part/],
        ['/threads', /haven’t written to each other/],
        ['/changes', /No repository/],
        ['/topics', /Topics/],
        [`/files ${dir}`, /notes\.txt/],
      ];
      for (const [command, shows] of panes) {
        await term.type(command);
        await until(command, () => shows.test(term.screen()));
        await term.keys('\u001b');
      }

      // In the file manager, a attaches the picked file.
      await term.type(`/files ${dir}`);
      await until('the files', () => term.screen().includes('notes.txt'));
      for (let i = 0; i < 4 && !/› +notes\.txt/.test(term.screen()); i++) await term.keys(DOWN);
      await term.keys('a');
      await until('the attachment from the files', () => term.screen().includes('was added to your message'));
      await term.keys('\u001b');
      assert.match(term.screen(), /📎 notes\.txt/);
      // (Files attached from the file manager go out too: the web page's "Ask SF Agents" uses the same call.)
      await term.type('from the files');
      await until('the message with the file from the files', () => users().length === 5);
      assert.equal(users()[4]!.attachments?.[0]?.name, 'notes.txt');
      await term.type(`/attach ${notes}`);
      await until('the attachment', () => term.screen().includes('📎 notes.txt'));
      await term.type('/detach');
      assert.doesNotMatch(term.screen(), /detach drops them/);

      await term.type('/help');
      assert.match(term.screen(), /\/attach <path>/);
    } finally {
      tui.quit();
      await done;
      await server.close();
      conversation.close();
    }
  });

  test('a GenUI view is drawn as text: values, controls, a table and a chart', () => {
    const m = new ViewModel({
      title: 'Plans',
      state: { plan: 'b', agree: true, n: 3 },
      data: { rows: [{ name: 'Basic', price: 5 }, { name: 'Pro', price: 12 }] },
      view: {
        type: 'layout',
        kind: 'card',
        title: 'Pick a plan',
        children: [
          { type: 'text', value: { $op: 'concat', args: ['You picked ', { $: 'state.plan' }] } },
          { type: 'control', kind: 'radio', label: 'Plan', bind: { $: 'state.plan' }, options: [{ label: 'Basic', value: 'a' }, { label: 'Pro', value: 'b' }] },
          { type: 'control', kind: 'checkbox', label: 'I agree', bind: { $: 'state.agree' } },
          { type: 'control', kind: 'button', label: 'Go', when: { $: 'state.agree' } },
          { type: 'table', columns: [{ key: 'name', label: 'Name' }, { key: 'price', label: 'Price', format: 'number' }], rows: { $: 'data.rows' } },
          { type: 'chart', kind: 'bar', data: { $: 'data.rows' }, x: 'name', series: [{ y: 'price' }] },
        ],
      },
    });
    const text = drawView(m, 70)
      .flatMap((l) => l.lines)
      .join('\n')
      .replace(/\u001b\[[0-9;]*m/g, '');
    assert.match(text, /Pick a plan/);
    assert.match(text, /You picked b/);
    assert.match(text, /\( \) Basic  \(•\) Pro/);
    assert.match(text, /\[x\] I agree/);
    assert.match(text, /\[ Go \]/);
    assert.match(text, /Name +Price/);
    assert.match(text, /Pro +12/);
    assert.match(text, /Pro +█+ 12/);
    assert.equal(drawView(m, 70).filter((l) => l.control).length, 3); // radio, checkbox, button
  });

  test('a view works from its pane, and a step shows its whole command and output', async () => {
    const dir = makeTempDir('sfagents-tui-');
    writeAgent(dir, { ...baseAgent('main') });
    const tree = loadAgentTree(dir);
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    fs.mkdirSync(conversation.genuiDir, { recursive: true });
    const file = path.join(conversation.genuiDir, 'pick.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        title: 'Pick',
        state: { agree: false },
        view: {
          type: 'layout',
          kind: 'column',
          children: [
            { type: 'control', kind: 'checkbox', label: 'I agree', bind: { $: 'state.agree' } },
            { type: 'control', kind: 'button', label: 'Send it', on: { click: [{ do: 'send', text: { $op: 'concat', args: ['agreed: ', { $: 'state.agree' }] } }] } },
          ],
        },
      }),
    );
    const view = conversation.linkArtifact({ title: 'Pick', file });
    assert.equal(view.type, 'genui');
    const long = `echo ${'x'.repeat(150)} && echo done`;
    const script: Script = (_req, call) => {
      if (call === 0) return { toolCalls: [{ name: 'no_such_tool', args: { command: long } }] };
      return { text: call === 1 ? 'Tried it.' : 'Thanks.' };
    };
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(script).factory, watchAgents: false, auth: false });
    const url = await server.start();
    const term = new Terminal();
    const tui = new Tui({ server, logs: new LogBook(), url, input: term.input, output: term.output, captureOutput: false });
    const done = tui.run();
    try {
      // A step: the chat shows a line; d shows all of it, with what came back.
      await term.type('try it');
      await until('the reply', () => term.screen().includes('Tried it.') && term.screen().includes('● idle'));
      const step = conversation.state.messages.find((m) => m.toolCalls?.length)!;
      const detail = await server.request('GET', `/api/activity/${encodeURIComponent(`${step.id}:${step.toolCalls![0]!.id}`)}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.json.command, long);
      assert.equal(detail.json.tool, 'no_such_tool');
      assert.match(String(detail.json.output), /no_such_tool/);
      await term.keys(CTRL_UP, CTRL_UP);
      assert.match(term.screen(), /d shows the command and output/);
      await term.keys('d');
      await until('the step', () => term.screen().includes('Command') && term.screen().includes('Output') && term.screen().includes('echo done'));
      await term.keys('\u001b');

      // The view: Enter toggles the checkbox (written to the file), then the button sends from the view.
      await term.type('/artifacts');
      await until('the views', () => term.screen().includes('Pick'));
      for (let i = 0; i < 6 && !/› +.*Pick/.test(term.screen()); i++) await term.keys(DOWN);
      await term.keys('\r');
      await until('the view pane', () => term.screen().includes('[ ] I agree'));
      await term.keys('\r');
      await until('the change', () => term.screen().includes('[x] I agree'));
      await until('the saved state', () => JSON.parse(fs.readFileSync(file, 'utf8')).state?.agree === true);
      await term.keys(DOWN, '\r');
      await until('the message from the view', () => conversation.state.messages.some((m) => m.role === 'user' && m.content === 'agreed: true' && m.view === view.id));
    } finally {
      tui.quit();
      await done;
      await server.close();
      conversation.close();
    }
  });

  test('the agent editor: a new agent from the keyboard, with errors by field, and Ctrl+S saves', async () => {
    const dir = makeTempDir('sfagents-tui-');
    writeAgent(dir, { ...baseAgent('main') });
    const tree = loadAgentTree(dir);
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir });
    const server = new WebServer({ tree, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, watchAgents: false, auth: false });
    const url = await server.start();
    const term = new Terminal(110, 60);
    const tui = new Tui({ server, logs: new LogBook(), url, input: term.input, output: term.output, captureOutput: false });
    const done = tui.run();
    const CTRL_S = '\u0013';
    const TAB = '\t';
    try {
      await term.type('/agents');
      await until('the agents', () => term.screen().includes('New agent') && /main.*\(replying\)/.test(term.screen()));
      await term.keys('n');
      await until('the editor', () => term.screen().includes('Network (required)'));
      // Saving an empty form says what each field needs.
      await term.keys(CTRL_S);
      await until('the errors', () => term.screen().includes('Give the agent a name.') && term.screen().includes('Choose what the agent’s container can reach.'));
      // Name: Enter asks for it.
      await term.keys('\r');
      await term.type('tester');
      // Tab down to the instructions (name, description, provider, model, instructions).
      await term.keys(TAB, TAB, TAB, TAB, '\r');
      await term.type('You test.');
      for (let i = 0; i < 8 && !/› +● Off|› +○ Off/.test(term.screen()); i++) await term.keys(TAB);
      await term.keys('\r', '\u001b[C');
      await until('network chosen', () => /● Packages\b/.test(term.screen()));
      await term.keys(CTRL_S);
      await until('saved', () => fs.existsSync(path.join(dir, 'agents', 'tester.json')));
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'tester.json'), 'utf8'));
      assert.deepEqual(raw, { systemPrompt: 'You test.', network: 'pkg' });
      await until('the title', () => term.screen().includes('Agent: tester'));
    } finally {
      tui.quit();
      await done;
      await server.close();
      conversation.close();
    }
  });
});
