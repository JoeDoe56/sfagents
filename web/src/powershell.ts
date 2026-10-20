/**
 * One long-lived Windows PowerShell process for the monitor's Windows
 * readings (processes, services, startup apps). Starting PowerShell takes
 * about a second, so commands are written to the same process's standard
 * input, one line each, and their output is read up to an end marker.
 *
 * Only commands built from fixed text are sent; anything variable (a
 * process id, a service name) is validated by the caller before it is put
 * into a command.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export class PowerShell {
  private child: ChildProcessWithoutNullStreams | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private buffer = '';
  private waiting: ((text: string | null) => void) | undefined;
  private readonly marker = `<<SFAGENTS-${randomBytes(6).toString('hex')}>>`;

  constructor(private readonly command = 'powershell.exe') {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      const at = this.buffer.indexOf(this.marker);
      if (at >= 0 && this.waiting) {
        const text = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + this.marker.length).replace(/^\r?\n/, '');
        const w = this.waiting;
        this.waiting = undefined;
        w(text);
      }
    });
    child.stderr.on('data', () => undefined);
    const gone = () => {
      if (this.child === child) this.child = undefined;
      this.buffer = '';
      this.waiting?.(null);
      this.waiting = undefined;
    };
    child.on('exit', gone);
    child.on('error', gone);
    // UTF-8 output, so names outside ASCII survive.
    child.stdin.write('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = "SilentlyContinue"\n');
    return child;
  }

  /** Runs one line of PowerShell; resolves with its output, or null if PowerShell is unavailable or too slow. */
  run(line: string, timeoutMs = 20_000): Promise<string | null> {
    const task = this.queue.then(
      () =>
        new Promise<string | null>((resolve) => {
          let child: ChildProcessWithoutNullStreams;
          try {
            child = this.start();
          } catch {
            resolve(null);
            return;
          }
          const timer = setTimeout(() => {
            this.waiting = undefined;
            // A stuck command: start over next time.
            child.kill();
            resolve(null);
          }, timeoutMs);
          this.waiting = (text) => {
            clearTimeout(timer);
            resolve(text);
          };
          child.stdin.write(`try { ${line} } catch { Write-Output ('ERROR: ' + $_.Exception.Message) }; Write-Output '${this.marker}'\n`);
        }),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Runs a command whose output is JSON (ConvertTo-Json -Compress). */
  async json<T>(line: string, timeoutMs?: number): Promise<T | null> {
    const out = await this.run(line, timeoutMs);
    if (!out) return null;
    const text = out.trim();
    if (text.startsWith('ERROR: ')) throw new Error(text.slice(7));
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  close(): void {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
  }
}
