/**
 * Resumable, deduplicating, chunked uploads in the style of copyparty's
 * up2k (https://github.com/9001/copyparty). This is an independent
 * implementation of the same protocol ideas, not copyparty code:
 *
 *  1. The client splits a file into chunks (size from `up2kChunkSize`) and
 *     hashes each one: SHA-512, first 33 bytes, base64url (44 characters).
 *  2. Handshake: the client posts {name, size, mime, lmod, hashes}. The
 *     server derives the upload's identity, the "wark"
 *     (sha512(salt, size, hashes)), and answers with the chunks it still
 *     needs. A file the server already has needs none (deduplication); an
 *     interrupted upload needs only what is missing (resume).
 *  3. The client posts needed chunks, several in parallel, each request
 *     naming the wark and one or more consecutive chunk hashes. The server
 *     verifies every chunk's hash and writes it straight into its place in
 *     a sparse file; there is no merge step.
 *  4. When every chunk has arrived, the file is moved to
 *     `uploads/<id>/<name>` and becomes an attachment that messages can
 *     reference. A later handshake returns it directly. An upload made
 *     into a folder (the file manager's Upload) is moved there instead,
 *     keeping both if the name is taken.
 *
 * Partial uploads survive server restarts (state is kept beside the sparse
 * file) and are discarded after a week without activity.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { safeFilename, type AttachmentRef } from '@sfagents/core';

export const HASH_RE = /^[A-Za-z0-9_-]{44}$/;
export const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const STALE_PARTIAL_MS = 7 * 24 * 3600 * 1000;
/** At most this many chunks in one chunk request (stitching). */
const MAX_STITCH = 16;

/** Chunk size for a file: 1 MiB, growing until there are at most 256 chunks (or 4096 at 32 MiB and up). */
export function up2kChunkSize(size: number): number {
  let chunk = 1024 * 1024;
  let step = 512 * 1024;
  for (;;) {
    for (const mul of [1, 2]) {
      const chunks = Math.ceil(size / chunk);
      if (chunks <= 256 || (chunk >= 32 * 1024 * 1024 && chunks <= 4096)) return chunk;
      chunk += step;
      step *= mul;
    }
  }
}

export function chunkCount(size: number): number {
  return Math.ceil(size / up2kChunkSize(size));
}

/** The chunk hash format: SHA-512, first 33 bytes, base64url. */
export function chunkHash(data: Uint8Array): string {
  return createHash('sha512').update(data).digest().subarray(0, 33).toString('base64url');
}

export class Up2kError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'Up2kError';
  }
}

export interface HandshakeRequest {
  name: string;
  size: number;
  mime?: string;
  lmod?: number;
  hashes: string[];
}

export interface HandshakeResponse {
  wark: string;
  chunkSize: number;
  /** Hashes of chunks the server still needs (each listed once). */
  needed: string[];
  done: boolean;
  attachment?: AttachmentRef;
  /** For an upload into a folder: where the finished file is. */
  file?: PlacedFile;
}

export interface PlacedFile {
  path: string;
  name: string;
  size: number;
}

interface PartialMeta {
  wark: string;
  name: string;
  size: number;
  mime: string;
  lmod?: number;
  chunkSize: number;
  hashes: string[];
  received: string[];
  /** The folder the finished file goes into (instead of becoming an attachment). */
  dest?: string;
}

interface PartialUpload {
  meta: PartialMeta;
  received: Set<string>;
  /** hash → chunk indexes (a hash can repeat, e.g. runs of zeros). */
  positions: Map<string, number[]>;
  fd?: fsp.FileHandle;
  writing: number;
  saveChain: Promise<void>;
  finishing?: Promise<AttachmentRef | PlacedFile>;
}

function safeMime(mime: unknown): string {
  return typeof mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) && mime.length <= 100 ? mime.toLowerCase() : 'application/octet-stream';
}

export class Up2kStore {
  private readonly base: string;
  private readonly partialDir: string;
  private readonly doneDir: string;
  private salt = '';
  private readonly partials = new Map<string, PartialUpload>();
  /** attachment id → ref, for every completed upload. */
  private readonly completed = new Map<string, AttachmentRef>();

