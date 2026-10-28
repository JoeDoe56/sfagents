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
 * Tools (granted by the agent definition's `artifacts.access`):
 *   read:   none; the agent sees the artifact index and reads files with the shell
 *   create: create_artifact (also changes an existing one), create_app_artifact
 */

import path from 'node:path';
import type { ToolCallContext, ToolInvocation, ToolResult } from '../tools/tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import type { ConversationService } from './service.js';
import type { ArtifactView } from './state.js';
import type { PermissionDecision } from '../tools/tools.js';
import type { WorkspaceContext } from '../permissions/workspace.js';
import fs from 'node:fs';

export type ArtifactAccess = 'none' | 'read' | 'create';
export const ARTIFACT_ACCESS_LEVELS: readonly ArtifactAccess[] = ['none', 'read', 'create'];

export const ArtifactToolNames = {
  CREATE: 'create_artifact',
  APP: 'create_app_artifact',
} as const;

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

function ok(text: string, display: string): ToolResult {
  return { llmContent: text, returnDisplay: display };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof ArtifactError ? error.message : `Artifact operation failed: ${getErrorMessage(error)}`;
  return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.CONVERSATION_OPERATION_ERROR } };
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
Artifacts are outputs the user keeps and opens outside the chat: documents (.md), code, web pages (.html), drawings (.svg), data (.json, .csv), PDFs, images, and running web apps. An artifact is a file in your workspace, not a copy: it appears in the chat with a preview where you created it, and always shows the file as it is now.
- To make one, write the file (create_artifact can write it for you with "content"), then create_artifact with its path. Keep your reply short and refer to the artifact by title.
- To change an artifact, change its file (with the shell, or create_artifact with its "id" and new "content"). Do not create a second artifact for the same file. create_artifact with "id" also retitles an artifact or points it at another file.
- To read an artifact, read its file (the index below gives each file).
- A web app you started (a dev server listening on a port of this computer) becomes an artifact with create_app_artifact: the user opens it inside SF Agents, also from their phone.
- Short answers and small snippets belong in the chat reply, not in an artifact.
</artifacts_guidance>`;

/** An existing file the agent may read, as an absolute canonical path. */
function existingFile(workspace: WorkspaceContext | undefined, p: string): string {
  if (!workspace) throw new ArtifactError('This agent has no workspace folders, so it has no files to show as artifacts.');
  const check = workspace.check(p, 'read');
  if (!check.ok || !check.resolvedPath) throw new ArtifactError(check.reason ?? `"${p}" is outside this agent's workspace.`);
  let st: fs.Stats;
  try {
    st = fs.statSync(check.resolvedPath);
  } catch {
    throw new ArtifactError(`There is no file at ${p}. Write it first (or give "content").`);
  }
  if (!st.isFile()) throw new ArtifactError(`${p} is a folder, not a file.`);
  return check.resolvedPath;
}

interface CreateParams {
  id?: string;
  title?: string;
  path?: string;
  content?: string;
}

