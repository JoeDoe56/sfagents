import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  addSection,
  AgentRuntime,
  ConfigError,
  ConversationService,
  editSection,
  fetchSection,
  listSections,
  loadAgentTree,
  readConversation,
  searchConversation,
  SectionOperationError,
  MAX_SECTION_REMINDERS,
  SECTION_REMINDER,
  type ChatMessage,
  type ModelRequest,
  type RuntimeEvent,
  type FunctionDeclaration,
} from '@sfagents/core';
import { baseAgent, lastToolContent, makeTempDir, runCli, scriptedFactory, writeJson, type Script, writeAgent } from './helpers.js';

function project(agent: Record<string, unknown> = {}, files: Record<string, unknown> = {}) {
  const dir = makeTempDir();
  writeAgent(dir, { ...baseAgent('main'), ...agent });
  for (const [f, v] of Object.entries(files)) writeJson(path.join(dir, f), v);
  return dir;
}

function open(dir: string) {
  const tree = loadAgentTree(path.join(dir, 'agent.json'));
  return { tree, conversation: ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: tree.configDir }) };
}

function collect() {
  const events: RuntimeEvent[] = [];
  return { events, onEvent: (e: RuntimeEvent) => void events.push(e) };
}

/** Writes simple user/assistant exchanges straight through the recorder. */
function seed(conversation: ConversationService, tree: ReturnType<typeof loadAgentTree>, exchanges: Array<[string, string]>) {
  for (const [u, a] of exchanges) {
    const r = conversation.beginRootRun(tree.root);
    r.user(u);
    r.start(tree.root);
    r.assistant({ role: 'assistant', content: a }, 'stop');
    r.end({ agentId: 'main', status: 'GOAL' as never, text: a, turns: 1, toolCalls: [], usage: {}, durationMs: 1 });
  }
}