  constructor(
    /** The conversation state directory (".sfagents"). */
    private readonly stateDir: string,
    readonly maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
  ) {
    this.base = path.join(stateDir, 'uploads', '.up2k');
    this.partialDir = path.join(this.base, 'partial');
    this.doneDir = path.join(this.base, 'done');
  }

  /** Creates folders, loads the salt and the completed index, removes stale partials. */
  init(): void {
    fs.mkdirSync(this.partialDir, { recursive: true });
    fs.mkdirSync(this.doneDir, { recursive: true });
    const saltFile = path.join(this.base, 'salt');
    try {
      this.salt = fs.readFileSync(saltFile, 'utf8').trim();
    } catch {
      this.salt = '';
    }
    if (!this.salt) {
      this.salt = randomBytes(24).toString('base64url');
      fs.writeFileSync(saltFile, this.salt);
    }
    for (const f of fs.readdirSync(this.doneDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const ref = JSON.parse(fs.readFileSync(path.join(this.doneDir, f), 'utf8')) as AttachmentRef;
        if (fs.existsSync(path.join(this.stateDir, ref.path))) this.completed.set(ref.id, ref);
      } catch {
        // ignore a damaged index entry; the file can be uploaded again
      }
    }
    const now = Date.now();
    for (const f of fs.readdirSync(this.partialDir)) {
      const full = path.join(this.partialDir, f);
      try {
        if (now - fs.statSync(full).mtimeMs > STALE_PARTIAL_MS) fs.rmSync(full, { force: true });
      } catch {
        // ignore
      }
    }
  }

  /** A completed upload by attachment id. */
  attachment(id: string): AttachmentRef | undefined {
    return this.completed.get(id);
  }

  wark(size: number, hashes: readonly string[], dest?: string): string {
    // An upload into a folder is its own upload, so the same file can go to two places.
    const text = `${this.salt}\n${size}\n${hashes.join('\n')}${dest ? `\n${dest}` : ''}`;
    return createHash('sha512').update(text).digest().subarray(0, 33).toString('base64url');
  }

  private donePath(wark: string): string {
    return path.join(this.doneDir, `${wark}.json`);
  }

  private readDone(wark: string): AttachmentRef | undefined {
    try {
      const ref = JSON.parse(fs.readFileSync(this.donePath(wark), 'utf8')) as AttachmentRef;
      return fs.existsSync(path.join(this.stateDir, ref.path)) ? ref : undefined;
    } catch {
      return undefined;
    }
  }

  /** @param dest an existing folder (validated by the caller) to upload into, instead of making an attachment. */
  async handshake(body: unknown, dest?: string): Promise<HandshakeResponse> {
    const req = body as { [K in keyof HandshakeRequest]?: unknown } | null;
    if (!req || typeof req !== 'object') throw new Up2kError('Expected a JSON object.');
    const name = typeof req.name === 'string' ? req.name.slice(0, 255) : '';
    if (!name.trim()) throw new Up2kError('"name" is required.');
    const size = req.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Up2kError('"size" must be a non-negative integer.');
    if (size > this.maxBytes) throw new Up2kError(`The file is larger than the upload limit (${this.maxBytes} bytes).`, 413);
    const hashes = req.hashes;
    if (!Array.isArray(hashes) || hashes.some((h) => typeof h !== 'string' || !HASH_RE.test(h))) throw new Up2kError('"hashes" must be an array of chunk hashes.');
    const chunkSize = up2kChunkSize(size);
    const expected = Math.ceil(size / chunkSize);
    if (hashes.length !== expected) throw new Up2kError(`Expected ${expected} chunk hashes for ${size} bytes (chunk size ${chunkSize}), got ${hashes.length}.`);
    const mime = safeMime(req.mime);
    const wark = this.wark(size, hashes, dest);

    const existing = dest ? undefined : this.readDone(wark);
    if (existing) {
      this.completed.set(existing.id, existing);
      return { wark, chunkSize, needed: [], done: true, attachment: existing };
    }
    const partial = await this.openPartial({ wark, name, size, mime, lmod: typeof req.lmod === 'number' ? req.lmod : undefined, chunkSize, hashes, received: [], ...(dest ? { dest } : {}) });
    const needed = [...new Set(hashes.filter((h) => !partial.received.has(h)))];
    if (needed.length === 0) {
      const outcome = await this.finish(partial);
      return { wark, chunkSize, needed: [], done: true, ...outcome };
    }
    return { wark, chunkSize, needed, done: false };
  }