class CreateArtifactInvocation extends BaseToolInvocation<CreateParams, ToolResult> {
  constructor(
    private readonly service: ConversationService,
    private readonly workspace: WorkspaceContext | undefined,
    private readonly runId: string | undefined,
    params: CreateParams,
  ) {
    super(params);
  }
  getDescription(): string {
    const p = this.params;
    if (p.id) return `${p.id}${p.title ? ` → "${p.title}"` : ''}${p.path ? ` (${p.path})` : ''}`;
    return `"${p.title}" (${p.path})`;
  }
  /** The artifact named by "id", if any. */
  private existing(): ArtifactView | undefined {
    if (this.params.id === undefined) return undefined;
    const v = this.service.state.artifactViews.get(this.params.id);
    if (!v) throw new ArtifactError(`There is no artifact "${this.params.id}". The <artifacts> index lists the IDs.`);
    return v;
  }
  /** The file "content" is written to: "path", or the file the artifact already shows. */
  private target(view: ArtifactView | undefined): string | undefined {
    if (this.params.path !== undefined) return this.params.path;
    return view?.file ? this.service.resolveArtifactFile(view.file) : undefined;
  }
  // The workspace checks (roots, workspace.access, SF Agents' own files) are the boundary, as for shell.
  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (this.params.content === undefined) return 'allow';
    let target: string | undefined;
    try {
      target = this.target(this.existing());
    } catch {
      return 'allow'; // execute reports the unknown ID
    }
    if (target === undefined) return 'allow'; // execute reports the missing path
    const check = this.workspace?.check(target, 'write');
    if (!check?.ok) {
      this.denialReason = check?.reason ?? 'This agent has no workspace folders to write in.';
      return 'deny';
    }
    return 'allow';
  }
  async execute(_signal: AbortSignal, _update?: (o: string) => void, context?: ToolCallContext): Promise<ToolResult> {
    try {
      const p = this.params;
      const view = this.existing();
      if (view) {
        if (view.type === 'app' && (p.path !== undefined || p.content !== undefined)) throw new ArtifactError(`Artifact ${view.id} is an app; only its "title" can change here.`);
        if (p.title === undefined && p.path === undefined && p.content === undefined) throw new ArtifactError('Give a new "title", "path" or "content" for the artifact.');
      } else if (!p.title || !p.path) throw new ArtifactError('A new artifact needs a "title" and a "path".');
      const target = this.target(view);
      let file: string | undefined;
      if (p.content !== undefined) {
        if (target === undefined) throw new ArtifactError(`Artifact ${view?.id} has no file to write; give a "path".`);
        if (p.content.length > MAX_ARTIFACT_CHARS) throw new ArtifactError(`The content is too large (${p.content.length} characters; the limit is ${MAX_ARTIFACT_CHARS}).`);
        const check = this.workspace?.check(target, 'write');
        if (!check?.ok || !check.resolvedPath) throw new ArtifactError(check?.reason ?? 'Path not permitted.');
        fs.mkdirSync(path.dirname(check.resolvedPath), { recursive: true });
        fs.writeFileSync(check.resolvedPath, p.content.replace(/\r\n/g, '\n'), 'utf8');
        file = check.resolvedPath;
      } else if (p.path !== undefined) file = existingFile(this.workspace, p.path);
      if (view) {
        const repoint = p.path !== undefined && file !== undefined;
        if (!repoint && p.title === undefined) return ok(`Wrote the file of artifact ${view.id} "${view.title}"; the artifact shows it as it is now.`, `updated ${view.id}`);
        const v = this.service.relinkArtifact(view.id, { title: p.title, file: repoint ? file : undefined, run: this.runId, callId: context?.callId });
        return ok(`Updated artifact ${v.id} "${v.title}".`, `updated ${v.id}`);
      }
      // One artifact per file: showing it again only retitles it.
      const recorded = [...this.service.state.artifactViews.values()].find((v) => v.file && this.service.resolveArtifactFile(v.file) === file);
      const v = recorded
        ? this.service.relinkArtifact(recorded.id, { title: p.title, run: this.runId, callId: context?.callId })
        : this.service.linkArtifact({ title: p.title!, file: file!, run: this.runId, callId: context?.callId });
      return ok(`${recorded ? 'Artifact' : 'Created artifact'} ${v.id} "${v.title}" shows ${p.path}. It follows the file: edit the file to change it.`, `${recorded ? 'updated' : 'created'} ${v.id}`);
    } catch (error) {
      return fail(error);
    }
  }
}

class CreateArtifactTool extends BaseDeclarativeTool<CreateParams, ToolResult> {
  constructor(
    private readonly service: ConversationService,
    private readonly workspace: WorkspaceContext | undefined,
    private readonly runId: string | undefined,
  ) {
    super(
      ArtifactToolNames.CREATE,
      ArtifactToolNames.CREATE,
      'Shows a file from your workspace as an artifact the user keeps: a document, code, a web page (.html), an SVG drawing, data, a PDF or an image. Give "content" to write the file at the same time. The artifact follows the file from then on. With "id", changes an existing artifact instead: a new title, another file ("path"), or new "content" for its file.',
      Kind.Edit,
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional: an existing artifact to change (e.g. "a12"). Omit to create one.' },
          title: { type: 'string', maxLength: 120, description: 'Short title shown on the artifact. Required when creating.' },
          path: { type: 'string', description: 'The file, relative to your workspace (e.g. "docs/plan.md") or absolute. Required when creating.' },
          content: { type: 'string', description: 'Optional: the complete content to write to the file first.' },
        },
      },
    );
  }
  protected createInvocation(params: CreateParams): ToolInvocation<CreateParams, ToolResult> {
    return new CreateArtifactInvocation(this.service, this.workspace, this.runId, params);
  }
}

