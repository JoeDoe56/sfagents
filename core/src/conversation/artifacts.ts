/**
 * Model-created artifacts: standalone outputs (documents, code, web pages,
 * SVG drawings, data files) that live beside the conversation instead of in
 * a chat message.
 *
 * Content is stored under the state directory as
 * `artifacts/<id>/r<rev>/<filename>`; every revision is kept. The
 * conversation records an `artifact` record for revision 1 and an
 * `artifact_update` record for each later revision, so the Markdown stays
 * the authoritative list. Pinning is a user action (`artifact_pin`).
 *
 * Access (the agent definition's `artifacts.access`):
 *   read:   the agent sees the artifact index and reads files with the shell
 *   create: also the `sf-artifact` shell command (see runArtifactRequest)
 */

import path from 'node:path';
import type { ConversationService } from './service.js';
import type { ArtifactView } from './state.js';
import type { WorkspaceContext } from '../permissions/workspace.js';
import fs from 'node:fs';

export type ArtifactAccess = 'none' | 'read' | 'create';
export const ARTIFACT_ACCESS_LEVELS: readonly ArtifactAccess[] = ['none', 'read', 'create'];

/** The shell command that makes and changes artifacts. */
export const ARTIFACT_COMMAND = 'sf-artifact';

/** Largest artifact revision the tools accept (characters of content). */
export const MAX_ARTIFACT_CHARS = 1_000_000;

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/x-python',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  cs: 'text/plain',
  sh: 'text/x-shellscript',
  ps1: 'text/plain',
  sql: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