describe('sections: operations', () => {
  test('create, nest, rename, move and reassign survive reopening; IDs and text never change', () => {
    const dir = project();
    let { tree, conversation } = open(dir);
    seed(conversation, tree, [
      ['Uploader retries fail on flaky Wi-Fi', 'Use backoff.'],
      ['Sourdough hydration?', '72%.'],
    ]);
    const ids = conversation.state.messages.map((m) => m.id);
    const s1 = addSection(conversation.main, { title: 'Uploader', messages: [`${ids[0]}-${ids[1]}`] });
    const s2 = addSection(conversation.main, { title: 'Retries', parent: s1.section, expectedRevision: 1 });
    const s3 = addSection(conversation.main, { title: 'Cooking', messages: [ids[2]!, ids[3]!] });
    editSection(conversation.main, { section: s1.section, title: 'Uploader project', expectedRevision: 3 });
    editSection(conversation.main, { section: s2.section, parent: null, assign: [ids[0]!], expectedRevision: 4 });
    const before = conversation.state.messages.map((m) => [m.id, m.content]);
    conversation.close();

    ({ tree, conversation } = open(dir));
    const page = listSections(conversation.state);
    assert.equal(page.revision, 5);
    assert.deepEqual(page.entries.map((e) => [e.id, e.title, e.parent, e.messages]), [
      [s1.section, 'Uploader project', null, 1],
      [s2.section, 'Retries', null, 1],
      [s3.section, 'Cooking', null, 2],
    ]);
    assert.deepEqual(conversation.state.messages.map((m) => [m.id, m.content]), before);
    assert.equal(conversation.state.sectionOf(ids[0]!), s2.section);
    conversation.close();
  });

  test('merging folds sections into one; it survives reopening and IDs are never reused', () => {
    const dir = project();
    let { tree, conversation } = open(dir);
    seed(conversation, tree, [
      ['Uploader retries', 'Use backoff.'],
      ['Upload chunk size', '8 MB.'],
      ['Sourdough', '72%.'],
    ]);
    const ids = conversation.state.messages.map((m) => m.id);
    const a = addSection(conversation.main, { title: 'Uploader', messages: [ids[0]!, ids[1]!] });
    const b = addSection(conversation.main, { title: 'Uploads', messages: [ids[2]!, ids[3]!] });
    const sub = addSection(conversation.main, { title: 'Chunking', parent: b.section });
    const c = addSection(conversation.main, { title: 'Baking', messages: [ids[4]!, ids[5]!] });
    addSection(conversation.main, { title: 'Back to uploads', parent: undefined });
    editSection(conversation.main, { section: b.section, current: true });
    const before = conversation.state.messages.map((m) => [m.id, m.content]);

    assert.throws(() => editSection(conversation.main, { section: a.section, merge: [b.section] }), /expected_revision is required/);
    assert.throws(() => editSection(conversation.main, { section: sub.section, merge: [b.section], expectedRevision: 6 }), /is inside s2; merge s3 into s2 instead/);
    assert.throws(() => editSection(conversation.main, { section: a.section, merge: [a.section], expectedRevision: 6 }), /into itself/);
    const r = editSection(conversation.main, { section: a.section, title: 'Uploader project', merge: [b.section, 's5'], expectedRevision: 6 });
    assert.deepEqual(r.merge, [b.section, 's5']);
    assert.throws(() => editSection(conversation.main, { section: a.section, merge: [b.section], expectedRevision: 7 }), /already merged into s1/);
    conversation.close();

    ({ tree, conversation } = open(dir));
    const state = conversation.state;
    assert.deepEqual(listSections(state).entries.map((e) => [e.id, e.title, e.parent, e.messages]), [
      [a.section, 'Uploader project', null, 4],
      [sub.section, 'Chunking', a.section, 0],
      [c.section, 'Baking', null, 2],
    ]);
    // Every message stays filed; the merged section's current status moved with it.
    assert.equal(state.sectionOf(ids[2]!), a.section);
    assert.equal(state.currentSection, a.section);
    assert.deepEqual(state.messages.map((m) => [m.id, m.content]), before);
    // Fetching a merged section's ID reads the section it went into.
    assert.match(fetchSection(state, b.section).text, /Upload chunk size/);
    // New IDs continue after the highest ever used.
    assert.equal(addSection(conversation.main, { title: 'Next' }).section, 's6');
    conversation.close();
  });

  test('invalid references, stale edits and cycles fail without writing anything', () => {
    const dir = project();
    const { tree, conversation } = open(dir);
    seed(conversation, tree, [['hello', 'hi']]);
    const a = addSection(conversation.main, { title: 'A' });
    const b = addSection(conversation.main, { title: 'B', parent: a.section });
    const file = conversation.file!;
    const size = fs.statSync(file).size;
    const cases: Array<[() => unknown, RegExp]> = [
      [() => addSection(conversation.main, { title: 'X', messages: ['m999'] }), /Unknown message m999/],
      [() => addSection(conversation.main, { title: 'X', parent: 's77' }), /Unknown parent section s77/],
      [() => addSection(conversation.main, { title: '   ' }), /must not be empty/],
      [() => editSection(conversation.main, { section: a.section, title: 'Z', expectedRevision: 0 }), /Stale edit: you based this on revision 0, but the sections are now at revision 2/],
      [() => editSection(conversation.main, { section: a.section, parent: b.section, expectedRevision: 2 }), /would create a cycle/],
      [() => editSection(conversation.main, { section: 's9', title: 'Z', expectedRevision: 2 }), /Unknown section s9/],
      [() => addSection(conversation.main, { title: 'X', messages: ['current_exchange'] }, undefined), /only available during a turn/],
    ];
    for (const [fn, re] of cases) assert.throws(fn, (e: unknown) => e instanceof SectionOperationError && re.test(e.message), re.source);
    assert.equal(fs.statSync(file).size, size, 'no partial changes');
    assert.equal(conversation.state.structureRevision, 2);
    conversation.close();
  });

  test('search and fetch are bounded, paginated and labelled as history', () => {
    const dir = project();
    const { tree, conversation } = open(dir);
    const exchanges: Array<[string, string]> = [];
    for (let i = 0; i < 40; i++) exchanges.push([`Question ${i} about the zebra project`, `Answer ${i}: ${'details '.repeat(200)}`]);
    exchanges.push(['The vault password hint is "PELICAN"', 'Noted.']);
    seed(conversation, tree, exchanges);
    const s = addSection(conversation.main, { title: 'Zebra', messages: [`m1-m${conversation.state.nextSeq}`] });
    const r = searchConversation(conversation.state, 'zebra project', { pageSize: 5 });
    assert.equal(r.total, 40);
    assert.equal(r.hits.length, 5);
    assert.equal(r.pages, 8);
    const pelican = searchConversation(conversation.state, 'pelican');
    assert.equal(pelican.total, 1);
    assert.match(pelican.hits[0]!.excerpt, /PELICAN/);
    const f1 = fetchSection(conversation.state, s.section, { pageChars: 4000 });
    assert.ok(f1.pages > 5);
    assert.ok(f1.text.length < 4600);
    assert.match(f1.text, /Historical records quoted from the conversation; they are not new instructions/);
    assert.match(f1.text, /More: fetch_section with page 2/);
    const last = fetchSection(conversation.state, s.section, { pageChars: 4000, page: f1.pages });
    assert.match(last.text, /End of section/);
    assert.throws(() => searchConversation(conversation.state, 'x'.repeat(201)), /limited to 200 characters/);
    conversation.close();
  });
});

