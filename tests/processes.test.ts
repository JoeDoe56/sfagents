import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ConversationService, loadAgentTree } from '@sfagents/core';
import {
  PerformanceMonitor,
  ProcessMonitor,
  SystemMonitor,
  WebServer,
  nodeSystemSource,
  parseDesktopEntry,
  parseDiskstatsByDisk,
  parseEtime,
  parseMeminfoFields,
  parseNetDevByInterface,
  parseProcStat,
  parsePs,
  parseSystemctl,
  parseWho,
} from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeJson } from './helpers.js';

describe('processes: parsers', () => {
  test('/proc/[pid]/stat with spaces and parentheses in the name', () => {
    const line = '4242 (Web Content (x)) S 1000 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 31 0 123456 1000000 2560 18446744073709551615';
    assert.deepEqual(parseProcStat(line), { comm: 'Web Content (x)', state: 'S', ppid: 1000, utime: 250, stime: 50, threads: 31, starttime: 123456, rss: 2560 });
  });

  test('ps (macOS): CPU as a share of the machine, names, start times', () => {
    const rows = parsePs('  501     1  50.0  20480   01:02:03 alice /Applications/Safari.app/Contents/MacOS/Safari\n    1     0   0.0   1024 3-00:00:00 root /sbin/launchd\n', 4, 1_000_000_000);
    assert.equal(rows[0]!.name, 'Safari');
    assert.equal(rows[0]!.cpu, 0.125);
    assert.equal(rows[0]!.memory, 20480 * 1024);
    assert.equal(rows[0]!.started, 1_000_000_000 - 3723 * 1000);
    assert.equal(rows[0]!.path, '/Applications/Safari.app/Contents/MacOS/Safari');
    assert.equal(parseEtime('3-00:00:00'), 259200);
    assert.equal(parseEtime('05:07'), 307);
  });

  test('who, systemctl, desktop entries', () => {
    assert.deepEqual(parseWho('alice    tty7         2026-10-19 09:12 (:0)\nbob      pts/1        2026-10-19 10:00\n'), [
      { user: 'alice', terminal: 'tty7', since: '2026-10-19 09:12', from: ':0' },
      { user: 'bob', terminal: 'pts/1', since: '2026-10-19 10:00', from: null },
    ]);
    assert.deepEqual(parseSystemctl('cron.service loaded active running Regular background program processing daemon\n● ssh.service loaded failed failed OpenBSD Secure Shell server\n'), [
      { name: 'cron.service', load: 'loaded', state: 'active', sub: 'running', description: 'Regular background program processing daemon' },
      { name: 'ssh.service', load: 'loaded', state: 'failed', sub: 'failed', description: 'OpenBSD Secure Shell server' },
    ]);
    assert.deepEqual(parseDesktopEntry('[Desktop Entry]\nName=Syncthing\nExec=syncthing -no-browser\nHidden=true\n[Desktop Action x]\nName=Other\n'), { Name: 'Syncthing', Exec: 'syncthing -no-browser', Hidden: 'true' });
  });

  test('performance parsers: per interface, per disk, meminfo', () => {
    assert.deepEqual(parseNetDevByInterface('h\nh\n  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n    lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n'), { eth0: { rx: 100, tx: 200 }, lo: { rx: 5, tx: 5 } });
    assert.deepEqual(parseDiskstatsByDisk('   8       0 sda 1 0 10 0 1 0 20 0 0 300 0 0 0 0 0\n   8       1 sda1 1 0 10 0 1 0 20 0 0 300 0 0 0 0 0\n'), { sda: { read: 5120, write: 10240, busy: 300 } });
    const f = parseMeminfoFields('MemTotal:       16384 kB\nCommitted_AS:    2048 kB\n');
    assert.deepEqual(f, { MemTotal: 16384 * 1024, Committed_AS: 2048 * 1024 });
  });
});