type Run<P> = (service: ConversationService, params: P, context: ToolCallContext | undefined) => ToolResult;

class ArtifactInvocation<P extends object> extends BaseToolInvocation<P, ToolResult> {
  constructor(
    private readonly service: ConversationService,
    params: P,
    private readonly describe: (p: P) => string,
    private readonly runFn: Run<P>,
  ) {
    super(params);
  }
  getDescription(): string {
    return this.describe(this.params);
  }
  async execute(_signal: AbortSignal, _update?: (output: string) => void, context?: ToolCallContext): Promise<ToolResult> {
    try {
      return this.runFn(this.service, this.params, context);
    } catch (error) {
      return fail(error);
    }
  }
}

class ArtifactTool<P extends object> extends BaseDeclarativeTool<P, ToolResult> {
  constructor(
    private readonly service: ConversationService,
    name: string,
    description: string,
    kind: Kind,
    schema: Record<string, unknown>,
    private readonly describe: (p: P) => string,
    private readonly runFn: Run<P>,
  ) {
    super(name, name, description, kind, schema);
  }
  protected createInvocation(params: P): ToolInvocation<P, ToolResult> {
    return new ArtifactInvocation(this.service, params, this.describe, this.runFn);
  }
}

/**
 * Builds the artifact tools for one agent. `runId` is the run that will
 * call them, recorded as each revision's provenance.
 */
export function createArtifactTools(
  service: ConversationService,
  access: ArtifactAccess,
  runId?: string,
  workspace?: WorkspaceContext,
) {
  if (access === 'none') return [];
  const tools: Array<ArtifactTool<never>> = [];
  const add = <P extends object>(t: ArtifactTool<P>) => tools.push(t as unknown as ArtifactTool<never>);

  if (access === 'create') {
    tools.push(new CreateArtifactTool(service, workspace, runId) as unknown as ArtifactTool<never>);
    add(
      new ArtifactTool<{ title: string; port: number; path?: string }>(
        service,
        ArtifactToolNames.APP,
        'Shows a web app running on this computer as an artifact: the user opens it inside SF Agents (from any device that reaches SF Agents). Start the app first (for example a dev server in the shell), then give its port.',
        Kind.Other,
        {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 120, description: 'Short title shown on the artifact.' },
            port: { type: 'integer', minimum: 1, maximum: 65535, description: 'The port the app listens on (on 127.0.0.1 / localhost).' },
            path: { type: 'string', maxLength: 500, description: 'Page to open first (default "/").' },
          },
          required: ['title', 'port'],
        },
        (p) => `"${p.title}" (port ${p.port})`,
        (s, p, ctx) => {
          const page = p.path ? (p.path.startsWith('/') ? p.path : `/${p.path}`) : '/';
          if (/[\s#]/.test(page) || page.startsWith('//')) throw new ArtifactError('"path" must be a path on the app, like "/" or "/settings".');
          const existing = [...s.state.artifactViews.values()].find((v) => v.type === 'app' && v.url === `http://127.0.0.1:${p.port}${page}`);
          const v = existing
            ? s.relinkArtifact(existing.id, { title: p.title, run: runId, callId: ctx?.callId })
            : s.linkArtifact({ title: p.title, url: `http://127.0.0.1:${p.port}${page}`, type: 'app', run: runId, callId: ctx?.callId });
          return ok(`App artifact ${v.id} "${v.title}" shows port ${p.port}. It works while the app is running.`, `app ${v.id}`);
        },
      ),
    );
  }
  return tools;
}
