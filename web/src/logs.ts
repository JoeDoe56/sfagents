/**
 * Every line SF Agents logs while it runs (the web server, screen mirroring,
 * dictation, the administrator setup, warnings at startup, and each model
 * request with its token usage), kept in memory for the terminal's Logs tab
 * and GET /api/logs, and appended to a log file (one per day) by default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sfagentsHome } from '@sfagents/core';

/** The folder of the daily log files: SFAGENTS_LOG_DIR, else "logs" in SF Agents' own folder. "off" turns the files off. */
export function defaultLogDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = env['SFAGENTS_LOG_DIR']?.trim();
  if (set && /^(off|none|0|false)$/i.test(set)) return null;
  return set ? path.resolve(set) : path.join(sfagentsHome(env), 'logs');
}

/** Log files older than this are deleted when SF Agents starts. */
const KEEP_DAYS = 14;

export interface LogLine {
  /** Increases by one per line. */
  seq: number;
  time: string;
  text: string;
  level: 'info' | 'warning' | 'error';
}

const LEVEL = /^(error|failed|could not|couldn't)\b|\b(error|failed)\b:/i;
const WARNING = /^(warning|note)\b/i;

export class LogBook {
  private readonly kept: LogLine[] = [];
  private seq = 0;
  private readonly listeners = new Set<(line: LogLine) => void>();

  private dir: string | null = null;
  private fileFailed = false;

  constructor(private readonly max = 5000) {}

  /** Appends every line from now on (and the ones kept so far) to sfagents-YYYY-MM-DD.log in `dir`. */
  writeTo(dir: string | null): string | null {
    this.dir = dir;
    if (!dir) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
      for (const name of fs.readdirSync(dir)) {
        if (!/^sfagents-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const file = path.join(dir, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
        } catch {
          // in use or gone
        }
      }
      if (this.kept.length) fs.appendFileSync(this.file(this.kept[0]!.time), this.kept.map(lineText).join(''));
    } catch {
      this.fileFailed = true;
    }
    return this.file(new Date().toISOString());
  }

  /** Today's log file, when lines go to one. */
  currentFile(): string | null {
    return this.dir ? this.file(new Date().toISOString()) : null;
  }

  private file(time: string): string {
    // Local date, so a day's file matches the person's day.
    const d = new Date(time);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.dir!, `sfagents-${day}.log`);
  }

  /** Adds one or more lines (text with newlines is split; ANSI colours are removed). */
  add(text: string, level?: LogLine['level']): void {
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    for (const part of clean.split('\n')) {
      if (!part.trim()) continue;
      const line: LogLine = { seq: ++this.seq, time: new Date().toISOString(), text: part, level: level ?? (LEVEL.test(part) ? 'error' : WARNING.test(part) ? 'warning' : 'info') };
      this.kept.push(line);
      if (this.dir && !this.fileFailed) {
        try {
          fs.appendFileSync(this.file(line.time), lineText(line));
        } catch {
          // a full disk or a locked file must never stop SF Agents; the Logs tab still has it
          this.fileFailed = true;
        }
      }
      if (this.kept.length > this.max) this.kept.splice(0, this.kept.length - this.max);
      for (const l of this.listeners) l(line);
    }
  }

  lines(): LogLine[] {
    return [...this.kept];
  }

  onLine(listener: (line: LogLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function lineText(line: LogLine): string {
  return `${line.time} ${line.level === 'info' ? 'INFO ' : line.level === 'warning' ? 'WARN ' : 'ERROR'} ${line.text}\n`;
}