  private async openPartial(fresh: PartialMeta): Promise<PartialUpload> {
    const live = this.partials.get(fresh.wark);
    if (live) return live;
    const metaFile = path.join(this.partialDir, `${fresh.wark}.json`);
    const dataFile = path.join(this.partialDir, `${fresh.wark}.part`);
    let meta = fresh;
    try {
      const saved = JSON.parse(await fsp.readFile(metaFile, 'utf8')) as PartialMeta;
      if (saved.size === fresh.size && saved.hashes.length === fresh.hashes.length && fs.existsSync(dataFile)) {
        meta = { ...fresh, received: saved.received.filter((h) => fresh.hashes.includes(h)) };
      }
    } catch {
      // new upload
    }
    if (meta.received.length === 0) {
      const fd = await fsp.open(dataFile, 'w');
      await fd.truncate(meta.size);
      await fd.close();
    }
    const positions = new Map<string, number[]>();
    meta.hashes.forEach((h, i) => positions.set(h, [...(positions.get(h) ?? []), i]));
    const partial: PartialUpload = { meta, received: new Set(meta.received), positions, writing: 0, saveChain: Promise.resolve() };
    this.partials.set(meta.wark, partial);
    await this.saveMeta(partial);
    return partial;
  }

  private saveMeta(p: PartialUpload): Promise<void> {
    p.saveChain = p.saveChain.then(async () => {
      const metaFile = path.join(this.partialDir, `${p.meta.wark}.json`);
      const tmp = `${metaFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ ...p.meta, received: [...p.received] }));
      await fsp.rename(tmp, metaFile);
    });
    return p.saveChain;
  }

  /**
   * Receives one chunk request: `X-Up2k-Wark` and `X-Up2k-Hash` (one or
   * more consecutive chunk hashes, comma-separated). Returns how many
   * chunks are still missing; finishes the upload when none are.
   */
  async receive(wark: string, hashHeader: string, req: IncomingMessage): Promise<{ remaining: number; attachment?: AttachmentRef; file?: PlacedFile }> {
    const p = this.partials.get(wark);
    if (!p) throw new Up2kError('Unknown upload; send a handshake first.', 404);
    const hashes = hashHeader.split(',').map((h) => h.trim());
    if (hashes.length === 0 || hashes.length > MAX_STITCH || hashes.some((h) => !HASH_RE.test(h) || !p.positions.has(h))) {
      throw new Up2kError('X-Up2k-Hash must name chunks of this upload.');
    }
    // Consecutive chunks: each hash's first position follows the previous one.
    const indexes = hashes.map((h) => p.positions.get(h)![0]!);
    for (let i = 1; i < indexes.length; i++) {
      if (!p.positions.get(hashes[i]!)!.includes(indexes[0]! + i)) throw new Up2kError('Stitched chunks must be consecutive.');
      indexes[i] = indexes[0]! + i;
    }
    const lengths = indexes.map((i) => Math.min(p.meta.chunkSize, p.meta.size - i * p.meta.chunkSize));
    const total = lengths.reduce((a, b) => a + b, 0);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared !== total) throw new Up2kError(`Expected ${total} bytes for these chunks, got ${declared}.`);

    const body = await readExactly(req, total);
    let offset = 0;
    const verified: Array<{ hash: string; data: Buffer }> = [];
    for (let i = 0; i < hashes.length; i++) {
      const data = body.subarray(offset, offset + lengths[i]!);
      offset += lengths[i]!;
      if (chunkHash(data) !== hashes[i]) throw new Up2kError(`Chunk ${indexes[i]} does not match its hash; it was not stored.`, 422);
      verified.push({ hash: hashes[i]!, data });
    }
    p.writing++;
    try {
      if (!p.fd) p.fd = await fsp.open(path.join(this.partialDir, `${wark}.part`), 'r+');
      for (const { hash, data } of verified) {
        if (p.received.has(hash)) continue;
        for (const index of p.positions.get(hash)!) await p.fd.write(data, 0, data.length, index * p.meta.chunkSize);
        p.received.add(hash);
      }
    } finally {
      p.writing--;
    }
    await this.saveMeta(p);
    const remaining = new Set(p.meta.hashes.filter((h) => !p.received.has(h))).size;
    if (remaining === 0) return { remaining, ...(await this.finish(p)) };
    return { remaining };
  }

  private async finish(p: PartialUpload): Promise<{ attachment?: AttachmentRef; file?: PlacedFile }> {
    const done = await this.complete(p);
    return 'id' in done ? { attachment: done } : { file: done };
  }

  private complete(p: PartialUpload): Promise<AttachmentRef | PlacedFile> {
    if (!p.finishing) {
      p.finishing = (async () => {
        while (p.writing > 0) await new Promise((r) => setTimeout(r, 5));
        await p.saveChain;
        const dataFile = path.join(this.partialDir, `${p.meta.wark}.part`);
        if (p.fd) {
          await p.fd.sync();
          await p.fd.close();
          p.fd = undefined;
        } else {
          const fd = await fsp.open(dataFile, 'r+');
          await fd.sync();
          await fd.close();
        }
        if (p.meta.dest) return this.place(p, dataFile, p.meta.dest);
        const id = `u${createHash('sha256').update(p.meta.wark).digest('hex').slice(0, 16)}`;
        const rel = `uploads/${id}/${safeFilename(p.meta.name, 'upload')}`;
        const target = path.join(this.stateDir, rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.rename(dataFile, target);
        if (p.meta.lmod && Number.isFinite(p.meta.lmod)) {
          const t = new Date(p.meta.lmod);
          await fsp.utimes(target, t, t).catch(() => undefined);
        }
        const ref: AttachmentRef = { id, name: p.meta.name, mime: p.meta.mime, path: rel, size: p.meta.size };
        await fsp.writeFile(this.donePath(p.meta.wark), JSON.stringify(ref));
        await fsp.rm(path.join(this.partialDir, `${p.meta.wark}.json`), { force: true });
        this.partials.delete(p.meta.wark);
        this.completed.set(id, ref);
        return ref;
      })();
    }
    return p.finishing;
  }

  /** Moves a finished upload into its folder under a free name ("Photo 2.jpg" if "Photo.jpg" exists). */
  private async place(p: PartialUpload, dataFile: string, dest: string): Promise<PlacedFile> {
    const ext = path.extname(p.meta.name);
    const clean = safeFilename(p.meta.name, 'upload');
    const stem = ext && ext !== clean ? clean.slice(0, -ext.length) : clean;
    let name = clean;
    for (let i = 2; fs.existsSync(path.join(dest, name)); i++) name = `${stem} ${i}${ext}`;
    const target = path.join(dest, name);
    try {
      await fsp.rename(dataFile, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw new Up2kError(`Could not save into the folder: ${(error as Error).message}`, 500);
      await fsp.copyFile(dataFile, target, fs.constants.COPYFILE_EXCL);
      await fsp.rm(dataFile, { force: true });
    }
    if (p.meta.lmod && Number.isFinite(p.meta.lmod)) {
      const t = new Date(p.meta.lmod);
      await fsp.utimes(target, t, t).catch(() => undefined);
    }
    await fsp.rm(path.join(this.partialDir, `${p.meta.wark}.json`), { force: true });
    this.partials.delete(p.meta.wark);
    return { path: target, name, size: p.meta.size };
  }

  async close(): Promise<void> {
    for (const p of this.partials.values()) {
      await p.saveChain.catch(() => undefined);
      await p.fd?.close().catch(() => undefined);
      p.fd = undefined;
    }
  }
}

/** Reads exactly `length` bytes of a request body; more or fewer is an error. */
export function readExactly(req: IncomingMessage, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      if (got + chunk.length > length) {
        failed = true;
        req.resume();
        reject(new Up2kError('Request body is longer than the chunks it names.'));
        return;
      }
      chunk.copy(buf, got);
      got += chunk.length;
    });
    req.on('end', () => {
      if (failed) return;
      if (got !== length) reject(new Up2kError(`Request body ended after ${got} of ${length} bytes.`));
      else resolve(buf);
    });
    req.on('error', (e) => {
      if (!failed) reject(e);
    });
  });
}
