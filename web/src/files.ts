/**
 * The file manager's view of the computer SF Agents runs on: browsing,
 * searching, previewing, editing text, and the everyday operations (new
 * folder, rename, copy, move, duplicate, Trash and Put Back, delete,
 * compress and uncompress, folder sizes).
 *
 * It works with absolute paths anywhere the user's account can reach, as
 * Finder or Explorer would; the web server's Host, Origin and fetch-site
 * checks decide who may call it. A few places are protected from being
 * moved, renamed or deleted: file system roots, the home folder itself, and
 * SF Agents' own state directory (the running conversation lives there).
 *
 * Operations that can take a while (copying a large folder, compressing,
 * extracting) run as jobs with progress and can be cancelled.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Trash, freeName, pathExists } from './trash.js';
import { extractZip, readZipEntries, safeEntryPath, writeZip, zipSourcesFor } from './zip.js';

// ------------------------------------------------------------------ kinds

export type FileKind = 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'code' | 'archive' | 'document' | 'spreadsheet' | 'presentation' | 'font' | 'app' | 'disk' | 'other';

interface TypeInfo {
  mime: string;
  kind: FileKind;
  label: string;
}

const T = (mime: string, kind: FileKind, label: string): TypeInfo => ({ mime, kind, label });
const TYPES: Record<string, TypeInfo> = {
  png: T('image/png', 'image', 'PNG image'),
  jpg: T('image/jpeg', 'image', 'JPEG image'),
  jpeg: T('image/jpeg', 'image', 'JPEG image'),
  gif: T('image/gif', 'image', 'GIF image'),
  webp: T('image/webp', 'image', 'WebP image'),
  heic: T('image/heic', 'image', 'HEIC image'),
  heif: T('image/heif', 'image', 'HEIF image'),
  avif: T('image/avif', 'image', 'AVIF image'),
  bmp: T('image/bmp', 'image', 'BMP image'),
  ico: T('image/x-icon', 'image', 'Icon'),
  tif: T('image/tiff', 'image', 'TIFF image'),
  tiff: T('image/tiff', 'image', 'TIFF image'),
  svg: T('image/svg+xml', 'image', 'SVG image'),
  mp4: T('video/mp4', 'video', 'MPEG-4 movie'),
  m4v: T('video/x-m4v', 'video', 'MPEG-4 movie'),
  mov: T('video/quicktime', 'video', 'QuickTime movie'),
  webm: T('video/webm', 'video', 'WebM movie'),
  mkv: T('video/x-matroska', 'video', 'Matroska movie'),
  avi: T('video/x-msvideo', 'video', 'AVI movie'),
  mp3: T('audio/mpeg', 'audio', 'MP3 audio'),
  m4a: T('audio/mp4', 'audio', 'MPEG-4 audio'),
  aac: T('audio/aac', 'audio', 'AAC audio'),
  wav: T('audio/wav', 'audio', 'WAVE audio'),
  flac: T('audio/flac', 'audio', 'FLAC audio'),
  ogg: T('audio/ogg', 'audio', 'Ogg audio'),
  opus: T('audio/ogg', 'audio', 'Opus audio'),
  aiff: T('audio/aiff', 'audio', 'AIFF audio'),
  pdf: T('application/pdf', 'pdf', 'PDF document'),
  txt: T('text/plain', 'text', 'Plain text'),
  md: T('text/markdown', 'text', 'Markdown document'),
  markdown: T('text/markdown', 'text', 'Markdown document'),
  rtf: T('application/rtf', 'document', 'Rich text document'),
  log: T('text/plain', 'text', 'Log file'),
  csv: T('text/csv', 'spreadsheet', 'CSV spreadsheet'),
  tsv: T('text/tab-separated-values', 'spreadsheet', 'TSV spreadsheet'),
  json: T('application/json', 'code', 'JSON'),
  xml: T('application/xml', 'code', 'XML'),
  yaml: T('text/yaml', 'code', 'YAML'),
  yml: T('text/yaml', 'code', 'YAML'),
  toml: T('text/plain', 'code', 'TOML'),
  ini: T('text/plain', 'code', 'Settings file'),
  env: T('text/plain', 'code', 'Environment file'),
  html: T('text/html', 'code', 'HTML document'),
  htm: T('text/html', 'code', 'HTML document'),
  css: T('text/css', 'code', 'CSS stylesheet'),
  js: T('text/javascript', 'code', 'JavaScript'),
  mjs: T('text/javascript', 'code', 'JavaScript'),
  cjs: T('text/javascript', 'code', 'JavaScript'),
  ts: T('text/plain', 'code', 'TypeScript'),
  tsx: T('text/plain', 'code', 'TypeScript'),
  jsx: T('text/plain', 'code', 'JavaScript'),
  py: T('text/x-python', 'code', 'Python script'),
  rb: T('text/plain', 'code', 'Ruby script'),
  go: T('text/plain', 'code', 'Go source'),
  rs: T('text/plain', 'code', 'Rust source'),
  java: T('text/plain', 'code', 'Java source'),
  kt: T('text/plain', 'code', 'Kotlin source'),
  swift: T('text/plain', 'code', 'Swift source'),
  c: T('text/plain', 'code', 'C source'),
  h: T('text/plain', 'code', 'C header'),
  cpp: T('text/plain', 'code', 'C++ source'),
  hpp: T('text/plain', 'code', 'C++ header'),
  cs: T('text/plain', 'code', 'C# source'),
  php: T('text/plain', 'code', 'PHP script'),
  sh: T('text/x-shellscript', 'code', 'Shell script'),
  bash: T('text/x-shellscript', 'code', 'Shell script'),
  zsh: T('text/x-shellscript', 'code', 'Shell script'),
  ps1: T('text/plain', 'code', 'PowerShell script'),
  bat: T('text/plain', 'code', 'Batch file'),
  cmd: T('text/plain', 'code', 'Batch file'),
  sql: T('text/plain', 'code', 'SQL'),
  lua: T('text/plain', 'code', 'Lua script'),
  zip: T('application/zip', 'archive', 'ZIP archive'),
  gz: T('application/gzip', 'archive', 'Gzip archive'),
  tgz: T('application/gzip', 'archive', 'Gzip archive'),
  tar: T('application/x-tar', 'archive', 'Tar archive'),
  bz2: T('application/x-bzip2', 'archive', 'Bzip2 archive'),
  xz: T('application/x-xz', 'archive', 'XZ archive'),
  '7z': T('application/x-7z-compressed', 'archive', '7-Zip archive'),
  rar: T('application/vnd.rar', 'archive', 'RAR archive'),
  doc: T('application/msword', 'document', 'Word document'),
  docx: T('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document', 'Word document'),
  odt: T('application/vnd.oasis.opendocument.text', 'document', 'OpenDocument text'),
  pages: T('application/vnd.apple.pages', 'document', 'Pages document'),
  epub: T('application/epub+zip', 'document', 'EPUB book'),
  xls: T('application/vnd.ms-excel', 'spreadsheet', 'Excel spreadsheet'),
  xlsx: T('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet', 'Excel spreadsheet'),
  ods: T('application/vnd.oasis.opendocument.spreadsheet', 'spreadsheet', 'OpenDocument spreadsheet'),
  numbers: T('application/vnd.apple.numbers', 'spreadsheet', 'Numbers spreadsheet'),
  ppt: T('application/vnd.ms-powerpoint', 'presentation', 'PowerPoint presentation'),
  pptx: T('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation', 'PowerPoint presentation'),
  odp: T('application/vnd.oasis.opendocument.presentation', 'presentation', 'OpenDocument presentation'),
  key: T('application/vnd.apple.keynote', 'presentation', 'Keynote presentation'),
  ttf: T('font/ttf', 'font', 'TrueType font'),
  otf: T('font/otf', 'font', 'OpenType font'),
  woff: T('font/woff', 'font', 'Web font'),
  woff2: T('font/woff2', 'font', 'Web font'),
  exe: T('application/vnd.microsoft.portable-executable', 'app', 'Application'),
  msi: T('application/x-msi', 'app', 'Windows installer'),
  app: T('application/octet-stream', 'app', 'Application'),
  dmg: T('application/x-apple-diskimage', 'disk', 'Disk image'),
  iso: T('application/x-iso9660-image', 'disk', 'Disk image'),
  img: T('application/octet-stream', 'disk', 'Disk image'),
  apk: T('application/vnd.android.package-archive', 'app', 'Android app'),
  deb: T('application/vnd.debian.binary-package', 'app', 'Debian package'),
  rpm: T('application/x-rpm', 'app', 'RPM package'),
};

const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'makefile', 'dockerfile', 'changelog', 'authors', 'notice', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.env', '.bashrc', '.zshrc', '.profile']);

export function typeOf(name: string, folder = false): TypeInfo {
  if (folder) return T('inode/directory', 'folder', 'Folder');
  const lower = name.toLowerCase();
  const ext = path.extname(lower).slice(1);
  const known = TYPES[ext];
  if (known) return known;
  if (TEXT_NAMES.has(lower) || TEXT_NAMES.has(lower.replace(/\.[^.]*$/, ''))) return T('text/plain', 'text', 'Plain text');
  return T('application/octet-stream', 'other', ext ? `${ext.toUpperCase()} file` : 'Document');
}

/** Media types a browser may show in place (everything else downloads). */
export const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)|video\/(mp4|webm|quicktime|x-m4v)|audio\/(mpeg|mp4|aac|wav|flac|ogg|aiff)|application\/pdf|text\/.+|application\/(json|xml))$/;

