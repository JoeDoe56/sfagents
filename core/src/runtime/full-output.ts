/**
 * Full tool output that was too long for the model. The model gets the
 * start and the end; the whole text is kept here, on this computer, for a
 * week, and the message tool's "output" action reads it back (a page at a
 * time, or only the lines that match).
 */

import fs from 'node:fs';
import path from 'node:path';
import { sfagentsHome } from '../settings/home.js';

const KEEP_MS = 7 * 24 * 3600_000;
let pruned = 0;

function dir(): string {
  return path.join(sfagentsHome(), 'tool-output');
}

function file(callId: string): string {
  return path.join(dir(), `${callId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}.txt`);
}

/** Keeps a call's whole output. Never throws: the model still gets the shortened text. */
export function saveFullOutput(callId: string, text: string): boolean {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(callId), text);
    if (Date.now() - pruned > 3600_000) {
      pruned = Date.now();
      for (const f of fs.readdirSync(dir())) {
        const p = path.join(dir(), f);
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { force: true });
        } catch {
          // gone already
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function readFullOutput(callId: string): string | undefined {
  try {
    return fs.readFileSync(file(callId), 'utf8');
  } catch {
    return undefined;
  }
}

export const OUTPUT_PAGE_CHARS = 10_000;

/** A page of a long output, or the lines matching a pattern (case-insensitive; a plain substring if it is not a valid regex). */
export function viewOutput(text: string, options: { grep?: string; page?: number }): string {
  if (options.grep) {
    let match: (line: string) => boolean;
    try {
      const re = new RegExp(options.grep, 'i');
      match = (l) => re.test(l);
    } catch {
      const needle = options.grep.toLowerCase();
      match = (l) => l.toLowerCase().includes(needle);
    }
    const hits: string[] = [];
    let total = 0;
    text.split('\n').forEach((line, i) => {
      if (!match(line)) return;
      total++;
      if (hits.length < 200) hits.push(`${i + 1}: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
    });
    if (!total) return `No lines match "${options.grep}".`;
    return `${total} matching line(s)${total > hits.length ? `, first ${hits.length} shown` : ''} (line numbers):\n${hits.join('\n')}`;
  }
  const pages = Math.max(1, Math.ceil(text.length / OUTPUT_PAGE_CHARS));
  const page = Math.min(Math.max(1, options.page ?? 1), pages);
  const body = text.slice((page - 1) * OUTPUT_PAGE_CHARS, page * OUTPUT_PAGE_CHARS);
  return pages === 1 ? body : `Page ${page} of ${pages} (${text.length} chars):\n${body}${page < pages ? `\n[more: page ${page + 1}]` : ''}`;
}
