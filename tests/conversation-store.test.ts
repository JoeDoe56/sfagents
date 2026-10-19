import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ConversationLock,
  ConversationLockedError,
  ConversationStorageError,
  FileConversationStore,
  InvalidOperationError,
  readConversation,
  type MessageRecord,
} from '@sfagents/core';
import { makeTempDir } from './helpers.js';

const MAIN = { header: { conversationKind: 'main' as const } };

function user(content: string) {
  return { kind: 'message' as const, id: 'm0', run: 'r1', role: 'user' as const, agent: 'main', content };
}
function appendUser(store: FileConversationStore, content: string) {
  return store.append({ ...user(content), id: `m${store.state.nextSeq}` });
}

describe('conversation lock', () => {
  test('a second writer gets a clear error; release lets it in', () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'conversation.lock');
    const first = ConversationLock.acquire(lockPath);
    assert.throws(() => ConversationLock.acquire(lockPath), (e: unknown) => e instanceof ConversationLockedError && /in use by process \d+ on this computer/.test(e.message));
    first.release();
    const second = ConversationLock.acquire(lockPath);
    second.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('a lock left by a dead process on this host is replaced', () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'conversation.lock');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: Number(dead.stdout), host: os.hostname(), started: '2026-01-01T00:00:00Z' }));
    const lock = ConversationLock.acquire(lockPath);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
    lock.release();
  });

  test('a lock held on another host is never assumed stale', () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'conversation.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, host: 'some-other-machine', started: '2026-01-01T00:00:00Z' }));
    assert.throws(() => ConversationLock.acquire(lockPath), /another host \(some-other-machine\)[\s\S]*sfagents conversation unlock/);
  });

  test('a fresh unreadable lock is respected; an old one is stale', () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, 'conversation.lock');
    fs.writeFileSync(lockPath, '');
    assert.throws(() => ConversationLock.acquire(lockPath), /could not be read/);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, old, old);
    ConversationLock.acquire(lockPath).release();
  });
});

describe('file conversation store', () => {
  test('creates, appends durably and reopens with identical state', () => {
    const file = path.join(makeTempDir(), 'conversation.md');
    const store = FileConversationStore.open(file, MAIN);
    assert.equal(store.report.created, true);
    appendUser(store, 'first');
    appendUser(store, 'second\r\nwith CRLF and <!-- sfa:end x -->');
    store.close();
    const reopened = FileConversationStore.open(file, MAIN);
    assert.equal(reopened.report.created, false);
    assert.deepEqual(reopened.state.messages.map((m) => m.content), ['first', 'second\r\nwith CRLF and <!-- sfa:end x -->']);
    appendUser(reopened, 'third');
    reopened.close();
    assert.equal(readConversation(file).state.messages.length, 3);
  });

  test('invalid records are rejected before anything is written', () => {
    const file = path.join(makeTempDir(), 'conversation.md');
    const store = FileConversationStore.open(file, MAIN);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(
      () => store.append({ kind: 'message', id: 'm2', run: 'r1', role: 'tool', agent: 'main', callId: 'nope', tool: 'x', content: 'x' }),
      InvalidOperationError,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    appendUser(store, 'still works');
    store.close();
  });

  test('external edits while open stop writing instead of interleaving', () => {
    const file = path.join(makeTempDir(), 'conversation.md');
    const store = FileConversationStore.open(file, MAIN);
    appendUser(store, 'ours');
    fs.appendFileSync(file, '\nsomeone else was here\n');
    assert.throws(() => appendUser(store, 'next'), (e: unknown) => e instanceof ConversationStorageError && /changed by another program/.test(e.message));
    assert.throws(() => appendUser(store, 'again'), ConversationStorageError, 'store stays stopped');
    store.close();
  });

  test('a disk write failure is reported and stops further writes', () => {
    const file = path.join(makeTempDir(), 'conversation.md');
    let failNext = false;
    const store = FileConversationStore.open(file, {
      ...MAIN,
      io: {
        write: (fd, data) => {
          if (failNext) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          fs.writeSync(fd, data);
        },
      },
    });
    appendUser(store, 'ok');
    failNext = true;
    assert.throws(() => appendUser(store, 'lost'), /failed to write .*ENOSPC/);
    failNext = false;
    assert.throws(() => appendUser(store, 'after'), ConversationStorageError);
    assert.equal(store.state.messages.length, 1, 'state only reflects committed records');
    store.close();
  });

  test('a damaged trailing record is moved aside, recorded and never silently dropped', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'conversation.md');
    const store = FileConversationStore.open(file, MAIN);
    appendUser(store, 'committed');
    store.close();
    const partial = '\n<!-- sfa:message {"seq":3,"time":"2026-10-18T00:00:00.000Z","id":"m3","run":"r1","role":"user","agent":"main","b":"ZZZZ"} --><b>User</b>\nhalf a mess';
    fs.appendFileSync(file, partial);
    const reopened = FileConversationStore.open(file, MAIN);
    assert.match(reopened.report.recoveredReason!, /no closing marker/);
    const saved = path.join(dir, reopened.report.recoveredTo!);
    assert.equal(fs.readFileSync(saved, 'utf8'), partial.slice(1));
    const last = reopened.state.records[reopened.state.records.length - 1]!;
    assert.equal(last.kind, 'recovery');
    assert.deepEqual(reopened.state.messages.map((m) => m.content), ['committed']);
    appendUser(reopened, 'continues');
    reopened.close();
    assert.equal(readConversation(file).state.messages.length, 2);
  });

  test('damage in the middle of the file refuses to open for writing', () => {
    const file = path.join(makeTempDir(), 'conversation.md');
    const store = FileConversationStore.open(file, MAIN);
    appendUser(store, 'a');
    appendUser(store, 'b');
    store.close();
    const text = fs.readFileSync(file, 'utf8').replace('"role":"user"', '"role":"wizard"');
    fs.writeFileSync(file, text);
    assert.throws(() => FileConversationStore.open(file, MAIN), /line 3: message record: "role" must be user, assistant or tool/);
  });

  test('a validated manual edit made while closed is accepted', () => {
    const file = path.join(makeTempDir(), 'conversation.md');
    const store = FileConversationStore.open(file, MAIN);
    appendUser(store, 'typo here');
    store.close();
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('typo here', 'fixed by hand'));
    const reopened = FileConversationStore.open(file, MAIN);
    assert.equal((reopened.state.messages[0] as MessageRecord).content, 'fixed by hand');
    reopened.close();
  });
});
