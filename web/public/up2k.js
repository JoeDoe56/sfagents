/**
 * Browser side of the up2k-style uploader (see web/src/up2k.ts):
 * hash chunks in parallel (SHA-512, first 33 bytes, base64url), handshake,
 * upload only the chunks the server still needs, several at a time with
 * retries, and handshake again to finish. Identical files finish instantly;
 * an interrupted upload resumes where it stopped, even after a reload when
 * the same file is chosen again.
 */

import { sha512 } from './sha512.js';

const HASH_PARALLEL = 4;
const UPLOAD_PARALLEL = 4;
const STITCH_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 6;

/** Same rule as the server: 1 MiB chunks, growing until at most 256 (or 4096 at 32 MiB). */
export function up2kChunkSize(size) {
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

function base64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const subtle = globalThis.crypto && globalThis.crypto.subtle;

async function hashChunk(blob) {
  const buf = await blob.arrayBuffer();
  const digest = subtle ? new Uint8Array(await subtle.digest('SHA-512', buf)) : sha512(new Uint8Array(buf));
  return base64url(digest.subarray(0, 33));
}

/** A tiny counting semaphore shared by all jobs. */
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const hashSlot = limiter(HASH_PARALLEL);
const uploadSlot = limiter(UPLOAD_PARALLEL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UploadError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new UploadError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

function sendChunk(job, hashes, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    job.xhrs.add(xhr);
    xhr.open('POST', '/api/up2k/chunk');
    xhr.setRequestHeader('X-Up2k-Wark', job.wark);
    xhr.setRequestHeader('X-Up2k-Hash', hashes.join(','));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      job.xhrs.delete(xhr);
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new UploadError(data.error || `HTTP ${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => {
      job.xhrs.delete(xhr);
      reject(new UploadError('Network error', 0));
    };
    xhr.onabort = () => {
      job.xhrs.delete(xhr);
      reject(new UploadError('Cancelled', -1));
    };
    xhr.send(blob);
  });
}

let nextId = 1;

/**
 * One file's upload. `state` goes hashing → uploading → done (or failed,
 * cancelled). `progress` is 0..1 over hashing and uploading together.
 */
export class UploadJob {
  /** @param {{dest?: string}} [options] dest: a folder on the computer to upload into (the file manager) instead of an attachment */
  constructor(file, onChange, options = {}) {
    this.dest = options.dest ?? null;
    /** For an upload into a folder: { path, name, size } once done. */
    this.placed = null;
    this.id = `j${nextId++}`;
    this.file = file;
    this.name = file.name || 'file';
    this.size = file.size;
    this.mime = file.type || '';
    this.state = 'hashing';
    this.hashed = 0;
    this.sent = 0;
    this.toSend = 0;
    this.attachment = null;
    this.error = '';
    this.speed = 0;
    this.xhrs = new Set();
    this.cancelled = false;
    this.onChange = onChange;
    this.promise = this.run().then(
      () => this.attachment,
      (error) => {
        if (this.cancelled) this.state = 'cancelled';
        else {
          this.state = 'failed';
          this.error = error.message || String(error);
        }
        this.changed();
        throw error;
      },
    );
    this.promise.catch(() => {});
  }

  get progress() {
    if (this.state === 'done') return 1;
    const hashPart = this.size ? this.hashed / this.size : 1;
    const sendPart = this.toSend ? this.sent / this.toSend : this.state === 'uploading' ? 0 : 0;
    return Math.min(0.999, hashPart * 0.15 + sendPart * 0.85);
  }

  changed() {
    try {
      this.onChange?.(this);
    } catch {
      // ignore listener errors
    }
  }

  cancel() {
    this.cancelled = true;
    for (const x of this.xhrs) x.abort();
  }

  async run() {
    const size = this.size;
    const chunkSize = up2kChunkSize(size);
    const count = Math.ceil(size / chunkSize);
    const hashes = new Array(count);
    let lastTick = 0;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        hashSlot(async () => {
          if (this.cancelled) throw new UploadError('Cancelled', -1);
          const blob = this.file.slice(i * chunkSize, Math.min(size, (i + 1) * chunkSize));
          hashes[i] = await hashChunk(blob);
          this.hashed += blob.size;
          const now = performance.now();
          if (now - lastTick > 80) {
            lastTick = now;
            this.changed();
          }
        }),
      ),
    );
    this.state = 'uploading';
    this.changed();
    for (let round = 0; round < 4; round++) {
      const hs = await this.handshake(hashes);
      if (hs.done) {
        this.attachment = hs.attachment ?? null;
        this.placed = hs.file ?? null;
        this.state = 'done';
        this.changed();
        return;
      }
      await this.upload(hs, hashes, chunkSize);
    }
    throw new UploadError('The server kept asking for chunks; giving up.');
  }

  async handshake(hashes) {
    for (let attempt = 0; ; attempt++) {
      try {
        const hs = await postJson('/api/up2k/handshake', { name: this.name, size: this.size, mime: this.mime, lmod: this.file.lastModified, hashes, ...(this.dest ? { dest: this.dest } : {}) });
        this.wark = hs.wark;
        return hs;
      } catch (error) {
        if (this.cancelled || (error.status >= 400 && error.status < 500) || attempt >= MAX_RETRIES) throw error;
        await sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
  }

  async upload(hs, hashes, chunkSize) {
    const needed = new Set(hs.needed);
    // First position of each needed hash, grouped into runs of consecutive chunks.
    const indexes = [];
    const seen = new Set();
    hashes.forEach((h, i) => {
      if (needed.has(h) && !seen.has(h)) {
        seen.add(h);
        indexes.push(i);
      }
    });
    const perRequest = Math.max(1, Math.floor(STITCH_BYTES / chunkSize));
    const groups = [];
    for (const i of indexes) {
      const last = groups[groups.length - 1];
      if (last && last[last.length - 1] === i - 1 && last.length < perRequest) last.push(i);
      else groups.push([i]);
    }
    const lengthOf = (i) => Math.min(chunkSize, this.size - i * chunkSize);
    this.toSend = indexes.reduce((a, i) => a + lengthOf(i), 0);
    this.sent = 0;
    const started = performance.now();
    await Promise.all(
      groups.map((group) =>
        uploadSlot(async () => {
          const from = group[0] * chunkSize;
          const to = from + group.reduce((a, i) => a + lengthOf(i), 0);
          const blob = this.file.slice(from, to);
          let reported = 0;
          for (let attempt = 0; ; attempt++) {
            if (this.cancelled) throw new UploadError('Cancelled', -1);
            try {
              await sendChunk(this, group.map((i) => hashes[i]), blob, (loaded) => {
                this.sent += loaded - reported;
                reported = loaded;
                const secs = (performance.now() - started) / 1000;
                if (secs > 0.25) this.speed = this.sent / secs;
                this.changed();
              });
              this.sent += blob.size - reported;
              reported = blob.size;
              this.changed();
              return;
            } catch (error) {
              this.sent -= reported;
              reported = 0;
              // 404: the server lost this upload; the next handshake restarts it.
              if (this.cancelled || error.status === 404 || error.status === 413 || error.status === 400 || attempt >= MAX_RETRIES) {
                if (error.status === 404) return;
                throw error;
              }
              await sleep(Math.min(8000, 400 * 2 ** attempt));
            }
          }
        }),
      ),
    );
  }
}