const CODE_EXTS = new Set(['css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'sh', 'ps1', 'sql', 'toml']);
const DATA_EXTS = new Set(['json', 'csv', 'tsv', 'xml', 'yaml', 'yml']);

export function extensionOf(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext;
}

export function mimeForFilename(filename: string): string {
  return MIME_BY_EXT[extensionOf(filename)] ?? 'text/plain';
}

/** Display category used by clients: document, html, image, code, data or text. */
export function artifactTypeFor(filename: string): string {
  const ext = extensionOf(filename);
  if (ext === 'md' || ext === 'markdown') return 'document';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg' || MIME_BY_EXT[ext]?.startsWith('image/')) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) return 'audio';
  if (CODE_EXTS.has(ext)) return 'code';
  if (DATA_EXTS.has(ext)) return 'data';
  return 'text';
}

/** True for media types whose content is text the model can read back. */
export function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'image/svg+xml';
}

/**
 * A safe single-segment file name: no directories, no control or reserved
 * characters, no leading dots, at most 100 characters (extension kept).
 */
export function safeFilename(name: string, fallback = 'artifact.txt'): string {
  let base = path.posix.basename(String(name).replace(/\\/g, '/'));
  base = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `_${base}`;
  if (!base) base = fallback;
  if (base.length > 100) {
    const ext = path.extname(base).slice(0, 16);
    base = base.slice(0, 100 - ext.length) + ext;
  }
  return base;
}

/** One line describing an artifact for the model. */
export function describeArtifact(v: ArtifactView): string {
  const where = v.url ? v.url : v.file ? v.file : v.path ? path.posix.basename(v.path) : '(no file)';
  return `[${v.id}] ${v.title} — ${where}, ${v.type}${v.pinned ? ', pinned by the user' : ''}`;
}

/** Artifacts newest-updated first; transcripts last unless asked for. */
export function sortedArtifacts(views: Iterable<ArtifactView>): ArtifactView[] {
  return [...views].sort((a, b) => b.updatedSeq - a.updatedSeq);
}

/** Short index of model-visible artifacts appended to the system prompt. */
export function artifactIndex(service: ConversationService, limit = 20): string | undefined {
  const views = sortedArtifacts(service.state.artifactViews.values()).filter((v) => v.type !== 'agent_transcript');
  if (views.length === 0) return undefined;
  const shown = views.slice(0, limit);
  const more = views.length - shown.length;
  return [
    '<artifacts>',
    ...shown.map((v) => `- ${describeArtifact(v)}`),
    ...(more > 0 ? [`${more} older artifact(s) not listed.`] : []),
    '</artifacts>',
  ].join('\n');
}

export const ARTIFACT_GUIDANCE = `<artifacts_guidance>
Artifacts are outputs the user keeps and opens outside the chat: documents (.md), code, web pages (.html), drawings (.svg), data (.json, .csv), PDFs, images, folders, and running web apps. An artifact is a file in your workspace, not a copy: it appears in the chat with a preview where you created it, and always shows the file as it is now.
You make and change artifacts with the \`sf-artifact\` command in your shell:
- \`sf-artifact docs/plan.md --title "Launch plan"\` shows a file you wrote (or a folder: it opens in the file manager). Keep your reply short and refer to the artifact by title.
- \`sf-artifact --port 5173 --title "Dashboard"\` shows a web app you started (a dev server on this computer); \`--page /settings\` opens another page first. The user opens it inside SF Agents, also from their phone.
- To change an artifact, change its file. \`sf-artifact --id a3 --title "New title"\` retitles it, and \`sf-artifact --id a3 other.md\` points it at another file. Never make a second artifact for the same file.
- \`--content "..."\` (or \`--stdin\`) writes the file before showing it, for when you have no other way to write files.
- To read an artifact, read its file (the index below gives each file).
- Short answers and small snippets belong in the chat reply, not in an artifact.
</artifacts_guidance>`;

/** What `sf-artifact` prints for --help or a usage error. */
export const ARTIFACT_USAGE = `Usage:
  sf-artifact <file-or-folder> --title "Title"      show a file or folder as an artifact
  sf-artifact --port <port> [--page /path] --title "Title"   show a web app running on this computer
  sf-artifact --id <id> [--title T] [<file>] [--port N]     change an artifact
Options: --content "text" or --stdin writes the file first.`;

/** An existing file or folder the agent may read, as an absolute canonical path. */
function existingFile(workspace: WorkspaceContext | undefined, p: string): string {
  if (!workspace) throw new ArtifactError('This agent has no workspace folders, so it has no files to show as artifacts.');
  const check = workspace.check(p, 'read');
  if (!check.ok || !check.resolvedPath) throw new ArtifactError(check.reason ?? `"${p}" is outside this agent's workspace.`);
  let st: fs.Stats;
  try {
    st = fs.statSync(check.resolvedPath);
  } catch {
    throw new ArtifactError(`There is no file at ${p}. Write it first (or give --content).`);
  }
  if (!st.isFile() && !st.isDirectory()) throw new ArtifactError(`${p} is neither a file nor a folder.`);
  return check.resolvedPath;
}

/** One `sf-artifact` call. */
export interface ArtifactRequest {
  id?: string;
  title?: string;
  /** A file or folder (relative to `cwd`). */
  path?: string;
  content?: string;
  /** A web app on this computer (127.0.0.1). */
  port?: number;
  page?: string;
}

/** Parses `sf-artifact` arguments (after the command name). */
export function parseArtifactArgs(args: readonly string[], stdin?: string): ArtifactRequest {
  const out: ArtifactRequest = {};
  const value = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) throw new ArtifactError(`${flag} needs a value.\n${ARTIFACT_USAGE}`);
    return v;
  };
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = /^(--[a-z]+)=(.*)$/s.exec(a);
    const flag = eq ? eq[1]! : a;
    const take = () => (eq ? eq[2]! : value(i++, flag));
    switch (flag) {
      case '--id':
        out.id = take();
        break;
      case '--title':
        out.title = take();
        break;
      case '--content':
        out.content = take();
        break;
      case '--stdin':
        if (stdin === undefined) throw new ArtifactError('--stdin: nothing was piped in.');
        out.content = stdin;
        break;
      case '--port': {
        const n = Number(take());
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ArtifactError('--port must be a port number (1-65535).');
        out.port = n;
        break;
      }
      case '--page':
        out.page = take();
        break;
      case '--path':
        paths.push(take());
        break;
      case '-h':
      case '--help':
        throw new ArtifactError(ARTIFACT_USAGE);
      default:
        if (a.startsWith('--')) throw new ArtifactError(`Unknown option ${a}.\n${ARTIFACT_USAGE}`);
        paths.push(a);
    }
  }
  if (paths.length > 1) throw new ArtifactError(`Give one file or folder (got ${paths.length}; quote a path with spaces).\n${ARTIFACT_USAGE}`);
  if (paths.length) out.path = paths[0];
  if (out.title !== undefined && (!out.title.trim() || out.title.length > 120)) throw new ArtifactError('--title must be 1-120 characters.');
  return out;
}

/**
 * Carries out `sf-artifact` for one agent: shows a file, folder or web app as
 * an artifact, or changes one. `runId` and `callId` are the provenance. The
 * workspace checks (roots, workspace access, SF Agents' own files) are the
 * boundary, as for the shell. Returns the text the command prints.
 */
