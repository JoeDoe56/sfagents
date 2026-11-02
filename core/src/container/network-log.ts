/**
 * The Network log: every connection an agent's container asked SF Agents'
 * proxy for (see network.ts), allowed or refused, with the command that made
 * it. Kept in memory (the last entries) and on disk as JSON lines, so the
 * agent sheet and the TUI show it across restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sfagentsHome } from '../settings/home.js';

export interface NetworkLogEntry {
  time: string;
  agent: string;
  /** The command that made the request, when known. */
  command?: string;
  host: string;
  port: number;
  allowed: boolean;
  reason?: string;
}

const MAX_LOG = 500;
/** The file starts over from the kept entries past this size. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class NetworkLog {
  private log: NetworkLogEntry[] = [];
  private listeners = new Set<(entry: NetworkLogEntry) => void>();

  /** @param file where the log is kept (JSON lines); its last entries are read back. */
  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_LOG)) {
        try {
          this.log.push(JSON.parse(line) as NetworkLogEntry);
        } catch {
          // a torn last line
        }
      }
    } catch {
      // no log yet
    }
  }

  entries(agent?: string): NetworkLogEntry[] {
    return agent ? this.log.filter((e) => e.agent === agent) : [...this.log];
  }

  add(entry: Omit<NetworkLogEntry, 'time'>): void {
    const full: NetworkLogEntry = { time: new Date().toISOString(), ...entry };
    this.log.push(full);
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        if ((fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > MAX_FILE_BYTES) {
          fs.writeFileSync(this.file, this.log.slice(-MAX_LOG).map((e) => JSON.stringify(e)).join('\n') + '\n');
        } else fs.appendFileSync(this.file, JSON.stringify(full) + '\n');
      } catch {
        // the in-memory log still has it
      }
    }
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    for (const l of this.listeners) l(full);
  }

  onEntry(listener: (entry: NetworkLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

let shared: NetworkLog | undefined;

/** The log every agent's container writes to (logs/network.jsonl in SF Agents' folder). */
export function networkLog(): NetworkLog {
  shared ??= new NetworkLog(path.join(sfagentsHome(), 'logs', 'network.jsonl'));
  return shared;
}