// ------------------------------------------------------------------ entries

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  /** "PNG image", "Folder", … */
  type: string;
  mime: string;
  /** Bytes for files; null for folders (see items). */
  size: number | null;
  /** Folders: how many items they hold (null when unreadable or not counted). */
  items?: number | null;
  modified: number;
  created: number;
  hidden: boolean;
  link?: { target: string; broken: boolean };
  writable: boolean;
}

export interface FileInfo extends FileEntry {
  accessed: number;
  /** "rwxr-xr-x" on Unix. */
  mode: string;
  owner?: string;
  parent: string;
  /** Can be put back from the Trash. */
  restorable?: boolean;
  /** For a ZIP archive: how many entries it holds. */
  archive?: { entries: number; size: number };
}

const WINDOWS_HIDDEN = new Set(['desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'dumpstack.log', 'ntuser.dat', 'recovery', '$windows.~ws', '$winreagent', 'config.msi']);

function isHidden(name: string, platform: NodeJS.Platform): boolean {
  if (name.startsWith('.')) return true;
  if (platform === 'win32') return WINDOWS_HIDDEN.has(name.toLowerCase()) || /^ntuser\./i.test(name);
  return false;
}

function modeString(mode: number): string {
  const chars = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-';
  return s;
}

// ------------------------------------------------------------------ errors

export class FileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FileError';
  }
}

