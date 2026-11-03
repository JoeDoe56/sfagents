import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sfagentsHome } from '../settings/home.js';
import { sanitizeChildEnv } from '../utils/child-env.js';

export interface DecisionQuestion { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> }
export interface DecisionAnswer { choice?: string | null; confidence?: number; probabilities?: Record<string, number>; none_probability?: number; noul?: number }
export interface UiDecider { decide(state: unknown, questions: Record<string, DecisionQuestion>, images: string[], signal: AbortSignal): Promise<Record<string, DecisionAnswer>> }
interface Install { python: string; llama: string; model: string; projector: string; folder: string }
export interface StartLuxOptions { dir?: string; log?: (text: string) => void; prepareGpu?: () => Promise<void>; releaseGpu?: () => Promise<void> }

const port = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

/** One serialized GPU worker; its reference count covers concurrent agents' container UI tasks. */
export class StartLux implements UiDecider {
  private processes: ChildProcess[] = [];
  private starting?: Promise<string>;
  private url?: string;
  private refs = 0;
  private gpuPrepared = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lifetime?: AbortController;
  private readonly dir: string;
  constructor(private readonly o: StartLuxOptions = {}) { this.dir = o.dir ?? path.join(sfagentsHome(), 'ui-model'); }

  private env(): NodeJS.ProcessEnv {
    const env = sanitizeChildEnv(process.env, Object.keys(process.env).filter((k) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)));
    return { ...env, STARTLUX_LLAMACPP_BIDIR: 'server', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
  }
  private launch(exe: string, args: string[], signal: AbortSignal): ChildProcess {
    signal.throwIfAborted();
    const env = this.env();
    const libs = path.dirname(exe);
    env['LD_LIBRARY_PATH'] = `${libs}:${env['LD_LIBRARY_PATH'] ?? ''}`;
    const p = spawn(exe, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
    this.processes.push(p);
    p.stdout?.on('data', (c: Buffer) => this.o.log?.(c.toString().slice(-1000)));
    p.stderr?.on('data', (c: Buffer) => this.o.log?.(c.toString().slice(-1000)));
    p.on('error', () => {});
    return p;
  }
  private async healthy(url: string, child: ChildProcess, signal: AbortSignal): Promise<void> {
    for (let i = 0; i < 600; i++) {
      signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode || !child.pid) throw new Error('StartLux runtime exited before it was ready. See the app log.');
      try { if ((await fetch(`${url}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })).ok) return; } catch { signal.throwIfAborted(); }
      await delay(500, undefined, { signal });
    }
    throw new Error('StartLux startup timed out.');
  }
  private async start(signal: AbortSignal): Promise<string> {
    if (this.url) return this.url;
    if (this.starting) return this.starting;
    const life = new AbortController(); this.lifetime = life;
    signal.throwIfAborted();
    const combined = life.signal;
    this.starting = (async () => {
      const file = path.join(this.dir, 'installed.json');
      if (!fs.existsSync(file)) {
        const setup = fileURLToPath(new URL('../../native/ui/setup-startlux.py', import.meta.url));
        const installer = this.launch(process.env['SFAGENTS_PYTHON'] || (process.platform === 'win32' ? 'python' : 'python3'), [setup, this.dir], combined);
        await new Promise<void>((resolve, reject) => {
          const abort = () => { this.kill(installer); reject(combined.reason); };
          combined.addEventListener('abort', abort, { once: true });
          installer.once('error', reject);
          installer.once('exit', (code) => { combined.removeEventListener('abort', abort); code === 0 ? resolve() : reject(new Error('StartLux first-use installation failed. See the app log.')); });
        });
      }
      combined.throwIfAborted();
      const installed = JSON.parse(fs.readFileSync(file, 'utf8')) as Install;
      this.gpuPrepared = true;
      await this.o.prepareGpu?.();
      combined.throwIfAborted();
      const enginePort = await port(); const apiPort = await port();
      const llama = this.launch(installed.llama, ['-m', installed.model, '--mmproj', installed.projector, '-ngl', '99', '--host', '127.0.0.1', '--port', String(enginePort), '--parallel', '1', '--ctx-checkpoints', '0', '-c', '8192', '-b', '8192', '-ub', '8192', '-fa', 'on', '--image-min-tokens', '64', '--image-max-tokens', '1024', '--override-kv', 'qwen35.attention.causal=bool:false'], combined);
      await this.healthy(`http://127.0.0.1:${enginePort}`, llama, combined);
      const api = this.launch(installed.python, ['-m', 'startlux_decide.cli', 'serve', '--model', installed.folder, '--backend', 'llamacpp', '--llamacpp-url', `http://127.0.0.1:${enginePort}`, '--host', '127.0.0.1', '--port', String(apiPort), '--think-mode', 'never'], combined);
      const url = `http://127.0.0.1:${apiPort}`;
      await this.healthy(url, api, combined);
      this.url = url; return url;
    })().catch(async (e) => { this.stop(); throw e; }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    this.refs++;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        this.start(signal).then(() => { signal.removeEventListener('abort', abort); resolve(); }, (e) => { signal.removeEventListener('abort', abort); reject(e); });
      });
    } catch (e) { if (--this.refs === 0) this.stop(); throw e; }
    let released = false;
    return () => { if (!released) { released = true; if (--this.refs === 0) this.stop(); } };
  }

  async decide(state: unknown, questions: Record<string, DecisionQuestion>, images: string[], signal: AbortSignal): Promise<Record<string, DecisionAnswer>> {
    const run = async () => {
      signal.throwIfAborted();
      const url = await this.start(signal);
      const r = await fetch(`${url}/v1/systemone`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions, images, think_mode: 'never', allow_none: true }) });
      if (!r.ok) throw new Error(`StartLux answered ${r.status}.`);
      return (await r.json() as { answers: Record<string, DecisionAnswer> }).answers;
    };
    const result = this.queue.then(run, run); this.queue = result.catch(() => undefined); return result;
  }
  private kill(child: ChildProcess): void {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') { const p = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); p.on('error', () => child.kill()); }
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  }
  stop(): void {
    this.lifetime?.abort(); this.lifetime = undefined;
    for (const child of this.processes) this.kill(child);
    this.processes = []; this.url = undefined;
    if (this.gpuPrepared) { this.gpuPrepared = false; void this.o.releaseGpu?.(); }
  }
}
