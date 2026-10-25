/**
 * Screen mirroring: this computer's screen in a sheet of SF Agents, streamed
 * to the browser over WebRTC.
 *
 * The capture, the encoding, the WebRTC transports and the input are
 * MoonlightWeb's (https://github.com/linckosz/moonlight-web, GPL-3.0): its
 * native engine and its per-stream worker, built as one helper program,
 * sfagents-screen (web/native/screen), and its stream page, served from
 * web/public/screen. Nothing of MoonlightWeb runs apart from that: SF Agents'
 * own server takes the place of MoonlightWeb's for the one host there is,
 * this computer. It:
 *
 *   - downloads the helper for this platform on first start, checked against
 *     the SHA-256 pinned here (as dictation downloads llama.cpp). On Windows
 *     the startup administrator approval copies it under Program Files and
 *     registers the elevated task that turns its virtual display on and off,
 *     as MoonlightWeb's installer does (screenSetupSteps);
 *   - answers the requests of the stream page (/api/screen/...) the way
 *     MoonlightWeb's server answers them for its native host: /start builds
 *     the stream's configuration (the transport chain, the size, the rate)
 *     and starts one helper with it (src/main.cpp, POST /api/hosts/:id/start);
 *   - carries the page's signaling WebSocket to that helper;
 *   - turns the virtual display off a moment after the last stream on it;
 *   - keeps each device's own settings (the stream's resolution, and the display's
 *     scaling on Windows, applied when that device streams).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getErrorMessage, readJsonFile, sfagentsHome, writeFileAtomic } from '@sfagents/core';

/** The helper's version: CI publishes it under the tag screen-v<version>. */
export const SCREEN_VERSION = '0.1.1';
export const SCREEN_RELEASES = `https://github.com/JoeDoe56/sfagents/releases/download/screen-v${SCREEN_VERSION}`;

interface Asset {
  name: string;
  sha256: string;
  /** The executable inside the archive. */
  exe: string;
}

/** Per platform-arch; an empty SHA-256 is a build not published yet. */
export const SCREEN_ASSETS: Readonly<Record<string, Asset>> = {
  'win32-x64': { name: 'sfagents-screen-win-x64.zip', sha256: 'd2866bd388cc8d564693875c025f814c7d3a5eccce53254269ab9892f9bf322f', exe: 'sfagents-screen/sfagents-screen.exe' },
  'linux-x64': { name: 'sfagents-screen-linux-x64.tar.gz', sha256: '51036a0f1c617d8d59140f07c13c599b81f4b9045a4200b7a416d3e204a12b67', exe: 'sfagents-screen/bin/sfagents-screen' },
};

/** The page's names for this computer, as MoonlightWeb's native host has them. */
export const HOST_UUID = 'moonlightweb-native-host';
/** The virtual display's app id (NativeHostBackend's kVirtualDisplayAppId). */
export const VIRTUAL_DISPLAY_APP = 1000;
/** The signaling socket the page connects to; ".../stream" is the WebSocket transport's. */
export const SIGNALING_PATH = '/api/screen/ws';
/** The worker's WebRTC media port (it takes the next free one when this one is in use). */
const MEDIA_PORT = 48560;
/** For a browser on the internet only: a LAN or tailnet one connects directly. */
const STUN_SERVER = 'stun:stun.l.google.com:19302';
/** The virtual display stays on this long after its last stream (a reload, a quality change). */
const VDISPLAY_GRACE_MS = 5_000;
/** How long a launch may take before the page is told it failed: past the helper's own two minutes for the virtual display, so its reason comes through. */
const START_TIMEOUT_MS = 150_000;
/** How long a stream's end is remembered for the page's stream-state question. */
const ENDS_KEEP_MS = 10 * 60_000;

/** Windows' scaling steps, in percent. */
export const DISPLAY_SCALES = [100, 125, 150, 175, 200, 225, 250, 300, 350];

/** The stream's size, as MoonlightWeb's page chooses it: its Auto, this screen pixel for pixel, or a height. */
export const SCREEN_RESOLUTIONS = ['auto', 'device', '1080', '720'] as const;
export type ScreenResolution = (typeof SCREEN_RESOLUTIONS)[number];

export interface DeviceScreenSettings {
  resolution: ScreenResolution;
  /** Windows scaling of the virtual display while this device streams, in percent; null = Windows' own. */
  displayScale: number | null;
}

const DEFAULT_SETTINGS: DeviceScreenSettings = { resolution: 'auto', displayScale: null };

