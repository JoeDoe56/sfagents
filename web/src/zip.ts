/**
 * ZIP archives for the file manager: Compress, Uncompress, and downloading
 * folders or several files as one archive. Streaming in both directions, so
 * archive size is not limited by memory.
 *
 * Writer: deflate (stored for formats that are already compressed), CRC-32
 * computed while streaming, data descriptors, UTF-8 names, and ZIP64 for
 * large files, large offsets or many entries (APPNOTE.TXT 6.3).
 * Reader: the central directory (with ZIP64), stored and deflated entries,
 * CRC and size checks. Entry names are confined to the destination
 * ("zip slip"); symbolic links and encrypted entries are skipped.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform, type Writable } from 'node:stream';

// ------------------------------------------------------------------ CRC-32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

// ------------------------------------------------------------------ writer

export interface ZipSource {
  /** Path inside the archive, "/"-separated; folders end with "/". */
  name: string;
  /** The file to read (absent for folders). */
  file?: string;
  size?: number;
  mtime: Date;
}

/** Formats that are already compressed: deflating them again wastes time. */
const STORED = /\.(zip|gz|tgz|bz2|xz|zst|7z|rar|jpe?g|png|gif|webp|heic|heif|avif|mp4|m4v|mov|mkv|webm|mp3|m4a|aac|ogg|opus|flac|pdf|docx|xlsx|pptx|pages|numbers|key|jar|apk|ipa|dmg|woff2?)$/i;
const MAX32 = 0xffffffff;

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Written {
  name: Buffer;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  method: number;
  zip64: boolean;
  dir: boolean;
  time: number;
  date: number;
}