/** A plain-language message for a file system error. */
export function explain(error: unknown, subject = 'This item'): FileError {
  if (error instanceof FileError) return error;
  const e = error as NodeJS.ErrnoException;
  switch (e?.code) {
    case 'ENOENT':
      return new FileError(`${subject} no longer exists.`, 404);
    case 'EACCES':
    case 'EPERM':
      return new FileError(`You don't have permission to do that with ${subject.toLowerCase().startsWith('this') ? subject.toLowerCase() : `"${subject}"`}.`, 403);
    case 'EEXIST':
      return new FileError(`An item with that name already exists.`, 409);
    case 'ENOTEMPTY':
      return new FileError(`The folder is not empty.`, 409);
    case 'EBUSY':
      return new FileError(`${subject} is in use by another program.`, 409);
    case 'ENOSPC':
      return new FileError('There is not enough free space.', 507);
    case 'EROFS':
      return new FileError('The drive is read-only.', 403);
    case 'ENAMETOOLONG':
      return new FileError('The name is too long.', 400);
    case 'ENOTDIR':
      return new FileError(`${subject} is not a folder.`, 400);
    case 'EISDIR':
      return new FileError(`${subject} is a folder.`, 400);
    case 'ELOOP':
      return new FileError('The path loops through links.', 400);
    default:
      return new FileError(e?.message ?? String(error), 500);
  }
}

// ------------------------------------------------------------------ jobs

export interface Job {
  id: string;
  kind: string;
  label: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  /** What the job is working on now ("Photos/IMG_0042.jpg"). */
  current?: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface RunningJob extends Job {
  controller: AbortController;
}

export type Conflict = 'ask' | 'replace' | 'keep' | 'skip';

export interface ConflictItem {
  name: string;
  source: string;
  existing: string;
  folder: boolean;
}

// ------------------------------------------------------------------ service

export interface FileServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** SF Agents' state directory: protected, and where the Trash log lives. */
  stateDir?: string;
  /** The agent tree's folder, offered as a location. */
  projectDir?: string;
  env?: NodeJS.ProcessEnv;
}

