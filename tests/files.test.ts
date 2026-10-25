import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ConversationService, loadAgentTree } from '@sfagents/core';
import { FileService, Trash, WebServer, chunkHash, crc32, extractZip, readZipEntries, safeEntryPath, up2kChunkSize, writeZip, zipSourcesFor, type Job } from '@sfagents/web';
import { baseAgent, makeTempDir, scriptedFactory, writeJson, writeAgent } from './helpers.js';

function tree(root: string, files: Record<string, string | null>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (content === null) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

async function settle(service: FileService, job: Job): Promise<Job> {
  let j = job;
  while (j.state === 'running') {
    await new Promise((r) => setTimeout(r, 20));
    j = service.job(j.id)!;
  }
  return j;
}

function setup() {
  const home = makeTempDir('sfagents-home-');
  const state = path.join(home, 'project', '.sfagents');
  fs.mkdirSync(state, { recursive: true });
  const env = { XDG_DATA_HOME: path.join(home, '.local', 'share') };
  const trash = new Trash({ platform: 'linux', home, stateDir: state, env });
  const service = new FileService({ home, stateDir: state, projectDir: path.join(home, 'project'), env, trash });
  return { home, state, service };
}

describe('files: ZIP', () => {
  test('crc32 matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  test('round trip: folders, empty files, UTF-8 names, stored and deflated entries', async () => {
    const dir = makeTempDir('sfagents-zip-');
    tree(dir, { 'Photos/a.jpg': 'x'.repeat(5000), 'Photos/sub/b.txt': 'hello '.repeat(1000), 'Photos/zero.txt': '', 'Photos/sub/naïve.txt': 'é', 'Empty': null });
    const zip = path.join(dir, 'out.zip');
    const out = fs.createWriteStream(zip);
    const r = await writeZip(zipSourcesFor([path.join(dir, 'Photos'), path.join(dir, 'Empty')]), out);
    await new Promise<void>((res) => out.end(res));
    assert.equal(r.entries, 7);
    const entries = await readZipEntries(zip);
    assert.deepEqual(entries.map((e) => [e.name, e.method]), [['Photos/', 0], ['Photos/a.jpg', 0], ['Photos/sub/', 0], ['Photos/sub/b.txt', 8], ['Photos/sub/naïve.txt', 8], ['Photos/zero.txt', 0], ['Empty/', 0]]);
    const res = await extractZip(zip, path.join(dir, 'x'));
    assert.deepEqual(res, { files: 4, folders: 3, skipped: [] });
    assert.equal(fs.readFileSync(path.join(dir, 'x', 'Photos', 'sub', 'b.txt'), 'utf8'), 'hello '.repeat(1000));
    assert.equal(fs.readFileSync(path.join(dir, 'x', 'Photos', 'sub', 'naïve.txt'), 'utf8'), 'é');
  });

  test('entry names cannot escape the destination', () => {
    assert.equal(safeEntryPath('../../etc/passwd'), null);
    assert.equal(safeEntryPath('/abs/file'), 'abs/file');
    assert.equal(safeEntryPath('C:\\\\Windows\\\\x.txt'), 'Windows/x.txt');
    assert.equal(safeEntryPath('a/./b/../c'), null);
    assert.equal(safeEntryPath('ok/CON.txt'), null);
  });
});

