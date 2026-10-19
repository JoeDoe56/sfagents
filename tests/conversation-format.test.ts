import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ConversationFormatError,
  ConversationState,
  parseConversation,
  serializeConversation,
  serializeRecord,
  type ConversationRecord,
  type MessageRecord,
} from '@sfagents/core';
import { REPO_ROOT } from './helpers.js';

const FIXTURE = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'conversation-v1.md'), 'utf8');

function load(text: string) {
  const parsed = parseConversation(text, 'test.md');
  return { parsed, state: ConversationState.from(parsed.records, parsed.lines, 'test.md') };
}

function header(): ConversationRecord {
  return { kind: 'conversation', seq: 1, time: '2026-10-18T00:00:00.000Z', v: 1, id: 'c', conversationKind: 'main' };
}
function msg(seq: number, content: string, extra: Partial<MessageRecord> = {}): MessageRecord {
  return { kind: 'message', seq, time: '2026-10-18T00:00:00.000Z', id: `m${seq}`, run: 'r1', role: 'user', agent: 'main', content, ...extra };
}

describe('conversation format v1', () => {
  test('reference fixture: messages, tool exchange, sections, artifacts, reset, interruption', () => {
    const { parsed, state } = load(FIXTURE);
    assert.equal(parsed.damagedTail, undefined);
    assert.equal(parsed.completeBytes, Buffer.byteLength(FIXTURE));
    assert.equal(state.header!.id, 'c_demo');
    assert.equal(state.messages.length, 12);
    // Sections: nested, renamed, moved.
    assert.deepEqual([...state.sections.values()].map((s) => [s.id, s.title, s.parent]), [
      ['s1', 'Uploader project', null],
      ['s2', 'Retry and backoff', 's1'],
      ['s3', 'Cooking', null],
    ]);
    assert.equal(state.structureRevision, 5);
    assert.equal(state.currentSection, 's3');
    assert.equal(state.sectionOf('m3'), 's2');
    assert.equal(state.sectionOf('m17'), 's3');
    assert.equal(state.sectionOf('m6'), undefined, 'tool results are not assigned');
    // Tool exchange and opaque reasoning payload.
    const m4 = state.messageById.get('m4')!;
    assert.deepEqual(m4.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: '{"file_path":"src/upload.ts"}' }]);
    assert.equal(m4.reasoningDetails![0]!['signature'], 'EqQBCkYIBxgCKkB0');
    assert.match(state.messageById.get('m6')!.content, /```inline backticks``` inside output$/);
    // Child transcript and document artifacts.
    assert.deepEqual(state.artifacts.map((a) => [a.id, a.type, a.path]), [
      ['a21', 'agent_transcript', 'transcripts/r4p5q6r7s8t.md'],
      ['a25', 'document', 'docs/uploader-retry-plan.md'],
    ]);
    assert.equal(state.lastResetSeq, 27);
    // Interrupted run is recognized, with call classification.
    const r5 = state.runs.get('r5u6v7w8x9y')!;
    assert.deepEqual(r5.interrupted && [r5.interrupted.notStarted, r5.interrupted.unknown], [['call_4'], ['call_3']]);
    assert.equal(state.unfinishedRuns().length, 0);
    // Tricky body survives exactly.
    const tricky = state.messageById.get('m12')!.content;
    assert.match(tricky, /const x = "<!-- sfa:end Q7f2 -->";/);
    assert.match(tricky, /<!-- sfa:message \{"id":"fake"\} --> ← also just text/);
    assert.match(tricky, /café, 日本語, emoji 🚀, RTL שלום — and a literal --> arrow\.$/);
  });

  test('parse → serialize → parse preserves all semantic data', () => {
    const first = parseConversation(FIXTURE).records;
    const again = parseConversation(serializeConversation(first)).records;
    assert.deepEqual(again, first);
  });

  test('bodies containing their own delimiters, fences and CRLF round-trip exactly', () => {
    const nasty = [
      '<!-- sfa:end AAAA -->',
      '<!-- sfa:end BBBB -->\r\nwindows line\r\n',
      '````\n```\nunclosed fence',
      '',
      '\n\nleading and trailing newlines\n\n',
      '<!-- sfa:message {"seq":99} -->',
      'no newline at end',
    ];
    const records: ConversationRecord[] = [header(), ...nasty.map((c, i) => msg(i + 2, c))];
    records.push({ ...msg(records.length + 1, '', { role: 'assistant', toolCalls: [{ id: 'c1', name: 'x', arguments: '{"s":"--> <!-- -->"}' }] }) });
    records.push({ ...msg(records.length + 1, '`````\nfive backticks\n`````', { role: 'tool', callId: 'c1', tool: 'x', status: 'ok' }) });
    const text = serializeConversation(records);
    const back = parseConversation(text).records as MessageRecord[];
    assert.deepEqual(back.slice(1).map((m) => m.content), [...nasty, '', '`````\nfive backticks\n`````']);
    assert.equal(back[back.length - 2]!.toolCalls![0]!.arguments, '{"s":"--> <!-- -->"}');
    assert.doesNotMatch(text.split('\n').filter((l) => l.startsWith('<!-- sfa:message')).join('\n'), /-->.*-->/, 'no early --> inside header JSON');
  });

  test('a file whose frames were converted to CRLF still parses', () => {
    const records: ConversationRecord[] = [header(), msg(2, 'single line'), msg(3, 'tool out', { role: 'assistant', toolCalls: [{ id: 'k', name: 't', arguments: '{}' }] })];
    records.push(msg(4, 'result text', { role: 'tool', callId: 'k', tool: 't' }));
    const crlf = serializeConversation(records).replace(/\n/g, '\r\n');
    const back = parseConversation(crlf).records as MessageRecord[];
    assert.deepEqual(back.slice(1).map((m) => m.content), ['single line', 'tool out', 'result text']);
  });

  test('unknown fields are preserved', () => {
    const text = serializeConversation([header()]).replace('"kind":"main"', '"kind":"main","futureField":{"a":1}');
    const back = parseConversation(text).records;
    assert.deepEqual(back[0]!.extra, { futureField: { a: 1 } });
    assert.match(serializeConversation(back), /"futureField":\{"a":1\}/);
  });

  test('newer format versions are refused with a clear message', () => {
    const text = serializeConversation([{ ...(header() as object), v: 2 } as ConversationRecord]);
    assert.throws(() => parseConversation(text), /format version 2 is newer than this SF Agents supports/);
  });

  test('malformed records are reported with line numbers, never dropped silently', () => {
    const good = serializeConversation([header(), msg(2, 'hello')]);
    const cases: Array<[string, RegExp]> = [
      [good + '\nstray paragraph\n', /line \d+: unexpected text between records/],
      [good + '\n<!-- sfa:bogus {"seq":3,"time":"x"} -->\n\n' + serializeRecord(msg(4, 'x')), /unknown record kind "bogus"/],
      [good + '\n<!-- sfa:context_reset {"seq":9,"time":"x"} -->\n', /expected seq 3, found 9/],
      [good + '\n<!-- sfa:message {"seq":3 not json -->\n\n<!-- sfa:context_reset {"seq":4,"time":"x"} -->\n', /line 7: malformed SF Agents header line/],
      [serializeConversation([msg(1, 'x')]), /first record must be a "conversation" header/],
    ];
    for (const [text, re] of cases) {
      assert.throws(() => parseConversation(text), (e: unknown) => e instanceof ConversationFormatError && re.test(e.message), re.source);
    }
  });

  test('semantic validation: duplicate ids, invalid references, cycles', () => {
    const base: ConversationRecord[] = [header(), msg(2, 'a')];
    const t = '2026-10-18T00:00:00.000Z';
    const cases: Array<[ConversationRecord[], RegExp]> = [
      [[...base, { ...msg(3, 'b'), id: 'm2' }], /duplicate message id m2/],
      [[...base, msg(3, 'r', { role: 'tool', callId: 'nope', tool: 'x' })], /which no assistant message in run r1 requested/],
      [[...base, { kind: 'section', seq: 3, time: t, op: 'add', section: 's1', title: 'A', parent: 's9', expected: 0, rev: 1 }], /unknown parent section s9/],
      [
        [
          ...base,
          { kind: 'section', seq: 3, time: t, op: 'add', section: 's1', title: 'A', expected: 0, rev: 1 },
          { kind: 'section', seq: 4, time: t, op: 'add', section: 's2', title: 'B', parent: 's1', expected: 1, rev: 2 },
          { kind: 'section', seq: 5, time: t, op: 'edit', section: 's1', parent: 's2', expected: 2, rev: 3 },
        ],
        /would create a cycle/,
      ],
      [[...base, { kind: 'section', seq: 3, time: t, op: 'add', section: 's1', title: 'A', assign: ['m99'], expected: 0, rev: 1 }], /unknown message m99/],
      [[...base, { kind: 'section', seq: 3, time: t, op: 'add', section: 's1', title: 'A', expected: 0, rev: 7 }], /revision 7 does not follow 0/],
      [[...base, { kind: 'run_end', seq: 3, time: t, run: 'r1', status: 'GOAL', turns: 1 }], /run_end for unknown run r1/],
    ];
    for (const [records, re] of cases) {
      const parsed = parseConversation(serializeConversation(records));
      assert.throws(() => ConversationState.from(parsed.records, parsed.lines, 'x.md'), (e: unknown) => e instanceof ConversationFormatError && re.test(e.message), re.source);
    }
  });

  test('an unfinished trailing record is reported as a damaged tail, earlier records intact', () => {
    const complete = serializeConversation([header(), msg(2, 'kept')]);
    const partialMessage = serializeRecord(msg(3, 'lost in a crash')).slice(0, -25);
    for (const tail of ['\n' + partialMessage, '\n<!-- sfa:mess', '\n<!-- sfa:run_end {"seq":3,"ti']) {
      const parsed = parseConversation(complete + tail);
      assert.ok(parsed.damagedTail, JSON.stringify(tail));
      assert.equal(parsed.records.length, 2);
      assert.equal(parsed.completeBytes, Buffer.byteLength(complete) + 1);
    }
  });
});