export function runArtifactRequest(
  service: ConversationService,
  workspace: WorkspaceContext | undefined,
  p: ArtifactRequest,
  o: { cwd?: string; runId?: string; callId?: string } = {},
): string {
  const where = (rel: string) => (o.cwd && !path.isAbsolute(rel) ? path.resolve(o.cwd, rel) : rel);
  const view = p.id !== undefined ? service.state.artifactViews.get(p.id) : undefined;
  if (p.id !== undefined && !view) throw new ArtifactError(`There is no artifact "${p.id}". The <artifacts> index lists the IDs.`);
  if (p.port !== undefined && (p.path !== undefined || p.content !== undefined)) throw new ArtifactError('An artifact shows either a file or folder, or a web app (--port), not both.');

  // A web app.
  if (p.port !== undefined || (view?.type === 'app' && p.path === undefined && p.content === undefined)) {
    if (view && view.type !== 'app') throw new ArtifactError(`Artifact ${view.id} shows a ${view.type === 'folder' ? 'folder' : 'file'}; make a new artifact for the app.`);
    if (!view && !p.title) throw new ArtifactError(`A new artifact needs --title.\n${ARTIFACT_USAGE}`);
    let url = view?.url;
    if (p.port !== undefined || p.page !== undefined) {
      const port = p.port ?? Number(view?.url ? new URL(view.url).port : NaN);
      const page = p.page ? (p.page.startsWith('/') ? p.page : `/${p.page}`) : '/';
      if (/[\s#]/.test(page) || page.startsWith('//')) throw new ArtifactError('--page must be a path on the app, like "/" or "/settings".');
      url = `http://127.0.0.1:${port}${page}`;
    }
    if (view) {
      if (p.title === undefined && url === view.url) throw new ArtifactError('Give a new --title, --port or --page for the artifact.');
      const v = service.relinkArtifact(view.id, { title: p.title, ...(url !== view.url ? { url } : {}), run: o.runId, callId: o.callId });
      return `Updated app artifact ${v.id} "${v.title}" (${v.url}).`;
    }
    const existing = [...service.state.artifactViews.values()].find((v) => v.type === 'app' && v.url === url);
    const v = existing
      ? service.relinkArtifact(existing.id, { title: p.title, run: o.runId, callId: o.callId })
      : service.linkArtifact({ title: p.title!, url: url!, type: 'app', run: o.runId, callId: o.callId });
    return `App artifact ${v.id} "${v.title}" shows port ${new URL(v.url!).port}. It works while the app is running.`;
  }

  // A file or folder.
  if (view) {
    if (p.title === undefined && p.path === undefined && p.content === undefined) throw new ArtifactError('Give a new --title, a file, or --content for the artifact.');
  } else if (!p.title || p.path === undefined) throw new ArtifactError(`A new artifact needs a file or folder and --title.\n${ARTIFACT_USAGE}`);
  const target = p.path !== undefined ? where(p.path) : view?.file ? service.resolveArtifactFile(view.file) : undefined;
  let file: string | undefined;
  if (p.content !== undefined) {
    if (target === undefined) throw new ArtifactError(`Artifact ${view?.id} has no file to write; give one.`);
    if (p.content.length > MAX_ARTIFACT_CHARS) throw new ArtifactError(`The content is too large (${p.content.length} characters; the limit is ${MAX_ARTIFACT_CHARS}).`);
    const check = workspace?.check(target, 'write');
    if (!check?.ok || !check.resolvedPath) throw new ArtifactError(check?.reason ?? 'This agent has no workspace folders to write in.');
    fs.mkdirSync(path.dirname(check.resolvedPath), { recursive: true });
    fs.writeFileSync(check.resolvedPath, p.content.replace(/\r\n/g, '\n'), 'utf8');
    file = check.resolvedPath;
  } else if (p.path !== undefined) file = existingFile(workspace, where(p.path));
  const folder = file !== undefined && fs.statSync(file).isDirectory();
  if (view) {
    const repoint = p.path !== undefined && file !== undefined;
    if (repoint && folder !== (view.type === 'folder')) throw new ArtifactError(`Artifact ${view.id} shows a ${view.type === 'folder' ? 'folder' : 'file'}; make a new artifact for ${p.path}.`);
    if (!repoint && p.title === undefined) return `Wrote the file of artifact ${view.id} "${view.title}"; the artifact shows it as it is now.`;
    const v = service.relinkArtifact(view.id, { title: p.title, file: repoint ? file : undefined, run: o.runId, callId: o.callId });
    return `Updated artifact ${v.id} "${v.title}".`;
  }
  // One artifact per file: showing it again only retitles it.
  const recorded = [...service.state.artifactViews.values()].find((v) => v.file && service.resolveArtifactFile(v.file) === file);
  const v = recorded
    ? service.relinkArtifact(recorded.id, { title: p.title, run: o.runId, callId: o.callId })
    : service.linkArtifact({ title: p.title!, file: file!, run: o.runId, callId: o.callId, ...(folder ? { type: 'folder' } : {}) });
  const follows = folder ? 'It opens the folder in the file manager.' : 'It follows the file: edit the file to change it.';
  return `${recorded ? 'Artifact' : 'Created artifact'} ${v.id} "${v.title}" shows ${p.path}. ${follows}`;
}

/** What an agent's `sf-artifact` runs: bound to its conversation, workspace and run. */
export type ArtifactCommand = (args: readonly string[], o: { cwd?: string; callId?: string; stdin?: string }) => string;

/** The `sf-artifact` handler for one agent, or undefined when it may not create artifacts. */
export function artifactCommand(service: ConversationService, access: ArtifactAccess, runId?: string, workspace?: WorkspaceContext): ArtifactCommand | undefined {
  if (access !== 'create') return undefined;
  return (args, o) => runArtifactRequest(service, workspace, parseArtifactArgs(args, o.stdin), { cwd: o.cwd, runId, callId: o.callId });
}
