/**
 * Every line SF Agents logs while it runs (the web server, screen mirroring,
 * dictation, the administrator setup, warnings at startup), kept in memory
 * for the terminal's Logs tab and GET /api/logs.
 */

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

  constructor(private readonly max = 5000) {}

  /** Adds one or more lines (text with newlines is split; ANSI colours are removed). */
  add(text: string, level?: LogLine['level']): void {
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    for (const part of clean.split('\n')) {
      if (!part.trim()) continue;
      const line: LogLine = { seq: ++this.seq, time: new Date().toISOString(), text: part, level: level ?? (LEVEL.test(part) ? 'error' : WARNING.test(part) ? 'warning' : 'info') };
      this.kept.push(line);
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