export interface ScreenStatus {
  state: 'missing' | 'installing' | 'ready' | 'unavailable' | 'error';
  progress?: { label: string; done: number; total: number };
  /** Why it is unavailable or failed, in words for the sheet. */
  error?: string;
}

/** What the helper's --info says: this computer as the page knows a host, and its displays. */
export interface ScreenInfo {
  host: Record<string, unknown> & { nativeDisplay?: { state?: string; diagnostic?: string; virtual_display?: { installed?: boolean } } };
  apps: Array<Record<string, unknown> & { id: number }>;
}

/** Where a request comes from, for the ICE plan (main.cpp's streamClientKind). */
export type ClientKind = 'loopback' | 'private' | 'tunnel' | 'public';

export function classifyAddress(address: string | undefined): ClientKind {
  let ip = (address ?? '').trim();
  if (!ip) return 'public';
  if (ip.toLowerCase() === 'localhost') return 'loopback';
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'tunnel';
    return 'public';
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1') return 'loopback';
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return 'private';
    // Tailscale's IPv6 range is a ULA (fd7a:115c:a1e0::/48): private above.
    return 'public';
  }
  return 'public';
}

/**
 * The browser's place, seen through a reverse proxy too (Tailscale Serve,
 * cloudflared, nginx): the forwarding headers move it to "public", so that it
 * gets STUN and ICE-TCP, never the other way.
 */
