/**
 * SF Agents' side of the bridge (see BRIDGE_SOURCE in scripts.ts): one
 * `docker exec -i` into the sfagents-bridge container whose standard input
 * and output carry every agent's proxy and host-channel connections, and the
 * connections SF Agents opens to servers inside agent containers. Nothing
 * listens on the host and no container has a network.
 */

import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { docker, type DockerCli } from './docker.js';
import { BRIDGE_SOURCE, FRAME, FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD } from './scripts.js';

export const BRIDGE_CONTAINER = 'sfagents-bridge';
export const RUN_VOLUME = 'sfagents-run';

export interface BridgeFile {
  content: string;
  mode?: number;
}

export function encodeFrame(type: number, id: number, payload?: Buffer | string): Buffer[] {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frames: Buffer[] = [];
  let at = 0;
  do {
    const part = body.subarray(at, at + MAX_FRAME_PAYLOAD);
    const head = Buffer.alloc(FRAME_HEADER_BYTES);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(id >>> 0, 1);
    head.writeUInt32BE(part.length, 5);
    frames.push(Buffer.concat([head, part]));
    at += MAX_FRAME_PAYLOAD;
  } while (at < body.length);
  return frames;
}

/** Splits a byte stream into frames. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly onFrame: (type: number, id: number, payload: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(5);
      if (this.buffer.length < FRAME_HEADER_BYTES + length) return;
      const type = this.buffer.readUInt8(0);
      const id = this.buffer.readUInt32BE(1);
      const payload = Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length));
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length);
      this.onFrame(type, id, payload);
    }
  }
}

/** One connection carried over the bridge. */
export class BridgeStream extends Duplex {
  private closedByPeer = false;
  constructor(
    readonly id: number,
    private readonly write$: (type: number, payload?: Buffer) => Promise<void>,
    private readonly forget: () => void,
  ) {
    super({ allowHalfOpen: true });
  }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.write$(FRAME.DATA, chunk).then(() => callback(), callback);
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.write$(FRAME.END).then(() => callback(), callback);
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.forget();
    if (!this.closedByPeer) void this.write$(FRAME.CLOSE).catch(() => {});
    callback(error);
  }
  /** @internal */
  peerData(payload: Buffer): void {
    this.push(payload);
  }
  /** @internal */
  peerEnd(): void {
    this.push(null);
  }
  /** @internal */
  peerClose(): void {
    this.closedByPeer = true;
    this.destroy();
  }
}

export interface BridgeOptions {
  image: string;
  /** A container opened a connection on an agent's proxy socket. */
  onConnection(agent: string, stream: BridgeStream): void;
  log?(message: string): void;
}

export class ContainerBridge {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private streams = new Map<number, BridgeStream>();
  private waiters = new Map<string, Array<{ resolve: () => void; reject: (e: Error) => void }>>();
  private nextId = 0;
  private stdinReady = Promise.resolve();

  constructor(
    private readonly cli: DockerCli,
    private readonly options: BridgeOptions,
  ) {}

