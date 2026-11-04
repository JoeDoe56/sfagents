/**
 * `sfa-patch`: creates, changes and deletes files from an edit on stdin, in
 * either of the two formats models are trained on, detected from the text:
 *
 * - search/replace blocks (Aider style): a file path line, then
 *   `<<<<<<< SEARCH`, the exact old text, `=======`, the new text,
 *   `>>>>>>> REPLACE`; an empty SEARCH creates the file.
 * - apply_patch (OpenAI V4A): `*** Begin Patch`, `*** Add File:`,
 *   `*** Update File:` with `@@` hunks of ' ' context, '-' and '+' lines,
 *   `*** Delete File:`, `*** Move to:`, `*** End Patch`.
 *
 * The same rules for both: the old text must match exactly once (only line
 * endings and trailing whitespace are normalized; indentation must match),
 * a failed match is refused with the nearest lines in the file, one call is
 * all or nothing, and each file keeps its own line endings. It runs in the
 * agent's container as a Node script, so it touches only what the shell can.
 *
 * The source below is the script itself; sfaPatch() runs the same code for tests.
 */

import fsModule from 'node:fs';
import pathModule from 'node:path';

export const SFA_PATCH_COMMAND = 'sfa-patch';
/** Older name, kept so a model that knows apply_patch still finds it. */
export const APPLY_PATCH_COMMAND = 'apply_patch';

/** Which format the shell tool's description teaches a model. */
export type PatchFormat = 'search-replace' | 'apply-patch';

/** GPT and Codex models are trained on apply_patch; every other family on search/replace. */
export function patchFormatFor(model: string | undefined, providerKind?: string): PatchFormat {
  if (providerKind === 'codex') return 'apply-patch';
  const m = (model ?? '').toLowerCase();
  return /(^|\/)(gpt|o\d|codex)|codex/.test(m) ? 'apply-patch' : 'search-replace';
}

