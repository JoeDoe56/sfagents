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
 *   read:   list_artifacts, read_artifact
 *   create: also create_artifact, update_artifact
 */

import path from 'node:path';
import type { ToolCallContext, ToolInvocation, ToolResult } from '../tools/tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import type { ConversationService } from './service.js';
import type { ArtifactView } from './state.js';

export type ArtifactAccess = 'none' | 'read' | 'create';
export const ARTIFACT_ACCESS_LEVELS: readonly ArtifactAccess[] = ['none', 'read', 'create'];

export const ArtifactToolNames = {
  CREATE: 'create_artifact',
  UPDATE: 'update_artifact',
  LIST: 'list_artifacts',
  READ: 'read_artifact',
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
  let base = path.basename(String(name).replace(/\\/g, '/'));
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
  const file = v.path ? path.posix.basename(v.path) : '(no file)';
  return `[${v.id}] ${v.title} — ${file}, ${v.type}, revision ${v.rev}${v.pinned ? ', pinned by the user' : ''}`;
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
    ...(more > 0 ? [`${more} older artifact(s) not listed; use list_artifacts.`] : []),
    '</artifacts>',
  ].join('\n');
}

export const ARTIFACT_GUIDANCE = `<artifacts_guidance>
Artifacts are standalone outputs the user keeps and opens outside the chat: documents (.md), code files, web pages (.html, self-contained), drawings (.svg), data (.json, .csv). The user sees them as tiles in a panel.
- Use create_artifact for substantial content the user will keep, reuse or open on its own (more than a short snippet). Keep your chat reply short and refer to the artifact by title.
- To change an existing artifact, use update_artifact with its ID and the complete new content; do not create a duplicate. Earlier revisions are kept.
- Short answers, explanations and small code snippets belong in the chat reply, not in an artifact.
</artifacts_guidance>`;

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
export function createArtifactTools(service: ConversationService, access: ArtifactAccess, runId?: string) {
  if (access === 'none') return [];
  const tools: Array<ArtifactTool<never>> = [];
  const add = <P extends object>(t: ArtifactTool<P>) => tools.push(t as unknown as ArtifactTool<never>);

  add(
    new ArtifactTool<{ include_transcripts?: boolean }>(
      service,
      ArtifactToolNames.LIST,
      'Lists the artifacts in this conversation, newest first, with IDs, titles, file names, revisions and whether the user pinned them.',
      Kind.Read,
      { type: 'object', properties: { include_transcripts: { type: 'boolean', description: 'Also list child-agent transcripts (default false).' } } },
      () => 'artifacts',
      (s, p) => {
        const views = sortedArtifacts(s.state.artifactViews.values()).filter((v) => p.include_transcripts || v.type !== 'agent_transcript');
        if (views.length === 0) return ok('There are no artifacts yet.', 'none');
        return ok(views.map((v) => `- ${describeArtifact(v)}`).join('\n'), `${views.length} artifact(s)`);
      },
    ),
  );

  add(
    new ArtifactTool<{ id: string; revision?: number }>(
      service,
      ArtifactToolNames.READ,
      'Returns the text content of an artifact (latest revision unless "revision" is given).',
      Kind.Read,
      {
        type: 'object',
        properties: { id: { type: 'string', description: 'Artifact ID, e.g. "a12".' }, revision: { type: 'integer', minimum: 1 } },
        required: ['id'],
      },
      (p) => `${p.id}${p.revision ? ` r${p.revision}` : ''}`,
      (s, p) => {
        const content = s.artifactContent(p.id, p.revision);
        if (!isTextMime(content.mime)) throw new ArtifactError(`Artifact ${p.id} is ${content.mime}, not text; it cannot be read as text.`);
        const text = content.data.toString('utf8');
        return ok(`Artifact ${p.id} "${content.view.title}" (${content.filename}, revision ${content.rev}):\n\n${text}`, `${content.filename} r${content.rev}`);
      },
    ),
  );

  if (access === 'create') {
    add(
      new ArtifactTool<{ title: string; filename: string; content: string }>(
        service,
        ArtifactToolNames.CREATE,
        'Creates an artifact: a standalone file the user keeps (document, code, self-contained web page, SVG drawing or data file). The file extension decides how it is shown.',
        Kind.Other,
        {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 120, description: 'Short title shown on the artifact tile.' },
            filename: { type: 'string', maxLength: 100, description: 'File name with extension, e.g. "plan.md", "chart.svg", "index.html", "tool.py".' },
            content: { type: 'string', description: 'The complete file content.' },
          },
          required: ['title', 'filename', 'content'],
        },
        (p) => `"${p.title}" (${p.filename})`,
        (s, p, ctx) => {
          if (p.content.length > MAX_ARTIFACT_CHARS) throw new ArtifactError(`Artifact content is too large (${p.content.length} characters; the limit is ${MAX_ARTIFACT_CHARS}).`);
          const v = s.createArtifact({ title: p.title, filename: p.filename, content: p.content, run: runId, callId: ctx?.callId });
          return ok(`Created artifact ${v.id} "${v.title}" (${path.posix.basename(v.path ?? '')}). The user can open it from the artifacts panel.`, `created ${v.id}`);
        },
      ),
    );
    add(
      new ArtifactTool<{ id: string; content: string; title?: string; filename?: string }>(
        service,
        ArtifactToolNames.UPDATE,
        'Replaces an artifact\'s content with a new revision (the previous revision is kept). Give the complete new content, optionally a new title or file name.',
        Kind.Other,
        {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Artifact ID, e.g. "a12".' },
            content: { type: 'string', description: 'The complete new file content.' },
            title: { type: 'string', maxLength: 120 },
            filename: { type: 'string', maxLength: 100 },
          },
          required: ['id', 'content'],
        },
        (p) => `${p.id}${p.title ? ` → "${p.title}"` : ''}`,
        (s, p, ctx) => {
          if (p.content.length > MAX_ARTIFACT_CHARS) throw new ArtifactError(`Artifact content is too large (${p.content.length} characters; the limit is ${MAX_ARTIFACT_CHARS}).`);
          const v = s.updateArtifact(p.id, { content: p.content, title: p.title, filename: p.filename, run: runId, callId: ctx?.callId });
          return ok(`Updated artifact ${v.id} "${v.title}" to revision ${v.rev}.`, `${v.id} r${v.rev}`);
        },
      ),
    );
  }
  return tools;
}