/** Counts and CRCs the bytes flowing through. */
class Measure extends Transform {
  crc = 0;
  bytes = 0;
  constructor(private readonly checksum: boolean) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    if (this.checksum) this.crc = crc32(chunk, this.crc);
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/** Writes a ZIP archive of `sources` to `out` (which is not ended). */
export async function writeZip(sources: Iterable<ZipSource> | AsyncIterable<ZipSource>, out: Writable, signal?: AbortSignal): Promise<{ entries: number; bytes: number }> {
  let offset = 0;
  const written: Written[] = [];
  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      offset += buf.length;
      if (out.write(buf)) resolve();
      else {
        const onDrain = () => {
          out.off('error', onError);
          resolve();
        };
        const onError = (e: Error) => {
          out.off('drain', onDrain);
          reject(e);
        };
        out.once('drain', onDrain);
        out.once('error', onError);
      }
    });

  for await (const src of sources) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const dir = src.name.endsWith('/');
    const name = Buffer.from(src.name, 'utf8');
    const method = dir || STORED.test(src.name) || (src.size ?? 0) === 0 ? 0 : 8;
    // Deflate can grow incompressible data a little; leave room.
    const zip64 = !dir && (src.size ?? 0) > 0xfff00000;
    const { time, date } = dosTime(src.mtime);
    const entryOffset = offset;
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2); // original and compressed size, filled in the data descriptor
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x0808, 6); // sizes in a data descriptor; UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    await write(Buffer.concat([local, name, extra]));

    let crc = 0;
    let usize = 0;
    let csize = 0;
    if (!dir && src.file) {
      const input = new Measure(true);
      const output = new Measure(false);
      const sink = new Transform({
        transform(chunk: Buffer, _e, cb) {
          write(chunk).then(() => cb(), cb);
        },
      });
      const stages = method === 8 ? [fs.createReadStream(src.file), input, createDeflateRaw({ level: 6 }), output, sink] : [fs.createReadStream(src.file), input, output, sink];
      await pipeline(stages as unknown as [NodeJS.ReadableStream, ...NodeJS.WritableStream[]], { signal });
      crc = input.crc;
      usize = input.bytes;
      csize = output.bytes;
    }
    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (zip64) {
      descriptor.writeBigUInt64LE(BigInt(csize), 8);
      descriptor.writeBigUInt64LE(BigInt(usize), 16);
    } else {
      descriptor.writeUInt32LE(csize, 8);
      descriptor.writeUInt32LE(usize, 12);
    }
    await write(descriptor);
    written.push({ name, crc, csize, usize, offset: entryOffset, method, zip64, dir, time, date });
  }

  // Central directory.
  const cdStart = offset;
  for (const e of written) {
    const needOffset64 = e.offset >= MAX32;
    const needSizes64 = e.zip64 || e.usize >= MAX32 || e.csize >= MAX32;
    const fields: bigint[] = [];
    if (needSizes64) fields.push(BigInt(e.usize), BigInt(e.csize));
    if (needOffset64) fields.push(BigInt(e.offset));
    const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
    if (fields.length) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(fields.length * 8, 2);
      fields.forEach((f, i) => extra.writeBigUInt64LE(f, 4 + i * 8));
    }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE((3 << 8) | 45, 4); // made by Unix, spec 4.5
    h.writeUInt16LE(needSizes64 || needOffset64 ? 45 : 20, 6);
    h.writeUInt16LE(0x0808, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(e.time, 12);
    h.writeUInt16LE(e.date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(needSizes64 ? MAX32 : e.csize, 20);
    h.writeUInt32LE(needSizes64 ? MAX32 : e.usize, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE((((e.dir ? 0o40755 : 0o100644) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    h.writeUInt32LE(needOffset64 ? MAX32 : e.offset, 42);
    await write(Buffer.concat([h, e.name, extra]));
  }
  const cdSize = offset - cdStart;
  const need64 = written.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
  if (need64) {
    const z = Buffer.alloc(56);
    const zipEndOffset = offset;
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE((3 << 8) | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(written.length), 24);
    z.writeBigUInt64LE(BigInt(written.length), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(zipEndOffset), 8);
    loc.writeUInt32LE(1, 16);
    await write(Buffer.concat([z, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Math.min(written.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(written.length, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  end.writeUInt16LE(0, 20);
  await write(end);
  return { entries: written.length, bytes: offset };
}

/**
 * The entries for files and folders on disk, folders walked recursively.
 * Names are relative to each item's parent, so "Photos" becomes "Photos/…".
 * Symbolic links are not followed.
 */
export async function* zipSourcesFor(paths: string[], signal?: AbortSignal): AsyncGenerator<ZipSource> {
  const seen = new Set<string>();
  async function* walk(full: string, rel: string): AsyncGenerator<ZipSource> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const st = await fsp.lstat(full);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      yield { name: `${rel}/`, mtime: st.mtime };
      const names = (await fsp.readdir(full)).sort((a, b) => a.localeCompare(b));
      for (const n of names) yield* walk(path.join(full, n), `${rel}/${n}`);
    } else if (st.isFile()) {
      yield { name: rel, file: full, size: st.size, mtime: st.mtime };
    }
  }
  for (const p of paths) {
    let base = path.basename(p) || 'root';
    // Two selected items with the same name keep both.
    for (let i = 2; seen.has(base); i++) base = `${path.basename(p)} ${i}`;
    seen.add(base);
    yield* walk(p, base);
  }
}

// ------------------------------------------------------------------ reader

export interface ZipEntry {
  name: string;
  dir: boolean;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  encrypted: boolean;
  symlink: boolean;
  mtime: Date;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const CP437 =
  '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function decodeName(buf: Buffer, utf8: boolean): string {
  if (utf8) return buf.toString('utf8');
  // Without the UTF-8 flag the name is code page 437 by the specification,
  // but macOS and Info-ZIP write UTF-8 without setting it: UTF-8 that
  // decodes cleanly is taken as UTF-8.
  try {
    return strictUtf8.decode(buf);
  } catch {
    return [...buf].map((b) => CP437[b]).join('');
  }
}

function fromDos(time: number, date: number): Date {
  return new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0xf) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** The central directory of a ZIP archive. */
export async function readZipEntries(file: string, maxEntries = 200_000): Promise<ZipEntry[]> {
  const fd = await fsp.open(file, 'r');
  try {
    const { size } = await fd.stat();
    const tailLength = Math.min(size, 22 + 0xffff + 20);
    const tail = Buffer.alloc(tailLength);
    await fd.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('This is not a ZIP archive, or it is damaged.');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
      const locAt = eocd - 20;
      if (locAt < 0 || tail.readUInt32LE(locAt) !== 0x07064b50) throw new ZipError('The archive is missing its ZIP64 directory.');
      const z64At = Number(tail.readBigUInt64LE(locAt + 8));
      const z = Buffer.alloc(56);
      await fd.read(z, 0, 56, z64At);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new ZipError('The archive is missing its ZIP64 directory.');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }
    if (count > maxEntries) throw new ZipError(`The archive has ${count} entries; at most ${maxEntries} can be extracted.`);
    if (cdOffset + cdSize > size) throw new ZipError('The archive is damaged (its directory runs past the end).');
    const cd = Buffer.alloc(cdSize);
    await fd.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The archive is damaged (bad directory entry).');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const external = cd.readUInt32LE(p + 38);
      let offset = cd.readUInt32LE(p + 42);
      let unicodeName: string | undefined;
      const rawName = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let x = 0; x + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(x);
        const len = extra.readUInt16LE(x + 2);
        if (id === 0x7075 && len > 5 && !(flags & 0x800)) {
          // Info-ZIP Unicode Path: version, CRC of the header name, then the UTF-8 name.
          unicodeName = extra.subarray(x + 9, x + 4 + len).toString('utf8');
        }
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === MAX32) (usize = Number(extra.readBigUInt64LE(q))), (q += 8);
          if (csize === MAX32) (csize = Number(extra.readBigUInt64LE(q))), (q += 8);
          if (offset === MAX32) offset = Number(extra.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      const name = unicodeName ?? rawName;
      const unixMode = madeBy === 3 ? (external >>> 16) & 0o170000 : 0;
      entries.push({
        name,
        dir: name.endsWith('/') || name.endsWith('\\') || (external & 0x10) !== 0 || unixMode === 0o040000,
        method,
        crc,
        csize,
        usize,
        offset,
        encrypted: (flags & 1) !== 0,
        symlink: unixMode === 0o120000,
        mtime: fromDos(time, date),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fd.close();
  }
}

/** A safe relative path for an entry name, or null when it must be skipped. */
export function safeEntryPath(name: string): string | null {
  const parts = name.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.includes('..')) return null;
  // Names Windows cannot create.
  const clean = parts.map((s) => s.replace(/[\u0000-\u001f<>:"|?*]/g, '_'));
  if (clean.some((s) => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s))) return null;
  return clean.join('/');
}

export interface ExtractResult {
  files: number;
  folders: number;
  skipped: string[];
}

/** Extracts `file` into the folder `dest` (created if needed). Nothing is written outside `dest`. */
export async function extractZip(file: string, dest: string, signal?: AbortSignal): Promise<ExtractResult> {
  const entries = await readZipEntries(file);
  const root = path.resolve(dest);
  await fsp.mkdir(root, { recursive: true });
  const result: ExtractResult = { files: 0, folders: 0, skipped: [] };
  const fd = await fsp.open(file, 'r');
  try {
    for (const e of entries) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const rel = safeEntryPath(e.name);
      if (!rel || e.symlink || e.encrypted || (e.method !== 0 && e.method !== 8 && !e.dir)) {
        result.skipped.push(e.name);
        continue;
      }
      const target = path.resolve(root, rel);
      if (target !== root && !target.startsWith(root + path.sep)) {
        result.skipped.push(e.name);
        continue;
      }
      if (e.dir) {
        await fsp.mkdir(target, { recursive: true });
        result.folders++;
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const local = Buffer.alloc(30);
      await fd.read(local, 0, 30, e.offset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`The archive is damaged at "${e.name}".`);
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (e.csize === 0 && e.usize === 0) {
        await fsp.writeFile(target, '');
        result.files++;
        continue;
      }
      const check = new Measure(true);
      const input = fs.createReadStream(file, { start, end: start + Math.max(1, e.csize) - 1 });
      const stages: (NodeJS.ReadableStream | NodeJS.WritableStream)[] = [input];
      if (e.method === 8) stages.push(createInflateRaw());
      stages.push(check, fs.createWriteStream(target));
      await pipeline(stages as unknown as [NodeJS.ReadableStream, ...NodeJS.WritableStream[]], { signal });
      if (check.bytes !== e.usize || check.crc !== e.crc) {
        await fsp.rm(target, { force: true });
        throw new ZipError(`"${e.name}" in the archive is damaged (its checksum does not match).`);
      }
      await fsp.utimes(target, e.mtime, e.mtime).catch(() => undefined);
      result.files++;
    }
  } finally {
    await fd.close();
  }
  return result;
}