export const PATCH_SOURCE = String.raw`
const SEARCH = /^<{5,9} ?SEARCH\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const REPLACE = /^>{5,9} ?REPLACE\s*$/;

function detect(text) {
  if (/^\s*\*\*\* Begin Patch/.test(text)) return 'apply-patch';
  if (text.split(/\r?\n/).some((l) => SEARCH.test(l))) return 'search-replace';
  throw new Error('Unrecognized edit. Send search/replace blocks (path line, <<<<<<< SEARCH, old text, =======, new text, >>>>>>> REPLACE) or an apply_patch patch (*** Begin Patch ... *** End Patch).');
}

/** Search/replace blocks → [{ path, search: string|null, replace }]. */
function parseBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let path = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (SEARCH.test(l)) {
      if (!path) throw new Error('Line ' + (i + 1) + ': a SEARCH block needs the file path on the line before it.');
      const search = [];
      i++;
      while (i < lines.length && !DIVIDER.test(lines[i])) {
        if (SEARCH.test(lines[i]) || REPLACE.test(lines[i])) throw new Error('Line ' + (i + 1) + ': expected "=======" before this line.');
        search.push(lines[i++]);
      }
      if (i >= lines.length) throw new Error('The SEARCH block for ' + path + ' has no "=======".');
      const replace = [];
      i++;
      while (i < lines.length && !REPLACE.test(lines[i])) {
        if (SEARCH.test(lines[i]) || DIVIDER.test(lines[i])) throw new Error('Line ' + (i + 1) + ': expected ">>>>>>> REPLACE" before this line.');
        replace.push(lines[i++]);
      }
      if (i >= lines.length) throw new Error('The block for ' + path + ' has no ">>>>>>> REPLACE".');
      blocks.push({ path, search: search.length ? search : null, replace });
      continue;
    }
    const t = l.trim();
    // Fences, blank lines and prose between blocks are skipped; a line that looks like a path is the next file.
    if (!t || t.startsWith('\x60\x60\x60')) continue;
    const bare = t.replace(/^[*\x60'"]+|[*\x60'":]+$/g, '').replace(/^(?:File|Path):\s*/i, '');
    if (bare && !/\s{2,}/.test(bare) && /[\w.-]/.test(bare)) path = bare;
  }
  if (!blocks.length) throw new Error('No search/replace blocks found.');
  return blocks;
}

/** apply_patch → [{ kind, path, ... }]. */
function parsePatch(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (lines[i]?.trim() !== '*** Begin Patch') throw new Error('The patch must start with "*** Begin Patch".');
  i++;
  const ops = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '*** End Patch') return ops;
    let m;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new Error('Line ' + (i + 1) + ': lines of an added file start with "+".');
        body.push(lines[i].slice(1));
        i++;
      }
      ops.push({ kind: 'add', path: m[1].trim(), lines: body });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      ops.push({ kind: 'delete', path: m[1].trim() });
      i++;
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const op = { kind: 'update', path: m[1].trim(), hunks: [] };
      i++;
      if ((m = /^\*\*\* Move to: (.+)$/.exec(lines[i] ?? ''))) {
        op.moveTo = m[1].trim();
        i++;
      }
      let hunk;
      while (i < lines.length && !(lines[i].startsWith('*** ') && lines[i] !== '*** End of File')) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          hunk = { anchor: l.slice(2).trim(), old: [], new: [], eof: false };
          op.hunks.push(hunk);
        } else if (l === '*** End of File') {
          if (hunk) hunk.eof = true;
        } else {
          if (!hunk) {
            hunk = { anchor: '', old: [], new: [], eof: false };
            op.hunks.push(hunk);
          }
          const tag = l[0];
          const rest = l.slice(1);
          if (tag === ' ' || l === '') {
            hunk.old.push(rest);
            hunk.new.push(rest);
          } else if (tag === '-') hunk.old.push(rest);
          else if (tag === '+') hunk.new.push(rest);
          else throw new Error('Line ' + (i + 1) + ': hunk lines start with " ", "-" or "+".');
        }
        i++;
      }
      if (!op.hunks.length && !op.moveTo) throw new Error('Update of ' + op.path + ' has no changes.');
      ops.push(op);
    } else if (line.trim() === '') {
      i++;
    } else {
      throw new Error('Line ' + (i + 1) + ': expected "*** Add File:", "*** Update File:", "*** Delete File:" or "*** End Patch", got: ' + line);
    }
  }
  throw new Error('The patch must end with "*** End Patch".');
}

const norm = (s) => s.replace(/[ \t]+$/, '');

/** Every place old (lines) starts in file (lines) from start, comparing without trailing whitespace. */
function matches(file, old, start) {
  const target = old.map(norm);
  const out = [];
  for (let at = start; at + target.length <= file.length; at++) {
    let ok = true;
    for (let k = 0; k < target.length && ok; k++) ok = norm(file[at + k]) === target[k];
    if (ok) out.push(at);
  }
  return out;
}

/** The lines in file most like old, to show the model what is really there. */
function nearest(file, old) {
  if (!file.length) return '(the file is empty)';
  const want = old.map((s) => s.trim());
  let best = 0;
  let bestScore = -1;
  for (let at = 0; at < Math.max(1, file.length - old.length + 1); at++) {
    let score = 0;
    for (let k = 0; k < want.length; k++) {
      const got = (file[at + k] ?? '').trim();
      if (got === want[k]) score += 2;
      else if (got && want[k] && (got.includes(want[k]) || want[k].includes(got))) score += 1;
    }
    if (score > bestScore) [best, bestScore] = [at, score];
  }
  const from = Math.max(0, best - 1);
  const to = Math.min(file.length, best + Math.max(old.length, 1) + 1);
  return file.slice(from, to).map((l, k) => String(from + k + 1).padStart(5) + ' | ' + l).join('\n');
}

function splitFile(text) {
  const crlf = text.includes('\r\n');
  const endsWithNewline = /\n$/.test(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (endsWithNewline) lines.pop();
  return { lines, crlf, endsWithNewline: endsWithNewline || text === '' };
}

function joinFile(f) {
  const out = f.lines.join('\n') + (f.endsWithNewline && f.lines.length ? '\n' : '');
  return f.crlf ? out.replace(/\n/g, '\r\n') : out;
}

/** Replaces old with new in f.lines, exactly once at or after start; returns where it ended. */
function replaceOnce(f, old, neu, start, name, anchorNote) {
  const found = matches(f.lines, old, start);
  if (found.length === 1) {
    f.lines.splice(found[0], old.length, ...neu);
    return found[0] + neu.length;
  }
  const what = old.join('\n');
  if (!found.length) throw new Error('No match in ' + name + anchorNote + ' for:\n' + what + '\nThe nearest lines in the file are:\n' + nearest(f.lines, old) + '\n(Indentation must match exactly; only trailing whitespace and line endings are ignored.)');
  throw new Error(found.length + ' matches in ' + name + anchorNote + ' (lines ' + found.map((n) => n + 1).join(', ') + ') for:\n' + what + '\nInclude more surrounding lines so the old text matches exactly once.');
}

function counts(before, after) {
  // A short +/- summary: lines only in one version (a multiset difference).
  const tally = new Map();
  for (const l of before) tally.set(l, (tally.get(l) || 0) + 1);
  let added = 0;
  for (const l of after) {
    const n = tally.get(l) || 0;
    if (n > 0) tally.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of tally.values()) removed += n;
  return '+' + added + ' -' + removed;
}

/**
 * Applies an edit (either format) relative to cwd, all or nothing.
 * Returns the summary lines ("A path (+n -0)", "M path (+n -m)", "D path").
 */
function sfaPatch(text, fs, path, cwd) {
  const format = detect(text);
  const files = new Map(); // abs path -> { name, before: lines|null, f: split|null, deleted, movedFrom }
  const load = (name) => {
    const abs = path.resolve(cwd, name);
    if (!files.has(abs)) {
      let text = null;
      try {
        if (fs.statSync(abs).isDirectory()) throw new Error(name + ' is a folder.');
        text = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const f = text === null ? null : splitFile(text);
      files.set(abs, { name, before: f ? [...f.lines] : null, f, deleted: false });
    }
    return files.get(abs);
  };
  if (format === 'search-replace') {
    for (const b of parseBlocks(text)) {
      const e = load(b.path);
      if (b.search === null) {
        if (e.f && !e.deleted && e.f.lines.length) throw new Error(b.path + ' already exists: an empty SEARCH only creates a new file. Search for the lines to change instead.');
        e.f = { lines: [...b.replace], crlf: false, endsWithNewline: true };
        e.deleted = false;
        continue;
      }
      if (!e.f || e.deleted) throw new Error(b.path + ' does not exist (an empty SEARCH block creates a file).');
      replaceOnce(e.f, b.search, b.replace, 0, b.path, '');
    }
  } else {
    const ops = parsePatch(text);
    if (!ops.length) throw new Error('The patch changes nothing.');
    for (const op of ops) {
      const e = load(op.path);
      if (op.kind === 'add') {
        if (e.f && !e.deleted) throw new Error(op.path + ' already exists (use *** Update File).');
        e.f = { lines: op.lines, crlf: false, endsWithNewline: true };
        e.deleted = false;
      } else if (op.kind === 'delete') {
        if (!e.f || e.deleted) throw new Error(op.path + ' does not exist.');
        e.deleted = true;
      } else {
        if (!e.f || e.deleted) throw new Error(op.path + ' does not exist (use *** Add File).');
        let cursor = 0;
        for (const h of op.hunks) {
          let note = '';
          if (h.anchor) {
            const a = matches(e.f.lines, [h.anchor], cursor);
            if (a.length) cursor = a[0] + 1;
            else note = ' after "' + h.anchor + '"';
          }
          if (!h.old.length) {
            const at = h.anchor && !note ? cursor : e.f.lines.length;
            e.f.lines.splice(at, 0, ...h.new);
            cursor = at + h.new.length;
            continue;
          }
          const from = h.eof ? Math.max(cursor, e.f.lines.length - h.old.length) : cursor;
          cursor = replaceOnce(e.f, h.old, h.new, from, op.path, note);
        }
        if (op.moveTo) {
          const target = load(op.moveTo);
          if (target.f && !target.deleted && path.resolve(cwd, op.moveTo) !== path.resolve(cwd, op.path)) throw new Error(op.moveTo + ' already exists.');
          target.f = e.f;
          target.deleted = false;
          target.movedFrom = op.path;
          e.deleted = true;
        }
      }
    }
  }
  // Everything checked: now write.
  const summary = [];
  for (const [abs, e] of files) {
    if (e.deleted) {
      if (e.before !== null) {
        fs.unlinkSync(abs);
        summary.push('D ' + e.name);
      }
      continue;
    }
    if (!e.f) continue;
    const next = joinFile(e.f);
    const created = e.before === null;
    if (!created && next === joinFile({ ...e.f, lines: e.before })) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    summary.push((created ? (e.movedFrom ? 'R ' + e.movedFrom + ' -> ' : 'A ') : 'M ') + e.name + ' (' + counts(e.before ?? [], e.f.lines) + ')');
  }
  if (!summary.length) throw new Error('The edit changes nothing.');
  return summary.join('\n');
}
`;