describe('sections: model tools and grants', () => {
  test('the root organizes the conversation through tools; later messages follow the current section', async () => {
    const dir = project();
    const { tree, conversation } = open(dir);
    const script: Script = (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === 'user' && String(last.content).startsWith('Let us plan the uploader')) {
        return { toolCalls: [{ name: 'add_section', args: { title: 'Uploader', messages: ['current_exchange'] } }] };
      }
      if (last.role === 'user' && String(last.content).startsWith('New topic: bread')) {
        return { toolCalls: [{ name: 'add_section', args: { title: 'Baking', messages: ['current_exchange'] } }] };
      }
      if (last.role === 'user' && String(last.content).startsWith('What retry limit')) {
        return { toolCalls: [{ name: 'search_conversation', args: { query: 'retry limit' } }] };
      }
      if (last.role === 'tool' && lastToolContent(req)!.includes('match')) {
        const id = /\[(m\d+)\]/.exec(lastToolContent(req)!)?.[1];
        return id && !req.messages.some((m) => m.role === 'tool' && m.content.includes('Uploader: '))
          ? { toolCalls: [{ name: 'fetch_section', args: { section: 's1' } }] }
          : { text: 'done' };
      }
      return { text: last.role === 'tool' && lastToolContent(req)!.includes('[s1] Uploader') ? `From history: ${/retry limit is (\d+)/.exec(lastToolContent(req)!)?.[1]}` : 'ok' };
    };
    const { factory, providers } = scriptedFactory(script);
    const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
    const session = runtime.createSession();
    await session.run('Let us plan the uploader. The retry limit is 5.');
    await session.run('Also add jitter.');
    await session.run('New topic: bread hydration');
    session.resetContext();
    const answer = await session.run('What retry limit did we choose?');
    assert.equal(answer.text, 'From history: 5');

    const state = conversation.state;
    const byText = (t: string) => state.messages.find((m) => m.role === 'user' && String(m.content).startsWith(t))!;
    assert.equal(state.sectionOf(byText('Let us plan').id), 's1');
    assert.equal(state.sectionOf(byText('Also add jitter').id), 's1', 'filed under the current section automatically');
    assert.equal(state.sectionOf(byText('New topic').id), 's2');
    // Tools and guidance were offered to the persistent root.
    const first = providers.get('main')!.requests[0]!;
    const names = (first.request.tools as FunctionDeclaration[]).map((t) => t.name);
    assert.ok(!names.includes('edit_section'), 'renaming and merging go through add_section');
    for (const n of ['list_sections', 'add_section', 'keep_section', 'search_sections', 'search_conversation', 'fetch_section']) assert.ok(names.includes(n), n);
    assert.match((first.messages[0] as { content: string }).content, /<conversation_memory>/);
    // After /clear, the old exchange is not in the request; it was retrieved on demand.
    const afterClear = providers.get('main')!.requests.find((r) => (r.messages as ChatMessage[]).some((m) => m.role === 'user' && String(m.content).startsWith('What retry limit')))!;
    assert.doesNotMatch(JSON.stringify(afterClear.messages), /retry limit is 5/);
    await runtime.dispose();
    conversation.close();
  });

  test('add_section with a section ID renames, files the turn and merges', async () => {
    const dir = project();
    const { tree, conversation } = open(dir);
    seed(conversation, tree, [['retries', 'backoff'], ['upload size', '8 MB']]);
    const ids = conversation.state.messages.map((m) => m.id);
    addSection(conversation.main, { title: 'Retries', messages: [ids[0]!, ids[1]!] });
    addSection(conversation.main, { title: 'Upload size', messages: [ids[2]!, ids[3]!] });
    const script: Script = (req, n) => {
      if (n === 0) return { toolCalls: [{ name: 'add_section', args: { section: 's1', title: 'Uploader', merge: ['s2'], messages: ['current_exchange'], make_current: true, expected_revision: 2 } }] };
      if (n === 1) return { toolCalls: [{ name: 'add_section', args: { merge: ['s1'] } }] };
      return { text: lastToolContent(req)! };
    };
    const { factory } = scriptedFactory(script);
    const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
    const result = await runtime.createSession().run('these are one topic really');
    assert.match(result.text, /"merge" needs "section"/);
    const state = conversation.state;
    assert.deepEqual([...state.sections.values()].map((s) => [s.id, s.title]), [['s1', 'Uploader']]);
    for (const m of state.messages.filter((m) => m.role !== 'tool')) assert.equal(state.sectionOf(m.id), 's1', m.id);
    await runtime.dispose();
    conversation.close();
  });

  test('agents in a thread get no conversation access by default; a read grant cannot organize', async () => {
    const dir = project(
      { tools: { allow: ['1-reader.json', '1-blind.json'] } },
      { 'agents/reader.json': baseAgent('reader', { conversation: { access: 'read' } }), 'agents/blind.json': baseAgent('blind') },
    );
    const { tree, conversation } = open(dir);
    seed(conversation, tree, [['the secret project codename is OSPREY', 'ok']]);
    const script: Script = (req, n, agent) => {
      if (agent === 'main') {
        if (n === 0) return { toolCalls: [{ name: 'message', args: { to: 'reader', text: 'find the codename', wait: true } }, { name: 'message', args: { to: 'blind', text: 'find the codename', wait: true } }] };
        return { text: 'done' };
      }
      if (agent === 'reader') {
        return n === 0
          ? { toolCalls: [{ name: 'search_conversation', args: { query: 'codename' } }, { name: 'add_section', args: { title: 'Hijack' } }] }
          : { text: lastToolContent(req)! };
      }
      return n === 0 ? { toolCalls: [{ name: 'search_conversation', args: { query: 'codename' } }] } : { text: lastToolContent(req)! };
    };
    const { factory, providers } = scriptedFactory(script);
    const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
    await runtime.createSession().run('delegate');
    const readerTools = (providers.get('reader')!.requests[0]!.request.tools as FunctionDeclaration[]).map((t) => t.name).sort();
    // Besides talking back to main (which every agent in a thread can), only read access.
    assert.deepEqual(readerTools, ['fetch_section', 'list_sections', 'message', 'search_conversation', 'search_sections']);
    assert.deepEqual((providers.get('blind')!.requests[0]!.request.tools as FunctionDeclaration[]).map((t) => t.name).sort(), ['message']);
    const readerReq = providers.get('reader')!.requests[1]!.messages as ChatMessage[];
    const toolOut = readerReq.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content);
    assert.match(toolOut[0]!, /OSPREY/);
    assert.match(toolOut[1]!, /not available to agent "reader"/);
    const blindReq = providers.get('blind')!.requests[1]!.messages as ChatMessage[];
    assert.match((blindReq.at(-1) as { content: string }).content, /not available to agent "blind"/);
    assert.equal(conversation.state.sections.size, 0);
    // Search covers the main conversation only, never threads between agents.
    assert.equal(searchConversation(conversation.state, 'find the codename').hits.filter((h) => h.role === 'user').length, 0);
    await runtime.dispose();
    conversation.close();
  });

  test('every turn must settle its section: a turn that ends without it is sent back, unrecorded', async () => {
    const dir = project();
    const { tree, conversation } = open(dir);
    const isReminder = (req: ModelRequest) => {
      const last = req.messages[req.messages.length - 1]!;
      return last.role === 'user' && last.content === SECTION_REMINDER;
    };
    const script: Script = (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (isReminder(req)) return { toolCalls: [{ name: 'add_section', args: { title: 'Uploader', messages: ['current_exchange'] } }] };
      if (last.role === 'tool') return lastToolContent(req)!.startsWith('This turn stays') || lastToolContent(req)!.startsWith('Created section') ? {} : { text: 'unexpected' };
      if (String(last.content).startsWith('Plan the uploader')) return { text: 'Use backoff.' };
      if (String(last.content).startsWith('And jitter')) return { toolCalls: [{ name: 'keep_section' }] };
      return { text: 'Forgot again.' };
    };
    const { factory, providers } = scriptedFactory(script, { scriptSectionReminders: true });
    const runtime = new AgentRuntime({ tree, providerFactory: factory, conversation });
    const session = runtime.createSession();
    const { events, onEvent } = collect();

    // Forgot: sent back once, chose a section, and the reply stays the result.
    const r1 = await session.run('Plan the uploader', { onEvent });
    assert.equal(r1.text, 'Use backoff.');
    assert.deepEqual(r1.toolCalls, [], 'the reminder round is bookkeeping');
    const requests = providers.get('main')!.requests;
    assert.equal(requests.length, 3);
    assert.ok(isReminder({ ...requests[1]!.request, messages: requests[1]!.messages } as ModelRequest));
    const state = conversation.state;
    const plan = state.messages.find((m) => m.role === 'user' && m.content === 'Plan the uploader')!;
    assert.equal(state.sectionOf(plan.id), 's1');
    // Only the exchange itself is recorded: no reminder, no extra assistant messages.
    assert.deepEqual(state.messages.map((m) => `${m.role}:${m.content ?? ''}`), ['user:Plan the uploader', 'assistant:Use backoff.']);

    // Chose first: no reminder.
    const before = requests.length;
    await session.run('And jitter?', { onEvent });
    assert.equal(requests.length - before, 2);
    assert.equal(requests.slice(before).some((r) => isReminder({ ...r.request, messages: r.messages } as ModelRequest)), false);
    assert.equal(state.sectionOf(state.messages.find((m) => m.content === 'And jitter?')!.id), 's1');

    // Never chooses: two reminders, then a warning and the reply stands.
    const script2: Script = (req) => (isReminder(req) || req.messages.at(-1)!.role === 'tool' ? {} : { text: 'Stubborn.' });
    const second = scriptedFactory(script2, { scriptSectionReminders: true });
    const rt2 = new AgentRuntime({ tree, providerFactory: second.factory, conversation });
    const r3 = await rt2.createSession().run('Hello', { onEvent });
    assert.equal(r3.text, 'Stubborn.');
    assert.equal(second.providers.get('main')!.requests.length, 1 + MAX_SECTION_REMINDERS);
    assert.ok(events.some((e) => e.type === 'warning' && /without keep_section/.test(e.message)));
    await rt2.dispose();
    await runtime.dispose();
    conversation.close();
  });

  test('ephemeral runs do not offer section tools', async () => {
    const dir = project();
    const tree = loadAgentTree(path.join(dir, 'agent.json'));
    const { factory, providers } = scriptedFactory(() => ({ text: 'ok' }));
    await new AgentRuntime({ tree, providerFactory: factory }).createSession().run('hi');
    assert.deepEqual(providers.get('main')!.requests[0]!.request.tools, []);
  });
});