describe('files: service', () => {
  test('listing: hidden items, folder counts, types, writability', async () => {
    const { home, service } = setup();
    tree(home, { 'Docs/a.pdf': 'pdf', 'Docs/notes.md': '# hi', 'Docs/.secret': 's', 'Docs/Sub/x.txt': 'x' });
    const listed = await service.list(path.join(home, 'Docs'));
    assert.deepEqual(listed.entries.map((e) => [e.name, e.kind, e.type]).sort(), [['Sub', 'folder', 'Folder'], ['a.pdf', 'pdf', 'PDF document'], ['notes.md', 'text', 'Markdown document']]);
    assert.equal(listed.entries.find((e) => e.name === 'Sub')!.items, 1);
    assert.equal(listed.parent, home);
    assert.ok((await service.list(path.join(home, 'Docs'), { hidden: true })).entries.some((e) => e.name === '.secret'));
    await assert.rejects(service.list('relative/path'), /full path/);
    await assert.rejects(service.list(path.join(home, 'Docs', 'a.pdf')), /not a folder/);
  });

  test('new folder, new file, rename, and the names that are refused', async () => {
    const { home, service } = setup();
    const folder = await service.mkdir(home, 'New Folder');
    assert.equal(folder.kind, 'folder');
    await assert.rejects(service.mkdir(home, 'New Folder'), /already exists/);
    await assert.rejects(service.mkdir(home, 'a/b'), /can't contain/);
    const file = await service.createFile(folder.path, 'untitled.txt', 'hi');
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'hi');
    const renamed = await service.rename(file.path, 'renamed.txt');
    assert.equal(renamed.name, 'renamed.txt');
    fs.writeFileSync(path.join(folder.path, 'taken.txt'), '');
    await assert.rejects(service.rename(renamed.path, 'taken.txt'), /already exists/);
  });

  test('protected places: roots, home and the state folder', async () => {
    const { home, state, service } = setup();
    await assert.rejects(service.rename(home, 'x'), /home folder/);
    await assert.rejects(service.moveToTrash([state]), /running conversation/);
    await assert.rejects(service.remove([path.join(state, 'x')]), /running conversation/);
    await assert.rejects(service.remove([path.dirname(state)]), /running conversation/);
    await assert.rejects(service.remove(['/']), /drive/);
    tree(home, { 'f.txt': 'x' });
    await assert.rejects(service.copy([path.join(home, 'f.txt')], state), /state folder/);
  });

  test('copy and move: conflicts are reported, then keep both, replace or skip', async () => {
    const { home, service } = setup();
    tree(home, { 'A/report.pdf': 'new', 'A/photo.jpg': 'p', 'B/report.pdf': 'old' });
    const sources = [path.join(home, 'A', 'report.pdf'), path.join(home, 'A', 'photo.jpg')];
    await assert.rejects(service.copy(sources, path.join(home, 'B')), (e: Error & { status?: number; details?: { conflicts: unknown[] } }) => e.status === 409 && e.details?.conflicts.length === 1);
    let job = await settle(service, await service.copy(sources, path.join(home, 'B'), 'keep'));
    assert.equal(job.state, 'done');
    assert.deepEqual(fs.readdirSync(path.join(home, 'B')).sort(), ['photo.jpg', 'report 2.pdf', 'report.pdf']);
    job = await settle(service, await service.copy([sources[0]!], path.join(home, 'B'), 'replace'));
    assert.equal(fs.readFileSync(path.join(home, 'B', 'report.pdf'), 'utf8'), 'new');
    job = await settle(service, await service.move(sources, path.join(home, 'B'), 'skip'));
    assert.equal(job.state, 'done');
    // Both existed in B, so both were skipped and stay in A.
    assert.deepEqual(fs.readdirSync(path.join(home, 'A')).sort(), ['photo.jpg', 'report.pdf']);
    await assert.rejects(service.move([path.join(home, 'A')], path.join(home, 'A')), /inside itself/);
    job = await settle(service, await service.move([path.join(home, 'A')], path.join(home, 'B')));
    assert.ok(fs.existsSync(path.join(home, 'B', 'A', 'photo.jpg')) && !fs.existsSync(path.join(home, 'A')));
  });

  test('duplicate uses Finder names; copying into the same folder duplicates', async () => {
    const { home, service } = setup();
    tree(home, { 'D/report.pdf': 'r', 'D/Folder/x.txt': 'x' });
    await settle(service, await service.duplicate([path.join(home, 'D', 'report.pdf'), path.join(home, 'D', 'Folder')]));
    await settle(service, await service.duplicate([path.join(home, 'D', 'report.pdf')]));
    await settle(service, await service.copy([path.join(home, 'D', 'report.pdf')], path.join(home, 'D')));
    assert.deepEqual(fs.readdirSync(path.join(home, 'D')).sort(), ['Folder', 'Folder copy', 'report copy 2.pdf', 'report copy 3.pdf', 'report copy.pdf', 'report.pdf']);
    assert.equal(fs.readFileSync(path.join(home, 'D', 'Folder copy', 'x.txt'), 'utf8'), 'x');
  });

  test('Trash (freedesktop): trash, Put Back, keep both on return, empty', async () => {
    const { home, state, service } = setup();
    tree(home, { 'T/keep.txt': 'k', 'T/gone.txt': 'g', 'T/Folder/inner.txt': 'i' });
    const job = await settle(service, await service.moveToTrash([path.join(home, 'T', 'gone.txt'), path.join(home, 'T', 'Folder')]));
    assert.equal(job.state, 'done', job.error);
    const trashFiles = path.join(home, '.local', 'share', 'Trash', 'files');
    assert.deepEqual(fs.readdirSync(trashFiles).sort(), ['Folder', 'gone.txt']);
    const info = fs.readFileSync(path.join(home, '.local', 'share', 'Trash', 'info', 'gone.txt.trashinfo'), 'utf8');
    assert.match(info, /^\[Trash Info\]\nPath=.*\/T\/gone\.txt\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
    const entry = await service.info(path.join(trashFiles, 'gone.txt'));
    assert.equal(entry.restorable, true);
    // Something new took the old name: Put Back keeps both.
    fs.writeFileSync(path.join(home, 'T', 'gone.txt'), 'new');
    const back = await settle(service, await service.restore([path.join(trashFiles, 'gone.txt')]));
    assert.deepEqual((back.result as { restored: string[] }).restored, [path.join(home, 'T', 'gone 2.txt')]);
    // Another app's item, known only from its .trashinfo.
    fs.writeFileSync(path.join(state, 'trash-log.json'), '[]');
    const again = await settle(service, await service.restore([path.join(trashFiles, 'Folder')]));
    assert.equal(again.state, 'done', again.error);
    assert.ok(fs.existsSync(path.join(home, 'T', 'Folder', 'inner.txt')));
    await settle(service, await service.moveToTrash([path.join(home, 'T', 'keep.txt')]));
    await settle(service, await service.emptyTrash());
    assert.deepEqual(fs.readdirSync(trashFiles), []);
    assert.deepEqual(fs.readdirSync(path.join(home, '.local', 'share', 'Trash', 'info')), []);
  });

  test('delete permanently, compress and uncompress like Archive Utility', async () => {
    const { home, service } = setup();
    tree(home, { 'Z/Photos/a.txt': 'a', 'Z/Photos/b/c.txt': 'c', 'Z/one.txt': '1', 'Z/two.txt': '2' });
    const one = await settle(service, await service.compress([path.join(home, 'Z', 'Photos')]));
    assert.equal((one.result as { path: string }).path, path.join(home, 'Z', 'Photos.zip'));
    const many = await settle(service, await service.compress([path.join(home, 'Z', 'one.txt'), path.join(home, 'Z', 'two.txt')]));
    assert.equal((many.result as { path: string }).path, path.join(home, 'Z', 'Archive.zip'));
    // One top-level folder: extracted as that folder ("Photos 2", since Photos exists).
    const x1 = await settle(service, await service.extract(path.join(home, 'Z', 'Photos.zip')));
    assert.equal((x1.result as { path: string }).path, path.join(home, 'Z', 'Photos 2'));
    assert.equal(fs.readFileSync(path.join(home, 'Z', 'Photos 2', 'b', 'c.txt'), 'utf8'), 'c');
    // Loose files: into a folder named after the archive.
    const x2 = await settle(service, await service.extract(path.join(home, 'Z', 'Archive.zip')));
    assert.deepEqual(fs.readdirSync((x2.result as { path: string }).path).sort(), ['one.txt', 'two.txt']);
    assert.equal(path.basename((x2.result as { path: string }).path), 'Archive');
    const del = await settle(service, await service.remove([path.join(home, 'Z', 'Photos 2')]));
    assert.equal(del.state, 'done');
    assert.ok(!fs.existsSync(path.join(home, 'Z', 'Photos 2')));
    assert.ok(!fs.readdirSync(path.join(home, 'Z')).some((n) => n.startsWith('.sfagents-extract')));
  });

  test('search, folder size, text editing with change detection', async () => {
    const { home, service } = setup();
    tree(home, { 'S/Quarterly Report.pdf': 'xx', 'S/deep/er/report-final.txt': 'yyy', 'S/other.txt': 'z', 'S/.hidden/report.txt': 'h' });
    const found = await service.search(path.join(home, 'S'), 'report');
    assert.deepEqual(found.results.map((r) => r.name).sort(), ['Quarterly Report.pdf', 'report-final.txt']);
    assert.equal((await service.search(path.join(home, 'S'), 'quarterly pdf')).results.length, 1);
    const size = await service.folderSize(path.join(home, 'S'));
    assert.deepEqual(size, { size: 2 + 3 + 1 + 1, files: 4, folders: 3, complete: true });
    const t = await service.readText(path.join(home, 'S', 'other.txt'));
    await service.writeText(t.path, 'edited', t.modified);
    assert.equal(fs.readFileSync(t.path, 'utf8'), 'edited');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(t.path, later, later);
    await assert.rejects(service.writeText(t.path, 'again', t.modified), /changed on disk/);
    fs.writeFileSync(path.join(home, 'S', 'bin.dat'), Buffer.from([1, 0, 2]));
    await assert.rejects(service.readText(path.join(home, 'S', 'bin.dat')), /not text/);
  });

  test('locations: home, standard folders (localized on Linux), the project and the trash', async () => {
    const { home, service } = setup();
    const pictures = process.platform === 'linux' ? 'Bilder' : 'Pictures';
    tree(home, { 'Desktop': null, 'Downloads': null, [pictures]: null, '.config/user-dirs.dirs': 'XDG_PICTURES_DIR="$HOME/Bilder"\n' });
    const loc = await service.locations();
    assert.deepEqual(loc.places.map((p) => p.name), [path.basename(home), 'Desktop', 'Downloads', pictures]);
    assert.equal(loc.project, path.join(home, 'project'));
    assert.equal(loc.trash, path.join(home, '.local', 'share', 'Trash', 'files'));
  });

  test('Trash on another platform layout (macOS ~/.Trash)', async () => {
    const home = makeTempDir('sfagents-mac-');
    tree(home, { 'doc.txt': 'd', '.Trash/doc.txt': 'older' });
    const trash = new Trash({ platform: 'darwin', home, stateDir: path.join(home, 'state') });
    const [out] = await trash.trash([path.join(home, 'doc.txt')]);
    assert.equal(out!.trashPath, path.join(home, '.Trash', 'doc 2.txt'));
    const [back] = await trash.restore([out!.trashPath!]);
    assert.equal(back!.path, path.join(home, 'doc.txt'));
  });
});

// ------------------------------------------------------------------ HTTP

function request(base: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: options.method ?? 'GET', headers: { Host: u.host, ...(options.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function post(base: string, pathname: string, body: unknown) {
  const r = await request(base, pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: JSON.parse(r.body.toString() || '{}') as Record<string, unknown> };
}

describe('files: HTTP API', () => {
  test('list, ranges, ZIP download, operations, upload into a folder, attach, and cross-site reads refused', async () => {
    const dir = makeTempDir('sfagents-files-web-');
    writeAgent(dir, baseAgent('main'));
    const agents = loadAgentTree(path.join(dir, 'agent.json'));
    const conversation = ConversationService.open(path.join(dir, '.sfagents', 'conversation.md'), { configDir: agents.configDir });
    const server = new WebServer({ tree: agents, conversation, port: 0, providerFactory: scriptedFactory(() => ({ text: 'ok' })).factory, lhmUrl: null, auth: false });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const work = path.join(dir, 'work');
      tree(work, { 'movie.mp4': '0123456789', 'Folder/a.txt': 'aaa', 'page.html': '<script>alert(1)</script>' });
      const list = JSON.parse((await request(base, `/api/files/list?path=${encodeURIComponent(work)}`)).body.toString());
      assert.deepEqual(list.entries.map((e: { name: string }) => e.name).sort(), ['Folder', 'movie.mp4', 'page.html']);
      // Byte ranges for media.
      const ranged = await request(base, `/api/files/raw?path=${encodeURIComponent(path.join(work, 'movie.mp4'))}`, { headers: { Range: 'bytes=2-5' } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers['content-range'], 'bytes 2-5/10');
      assert.equal(ranged.body.toString(), '2345');
      assert.equal(ranged.headers['content-type'], 'video/mp4');
      // HTML from disk never runs scripts.
      const html = await request(base, `/api/files/raw?path=${encodeURIComponent(path.join(work, 'page.html'))}`);
      assert.match(String(html.headers['content-security-policy']), /^sandbox; default-src 'none'/);
      // Another site cannot read files, even by embedding them.
      assert.equal((await request(base, `/api/files/raw?path=${encodeURIComponent(path.join(work, 'movie.mp4'))}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await request(base, `/api/files/list?path=${encodeURIComponent(work)}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
      // A folder downloads as a ZIP archive.
      const zipped = await request(base, `/api/files/zip?path=${encodeURIComponent(path.join(work, 'Folder'))}`);
      assert.equal(zipped.status, 200);
      assert.match(String(zipped.headers['content-disposition']), /Folder\.zip/);
      fs.writeFileSync(path.join(dir, 'dl.zip'), zipped.body);
      assert.deepEqual((await readZipEntries(path.join(dir, 'dl.zip'))).map((e) => e.name), ['Folder/', 'Folder/a.txt']);
      // Operations, conflicts as 409 with the list.
      assert.equal((await post(base, '/api/files/mkdir', { dir: work, name: 'Made' })).status, 200);
      const clash = await post(base, '/api/files/copy', { paths: [path.join(work, 'Folder', 'a.txt')], dest: work });
      assert.equal(clash.status, 200); // same folder: a duplicate, not a conflict
      fs.writeFileSync(path.join(work, 'Made', 'a.txt'), 'other');
      const conflict = await post(base, '/api/files/move', { paths: [path.join(work, 'Folder', 'a.txt')], dest: path.join(work, 'Made') });
      assert.equal(conflict.status, 409);
      assert.equal((conflict.json['conflicts'] as unknown[]).length, 1);
      const moved = await post(base, '/api/files/move', { paths: [path.join(work, 'Folder', 'a.txt')], dest: path.join(work, 'Made'), conflict: 'keep' });
      assert.equal(moved.status, 200);
      let job = moved.json as unknown as Job;
      while (job.state === 'running') job = JSON.parse((await request(base, `/api/files/jobs?id=${job.id}`)).body.toString());
      assert.deepEqual(fs.readdirSync(path.join(work, 'Made')).sort(), ['a 2.txt', 'a.txt']);
      // The state folder is protected over HTTP too.
      assert.equal((await post(base, '/api/files/delete', { paths: [path.join(dir, '.sfagents')] })).status, 403);
      // Upload into a folder with up2k: placed there under a free name.
      const data = Buffer.from('uploaded bytes');
      const hashes = [chunkHash(data)];
      assert.equal(up2kChunkSize(data.length), 1024 * 1024);
      const hs = await post(base, '/api/up2k/handshake', { name: 'a.txt', size: data.length, hashes, dest: path.join(work, 'Made') });
      assert.equal(hs.status, 200, JSON.stringify(hs.json));
      const chunk = await request(base, '/api/up2k/chunk', { method: 'POST', headers: { 'X-Up2k-Wark': String(hs.json['wark']), 'X-Up2k-Hash': hashes[0]!, 'Content-Type': 'application/octet-stream' }, body: data });
      const placed = JSON.parse(chunk.body.toString());
      assert.equal(placed.file.path, path.join(work, 'Made', 'a 3.txt'));
      assert.equal(fs.readFileSync(placed.file.path, 'utf8'), 'uploaded bytes');
      assert.equal((await post(base, '/api/up2k/handshake', { name: 'x', size: data.length, hashes, dest: path.join(dir, '.sfagents') })).status, 403);
      // Ask SF Agents: a file becomes an attachment.
      const attached = await post(base, '/api/files/attach', { path: path.join(work, 'movie.mp4') });
      assert.equal((attached.json['attachment'] as { name: string }).name, 'movie.mp4');
    } finally {
      await server.close();
      conversation.close();
    }
  });
});