const MAX_LIST = 10_000;
const MAX_TEXT = 5 * 1024 * 1024;
const COUNT_FOLDERS = 400;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export class FileService {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly trash: Trash;
  private readonly jobs = new Map<string, RunningJob>();
  private readonly protectedDirs: string[];

  constructor(private readonly options: FileServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = path.resolve(options.home ?? os.homedir());
    this.trash = new Trash({ platform: this.platform, home: this.home, stateDir: options.stateDir, env: options.env });
    this.protectedDirs = options.stateDir ? [path.resolve(options.stateDir)] : [];
  }

  // ---------------------------------------------------------------- paths

  /** An absolute, normalized path from client input. */
  resolve(input: unknown): string {
    if (typeof input !== 'string' || !input || input.includes('\0') || input.length > 4096) throw new FileError('A full path is required.');
    const p = this.platform === 'win32' ? path.win32 : path.posix;
    if (!p.isAbsolute(input)) throw new FileError('A full path is required.');
    return p.resolve(input);
  }

  paths(input: unknown): string[] {
    if (!Array.isArray(input) || input.length === 0) throw new FileError('"paths" must list at least one item.');
    if (input.length > 10_000) throw new FileError('Too many items at once.');
    return input.map((p) => this.resolve(p));
  }

  private same(a: string, b: string): boolean {
    return this.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  private inside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** Roots, the home folder and SF Agents' state can't be moved, renamed or deleted. */
  private guard(p: string, action: string): void {
    const name = path.basename(p) || p;
    if (path.parse(p).root === p) throw new FileError(`"${p}" is a drive; it can't be ${action}.`, 403);
    if (this.same(p, this.home)) throw new FileError(`Your home folder can't be ${action}.`, 403);
    for (const dir of this.protectedDirs) {
      if (this.same(p, dir) || this.inside(p, dir) || this.inside(dir, p)) throw new FileError(`"${name}" holds SF Agents' running conversation, so it can't be ${action} here.`, 403);
    }
  }

  private validName(name: unknown): string {
    if (typeof name !== 'string') throw new FileError('A name is required.');
    const n = name.trim();
    if (!n) throw new FileError('A name is required.');
    if (n === '.' || n === '..' || /[/\0]/.test(n) || (this.platform === 'win32' && /[<>:"\\|?*\u0000-\u001f]/.test(n))) {
      throw new FileError(this.platform === 'win32' ? 'Names can\'t contain \\ / : * ? " < > |.' : 'Names can\'t contain "/".');
    }
    if (this.platform === 'win32' && (/[. ]$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n))) throw new FileError('Windows does not allow that name.');
    if (Buffer.byteLength(n) > 255) throw new FileError('The name is too long.');
    return n;
  }

  // ---------------------------------------------------------------- reading

  async entry(full: string, countItems = false): Promise<FileEntry> {
    const name = path.basename(full) || full;
    const lst = await fsp.lstat(full);
    let st = lst;
    let link: FileEntry['link'];
    if (lst.isSymbolicLink()) {
      const target = await fsp.readlink(full).catch(() => '');
      try {
        st = await fsp.stat(full);
        link = { target, broken: false };
      } catch {
        link = { target, broken: true };
      }
    }
    const folder = st.isDirectory();
    const type = typeOf(name, folder);
    let items: number | null | undefined;
    if (folder && countItems) items = await fsp.readdir(full).then((n) => n.length, () => null);
    let writable = true;
    try {
      await fsp.access(full, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return {
      name,
      path: full,
      kind: type.kind,
      type: link?.broken ? 'Broken alias' : type.label,
      mime: type.mime,
      size: folder ? null : st.size,
      ...(folder ? { items } : {}),
      modified: st.mtimeMs,
      created: st.birthtimeMs || st.ctimeMs,
      hidden: isHidden(name, this.platform),
      ...(link ? { link } : {}),
      writable,
    };
  }

  async list(dirInput: unknown, opts: { hidden?: boolean } = {}): Promise<{ path: string; parent: string | null; name: string; entries: FileEntry[]; truncated: boolean; writable: boolean }> {
    const dir = this.resolve(dirInput);
    let names: string[];
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) throw new FileError(`"${path.basename(dir)}" is not a folder.`, 400);
      names = await fsp.readdir(dir);
    } catch (error) {
      throw explain(error, `"${path.basename(dir) || dir}"`);
    }
    const visible = opts.hidden ? names : names.filter((n) => !isHidden(n, this.platform));
    const truncated = visible.length > MAX_LIST;
    const chosen = visible.slice(0, MAX_LIST);
    let counted = 0;
    const entries = (
      await mapLimit(chosen, 32, async (n) => {
        try {
          const full = path.join(dir, n);
          // Folder item counts (as Files shows them) for the first few hundred folders.
          const e = await this.entry(full, false);
          if (e.kind === 'folder' && counted++ < COUNT_FOLDERS) e.items = await fsp.readdir(full).then((x) => (opts.hidden ? x.length : x.filter((y) => !isHidden(y, this.platform)).length), () => null);
          return e;
        } catch {
          return null;
        }
      })
    ).filter((e): e is FileEntry => e !== null);
    const parent = path.dirname(dir);
    const writable = await fsp.access(dir, fs.constants.W_OK).then(() => true, () => false);
    return { path: dir, parent: parent === dir ? null : parent, name: path.basename(dir) || dir, entries, truncated, writable };
  }

  async info(input: unknown): Promise<FileInfo> {
    const full = this.resolve(input);
    try {
      const e = await this.entry(full, true);
      const st = await fsp.stat(full).catch(() => fsp.lstat(full));
      let owner: string | undefined;
      if (this.platform !== 'win32') owner = (await this.userName(st.uid)) ?? String(st.uid);
      const trashDir = this.trash.location();
      const restorable = trashDir ? path.dirname(full) === trashDir && !!(await this.trash.originOf(full)) : false;
      let archive: FileInfo['archive'];
      if (e.kind === 'archive' && /\.zip$/i.test(full)) {
        archive = await readZipEntries(full).then(
          (list) => ({ entries: list.length, size: list.reduce((a, x) => a + x.usize, 0) }),
          () => undefined,
        );
      }
      return { ...e, accessed: st.atimeMs, mode: modeString(st.mode), owner, parent: path.dirname(full), restorable, ...(archive ? { archive } : {}) };
    } catch (error) {
      throw explain(error, `"${path.basename(full)}"`);
    }
  }

  private users: Map<number, string> | undefined;
  private async userName(uid: number): Promise<string | undefined> {
    if (!this.users) {
      this.users = new Map();
      const text = await fsp.readFile('/etc/passwd', 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        const [name, , id] = line.split(':');
        if (name && id) this.users.set(Number(id), name);
      }
    }
    return this.users.get(uid);
  }

  /** The total size of a folder (stops after `timeLimitMs`, marking the result incomplete). */
  async folderSize(input: unknown, timeLimitMs = 20_000): Promise<{ size: number; files: number; folders: number; complete: boolean }> {
    const root = this.resolve(input);
    const deadline = Date.now() + timeLimitMs;
    let size = 0;
    let files = 0;
    let folders = 0;
    let complete = true;
    const stack = [root];
    while (stack.length) {
      if (Date.now() > deadline) {
        complete = false;
        break;
      }
      const dir = stack.pop()!;
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        complete = false;
        continue;
      }
      await mapLimit(dirents, 32, async (d) => {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          folders++;
          stack.push(full);
        } else if (d.isFile()) {
          files++;
          const bytes = await fsp.lstat(full).then((s) => s.size, () => 0);
          size += bytes;
        }
      });
    }
    return { size, files, folders, complete };
  }

  /** Items whose names contain every word of `query`, under `dir`. */
  async search(dirInput: unknown, query: unknown, opts: { hidden?: boolean; limit?: number; timeLimitMs?: number } = {}): Promise<{ results: FileEntry[]; complete: boolean }> {
    const root = this.resolve(dirInput);
    if (typeof query !== 'string' || !query.trim()) throw new FileError('Type something to search for.');
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(opts.limit ?? 300, 1000);
    const deadline = Date.now() + (opts.timeLimitMs ?? 5000);
    const found: string[] = [];
    let complete = true;
    const queue = [root];
    while (queue.length && found.length < limit) {
      if (Date.now() > deadline) {
        complete = false;
        break;
      }
      const dir = queue.shift()!;
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (!opts.hidden && isHidden(d.name, this.platform)) continue;
        const full = path.join(dir, d.name);
        const lower = d.name.toLowerCase();
        if (words.every((w) => lower.includes(w))) {
          found.push(full);
          if (found.length >= limit) break;
        }
        if (d.isDirectory()) queue.push(full);
      }
    }
    if (queue.length) complete = false;
    const results = (await mapLimit(found, 32, (p) => this.entry(p).catch(() => null))).filter((e): e is FileEntry => e !== null);
    return { results, complete };
  }

  /** A text file's contents for the editor. */
  async readText(input: unknown): Promise<{ path: string; text: string; modified: number; size: number }> {
    const full = this.resolve(input);
    try {
      const st = await fsp.stat(full);
      if (st.isDirectory()) throw new FileError('That is a folder.');
      if (st.size > MAX_TEXT) throw new FileError('The file is too large to edit here (over 5 MB).', 413);
      const data = await fsp.readFile(full);
      if (data.subarray(0, 8192).includes(0)) throw new FileError('This file is not text.', 415);
      return { path: full, text: data.toString('utf8'), modified: st.mtimeMs, size: st.size };
    } catch (error) {
      throw explain(error, `"${path.basename(full)}"`);
    }
  }

  /** Saves a text file; refuses if it changed on disk since `modified` unless forced. */
  async writeText(input: unknown, text: unknown, modified: unknown, force = false): Promise<FileEntry> {
    const full = this.resolve(input);
    if (typeof text !== 'string') throw new FileError('"text" is required.');
    if (Buffer.byteLength(text) > MAX_TEXT) throw new FileError('The text is too large (over 5 MB).', 413);
    try {
      if (!force && typeof modified === 'number') {
        const st = await fsp.stat(full);
        if (Math.abs(st.mtimeMs - modified) > 1) throw new FileError('The file changed on disk after you opened it.', 409, { modified: st.mtimeMs });
      }
      await fsp.writeFile(full, text);
      return await this.entry(full);
    } catch (error) {
      throw explain(error, `"${path.basename(full)}"`);
    }
  }

  // ---------------------------------------------------------------- creating

  async mkdir(dirInput: unknown, nameInput: unknown): Promise<FileEntry> {
    const dir = this.resolve(dirInput);
    const name = this.validName(nameInput);
    const full = path.join(dir, name);
    try {
      await fsp.mkdir(full);
      return await this.entry(full, true);
    } catch (error) {
      throw explain(error, `"${name}"`);
    }
  }

  async createFile(dirInput: unknown, nameInput: unknown, text: unknown = ''): Promise<FileEntry> {
    const dir = this.resolve(dirInput);
    const name = this.validName(nameInput);
    const full = path.join(dir, name);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) throw new FileError('"text" must be under 5 MB of text.');
    try {
      await fsp.writeFile(full, text, { flag: 'wx' });
      return await this.entry(full);
    } catch (error) {
      throw explain(error, `"${name}"`);
    }
  }

  async rename(input: unknown, nameInput: unknown): Promise<FileEntry> {
    const full = this.resolve(input);
    const name = this.validName(nameInput);
    this.guard(full, 'renamed');
    const target = path.join(path.dirname(full), name);
    if (target === full) return this.entry(full, true);
    try {
      // A change of case only (on case-insensitive drives the new name "exists").
      if (!this.same(target, full) && (await pathExists(target))) throw new FileError(`"${name}" already exists here.`, 409);
      await fsp.rename(full, target);
      return await this.entry(target, true);
    } catch (error) {
      throw explain(error, `"${path.basename(full)}"`);
    }
  }

  // ---------------------------------------------------------------- jobs

  job(id: string): Job | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    const { controller: _c, ...rest } = j;
    return rest;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== 'running') return false;
    j.controller.abort(new FileError('Cancelled.', 499));
    return true;
  }

  /** Starts a job; resolves with it after `waitMs` or when it finishes, whichever is first. */
  async start(kind: string, label: string, work: (job: RunningJob) => Promise<unknown>, waitMs = 700): Promise<Job> {
    const job: RunningJob = { id: `j${randomBytes(6).toString('hex')}`, kind, label, state: 'running', done: 0, total: 0, startedAt: Date.now(), controller: new AbortController() };
    this.jobs.set(job.id, job);
    // Finished jobs are kept for a while so the client can read the outcome.
    for (const [id, j] of this.jobs) if (j.finishedAt && Date.now() - j.finishedAt > 10 * 60_000) this.jobs.delete(id);
    const finished = work(job).then(
      (result) => {
        job.result = result;
        job.state = 'done';
      },
      (error: unknown) => {
        if (job.controller.signal.aborted) job.state = 'cancelled';
        else {
          job.state = 'failed';
          job.error = explain(error).message;
        }
      },
    ).finally(() => {
      job.finishedAt = Date.now();
      job.current = undefined;
    });
    await Promise.race([finished, new Promise((r) => setTimeout(r, waitMs))]);
    return this.job(job.id)!;
  }

  // ---------------------------------------------------------------- copy / move

  /** Items in `dest` that `sources` would collide with. */
  async conflicts(sources: string[], dest: string): Promise<ConflictItem[]> {
    const out: ConflictItem[] = [];
    for (const s of sources) {
      const existing = path.join(dest, path.basename(s));
      if (this.same(path.dirname(s), dest)) continue;
      if (await pathExists(existing)) {
        const folder = await fsp.stat(existing).then((x) => x.isDirectory(), () => false);
        out.push({ name: path.basename(s), source: s, existing, folder });
      }
    }
    return out;
  }

  private async prepareTransfer(pathsInput: unknown, destInput: unknown, conflict: Conflict, moving: boolean) {
    const sources = this.paths(pathsInput);
    const dest = this.resolve(destInput);
    const st = await fsp.stat(dest).catch((e: unknown) => {
      throw explain(e, 'The destination');
    });
    if (!st.isDirectory()) throw new FileError('The destination is not a folder.');
    for (const s of sources) {
      if (moving) this.guard(s, 'moved');
      if (this.same(s, dest) || this.inside(dest, s)) throw new FileError(`"${path.basename(s)}" can't be put inside itself.`);
      if (!(await pathExists(s))) throw new FileError(`"${path.basename(s)}" no longer exists.`, 404);
    }
    for (const dir of this.protectedDirs) if (this.same(dest, dir) || this.inside(dest, dir)) throw new FileError("Items can't be put inside SF Agents' state folder.", 403);
    const clashes = await this.conflicts(sources, dest);
    if (clashes.length && conflict === 'ask') throw new FileError(clashes.length === 1 ? `An item named "${clashes[0]!.name}" already exists in this location.` : `${clashes.length} items with the same names already exist in this location.`, 409, { conflicts: clashes });
    return { sources, dest, clashes };
  }

  /** The bytes a copy will write, for progress. */
  private async measure(sources: string[], signal: AbortSignal): Promise<number> {
    let total = 0;
    const stack = [...sources];
    while (stack.length) {
      if (signal.aborted) throw signal.reason;
      const p = stack.pop()!;
      const st = await fsp.lstat(p).catch(() => undefined);
      if (!st) continue;
      if (st.isDirectory()) for (const n of await fsp.readdir(p).catch(() => [] as string[])) stack.push(path.join(p, n));
      else if (st.isFile()) total += st.size;
    }
    return total;
  }

  private async copyTree(from: string, to: string, job: RunningJob, base: string): Promise<void> {
    const signal = job.controller.signal;
    if (signal.aborted) throw signal.reason;
    const st = await fsp.lstat(from);
    job.current = path.relative(base, from) || path.basename(from);
    if (st.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(from), to);
    } else if (st.isDirectory()) {
      await fsp.mkdir(to);
      for (const n of await fsp.readdir(from)) await this.copyTree(path.join(from, n), path.join(to, n), job, base);
      await fsp.utimes(to, st.atime, st.mtime).catch(() => undefined);
    } else {
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      await fsp.utimes(to, st.atime, st.mtime).catch(() => undefined);
      job.done += st.size;
    }
  }

  private async place(source: string, dest: string, clash: ConflictItem | undefined, conflict: Conflict, duplicateName = false): Promise<string | null> {
    let name = path.basename(source);
    if (duplicateName) name = await this.copyName(dest, name);
    else if (clash) {
      if (conflict === 'skip') return null;
      if (conflict === 'keep') name = await freeName(dest, name);
      if (conflict === 'replace') {
        this.guard(clash.existing, 'replaced');
        await fsp.rm(clash.existing, { recursive: true, force: true });
      }
    }
    return path.join(dest, name);
  }

  /** Finder's duplicate names: "Report copy.pdf", "Report copy 2.pdf". */
  private async copyName(dir: string, name: string): Promise<string> {
    const ext = path.extname(name);
    const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
    let candidate = `${stem} copy${ext}`;
    for (let i = 2; await pathExists(path.join(dir, candidate)); i++) candidate = `${stem} copy ${i}${ext}`;
    return candidate;
  }

  async copy(pathsInput: unknown, destInput: unknown, conflict: Conflict = 'ask'): Promise<Job> {
    const { sources, dest, clashes } = await this.prepareTransfer(pathsInput, destInput, conflict, false);
    const label = sources.length === 1 ? `Copying "${path.basename(sources[0]!)}"` : `Copying ${sources.length} items`;
    return this.start('copy', label, async (job) => {
      job.total = await this.measure(sources, job.controller.signal);
      const placed: string[] = [];
      for (const s of sources) {
        const same = this.same(path.dirname(s), dest);
        const target = await this.place(s, dest, clashes.find((c) => c.source === s), conflict, same);
        if (!target) continue;
        try {
          await this.copyTree(s, target, job, path.dirname(s));
        } catch (error) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
          throw explain(error, `"${path.basename(s)}"`);
        }
        placed.push(target);
      }
      return { paths: placed };
    });
  }

  async duplicate(pathsInput: unknown): Promise<Job> {
    const sources = this.paths(pathsInput);
    const label = sources.length === 1 ? `Duplicating "${path.basename(sources[0]!)}"` : `Duplicating ${sources.length} items`;
    return this.start('duplicate', label, async (job) => {
      job.total = await this.measure(sources, job.controller.signal);
      const placed: string[] = [];
      for (const s of sources) {
        const target = path.join(path.dirname(s), await this.copyName(path.dirname(s), path.basename(s)));
        try {
          await this.copyTree(s, target, job, path.dirname(s));
        } catch (error) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
          throw explain(error, `"${path.basename(s)}"`);
        }
        placed.push(target);
      }
      return { paths: placed };
    });
  }

  async move(pathsInput: unknown, destInput: unknown, conflict: Conflict = 'ask'): Promise<Job> {
    const { sources, dest, clashes } = await this.prepareTransfer(pathsInput, destInput, conflict, true);
    const label = sources.length === 1 ? `Moving "${path.basename(sources[0]!)}"` : `Moving ${sources.length} items`;
    return this.start('move', label, async (job) => {
      const placed: string[] = [];
      let measured = false;
      for (const s of sources) {
        if (this.same(path.dirname(s), dest)) {
          placed.push(s);
          continue;
        }
        const target = await this.place(s, dest, clashes.find((c) => c.source === s), conflict);
        if (!target) continue;
        job.current = path.basename(s);
        try {
          await fsp.rename(s, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw explain(error, `"${path.basename(s)}"`);
          // Another drive: copy, then remove the original.
          if (!measured) {
            job.total = await this.measure(sources, job.controller.signal);
            measured = true;
          }
          try {
            await this.copyTree(s, target, job, path.dirname(s));
          } catch (copyError) {
            await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
            throw explain(copyError, `"${path.basename(s)}"`);
          }
          await fsp.rm(s, { recursive: true, force: true });
        }
        placed.push(target);
      }
      return { paths: placed };
    });
  }

  // ---------------------------------------------------------------- removing

  async moveToTrash(pathsInput: unknown): Promise<Job> {
    const sources = this.paths(pathsInput);
    for (const s of sources) this.guard(s, 'moved to the Trash');
    const label = sources.length === 1 ? `Moving "${path.basename(sources[0]!)}" to the Trash` : `Moving ${sources.length} items to the Trash`;
    return this.start('trash', label, async (job) => {
      job.total = sources.length;
      const outcomes = await this.trash.trash(sources);
      job.done = sources.length;
      const failed = outcomes.filter((o) => o.error);
      if (failed.length === outcomes.length) throw new FileError(failed[0]!.error!);
      return { trashed: outcomes.filter((o) => !o.error), failed };
    });
  }

  async remove(pathsInput: unknown): Promise<Job> {
    const sources = this.paths(pathsInput);
    for (const s of sources) this.guard(s, 'deleted');
    const label = sources.length === 1 ? `Deleting "${path.basename(sources[0]!)}"` : `Deleting ${sources.length} items`;
    return this.start('delete', label, async (job) => {
      job.total = sources.length;
      for (const s of sources) {
        job.current = path.basename(s);
        try {
          await fsp.rm(s, { recursive: true, force: false });
        } catch (error) {
          throw explain(error, `"${path.basename(s)}"`);
        }
        job.done++;
      }
      return { deleted: sources };
    });
  }

  async restore(pathsInput: unknown): Promise<Job> {
    const sources = this.paths(pathsInput);
    return this.start('restore', sources.length === 1 ? `Putting back "${path.basename(sources[0]!)}"` : `Putting back ${sources.length} items`, async () => {
      const outcomes = await this.trash.restore(sources);
      const failed = outcomes.filter((o) => o.error);
      if (failed.length === outcomes.length) throw new FileError(failed[0]!.error!);
      return { restored: outcomes.filter((o) => !o.error).map((o) => o.path), failed };
    });
  }

  async emptyTrash(): Promise<Job> {
    return this.start('empty-trash', 'Emptying the Trash', async () => ({ removed: await this.trash.empty() }));
  }

  // ---------------------------------------------------------------- archives

  /** Finder's naming: one item → "Name.zip" (keeping its extension), several → "Archive.zip". */
  async compress(pathsInput: unknown, destInput?: unknown): Promise<Job> {
    const sources = this.paths(pathsInput);
    const dest = destInput === undefined ? path.dirname(sources[0]!) : this.resolve(destInput);
    const base = sources.length === 1 ? path.basename(sources[0]!) : 'Archive';
    const name = await freeName(dest, `${base}.zip`);
    const target = path.join(dest, name);
    return this.start('compress', `Compressing ${sources.length === 1 ? `"${path.basename(sources[0]!)}"` : `${sources.length} items`}`, async (job) => {
      job.total = await this.measure(sources, job.controller.signal);
      const out = fs.createWriteStream(target, { flags: 'wx' });
      const tracked = (async function* (src: AsyncGenerator<import('./zip.js').ZipSource>) {
        for await (const s of src) {
          job.current = s.name;
          yield s;
          if (s.size) job.done += s.size;
        }
      })(zipSourcesFor(sources, job.controller.signal));
      try {
        await writeZip(tracked, out, job.controller.signal);
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
      } catch (error) {
        out.destroy();
        await fsp.rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
      return { path: target };
    });
  }

  /**
   * Extracts a ZIP archive next to it, as Archive Utility does: an archive
   * holding one top-level folder becomes that folder, anything else goes
   * into a folder named after the archive.
   */
  async extract(input: unknown, destInput?: unknown): Promise<Job> {
    const archive = this.resolve(input);
    if (!/\.zip$/i.test(archive)) throw new FileError('Only ZIP archives can be uncompressed here.', 415);
    const dest = destInput === undefined ? path.dirname(archive) : this.resolve(destInput);
    return this.start('extract', `Uncompressing "${path.basename(archive)}"`, async (job) => {
      const entries = await readZipEntries(archive);
      job.total = entries.reduce((a, e) => a + e.usize, 0);
      const tops = new Set(entries.map((e) => safeEntryPath(e.name)?.split('/')[0]).filter(Boolean));
      const single = tops.size === 1 && entries.some((e) => e.dir && safeEntryPath(e.name) === [...tops][0]) && entries.every((e) => safeEntryPath(e.name)?.includes('/') || e.dir);
      const stage = path.join(dest, `.sfagents-extract-${randomBytes(4).toString('hex')}`);
      try {
        const result = await extractZip(archive, stage, job.controller.signal);
        job.done = job.total;
        let final: string;
        if (single) {
          const top = [...tops][0]!;
          final = path.join(dest, await freeName(dest, top));
          await fsp.rename(path.join(stage, top), final);
          await fsp.rm(stage, { recursive: true, force: true });
        } else {
          final = path.join(dest, await freeName(dest, path.basename(archive).replace(/\.zip$/i, '')));
          await fsp.rename(stage, final);
        }
        return { path: final, ...result };
      } catch (error) {
        await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  /** A folder that uploads may go into. */
  async uploadFolder(input: unknown): Promise<string> {
    const dir = this.resolve(input);
    const st = await fsp.stat(dir).catch((e: unknown) => {
      throw explain(e, 'The folder');
    });
    if (!st.isDirectory()) throw new FileError('Uploads go into a folder.');
    for (const p of this.protectedDirs) if (this.same(dir, p) || this.inside(dir, p)) throw new FileError("Files can't be uploaded into SF Agents' state folder.", 403);
    return dir;
  }

  /** Opens a file for streaming; rejects folders. */
  async openForRead(input: unknown): Promise<{ path: string; size: number; modified: number; type: ReturnType<typeof typeOf> }> {
    const full = this.resolve(input);
    try {
      const st = await fsp.stat(full);
      if (st.isDirectory()) throw new FileError('That is a folder; download it as a ZIP archive.');
      return { path: full, size: st.size, modified: st.mtimeMs, type: typeOf(full) };
    } catch (error) {
      throw explain(error, `"${path.basename(full)}"`);
    }
  }

  // ---------------------------------------------------------------- locations

  /** Standard folders that exist on this computer, with their localized names on Linux. */
  async locations(): Promise<{ home: string; places: { id: string; name: string; path: string }[]; trash: string | null; project: string | null }> {
    const h = this.home;
    const xdg: Record<string, string> = {};
    if (this.platform === 'linux') {
      const text = await fsp.readFile(path.join(this.options.env?.XDG_CONFIG_HOME ?? path.join(h, '.config'), 'user-dirs.dirs'), 'utf8').catch(() => '');
      for (const m of text.matchAll(/^XDG_(\w+)_DIR="(.*)"$/gm)) xdg[m[1]!] = m[2]!.replace('$HOME', h);
    }
    const pick = (key: string, fallback: string) => xdg[key] ?? path.join(h, fallback);
    const candidates = [
      { id: 'desktop', name: 'Desktop', path: pick('DESKTOP', 'Desktop') },
      { id: 'documents', name: 'Documents', path: pick('DOCUMENTS', 'Documents') },
      { id: 'downloads', name: 'Downloads', path: pick('DOWNLOAD', 'Downloads') },
      { id: 'pictures', name: 'Pictures', path: pick('PICTURES', 'Pictures') },
      { id: 'music', name: 'Music', path: pick('MUSIC', 'Music') },
      { id: 'videos', name: this.platform === 'darwin' ? 'Movies' : 'Videos', path: this.platform === 'darwin' ? path.join(h, 'Movies') : pick('VIDEOS', 'Videos') },
    ];
    const places = [{ id: 'home', name: path.basename(h) || 'Home', path: h }];
    for (const c of candidates) if (await fsp.stat(c.path).then((s) => s.isDirectory(), () => false)) places.push({ ...c, name: path.basename(c.path) || c.name });
    const trash = this.trash.location();
    return {
      home: h,
      places,
      trash,
      project: this.options.projectDir ? path.resolve(this.options.projectDir) : null,
    };
  }
}
