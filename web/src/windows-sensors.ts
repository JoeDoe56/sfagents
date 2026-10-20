/** Private, read-only process transport for the bundled Windows LHM adapter. */
import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { LhmSensor, LhmReader } from './lhm.js';

export interface WindowsSensorOptions {
  elevate?: boolean;
  log?: (message: string) => void;
  /** Tests use a small protocol fixture in place of the native executable. */
  command?: string;
  args?: string[];
  timeoutMs?: number;
  retryMs?: number;
}

export function sensorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|HOMEDRIVE|HOMEPATH)$/i;
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => allowed.test(name) && value !== undefined));
}

export class WindowsSensorClient implements LhmReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: Promise<LhmSensor[] | null> | undefined;
  private deliver: ((line: string | null) => void) | undefined;
  private failedAt = 0;
  private disposed = false;
  private warned = false;
  hint: string | null = null;
  processes: number | null = null;

  constructor(private readonly options: WindowsSensorOptions = {}) {}

  read(): Promise<LhmSensor[] | null> {
    if (this.disposed || (this.failedAt && Date.now() - this.failedAt < (this.options.retryMs ?? 30_000))) return Promise.resolve(null);
    if (this.pending) return this.pending;
    this.pending = this.request().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const command = this.options.command ?? fileURLToPath(new URL(`../native/bin/win-${process.arch}/SfAgents.Sensors.exe`, import.meta.url));
    if (!this.options.command && !fs.existsSync(command)) throw new Error('Bundled Windows sensors are missing. Run npm run build to prepare them.');
    const child = spawn(command, this.options.args ?? (this.options.elevate ? ['--elevate'] : []), {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: sensorEnvironment(process.env),
    });
    this.child = child;
    let buffered = '';
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (data: Buffer) => {
      buffered += decoder.write(data);
      if (Buffer.byteLength(buffered) > 8 * 1024 * 1024) { this.stop(); return; }
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        this.deliver?.(line);
      }
    });
    // Native error details are logged, never exposed as an HTTP endpoint.
    child.stderr.on('data', (data: Buffer) => this.options.log?.(data.toString().trim().slice(0, 2000)));
    child.stdin.on('error', () => this.deliver?.(null));
    child.on('error', () => this.deliver?.(null));
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
      this.deliver?.(null);
    });
    return child;
  }

  private async request(): Promise<LhmSensor[] | null> {
    try {
      const child = this.start();
      const line = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => finish(null), this.options.timeoutMs ?? (this.options.elevate ? 100_000 : 20_000));
        const finish = (value: string | null) => {
          clearTimeout(timeout);
          if (this.deliver === finish) this.deliver = undefined;
          resolve(value);
        };
        this.deliver = finish;
        child.stdin.write('read\n', (error) => { if (error) finish(null); });
      });
      if (!line) throw new Error('The Windows sensor helper stopped or did not respond.');
      const payload: unknown = JSON.parse(line);
      if (!payload || typeof payload !== 'object' || !('sensors' in payload) || !Array.isArray(payload.sensors) ||
          !payload.sensors.every(isSensor)) throw new Error('The Windows sensor helper returned invalid readings.');
      this.hint = 'hint' in payload && typeof payload.hint === 'string' ? payload.hint : null;
      this.processes = 'processes' in payload && typeof payload.processes === 'number' && Number.isInteger(payload.processes) && payload.processes > 0
        ? payload.processes : null;
      this.failedAt = 0;
      this.warned = false;
      return payload.sensors;
    } catch (error) {
      this.failedAt = Date.now();
      this.processes = null;
      this.hint = error instanceof Error ? error.message : 'Windows sensors are unavailable.';
      if (!this.warned) this.options.log?.(this.hint);
      this.warned = true;
      this.stop();
      return null;
    }
  }

  private stop(): void {
    this.deliver?.(null);
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.deliver?.(null);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.stdin.end();
    });
    this.child = undefined;
  }
}

function isSensor(value: unknown): value is LhmSensor {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return ['hardwareId', 'hardware', 'id', 'name', 'type'].every(key => typeof s[key] === 'string') &&
    (s.value === null || (typeof s.value === 'number' && Number.isFinite(s.value)));
}