const USAGE = String.raw`Usage: sfa-patch < edit
Creates, changes and deletes files. Send the edit on stdin in either format:

Search/replace blocks (the file path on its own line, then one or more blocks):
path/to/file.py
<<<<<<< SEARCH
exact old lines
=======
new lines
>>>>>>> REPLACE
An empty SEARCH creates a new file.

apply_patch:
*** Begin Patch
*** Update File: path/to/file.py
@@ optional line just above the change
 context line
-old line
+new line
*** Add File: new/file.txt
+contents
*** Delete File: old/file.txt
*** End Patch

The old text must match exactly once (indentation included; trailing
whitespace and line endings are ignored). If any part fails, no file changes.`;

/** The script put on the container's PATH as sfa-patch (and apply_patch). */
export function sfaPatchScript(name: string = SFA_PATCH_COMMAND): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
${PATCH_SOURCE}
const usage = ${JSON.stringify(USAGE)};
const NAME = ${JSON.stringify(name)};
function run(text) {
  try {
    process.stdout.write(sfaPatch(text, fs, path, process.cwd()) + '\\n');
  } catch (error) {
    process.stderr.write(NAME + ': ' + error.message + '\\n');
    process.exit(1);
  }
}
const arg = process.argv.slice(2).join(' ');
if (arg === '-h' || arg === '--help') {
  process.stdout.write(usage + '\\n');
} else if (arg) {
  run(arg);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => (input.trim() ? run(input) : (process.stderr.write(usage + '\\n'), process.exit(1))));
}
`;
}

/** sfaPatch for tests: the same code the container runs. */
export function sfaPatch(text: string, cwd: string): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('text', 'fs', 'path', 'cwd', `${PATCH_SOURCE}\nreturn sfaPatch(text, fs, path, cwd);`);
  return fn(text, fsModule, pathModule, cwd) as string;
}

/** How the shell tool's description tells a model to edit files. */
export function patchGuidance(format: PatchFormat): string {
  return format === 'apply-patch'
    ? 'To create, change or delete files, run sfa-patch with an apply_patch patch in the stdin parameter: *** Begin Patch, then *** Add File: <path> with + lines, *** Update File: <path> with @@ hunks of \' \' context, \'-\' removed and \'+\' added lines, or *** Delete File: <path>, then *** End Patch. The removed and context lines must match the file exactly once. If any part fails, nothing changes.'
    : 'To create or change files, run sfa-patch with search/replace blocks in the stdin parameter: the file path on its own line, then <<<<<<< SEARCH, the exact old lines, =======, the new lines, >>>>>>> REPLACE (several blocks and files per call are fine; an empty SEARCH creates a new file). The SEARCH text must match the file exactly once, indentation included. If any block fails, nothing changes. Delete files with rm.';
}