  /** Starts the bridge container and its exec once (again after it stopped). */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.launch().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    const state = (await this.cli.run(['container', 'inspect', '--format', '{{.State.Running}}', BRIDGE_CONTAINER])).stdout.trim();
    if (state === '') {
      await docker(this.cli, ['volume', 'create', '--label', 'sfagents=1', RUN_VOLUME]);
      await docker(this.cli, [
        'run', '-d', '--name', BRIDGE_CONTAINER,
        '--label', 'sfagents=1', '--label', 'sfagents.role=bridge',
        '--network', 'none', '--user', 'root', '--restart', 'unless-stopped',
        '--memory', '256m', '--pids-limit', '256',
        '--mount', `type=volume,src=${RUN_VOLUME},dst=/run/sfagents`,
        this.options.image, 'sleep', 'infinity',
      ], { timeoutMs: 120_000 });
    } else if (state !== 'true') {
      await docker(this.cli, ['start', BRIDGE_CONTAINER]);
    }
    await docker(this.cli, ['exec', '-i', '-u', 'root', BRIDGE_CONTAINER, 'sh', '-c', 'mkdir -p /run/sfagents/agents && cat > /run/sfagents/bridge.cjs'], { stdin: BRIDGE_SOURCE });
    const child = this.cli.spawn(['exec', '-i', '-u', 'root', '-e', 'SFA_RUN=/run/sfagents/agents', BRIDGE_CONTAINER, 'node', '/run/sfagents/bridge.cjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const reader = new FrameReader((type, id, payload) => this.onFrame(type, id, payload));
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-2000)));
    child.stdin?.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The container bridge did not start: ${stderr.trim() || 'no answer'}`)), 30_000);
      this.waitFor('hello', () => {
        clearTimeout(timer);
        resolve();
      }, reject);
      child.stdout?.on('data', (c: Buffer) => reader.push(c));
      child.on('error', (error) => reject(error));
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.starting = undefined;
      this.options.log?.(`The container bridge stopped (exit ${code}). ${stderr.trim()}`);
      for (const s of this.streams.values()) s.peerClose();
      this.streams.clear();
      for (const [, list] of this.waiters) for (const w of list) w.reject(new Error('The container bridge stopped.'));
      this.waiters.clear();
    });
  }

  private waitFor(key: string, resolve: () => void, reject: (e: Error) => void): void {
    const list = this.waiters.get(key) ?? [];
    list.push({ resolve, reject });
    this.waiters.set(key, list);
  }

  private settle(key: string, error?: Error): void {
    const list = this.waiters.get(key);
    if (!list) return;
    this.waiters.delete(key);
    for (const w of list) (error ? w.reject(error) : w.resolve());
  }

  private send(type: number, id: number, payload?: Buffer | string): Promise<void> {
    const child = this.child;
    if (!child?.stdin) return Promise.reject(new Error('The container bridge is not running.'));
    // Frames of one write stay together; writes wait for the pipe to drain.
    this.stdinReady = this.stdinReady.then(() => new Promise<void>((resolve) => {
      let ok = true;
      for (const frame of encodeFrame(type, id, payload)) ok = child.stdin!.write(frame) && ok;
      if (ok) resolve();
      else child.stdin!.once('drain', () => resolve());
    }));
    return this.stdinReady;
  }

  private control(message: Record<string, unknown>): Promise<void> {
    return this.send(FRAME.CONTROL, 0, JSON.stringify(message));
  }

  private makeStream(id: number): BridgeStream {
    const stream = new BridgeStream(id, (type, payload) => this.send(type, id, payload), () => this.streams.delete(id));
    this.streams.set(id, stream);
    return stream;
  }

  private onFrame(type: number, id: number, payload: Buffer): void {
    if (type === FRAME.CONTROL) {
      let message: { op?: string; id?: string; error?: string };
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      if (message.op === 'hello') this.settle('hello');
      else if (message.op === 'agent-ready' && message.id) this.settle(`agent:${message.id}`);
      else if (message.op === 'error') {
        if (message.id) this.settle(`agent:${message.id}`, new Error(message.error ?? 'bridge error'));
        else this.options.log?.(`Container bridge: ${message.error}`);
      }
      return;
    }
    if (type === FRAME.OPEN) {
      let info: { agent?: string; kind?: string };
      try {
        info = JSON.parse(payload.toString('utf8'));
      } catch {
        void this.send(FRAME.CLOSE, id);
        return;
      }
      const stream = this.makeStream(id);
      if (info.kind === 'proxy' && info.agent) this.options.onConnection(info.agent, stream);
      else stream.destroy();
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    if (type === FRAME.DATA) stream.peerData(payload);
    else if (type === FRAME.END) stream.peerEnd();
    else if (type === FRAME.CLOSE) {
      this.streams.delete(id);
      stream.peerClose();
    }
  }

  /** Prepares an agent's run folder: its commands and its proxy socket. */
  async addAgent(id: string, files: Record<string, BridgeFile>): Promise<void> {
    await this.start();
    const ready = new Promise<void>((resolve, reject) => this.waitFor(`agent:${id}`, resolve, reject));
    await this.control({ op: 'agent', id, files });
    await ready;
  }

  async removeAgent(id: string): Promise<void> {
    if (this.child) await this.control({ op: 'remove-agent', id });
  }

  /** A connection to `port` on the agent container's loopback. */
  async openPort(agent: string, port: number): Promise<BridgeStream> {
    await this.start();
    this.nextId += 2;
    const stream = this.makeStream(this.nextId);
    await this.send(FRAME.OPEN, this.nextId, JSON.stringify({ agent, kind: 'port', port }));
    return stream;
  }

  stop(): void {
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = undefined;
    this.starting = undefined;
  }
}

/**
 * A stream usable at once whose other end connects later (http.request's
 * createConnection must return synchronously). Writes wait for the
 * connection; a failed connection destroys the stream with its error.
 */
export function lazyDuplex(open: Promise<Duplex>): Duplex {
  let target: Duplex | undefined;
  const waiting: Array<() => void> = [];
  const proxy = new Duplex({
    allowHalfOpen: true,
    read() {
      target?.resume();
    },
    write(chunk, encoding, callback) {
      const go = () => (target!.write(chunk, encoding) ? callback() : target!.once('drain', () => callback()));
      if (target) go();
      else waiting.push(go);
    },
    final(callback) {
      const go = () => {
        target!.end();
        callback();
      };
      if (target) go();
      else waiting.push(go);
    },
    destroy(error, callback) {
      target?.destroy();
      callback(error);
    },
  });
  open.then(
    (stream) => {
      if (proxy.destroyed) return stream.destroy();
      target = stream;
      stream.on('data', (chunk) => {
        if (!proxy.push(chunk)) stream.pause();
      });
      stream.on('end', () => proxy.push(null));
      stream.on('error', (error) => proxy.destroy(error));
      stream.on('close', () => {
        if (!proxy.readableEnded) proxy.push(null);
      });
      for (const go of waiting.splice(0)) go();
      proxy.emit('connect');
    },
    (error) => proxy.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  return proxy;
}
