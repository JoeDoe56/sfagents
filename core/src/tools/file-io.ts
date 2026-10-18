/**
 * Text file helpers shared by write_file and edit. Mirrors upstream's
 * BOM and line-ending preservation (qwen-code tools/edit.ts, write-file.ts),
 * without encoding detection: SF Agents reads and writes UTF-8.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createPatch } from 'diff';

export type LineEnding = 'lf' | 'crlf';

export interface TextFileSnapshot {
  /** Content with LF line endings and no BOM. */
  content: string;
  bom: boolean;
  lineEnding: LineEnding;
}

export function detectLineEnding(content: string): LineEnding {
  return content.includes('\r\n') ? 'crlf' : 'lf';
}

export async function readTextFile(filePath: string): Promise<TextFileSnapshot> {
  const raw = await fs.readFile(filePath, 'utf8');
  const bom = raw.codePointAt(0) === 0xfeff;
  const withoutBom = bom ? raw.slice(1) : raw;
  return {
    content: withoutBom.replace(/\r\n/g, '\n'),
    bom,
    lineEnding: detectLineEnding(withoutBom),
  };
}

export async function writeTextFile(
  filePath: string,
  content: string,
  options: { bom: boolean; lineEnding: LineEnding },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let out = content.replace(/\r\n/g, '\n');
  if (options.lineEnding === 'crlf') out = out.replace(/\n/g, '\r\n');
  if (options.bom) out = '﻿' + out;
  await fs.writeFile(filePath, out, 'utf8');
}

export function makeDiff(fileName: string, oldContent: string, newContent: string): string {
  return createPatch(fileName, oldContent, newContent, 'Current', 'Proposed', { context: 3 });
}
