/** Private, read-only process transport shared by bundled sensor adapters. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { LhmSensor, LhmReader } from './lhm.js';

export interface SensorProcessOptions {
  command: string;
  name: string;
  log?: (message: string) => void;
  /** Tests use a small protocol fixture in place of the native executable. */
  args?: string[];
  timeoutMs?: number;
  retryMs?: number;
  /**
   * How to run the program with administrator rights, from the approval
   * given at startup (privileges.ts). Used until it fails, or until
   * @p approved says the approval was not given; then the program runs
   * as command and args, at SF Agents' own level.
   */
  elevated?: { command: string; args: string[]; timeoutMs?: number; approved?: Promise<boolean> };
}

export function sensorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(PATH|HOME|TMPDIR|LANG|LC_ALL|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|HOMEDRIVE|HOMEPATH)$/i;
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => allowed.test(name) && value !== undefined));
}

export class SensorProcessClient implements LhmReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: Promise<LhmSensor[] | null> | undefined;
  private deliver: ((line: string | null) => void) | undefined;
  private failedAt = 0;
  private disposed = false;
  private warned = false;
  private elevated: SensorProcessOptions['elevated'];
  hint: string | null = null;
  processes: number | null = null;

  constructor(private readonly options: SensorProcessOptions) {
    this.elevated = options.elevated;
    void this.elevated?.approved?.then((ok) => { if (!ok) this.dropElevated(); }, () => this.dropElevated());
  }

  /** From now on, at SF Agents' own level. */
  private dropElevated(): void {
    if (!this.elevated) return;
    this.elevated = undefined;
    this.stop();
  }

  read(): Promise<LhmSensor[] | null> {
    if (this.disposed || (this.failedAt && Date.now() - this.failedAt < (this.options.retryMs ?? 30_000))) return Promise.resolve(null);
    if (this.pending) return this.pending;
    this.pending = this.request().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const program = this.options.command;
    if (path.isAbsolute(program) && !fs.existsSync(program)) throw new Error(`Bundled ${this.options.name} sensors are missing. Run npm run build to prepare them.`);
    const { command, args } = this.elevated ?? { command: program, args: this.options.args ?? [] };
    const child = spawn(command, args, {
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
        if (this.child === child) this.deliver?.(line);
      }
    });
    // Native error details are logged, never exposed as an HTTP endpoint.
    child.stderr.on('data', (data: Buffer) => this.options.log?.(data.toString().trim().slice(0, 2000)));
    // A child that was stopped (and replaced) no longer answers for the current request.
    const gone = () => {
      if (this.child !== child) return;
      this.child = undefined;
      child.kill();
      this.deliver?.(null);
    };
    child.stdin.on('error', gone);
    child.on('error', gone);
    child.on('exit', gone);
    return child;
  }

  private async request(): Promise<LhmSensor[] | null> {
    const elevated = this.elevated;
    try {
      const child = this.start();
      const line = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => finish(null), (this.elevated?.timeoutMs ?? this.options.timeoutMs) ?? 20_000);
        const finish = (value: string | null) => {
          clearTimeout(timeout);
          if (this.deliver === finish) this.deliver = undefined;
          resolve(value);
        };
        this.deliver = finish;
        child.stdin.write('read\n', (error) => { if (error) finish(null); });
      });
      if (!line) throw new Error(`The ${this.options.name} sensor helper stopped or did not respond.`);
      const payload: unknown = JSON.parse(line);
      if (!payload || typeof payload !== 'object' || !('sensors' in payload) || !Array.isArray(payload.sensors) ||
          !payload.sensors.every(isSensor)) throw new Error(`The ${this.options.name} sensor helper returned invalid readings.`);
      this.hint = 'hint' in payload && typeof payload.hint === 'string' ? payload.hint : null;
      this.processes = 'processes' in payload && typeof payload.processes === 'number' && Number.isInteger(payload.processes) && payload.processes > 0
        ? payload.processes : null;
      this.failedAt = 0;
      this.warned = false;
      return payload.sensors;
    } catch (error) {
      if (elevated && !this.disposed) {
        // (Not when the approval was declined: that was said already.)
        if (this.elevated) this.options.log?.(`${this.options.name} sensors: the elevated helper failed (${error instanceof Error ? error.message : String(error)}); reading without administrator rights.`);
        this.dropElevated();
        return this.request();
      }
      this.failedAt = Date.now();
      this.processes = null;
      this.hint = error instanceof Error ? error.message : `${this.options.name} sensors are unavailable.`;
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