describe('sections: CLI inspection', () => {
  test('conversation sections, show and search', async () => {
    const dir = project();
    const { tree, conversation } = open(dir);
    seed(conversation, tree, [
      ['Deploy target is eu-west-3', 'ok'],
      ['Favourite tea is genmaicha', 'ok'],
    ]);
    addSection(conversation.main, { title: 'Infrastructure', messages: ['m1-m4'] });
    conversation.close();
    const sections = await runCli(['conversation', 'sections'], { cwd: dir });
    assert.match(sections.stdout, /- \[s1\] Infrastructure \(2 msg, m\d+–m\d+\) ← current/);
    assert.match(sections.stdout, /2 unassigned message/);
    const show = await runCli(['conversation', 'show', 's1'], { cwd: dir });
    assert.match(show.stdout, /\[s1\] Infrastructure: 2 message\(s\)[\s\S]*eu-west-3/);
    const unassigned = await runCli(['conversation', 'show', 'unassigned'], { cwd: dir });
    assert.match(unassigned.stdout, /genmaicha/);
    const search = await runCli(['conversation', 'search', 'genmaicha'], { cwd: dir });
    assert.match(search.stdout, /1 message\(s\) match "genmaicha"[\s\S]*\(unassigned\)/);
    const artifacts = await runCli(['conversation', 'artifacts'], { cwd: dir });
    assert.match(artifacts.stdout, /No artifacts/);
    assert.equal(readConversation(path.join(dir, '.sfagents', 'conversation.md')).state.sections.size, 1);
  });
});
