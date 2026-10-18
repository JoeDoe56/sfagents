/**
 * Minimal debug logger with the same call shape as upstream's
 * `createDebugLogger`. Output goes to stderr only when SFAGENTS_DEBUG is set,
 * so it never interleaves with normal CLI output.
 */

import { format } from 'node:util';

export interface DebugLogger {
  isEnabled(): boolean;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function enabled(): boolean {
  const value = process.env['SFAGENTS_DEBUG'];
  return value !== undefined && value !== '' && value !== '0';
}

export function createDebugLogger(tag: string): DebugLogger {
  const write = (level: string, args: unknown[]) => {
    if (!enabled()) return;
    process.stderr.write(`[${level}] [${tag}] ${format(...args)}\n`);
  };
  return {
    isEnabled: enabled,
    debug: (...args) => write('DEBUG', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  };
}
