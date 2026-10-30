/**
 * Shared prompt files: the project's `prompts` folder, next to `agents`.
 *
 * An agent's systemPrompt may reference them: a line that is only
 * `@name.txt` (or `@name.md`, or `@name` for either; a bare `@name` that
 * names no file stays as text) is replaced by that file's text, so several agents can share instructions without copying
 * them. systemPrompt may also be a list, whose entries are joined in order:
 * `["@working-rules.txt", "@coding.txt", "You review pull requests."]`.
 * A prompt file may reference others the same way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROMPTS_DIR_NAME = 'prompts';
const PROMPT_EXTENSIONS = ['.txt', '.md'];
const MAX_DEPTH = 8;
const MAX_PROMPT_CHARS = 200_000;
/** A line that is only a reference: `@name.txt`, `@name.md` (spaces allowed) or `@name`. */
const REFERENCE = /^\s*@([^\s@][^\n]*?\.(?:txt|md)|[^\s@]+)\s*$/i;

export class PromptReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptReferenceError';
  }
}

export interface ExpandedPrompt {
  text: string;
  /** Prompt files used, as canonical absolute paths, in the order first read. */
  files: string[];
}

/** The file a reference names, inside `promptsDir`; undefined when there is none. */
function resolveReference(promptsDir: string, name: string): string | undefined {
  const clean = name.replace(/\\/g, '/');
  if (clean.split('/').some((part) => part === '..' || part === '') || path.isAbsolute(clean)) {
    throw new PromptReferenceError(`"@${name}" must name a file inside the ${PROMPTS_DIR_NAME} folder`);
  }
  const candidates = PROMPT_EXTENSIONS.includes(path.extname(clean).toLowerCase()) ? [clean] : PROMPT_EXTENSIONS.map((ext) => `${clean}${ext}`);
  for (const c of candidates) {
    const file = path.join(promptsDir, c);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return fs.realpathSync(file);
  }
  return undefined;
}

/** True when a line of a prompt is a reference to a prompt file. */
export function isPromptReference(line: string): boolean {
  return REFERENCE.test(line);
}

/**
 * Replaces each reference line in `text` with the file it names, in order.
 * Throws PromptReferenceError when a referenced file is missing, outside the
 * folder, or references itself.
 */
export function expandPrompt(text: string, promptsDir: string): ExpandedPrompt {
  const files: string[] = [];
  const realDir = fs.existsSync(promptsDir) ? fs.realpathSync(promptsDir) : promptsDir;
  const expand = (source: string, stack: string[]): string =>
    source
      .split(/\r?\n/)
      .map((line) => {
        const m = REFERENCE.exec(line);
        if (!m) return line;
        const name = m[1]!;
        const file = resolveReference(promptsDir, name);
        // "@name" without an extension that names no file is ordinary text.
        if (!file && !PROMPT_EXTENSIONS.includes(path.extname(name).toLowerCase())) return line;
        if (!file) {
          throw new PromptReferenceError(`"@${name}" was not found in the ${PROMPTS_DIR_NAME} folder (${PROMPT_EXTENSIONS.join(' or ')} files)`);
        }
        if (!file.startsWith(realDir + path.sep)) throw new PromptReferenceError(`"@${name}" leads outside the ${PROMPTS_DIR_NAME} folder`);
        if (stack.includes(file)) throw new PromptReferenceError(`"@${name}" references itself (${[...stack, file].map((f) => path.basename(f)).join(' → ')})`);
        if (stack.length >= MAX_DEPTH) throw new PromptReferenceError(`"@${name}" is nested more than ${MAX_DEPTH} references deep`);
        if (!files.includes(file)) files.push(file);
        return expand(fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim(), [...stack, file]);
      })
      .join('\n');
  const out = expand(text, []).trim();
  if (!out) throw new PromptReferenceError('the prompt is empty once its references are filled in');
  if (out.length > MAX_PROMPT_CHARS) throw new PromptReferenceError(`the prompt is longer than ${MAX_PROMPT_CHARS} characters once its references are filled in`);
  return { text: out, files };
}

/** The default prompt files shipped with SF Agents (examples/prompts). */
export function defaultPromptsDir(): string | undefined {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', PROMPTS_DIR_NAME);
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * Creates the project's prompts folder with the default prompt files when
 * it does not exist. Returns the paths it created.
 */
export function ensurePrompts(projectDir: string): string[] {
  const dir = path.join(projectDir, PROMPTS_DIR_NAME);
  if (fs.existsSync(dir)) return [];
  fs.mkdirSync(dir, { recursive: true });
  const created = [dir];
  const defaults = defaultPromptsDir();
  for (const name of defaults ? fs.readdirSync(defaults) : []) {
    if (!PROMPT_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
    const target = path.join(dir, name);
    fs.copyFileSync(path.join(defaults!, name), target, fs.constants.COPYFILE_EXCL);
    created.push(target);
  }
  return created;
}