export function clientKind(req: IncomingMessage): ClientKind {
  const kind = classifyAddress(req.socket.remoteAddress);
  if (kind !== 'loopback' && kind !== 'private') return kind;
  const h = req.headers;
  if (h['x-forwarded-for'] || h['forwarded'] || h['cf-connecting-ip'] || h['tailscale-funnel-request']) {
    const forwarded = String(h['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    // Tailscale Serve says who it carries: a tailnet peer stays one.
    const through = forwarded ? classifyAddress(forwarded) : 'public';
    return through === 'tunnel' || through === 'private' ? through : 'public';
  }
  return kind;
}

/** The fallback chain of transports, in the order MoonlightWeb tries them (TransportPriorities.h). */
export function transportChain(body: Record<string, unknown>, kind: ClientKind, codec: Codec): string[] {
  const enhancement = body['video_enhancement'] === 'on';
  const auto = enhancement
    ? ['webrtc-dc-udp', 'webrtc-dc-tcp', 'wss', 'webrtc-media-udp', 'webrtc-media-tcp']
    : ['webrtc-dc-udp', 'webrtc-dc-tcp', 'webrtc-media-udp', 'webrtc-media-tcp', 'wss'];
  // <video> (MediaTrack) carries H.264 only: an HEVC or AV1 stream skips it.
  const order = auto.filter((t) => !(t.startsWith('webrtc-media') && (codec === 'hevc' || codec === 'av1' || codec === 'auto')));
  let mode = typeof body['transport_mode'] === 'string' && body['transport_mode'] ? (body['transport_mode'] as string) : 'auto';
  if (mode === 'all') mode = 'auto';
  let chain: string[];
  if (mode === 'auto') chain = order;
  else {
    const sibling = mode.endsWith('-udp') ? `${mode.slice(0, -4)}-tcp` : '';
    chain = [mode, ...(sibling && order.includes(sibling) ? [sibling] : []), ...order.filter((m) => m !== mode && m !== sibling)];
  }
  // No STUN answer from the browser: its UDP rungs would each run to their
  // ICE deadline. Only for an internet browser, and never down to nothing.
  if (body['udp_blocked'] === true && kind === 'public') {
    const kept = chain.filter((m) => !m.endsWith('-udp'));
    if (kept.length) chain = kept;
  }
  return chain;
}

export type Codec = 'auto' | 'h264' | 'hevc' | 'av1';
const CODEC_NUMBER: Record<Codec, number> = { auto: -1, h264: 0, hevc: 1, av1: 2 };

function codecOf(v: unknown): Codec {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'h264' || s === 'hevc' || s === 'av1' ? s : 'auto';
}

/**
 * The helper's configuration for one stream, from the page's /start request
 * (MoonlightWeb's main.cpp, the worker path of POST /api/hosts/:id/start,
 * for its native host).
 */
export function streamConfig(
  body: Record<string, unknown>,
  ctx: { kind: ClientKind; serverHost: string; serverPort: number; signalingPort: number; streamRelayPort: number },
): { cfg: Record<string, unknown>; chain: string[] } | { error: string; code: number } {
  const appId = Number(body['appId'] ?? 0);
  if (!Number.isInteger(appId) || appId <= 0) return { code: 400, error: 'Missing or invalid appId' };
  const int = (key: string, fallback = 0) => {
    const v = Number(body[key]);
    return Number.isFinite(v) ? Math.trunc(v) : fallback;
  };
  const bool = (key: string, fallback = false) => (typeof body[key] === 'boolean' ? (body[key] as boolean) : fallback);

  const codec = codecOf(body['video_codec']);
  const bitrate = int('stream_bitrate') > 0 ? int('stream_bitrate') : 20000;
  // 0 is "the display's own size", which the native host answers itself.
  const height = int('stream_height', 1080) > 0 ? int('stream_height') : typeof body['stream_height'] === 'number' ? 0 : 1080;
  let aspect = 16 / 9;
  const ratio = String(body['stream_aspect'] ?? '');
  if (ratio.includes(':')) {
    const [w, h] = ratio.split(':').map(Number) as [number, number];
    if (w > 0 && h > 0) aspect = w / h;
  }
  const width = height > 0 ? Math.round(height * aspect) & ~1 : 0;
  const fitBox = bool('stream_fit_box');
  const allowUpscale = fitBox && bool('stream_allow_upscale');
  const matchDisplay = fitBox && bool('stream_match_display');
  const side = (key: string) => {
    const v = int(key);
    return v >= 360 && v <= 4096 ? v & ~1 : 0;
  };
  const clientFps = (mhz: number) => (mhz <= 0 ? 0 : Math.min(240, Math.max(24, Math.round(mhz / 1000))));
  let fps = int('stream_fps');
  if (fps <= 0) fps = clientFps(int('client_refresh_mhz')) || 60;

  const chain = transportChain(body, ctx.kind, codec);
  const index = int('transport_index');
  if (!chain.length || index < 0 || index >= chain.length) return { code: 502, error: 'All transport modes failed' };
  const mode = chain[index]!;
  const internal = mode.startsWith('webrtc-media') ? 'webrtc-media' : mode.startsWith('webrtc-dc') ? 'webrtc' : 'wss';
  // MediaTrack carries H.264 only.
  const effective = internal === 'webrtc-media' && (codec === 'hevc' || codec === 'av1') ? 'h264' : codec;
  const uid = String(body['client_uniqueid'] ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .slice(0, 32);

  const cfg: Record<string, unknown> = {
    appId,
    codec: CODEC_NUMBER[effective],
    codecOverridden: effective !== codec,
    originalCodec: effective !== codec ? CODEC_NUMBER[codec] : -1,
    gamingMode: bool('gaming_mode'),
    internalTransport: internal,
    transportMode: mode,
    transportChain: chain,
    transportIndex: index,
    stunServer: ctx.kind === 'public' ? STUN_SERVER : '',
    height,
    width,
    fps,
    bitrateKbps: bitrate,
    yuv444: bool('chroma_444_enabled'),
    hdr: bool('hdr_enabled'),
    iceTcp: mode.endsWith('-tcp'),
    lowAudio: bool('low_audio'),
    muteHostAudio: bool('mute_host_audio', true),
    rideOutLoss: bool('ride_out_loss'),
    refInvalidation: bool('ref_invalidation', true),
    cropsToFrame: bool('crops_to_frame'),
    fpsCeiling: Math.max(0, int('stream_fps_max')),
    clientRefreshMilliHz: int('client_refresh_mhz'),
    clientVsync: bool('client_vsync'),
    clientTearingReal: bool('client_tearing_real'),
    followDisplayShape: bool('follow_display_shape'),
    fitRequestedBox: fitBox,
    allowUpscale,
    matchClientDisplay: matchDisplay,
    fallbackWidth: matchDisplay ? side('stream_fallback_width') : 0,
    fallbackHeight: matchDisplay ? side('stream_fallback_height') : 0,
    // The owner's own session: SF Agents' sign-in already let them in.
    viewerAdmin: true,
    virtualPrimary: appId === VIRTUAL_DISPLAY_APP,
    nativeVideoPipeline: 'auto',
    nativeTuning: '',
    rtpVideo: '',
    clientUniqueId: uid,
    clientKind: ctx.kind,
    autoMode: true,
    preferResume: false,
    serverHost: ctx.serverHost,
    serverHttpsPort: ctx.serverPort,
    signalingPort: ctx.signalingPort,
    streamRelayPort: ctx.streamRelayPort,
    mediaPort: MEDIA_PORT,
    wsPath: SIGNALING_PATH,
  };
  return { cfg, chain };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Where Windows keeps the helper SF Agents installed with administrator rights. */
export function programFilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['ProgramW6432'] ?? env['ProgramFiles'] ?? 'C:\\Program Files', 'SF Agents', 'Screen');
}

interface Stream {
  id: string;
  child: ChildProcess;
  signalingPort: number;
  streamRelayPort: number;
  device: string;
  appId: number;
  endedEvent: boolean;
  streaming: boolean;
}

export interface ScreenOptions {
  /** Where downloads and the devices' settings go (default <SF Agents home>/screen). */
  dir?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  onChange?: (status: ScreenStatus) => void;
  /** The helper to run, instead of a downloaded one (tests, development: SFAGENTS_SCREEN_EXE). */
  exe?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export class ScreenMirror {
  readonly dir: string;
  private readonly fetch: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly listeners = new Set<(status: ScreenStatus) => void>();
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly exeOverride: string | undefined;
  private status_: ScreenStatus = { state: 'missing' };
  private installing: Promise<void> | null = null;
  private info_: { at: number; value: Promise<ScreenInfo> } | null = null;
  private stream: Stream | null = null;
  /** How each stream ended, for the page's stream-state question. */
  private readonly ends = new Map<string, { state: 'live' | 'ended' | 'crashed'; device: string; at: number }>();
  private vdisplayTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: ScreenOptions = {}) {
    this.dir = options.dir ?? path.join(sfagentsHome(), 'screen');
    this.fetch = options.fetch ?? fetch;
    this.log = options.log ?? (() => {});
    if (options.onChange) this.listeners.add(options.onChange);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.exeOverride = options.exe ?? (process.env['SFAGENTS_SCREEN_EXE'] || undefined);
    if (this.helper()) this.status_ = { state: 'ready' };
    else if (!this.asset()) this.status_ = { state: 'unavailable', error: 'Screen mirroring has no build for this computer yet.' };
  }

  status(): ScreenStatus {
    return this.status_;
  }

  /** Calls @p fn at each change of status (the server tells the pages). */
  onStatus(fn: (status: ScreenStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(status: ScreenStatus): void {
    this.status_ = status;
    for (const fn of this.listeners) fn(status);
  }

  private asset(): Asset | undefined {
    return SCREEN_ASSETS[`${this.platform}-${this.arch}`];
  }

  /** The downloaded copy, in SF Agents' home. */
  downloadedDir(): string {
    return path.join(this.dir, SCREEN_VERSION);
  }

  downloadedExe(): string | null {
    const asset = this.asset();
    if (!asset) return null;
    const exe = path.join(this.downloadedDir(), ...asset.exe.split('/'));
    return fs.existsSync(exe) ? exe : null;
  }

  /**
   * The helper streams run: on Windows the copy under Program Files when the
   * startup approval installed this version there (only that one can turn the
   * virtual display on through its task), else the downloaded one.
   */
  helper(): string | null {
    if (this.exeOverride) return fs.existsSync(this.exeOverride) ? this.exeOverride : null;
    if (this.platform === 'win32') {
      const installed = path.join(programFilesDir(), 'sfagents-screen.exe');
      if (installedVersion() === SCREEN_VERSION && fs.existsSync(installed)) return installed;
    }
    return this.downloadedExe();
  }

  /** Downloads the helper when it is not here yet; resolves when it is (or failed). */
  ensure(): Promise<void> {
    if (this.helper() || this.downloadedExe()) {
      if (this.status_.state !== 'ready') this.set({ state: 'ready' });
      return Promise.resolve();
    }
    if (this.installing) return this.installing;
    const asset = this.asset();
    if (!asset) return Promise.resolve();
    this.installing = this.install(asset)
      .then(() => this.set({ state: 'ready' }))
      .catch((error) => {
        this.log(`screen: ${getErrorMessage(error)}`);
        this.set({ state: 'error', error: getErrorMessage(error) });
      })
      .finally(() => {
        this.installing = null;
      });
    return this.installing;
  }

  private async install(asset: Asset): Promise<void> {
    if (!asset.sha256) throw new Error('The screen mirroring helper for this computer is not published yet.');
    fs.mkdirSync(this.dir, { recursive: true });
    const archive = path.join(this.dir, asset.name);
    const label = 'Downloading screen mirroring';
    this.set({ state: 'installing', progress: { label, done: 0, total: 0 } });
    const headers: Record<string, string> = { 'User-Agent': 'SF-Agents', Accept: 'application/octet-stream' };
    const token = process.env['SFAGENTS_GITHUB_TOKEN'] || process.env['GITHUB_TOKEN'];
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await this.fetch(`${SCREEN_RELEASES}/${asset.name}`, { headers, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Downloading screen mirroring failed: HTTP ${res.status}.`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const hash = crypto.createHash('sha256');
    let done = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      done += chunk.length;
      if (done - last > 1_000_000) {
        last = done;
        this.set({ state: 'installing', progress: { label, done, total } });
      }
    });
    await pipeline(body, fs.createWriteStream(`${archive}.part`));
    if (hash.digest('hex') !== asset.sha256) {
      fs.rmSync(`${archive}.part`, { force: true });
      throw new Error('The screen mirroring download did not match its checksum.');
    }
    fs.renameSync(`${archive}.part`, archive);
    const target = this.downloadedDir();
    const staging = `${target}.part`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await extract(archive, staging);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    fs.rmSync(archive, { force: true });
  }

  /** This computer as the stream page knows it (cached for a few seconds: the page asks at each launch). */
  info(force = false): Promise<ScreenInfo> {
    if (!force && this.info_ && Date.now() - this.info_.at < 5_000) return this.info_.value;
    const exe = this.helper();
    const value = exe ? runInfo(exe) : Promise.reject(new Error('Screen mirroring is not installed yet.'));
    this.info_ = { at: Date.now(), value };
    value.catch(() => {
      if (this.info_?.value === value) this.info_ = null;
    });
    return value;
  }

  /** The device streaming now, if any. */
  streamingDevice(): string | null {
    return this.stream?.streaming ? this.stream.device : null;
  }

  // ------------------------------------------------------------ the page's API

  /**
   * POST /api/screen/start: one stream, in a helper of its own. A new start
   * takes over the running stream (MoonlightWeb's take-over: the page that
   * had it is told, and the newcomer gets the screen).
   */
  async start(body: Record<string, unknown>, req: IncomingMessage, device: string): Promise<{ code: number; body: Record<string, unknown> }> {
    if (body['standby'] === true) return { code: 200, body: { status: 'dual_unavailable', reason: 'one stream at a time' } };
    const exe = this.helper();
    if (!exe) return { code: 503, body: { error: 'Screen mirroring is still being set up.' } };
    if (this.vdisplayTimer) {
      clearTimeout(this.vdisplayTimer);
      this.vdisplayTimer = null;
    }
    await this.stop(true);
    const [signalingPort, streamRelayPort] = [await freePort(), await freePort()];
    const hostHeader = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
    const serverHost = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '');
    const port = Number(/:(\d+)$/.exec(hostHeader)?.[1] ?? (forwardedProto === 'http' ? 80 : 443));
    const made = streamConfig(body, { kind: clientKind(req), serverHost, serverPort: port, signalingPort, streamRelayPort });
    if ('error' in made) return { code: made.code, body: { error: made.error } };

    const id = crypto.randomBytes(12).toString('hex');
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(exe) });
    const stream: Stream = { id, child, signalingPort, streamRelayPort, device, appId: made.cfg['appId'] as number, endedEvent: false, streaming: false };
    this.stream = stream;
    child.stdin?.on('error', () => {});
    child.stdin?.write(`${JSON.stringify(made.cfg)}\n`);
    child.stderr?.setEncoding('utf8');
    let tail = '';
    child.stderr?.on('data', (d: string) => {
      tail = (tail + d).slice(-4000);
    });

    const answer = new Promise<{ code: number; body: Record<string, unknown> }>((resolve) => {
      const timer = setTimeout(() => resolve({ code: 504, body: { error: 'The stream did not start in time.' } }), START_TIMEOUT_MS);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event['event'] === 'response') {
            clearTimeout(timer);
            resolve({ code: Number(event['code'] ?? 500), body: (event['body'] as Record<string, unknown>) ?? {} });
          } else if (event['event'] === 'ended') {
            stream.endedEvent = true;
          }
        }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code: 500, body: { error: lastError(tail) ?? `The stream helper stopped (${signal ?? `exit ${code}`}).` } });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 500, body: { error: `The stream helper could not start: ${error.message}` } });
      });
    });

    child.once('exit', (code, signal) => {
      const crashed = !stream.endedEvent && (signal !== null || (code !== 0 && code !== null));
      const end = this.ends.get(id);
      if (end) this.ends.set(id, { ...end, state: crashed && end.state === 'live' ? 'crashed' : 'ended', at: Date.now() });
      if (crashed) this.log(`screen: the stream helper stopped (${signal ?? `exit ${code}`}): ${lastError(tail) ?? ''}`.trim());
      if (this.stream === stream) {
        this.stream = null;
        if (stream.appId === VIRTUAL_DISPLAY_APP) this.releaseVirtualDisplay(crashed ? 30_000 : VDISPLAY_GRACE_MS);
      }
    });

    const result = await answer;
    if (result.code === 200 && result.body['status'] === 'streaming' && this.stream === stream) {
      stream.streaming = true;
      this.ends.set(id, { state: 'live', device, at: Date.now() });
      this.prune();
      return { code: 200, body: { ...result.body, slot: 0, dual_supported: false, stream_id: id } };
    }
    this.log(`screen: the stream did not start (${result.code}): ${String(result.body['error'] ?? result.body['status'] ?? '')}${tail.trim() ? `\n${tail.trim().split('\n').slice(-15).join('\n')}` : ''}`);
    if (this.stream === stream) await this.stop(false);
    return result;
  }

  /** GET /api/screen/stream-state: how the page's stream ended (stream/CrashRelaunch.js). */
  streamState(id: string, device: string): string {
    const e = this.ends.get(id);
    return e && e.device === device ? e.state : 'unknown';
  }

  /** POST /api/screen/quit and /stop-session: the stream ends. */
  async quit(): Promise<void> {
    await this.stop(false);
  }

  /** Ends the running stream; @p takenOver tells its page another one took the screen. */
  private async stop(takenOver: boolean): Promise<void> {
    const s = this.stream;
    if (!s) return;
    this.stream = null;
    if (s.child.exitCode !== null || s.child.signalCode !== null) return;
    const gone = new Promise<void>((resolve) => s.child.once('exit', () => resolve()));
    try {
      s.child.stdin?.write(`${JSON.stringify({ cmd: takenOver ? 'takenOver' : 'quit' })}\n`);
    } catch {
      // gone already
    }
    const timer = setTimeout(() => s.child.kill(), 6_000);
    await gone;
    clearTimeout(timer);
  }

  /** The virtual display off again, unless a stream came back to it meanwhile. */
  private releaseVirtualDisplay(graceMs: number): void {
    if (this.vdisplayTimer) clearTimeout(this.vdisplayTimer);
    this.vdisplayTimer = setTimeout(() => {
      this.vdisplayTimer = null;
      if (this.stream || this.closed) return;
      const exe = this.helper();
      if (!exe) return;
      const child = spawn(exe, ['--vdisplay-off'], { stdio: 'ignore', windowsHide: true, cwd: path.dirname(exe) });
      child.on('error', () => {});
    }, graceMs);
    this.vdisplayTimer.unref?.();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, e] of this.ends) if (now - e.at > ENDS_KEEP_MS && e.state !== 'live') this.ends.delete(id);
  }

  /**
   * The page's signaling socket (and the WebSocket transport's, at
   * ".../stream"), carried to the running stream's helper.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pathname: string): boolean {
    const s = this.stream;
    if (!s || (pathname !== SIGNALING_PATH && pathname !== `${SIGNALING_PATH}/stream`)) return false;
    const port = pathname.endsWith('/stream') ? s.streamRelayPort : s.signalingPort;
    const upstream = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${pathname} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k === 'host' || k === 'cookie' || k === 'authorization') continue;
        for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    return true;
  }

  // ---------------------------------------------------------------- devices

  private settingsFile(): string {
    return path.join(this.dir, 'devices.json');
  }

  deviceSettings(device: string): DeviceScreenSettings {
    const all = readJsonFile<Record<string, Partial<DeviceScreenSettings>>>(this.settingsFile(), {});
    const s = { ...DEFAULT_SETTINGS, ...(all[device] ?? {}) };
    if (!SCREEN_RESOLUTIONS.includes(s.resolution)) s.resolution = 'auto';
    return s;
  }

  saveDeviceSettings(device: string, patch: Partial<DeviceScreenSettings>): DeviceScreenSettings {
    const all = readJsonFile<Record<string, Partial<DeviceScreenSettings>>>(this.settingsFile(), {});
    const next = { ...DEFAULT_SETTINGS, ...(all[device] ?? {}) };
    if (patch.resolution !== undefined) {
      if (!SCREEN_RESOLUTIONS.includes(patch.resolution)) throw new Error(`The resolution must be one of ${SCREEN_RESOLUTIONS.join(', ')}.`);
      next.resolution = patch.resolution;
    }
    if (patch.displayScale !== undefined) {
      if (patch.displayScale !== null && !DISPLAY_SCALES.includes(patch.displayScale)) throw new Error(`The display scaling must be one of ${DISPLAY_SCALES.join(', ')}.`);
      next.displayScale = patch.displayScale;
    }
    all[device] = next;
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.settingsFile(), `${JSON.stringify(all, null, 2)}\n`);
    return next;
  }

  close(): void {
    this.closed = true;
    if (this.vdisplayTimer) clearTimeout(this.vdisplayTimer);
    const s = this.stream;
    this.stream = null;
    if (s && s.child.exitCode === null) {
      try {
        s.child.stdin?.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
      } catch {
        // gone
      }
      setTimeout(() => s.child.kill(), 3_000).unref?.();
      // The display it made goes with SF Agents.
      if (s.appId === VIRTUAL_DISPLAY_APP) {
        const exe = this.helper();
        if (exe) s.child.once('exit', () => spawn(exe, ['--vdisplay-off'], { stdio: 'ignore', windowsHide: true, detached: true }).unref());
      }
    }
  }
}

/** The version under Program Files (written there by the startup approval). */
export function installedVersion(): string | null {
  try {
    return fs.readFileSync(path.join(programFilesDir(), 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

function lastError(log: string): string | undefined {
  const lines = log.split(/\r?\n/).filter((l) => /error|fail|cannot|could not/i.test(l));
  return lines.at(-1)?.replace(/^\S+\s+\S+\s+/, '').trim() || undefined;
}

function runInfo(exe: string): Promise<ScreenInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['--info'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(exe) });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim().split('\n').at(-1) ?? '') as ScreenInfo;
        if (!parsed.host) throw new Error('no host');
        resolve(parsed);
      } catch {
        reject(new Error(lastError(err) ?? `The screen helper did not answer (exit ${code}).`));
      }
    });
  });
}

/** Unpacks a .tar.gz or .zip with the system tar (bsdtar reads zip on Windows 10+). */
function extract(archive: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = process.platform === 'win32' ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const child = spawn(tar, ['-xf', archive, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar exited with code ${code}`))));
  });
}

// ------------------------------------------------------------ administrator setup

const VIGEMBUS_URL = 'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe';
const VIGEMBUS_SHA256 = '89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a';
export const VDISPLAY_TASK = 'SF Agents Virtual Display';
const FIREWALL_RULE = 'SF Agents Screen';

export interface SetupStep {
  file: string;
  args: string[];
  /** Exit codes that are not failures (3010: done, a restart finishes it). */
  ok?: number[];
}

function regKeyExists(key: string): boolean {
  return spawnSync('reg.exe', ['query', key], { stdio: 'ignore', windowsHide: true }).status === 0;
}

/** Who the scheduled task runs as, the way schtasks resolves it (MoonlightWeb's installer, TaskPrincipal). */
function taskPrincipal(env: NodeJS.ProcessEnv = process.env): string {
  let domain = env['USERDOMAIN'] ?? '';
  if (!domain || domain.toUpperCase() === 'WORKGROUP') domain = env['COMPUTERNAME'] ?? '';
  const user = env['USERNAME'] ?? '';
  return domain ? `${domain}\\${user}` : user;
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[^\x20-\x7e]/g, (c) => `&#${c.codePointAt(0)};`);
}