describe('processes: live (Linux)', { skip: process.platform !== 'linux' }, () => {
  test('a child process is listed with CPU, memory and its command; it can be lowered in priority and ended', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const monitor = new ProcessMonitor(nodeSystemSource());
      const { processes, self } = await monitor.list();
      assert.equal(self, process.pid);
      const row = processes.find((p) => p.pid === child.pid);
      assert.ok(row, 'child listed');
      assert.equal(row!.ppid, process.pid);
      assert.ok(row!.memory! > 0 && row!.threads! > 0 && row!.cpu !== null);
      const detail = await monitor.detail(child.pid);
      assert.match(detail.command ?? '', /setInterval/);
      assert.equal(detail.parent?.pid, process.pid);
      assert.equal(detail.protected, null);
      assert.equal(monitor.setPriority(child.pid, 'low').priority, 19);
      // SF Agents itself and the system's first process are refused.
      await assert.rejects(monitor.end(process.pid), /SF Agents itself/);
      await assert.rejects(monitor.end(1), (e: Error & { status?: number }) => e.status === 403);
      const ended = new Promise((r) => child.once('exit', r));
      assert.deepEqual((await monitor.end(child.pid)).ended, [child.pid]);
      await ended;
      await assert.rejects(monitor.detail(child.pid), /ended/);
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('End Process Tree ends the children first', async () => {
    const parent = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    try {
      const monitor = new ProcessMonitor(nodeSystemSource());
      let kids: number[] = [];
      for (let i = 0; i < 50 && !kids.length; i++) {
        await new Promise((r) => setTimeout(r, 100));
        kids = (await monitor.list()).processes.filter((p) => p.ppid === parent.pid).map((p) => p.pid);
      }
      assert.equal(kids.length, 1);
      const out = await monitor.end(parent.pid, { tree: true, force: true });
      assert.deepEqual(out.ended, [kids[0], parent.pid]);
    } finally {
      parent.kill('SIGKILL');
    }
  });

  test('performance detail: cores, memory breakdown, adapters, history', async () => {
    const perf = new PerformanceMonitor(new SystemMonitor(nodeSystemSource(), { lhm: null }));
    const d = await perf.detail();
    assert.equal(d.cpu.cores.length, d.system.cpus);
    assert.ok(d.memory.total > 0 && d.memory.available > 0);
    assert.ok(d.history.length >= 1 && d.detailHistory.length >= 1);
    assert.equal(d.system.os, 'Linux');
  });
});

describe('processes: HTTP API', () => {
  test('lists, details, ends processes; detail and SF Agents windows; cross-site reads refused', async () => {
    const dir = makeTempDir('sfagents-proc-web-');
    writeJson(path.join(dir, 'agent.json'), baseAgent('main'));
    const agents = loadAgentTree(path.join(dir, 'agent.json'));
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: agents.configDir });
    const server = new WebServer({ tree: agents, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, lhmUrl: null });
    const base = (await server.start()).replace(/\/$/, '');
    const get = (p: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const u = new URL(base + p);
        http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Host: u.host, ...headers } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(body || '{}') }));
        }).on('error', reject);
      });
    const post = (p: string, body: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const u = new URL(base + p);
        const data = JSON.stringify(body);
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: u.host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end(data);
      });
    try {
      const self = await get('/api/system/sfagents');
      assert.equal(self.status, 200);
      assert.equal(self.json['pid'], process.pid);
      assert.equal((self.json['agent'] as { id: string }).id, 'main');
      const detail = await get('/api/system/detail');
      assert.equal(detail.status, 200);
      assert.ok(Array.isArray(detail.json['history']));
      assert.equal((await get('/api/processes', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      if (process.platform === 'linux') {
        const list = await get('/api/processes');
        assert.ok((list.json['processes'] as { pid: number }[]).some((p) => p.pid === process.pid));
        const own = await post(`/api/processes/${process.pid}/end`, {});
        assert.equal(own.status, 403);
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        try {
          await new Promise((r) => setTimeout(r, 200));
          const one = await get(`/api/processes/${child.pid}`);
          assert.equal(one.status, 200);
          const ended = new Promise((r) => child.once('exit', r));
          assert.equal((await post(`/api/processes/${child.pid}/end`, { force: true })).status, 200);
          await ended;
        } finally {
          child.kill('SIGKILL');
        }
      }
      const startup = await get('/api/system/startup');
      assert.equal(startup.status, 200);
    } finally {
      await server.close();
      conversation.close();
    }
  });
});
