/**
 * `apply_patch`: edits files from a patch on stdin, in the format Codex and
 * GPT models write (*** Begin Patch / *** Add File / *** Update File /
 * *** Delete File / *** Move to / @@ hunks / *** End Patch). Editing through
 * a shell's quoting (cmd especially) breaks on multi-line text; a patch on
 * stdin does not. The command runs inside the agent's container as a Node script, so
 * the agent's file permissions apply to every change.
 *
 * The source below is the script itself (applyPatch is also exported for tests).
 */

import fsModule from 'node:fs';
import pathModule from 'node:path';

export const APPLY_PATCH_COMMAND = 'apply_patch';

/** The patch applier, as plain JavaScript (the script body and the tested function share it). */
export const APPLY_PATCH_SOURCE = String.raw`
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
      ops.push({ kind: 'add', path: m[1].trim(), text: body.join('\n') + '\n' });
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

/** Finds old lines in file lines from start: exactly, then ignoring trailing, then all surrounding whitespace. */
function findBlock(file, old, start, eof) {
  const tries = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()];
  for (const norm of tries) {
    const target = old.map(norm);
    const from = eof ? Math.max(start, file.length - target.length) : start;
    for (let at = from; at + target.length <= file.length; at++) {
      let ok = true;
      for (let k = 0; k < target.length && ok; k++) ok = norm(file[at + k]) === target[k];
      if (ok) return at;
    }
  }
  return -1;
}

function updateText(original, hunks, name) {
  const crlf = original.includes('\r\n');
  const endsWithNewline = /\n$/.test(original);
  let file = original.replace(/\r\n/g, '\n').split('\n');
  if (endsWithNewline) file.pop();
  let cursor = 0;
  for (const h of hunks) {
    if (h.anchor) {
      const a = findBlock(file, [h.anchor], cursor, false);
      if (a >= 0) cursor = a + 1;
    }
    if (!h.old.length) {
      // Pure insertion: after the anchor, or at the end.
      const at = h.anchor ? cursor : file.length;
      file.splice(at, 0, ...h.new);
      cursor = at + h.new.length;
      continue;
    }
    const at = findBlock(file, h.old, cursor, h.eof);
    if (at < 0) throw new Error('Could not find these lines in ' + name + ':\n' + h.old.join('\n'));
    file.splice(at, h.old.length, ...h.new);
    cursor = at + h.new.length;
  }
  let out = file.join('\n') + (endsWithNewline || !original ? '\n' : '');
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/** Applies a patch with the given fs and path modules, relative to cwd. Returns a summary. */
function applyPatch(text, fs, path, cwd) {
  const ops = parsePatch(text);
  if (!ops.length) throw new Error('The patch changes nothing.');
  const done = [];
  // Work out every change first, so a patch that does not apply changes nothing.
  const writes = [];
  for (const op of ops) {
    const file = path.resolve(cwd, op.path);
    if (op.kind === 'add') {
      if (fs.existsSync(file)) throw new Error(op.path + ' already exists (use *** Update File).');
      writes.push(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, op.text); });
      done.push('A ' + op.path);
    } else if (op.kind === 'delete') {
      if (!fs.existsSync(file)) throw new Error(op.path + ' does not exist.');
      writes.push(() => fs.unlinkSync(file));
      done.push('D ' + op.path);
    } else {
      const original = fs.readFileSync(file, 'utf8');
      const next = op.hunks.length ? updateText(original, op.hunks, op.path) : original;
      const target = op.moveTo ? path.resolve(cwd, op.moveTo) : file;
      writes.push(() => {
        if (op.moveTo) fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, next);
        if (op.moveTo && target !== file) fs.unlinkSync(file);
      });
      done.push('M ' + op.path + (op.moveTo ? ' -> ' + op.moveTo : ''));
    }
  }
  for (const w of writes) w();
  return done.join('\n');
}
`;

/** The script put on the container's PATH as `apply_patch`. */
export function applyPatchScript(): string {
  return String.raw`#!/usr/bin/env sf-node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
${APPLY_PATCH_SOURCE}
const usage = 'Usage: apply_patch < patch   (or: apply_patch "<patch text>")\n' +
  'Patch format:\n*** Begin Patch\n*** Update File: path/to/file\n@@ optional nearby line\n context\n-old line\n+new line\n*** Add File: new/file\n+contents\n*** Delete File: old/file\n*** End Patch';
function run(text) {
  try {
    process.stdout.write(applyPatch(text, fs, path, process.cwd()) + '\n');
  } catch (error) {
    process.stderr.write('apply_patch: ' + error.message + '\n');
    process.exit(1);
  }
}
const arg = process.argv.slice(2).join(' ');
if (arg === '-h' || arg === '--help') {
  process.stdout.write(usage + '\n');
} else if (arg) {
  run(arg);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => (input.trim() ? run(input) : (process.stderr.write(usage + '\n'), process.exit(1))));
}
`;
}

/** applyPatch for tests and helper mode. */
export function applyPatch(text: string, cwd: string): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('text', 'fs', 'path', 'cwd', `${APPLY_PATCH_SOURCE}\nreturn applyPatch(text, fs, path, cwd);`);
  return fn(text, fsModule, pathModule, cwd) as string;
}