/** Where the stream leaves the virtual display's requests for the task (VirtualDisplay::stagingDir). */
export function vdisplayStagingDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env['LOCALAPPDATA'] ?? '', 'SF Agents', 'vdisplay');
}

/** The task is there, and names its staging folder (helper 0.1.1 on). */
function vdisplayTaskCurrent(): boolean {
  const r = spawnSync('schtasks.exe', ['/Query', '/TN', VDISPLAY_TASK, '/XML'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && String(r.stdout).includes('--vdisplay-dir');
}

/**
 * The trigger-less, elevated task the helper starts (`schtasks /Run`) to turn
 * its virtual display on and off without a prompt: MoonlightWeb's installer's
 * RegisterVirtualDisplayTask. Its command is the copy under Program Files,
 * which only an administrator can change. It names the staging folder
 * itself, so that the elevated run does not depend on its environment to find
 * the request.
 */
export function vdisplayTaskXml(exe: string, stagingDir = vdisplayStagingDir(), principal = taskPrincipal()): string {
  return [
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Author>SF Agents</Author></RegistrationInfo>',
    `  <Principals><Principal id="Author"><UserId>${xmlEscape(principal)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>`,
    '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowStartOnDemand>true</AllowStartOnDemand><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>',
    `  <Actions Context="Author"><Exec><Command>"${xmlEscape(exe)}"</Command><Arguments>--vdisplay-apply --vdisplay-dir "${xmlEscape(stagingDir)}"</Arguments></Exec></Actions>`,
    '</Task>',
    '',
  ].join('\r\n');
}

/**
 * Windows: what screen mirroring needs done with administrator rights and is
 * not done yet, for the startup approval (privileges.ts): the helper copied
 * under Program Files, the virtual display's driver and its task, the
 * firewall rule for the stream, and the ViGEmBus gamepad driver.
 */
export async function screenSetupSteps(screen: ScreenMirror, setupDir: string, fetchImpl: typeof fetch = fetch, log: (line: string) => void = () => {}): Promise<SetupStep[]> {
  if (process.platform !== 'win32') return [];
  await screen.ensure();
  const source = screen.downloadedExe();
  const steps: SetupStep[] = [];
  const pf = programFilesDir();
  const exe = path.join(pf, 'sfagents-screen.exe');
  const ps = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  fs.mkdirSync(setupDir, { recursive: true });

  if (source && installedVersion() !== SCREEN_VERSION) {
    const from = path.dirname(source);
    // Stopped first: a helper left running from an earlier start holds its files.
    const script = [
      `Get-Process sfagents-screen -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ${q(`${pf}\\*`)} } | Stop-Process -Force`,
      `New-Item -ItemType Directory -Force -Path ${q(pf)} | Out-Null`,
      `Copy-Item -Path ${q(`${from}\\*`)} -Destination ${q(pf)} -Recurse -Force`,
      `Set-Content -Path ${q(path.join(pf, 'VERSION'))} -Value ${q(SCREEN_VERSION)} -Encoding ascii`,
    ].join('; ');
    steps.push({ file: ps, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script] });
  }
  const willHave = Boolean(source) || installedVersion() === SCREEN_VERSION;
  if (!willHave) return steps;

  const vdInstalled = await screen
    .info(true)
    .then((i) => i.host.nativeDisplay?.virtual_display?.installed === true)
    .catch(() => false);
  if (!vdInstalled) {
    const dir = path.join(setupDir, 'vdisplay-install');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'request.json'), '{"action":"install"}\n');
    steps.push({ file: exe, args: ['--vdisplay-apply', '--stage=driver', '--vdisplay-dir', dir], ok: [0, 3010] });
  }
  if (!vdisplayTaskCurrent() || steps.length) {
    const xml = path.join(setupDir, 'vdisplay-task.xml');
    fs.writeFileSync(xml, vdisplayTaskXml(exe));
    steps.push({ file: 'schtasks.exe', args: ['/Create', '/TN', VDISPLAY_TASK, '/XML', xml, '/F'] });
  }
  if (spawnSync('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    steps.push({ file: 'netsh.exe', args: ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow', `program=${exe}`, 'enable=yes', 'profile=any'] });
  }
  if (!regKeyExists('HKLM\\SYSTEM\\CurrentControlSet\\Services\\ViGEmBus')) {
    try {
      const file = path.join(setupDir, 'ViGEmBus_1.22.0_x64_x86_arm64.exe');
      if (!fs.existsSync(file)) {
        const res = await fetchImpl(VIGEMBUS_URL, { headers: { 'User-Agent': 'SF-Agents' }, redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (crypto.createHash('sha256').update(buf).digest('hex') !== VIGEMBUS_SHA256) throw new Error('it did not match its checksum');
        fs.writeFileSync(file, buf);
      }
      steps.push({ file, args: ['/quiet', '/norestart'], ok: [0, 3010] });
    } catch (error) {
      log(`The gamepad driver could not be downloaded: ${getErrorMessage(error)}`);
    }
  }
  return steps;
}

/** Linux: the udev rule that lets the helper type and click (/dev/uinput), when it is missing. */
export const UINPUT_RULES = `KERNEL=="uinput", SUBSYSTEM=="misc", OPTIONS+="static_node=uinput", TAG+="uaccess", MODE="0660", GROUP="input"
KERNEL=="uhid", SUBSYSTEM=="misc", OPTIONS+="static_node=uhid", TAG+="uaccess", MODE="0660", GROUP="input"
`;

export function linuxInputNeedsSetup(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    fs.accessSync('/dev/uinput', fs.constants.W_OK);
    return false;
  } catch {
    return !fs.existsSync('/etc/udev/rules.d/70-sfagents-uinput.rules');
  }
}

/** The shell script, run as root once, that sets /dev/uinput up for the user. */
export function linuxInputScript(): string {
  const quoted = `'${UINPUT_RULES.replace(/'/g, `'\\''`)}'`;
  return [
    `printf '%s' ${quoted} > /etc/udev/rules.d/70-sfagents-uinput.rules`,
    `printf 'uinput\\nuhid\\n' > /etc/modules-load.d/sfagents-uinput.conf`,
    'modprobe uinput; modprobe uhid',
    'udevadm control --reload-rules; udevadm trigger --subsystem-match=misc',
  ].join('; ');
}
