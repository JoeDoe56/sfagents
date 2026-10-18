/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/cli/src/utils/readStdin.ts:
 * reads piped stdin with an 8 MB cap, truncating on a UTF-8 boundary.
 */

const MAX_STDIN_SIZE = 8 * 1024 * 1024;

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let totalSize = 0;
    let settled = false;
    process.stdin.setEncoding('utf8');

    const onReadable = () => {
      let chunk: string | null;
      while ((chunk = process.stdin.read() as string | null) !== null) {
        const chunkSize = Buffer.byteLength(chunk, 'utf8');
        if (totalSize + chunkSize > MAX_STDIN_SIZE) {
          const prefix = takeUtf8Prefix(chunk, MAX_STDIN_SIZE - totalSize);
          data += prefix;
          process.stderr.write(`Warning: stdin input truncated to ${MAX_STDIN_SIZE} bytes.\n`);
          finish();
          process.stdin.destroy();
          return;
        }
        data += chunk;
        totalSize += chunkSize;
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      process.stdin.removeListener('readable', onReadable);
      process.stdin.removeListener('end', finish);
      process.stdin.removeListener('error', onError);
    };
    process.stdin.on('readable', onReadable);
    process.stdin.on('end', finish);
    process.stdin.on('error', onError);
  });
}
