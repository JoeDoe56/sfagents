import { uiNativeFile } from '../ui/ui.js';
/**
 * Agent containers: one long-lived container per agent, all from the same
 * image (ghcr.io/joedoe56/sfagents-agent), managed by SF Agents.
 *
 * Each container has no network (`--network none`); its only ways out are
 * the agent's two sockets in /run/sfa, served by the bridge (bridge.ts):
 * proxy.sock, which SF Agents enforces the agent's network level on
 * (network.ts), and ports.sock, which SF Agents uses to open the agent's
 * dev servers as app artifacts. It runs as `agent` (uid 1000) with sudo in
 * the container, a reduced capability set, and memory and process limits.
 *
 * Mounts, the same in every agent's container:
 *   /workspaces   shared, read-write: where agents clone and work
 *   /cache        shared package caches
 *   /home/agent   the agent's own home (and Wine prefix)
 *   /roots/<name> the agent's folders on this computer, read-only, with
 *                 secret files (.env, keys) and SF Agents' own files hidden
 *   /run/sfa      the agent's run folder (sockets and SF Agents' commands)
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { sfagentsHome } from '../settings/home.js';
import { getErrorMessage } from '../utils/errors.js';
import { isPathWithinRoot } from '../utils/paths.js';
import { sfaPatchScript, SFA_PATCH_COMMAND, APPLY_PATCH_COMMAND } from '../tools/sfa-patch.js';
import { VIEW_COMMAND, VIEW_SOURCE } from '../tools/sfa-view.js';
import type { ToolImage } from '../tools/tools.js';
import { runHostCommand, type HostCommands } from '../tools/host-commands.js';
import { networkLog } from './network-log.js';
import { ContainerBridge, RUN_VOLUME, type BridgeFile } from './bridge.js';
import { defaultDockerCli, docker, type DockerCli } from './docker.js';
import { handleProxyConnection, type NetworkEvent, type NetworkLevel } from './network.js';
import { CLIENT_SOURCE, clientLauncher, EXEC_SOURCE, INIT_SOURCE, KILL_SOURCE } from './scripts.js';
import { distroWorkspacesDir, mountRootsInDistro, windowsWorkspacesDir } from './wsl.js';

export const DEFAULT_AGENT_IMAGE = 'ghcr.io/joedoe56/sfagents-agent:docker';
export const CACHE_VOLUME = 'sfagents-cache';
export const CONTAINER_WORKSPACES = '/workspaces';
export const CONTAINER_ROOTS = '/roots';
/** SF Agents' commands inside containers, and the names they run as on the host. */
/** SF Agents' commands in every container; each hands its call to SF Agents. */
export const CONTAINER_COMMANDS: readonly string[] = ['sfa-web', 'sfa-artifact', 'sfa-mcp', 'sfa-git', 'sfa-ci', 'sfa-ui'];
/** Commands that are scripts of their own in the container but also ask SF Agents. */
const SCRIPT_COMMANDS: readonly string[] = [VIEW_COMMAND];
/** Capabilities sudo and apt need; everything else (NET_RAW, NET_ADMIN, SYS_*) stays dropped. */
export const CONTAINER_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETUID', 'SETGID', 'KILL', 'AUDIT_WRITE'];
/** The Git helper's id, as an agent's (it is not one: no agent file can have a name starting with a dot). */
export const GIT_HELPER_AGENT = '.sfagents-git';
export const DEFAULT_MEMORY_MB = 4096;
export const DEFAULT_CPUS = 4;
/** How long a checked container counts as ready without checking again. */
const READY_TTL_MS = 60_000;

export function agentImage(): string {
  return process.env['SFAGENTS_AGENT_IMAGE'] || DEFAULT_AGENT_IMAGE;
}

/** The container id for an agent: readable, unique, and safe as a name and folder. */
export function containerIdFor(agentId: string): string {
  const slug = agentId.toLowerCase().replace(/\.json$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  return `${slug}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`;
}

export function containerName(cid: string): string {
  return `sfa-${cid}`;
}

/** Where /workspaces lives, as SF Agents (on this computer) reads it. */
export function hostWorkspacesDir(): string {
  // Tests point it at a temporary folder (their stand-in for Docker mounts it as /workspaces).
  const override = process.env['SFAGENTS_WORKSPACES_DIR'];
  if (override) return override;
  return process.platform === 'win32' ? windowsWorkspacesDir() : path.join(sfagentsHome(), 'workspaces');
}

export interface RootMount {
  /** The folder on this computer. */
  hostPath: string;
  /** /roots/<name> */
  containerPath: string;
}

export interface AgentContainerSpec {
  agentId: string;
  level: NetworkLevel;
  /** The agent's folders on this computer (mounted read-only). */
  roots: readonly string[];
  /** Files and folders under the roots no command may see (SF Agents' own, the project's .env). */
  hidden?: readonly string[];
  memoryMb?: number;
  cpus?: number;
}

/** Names folders under /roots by their last part, numbered when two share one. */
export function rootMounts(roots: readonly string[]): RootMount[] {
  const used = new Set<string>();
  const out: RootMount[] = [];
  for (const hostPath of roots) {
    const base = (hostPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'root').replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`;
    used.add(name.toLowerCase());
    out.push({ hostPath, containerPath: `${CONTAINER_ROOTS}/${name}` });
  }
  return out;
}

function within(child: string, parent: string): string | undefined {
  const sep = /[\\/]/;
  const c = child.split(sep).filter(Boolean);
  const p = parent.split(sep).filter(Boolean);
  const eq = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (c.length < p.length || !p.every((part, i) => eq(part, c[i]!))) return undefined;
  return c.slice(p.length).join('/');
}

/** A path on this computer as the container sees it, if it is mounted. */
export function hostToContainerPath(hostPath: string, mounts: readonly RootMount[]): string | undefined {
  const ws = within(hostPath, hostWorkspacesDir());
  if (ws !== undefined) return ws ? `${CONTAINER_WORKSPACES}/${ws}` : CONTAINER_WORKSPACES;
  for (const m of [...mounts].sort((a, b) => b.hostPath.length - a.hostPath.length)) {
    const rel = within(hostPath, m.hostPath);
    if (rel !== undefined) return rel ? `${m.containerPath}/${rel}` : m.containerPath;
  }
  return undefined;
}

/** A container path as SF Agents reads it on this computer (for artifacts). */
export function containerToHostPath(containerPath: string, mounts: readonly RootMount[]): string | undefined {
  const norm = path.posix.normalize(containerPath);
  const ws = path.posix.relative(CONTAINER_WORKSPACES, norm);
  if (ws === '' || (!ws.startsWith('..') && !path.posix.isAbsolute(ws))) return ws ? path.join(hostWorkspacesDir(), ...ws.split('/')) : hostWorkspacesDir();
  for (const m of mounts) {
    const rel = path.posix.relative(m.containerPath, norm);
    if (rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel))) return rel ? path.join(m.hostPath, ...rel.split('/')) : m.hostPath;
  }
  return undefined;
}

/** Names of files that usually hold secrets. */
const SECRET_NAME = /^(\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.dockercfg|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|pfx|p12|keystore|jks|kdbx))$/i;
const NOT_SECRET = /^\.env\.(example|sample|template|defaults?)$|\.pub$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.cache', '.gradle', 'bin', 'obj']);

/** Secret-looking files under a folder (a bounded walk that skips build output). */
export function findSecretFiles(root: string, limits = { depth: 6, entries: 50_000 }): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > limits.depth || seen > limits.entries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > limits.entries) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1);
      } else if (e.isFile() && SECRET_NAME.test(e.name) && !NOT_SECRET.test(e.name)) {
        found.push(p);
      }
    }
  };
  walk(root, 0);
  return found;
}

/** App artifacts of container agents: http://<container id>.sfa-agent:<port>/ */
export const APP_HOST_SUFFIX = '.sfa-agent';

function containerIdOf(state: AgentState): string {
  return containerIdFor(state.agentId);
}

/** The container id in an app artifact's host name, if it is one. */
export function containerIdFromAppHost(hostname: string): string | undefined {
  return hostname.endsWith(APP_HOST_SUFFIX) ? hostname.slice(0, -APP_HOST_SUFFIX.length) : undefined;
}

interface AgentState {
  agentId: string;
  level: NetworkLevel;
  mounts: RootMount[];
  /** Files and folders on this computer the container does not see (secrets, SF Agents' data). */
  hidden: string[];
  /** Outgoing network tunnels; local SF Agents command channels are excluded. */
  connections: Set<Duplex>;
  /** Commands running now, newest last: their host commands and call. */
  contexts: Array<{ cmds: HostCommands; callId?: string; signal: AbortSignal; command?: string; images?: ToolImage[] }>;
}

export interface ContainerManagerOptions {
  cli?: DockerCli;
  image?: string;
  /** Network log. */
  onNetwork?(event: NetworkEvent): void;
  log?(message: string): void;
}

export class ContainerManager {
  readonly cli: DockerCli;
  readonly image: string;
  readonly bridge: ContainerBridge;
  private agents = new Map<string, AgentState>();
  private imageReady?: Promise<void>;
  private preparing = new Map<string, Promise<string>>();
  /** Recently checked containers: spec key and when, per container id. */
  private ready = new Map<string, { key: string; name: string; at: number }>();

  constructor(private readonly options: ContainerManagerOptions = {}) {
    this.cli = options.cli ?? defaultDockerCli();
    this.image = options.image ?? agentImage();
    this.bridge = new ContainerBridge(this.cli, {
      image: this.image,
      onConnection: (cid, stream) => this.onConnection(cid, stream),
      log: options.log,
    });
  }

  /** Pulls the image once, if this machine does not have it. */
  ensureImage(): Promise<void> {
    this.imageReady ??= (async () => {
      const present = await this.cli.run(['image', 'inspect', '--format', '{{.Id}}', this.image]);
      if (present.code === 0) return;
      this.options.log?.(`Downloading the agent image ${this.image} (about 4 GB, once)…`);
      const started = Date.now();
      const ticker = setInterval(() => this.options.log?.(`  still downloading (${Math.round((Date.now() - started) / 1000)} s)…`), 20_000);
      try {
        await docker(this.cli, ['pull', '--quiet', this.image], { timeoutMs: 2 * 60 * 60_000 });
      } finally {
        clearInterval(ticker);
      }
    })().catch((error) => {
      this.imageReady = undefined;
      throw error;
    });
    return this.imageReady;
  }

  /** The files the bridge puts in an agent's /run/sfa/bin. */
  runFiles(): Record<string, BridgeFile> {
    const files: Record<string, BridgeFile> = {
      'sfa-desktop': { content: uiNativeFile('desktop.sh') },
      'sfa-ui-native.py': { content: uiNativeFile('linux.py'), mode: 0o644 },
      'sfa-init.cjs': { content: INIT_SOURCE, mode: 0o644 },
      'sfa-client.cjs': { content: CLIENT_SOURCE, mode: 0o644 },
      'sfa-exec': { content: EXEC_SOURCE },
      'sfa-kill': { content: KILL_SOURCE },
      [SFA_PATCH_COMMAND]: { content: sfaPatchScript() },
      [APPLY_PATCH_COMMAND]: { content: sfaPatchScript(APPLY_PATCH_COMMAND) },
      [VIEW_COMMAND]: { content: VIEW_SOURCE },
    };
    for (const name of CONTAINER_COMMANDS) files[name] = { content: clientLauncher(name) };
    return files;
  }

  /**
   * Makes sure the agent's container exists with this spec and is running,
   * and resolves with its name. A changed spec (folders, limits) recreates
   * the container; its home and the shared workspaces are kept. The network
   * level changes without a restart.
   */
  prepare(spec: AgentContainerSpec): Promise<string> {
    const cid = containerIdFor(spec.agentId);
    const mounts = rootMounts(spec.roots);
    const state = this.agents.get(cid);
    if (state) {
      this.setNetworkLevel(spec.agentId, spec.level);
      state.mounts = mounts;
      state.hidden = [...(spec.hidden ?? [])];
    } else {
      this.agents.set(cid, { agentId: spec.agentId, level: spec.level, mounts, hidden: [...(spec.hidden ?? [])], connections: new Set(), contexts: [] });
    }
    const key = `${cid}\0${JSON.stringify([spec.roots, spec.hidden, spec.memoryMb, spec.cpus])}`;
    // Checking a container costs a few wsl.exe calls and a walk for secret
    // files; commands in a row reuse the last check for a short while.
    const recent = this.ready.get(cid);
    if (recent && recent.key === key && Date.now() - recent.at < READY_TTL_MS) return Promise.resolve(recent.name);
    let pending = this.preparing.get(key);
    if (!pending) {
      pending = this.create(cid, spec, mounts)
        .then((name) => {
          this.ready.set(cid, { key, name, at: Date.now() });
          return name;
        })
        .finally(() => this.preparing.delete(key));
      this.preparing.set(key, pending);
    }
    return pending;
  }

  /**
   * Runs a shell script in SF Agents' Git helper container: the agent image
   * with /workspaces, at network level "git", used for every Git operation
   * SF Agents does itself (see ../git/workspaces.ts), so logins for pushing
   * never enter an agent's container.
   */
  async runGit(script: string, o: { cwd: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
    const name = await this.prepare({ agentId: GIT_HELPER_AGENT, level: 'git', roots: [] });
    const env = Object.entries(o.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = ['exec', ...(o.stdin !== undefined ? ['-i'] : []), '-u', 'agent', '-w', '/', ...env, '-e', `SFA_CWD=${o.cwd}`, '-e', `SFA_COMMAND=${script}`, name, '/run/sfa/bin/sfa-exec', randomUUID()];
    const r = await this.cli.run(args, { ...(o.stdin !== undefined ? { stdin: o.stdin } : {}), timeoutMs: o.timeoutMs ?? 120_000 });
    return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
  }

  /**
   * Removes the agent's container and its home volume (Reset Environment,
   * and deleting the agent). /workspaces and the shared cache stay. The next
   * command makes a fresh container.
   */
  async removeAgent(agentId: string): Promise<void> {
    const cid = containerIdFor(agentId);
    this.ready.delete(cid);
    this.agents.delete(cid);
    await this.cli.run(['rm', '-f', containerName(cid)], { timeoutMs: 60_000 });
    await this.cli.run(['volume', 'rm', '-f', `sfagents-home-${cid}`], { timeoutMs: 60_000 });
    await this.bridge.removeAgent(cid).catch(() => {});
  }

  /** Checks the agent's container again on its next command. */
  forget(agentId: string): void {
    this.ready.delete(containerIdFor(agentId));
  }

  private async create(cid: string, spec: AgentContainerSpec, mounts: RootMount[]): Promise<string> {
    await this.ensureImage();
    await this.bridge.addAgent(cid, this.runFiles());
    const name = containerName(cid);
    const sources = process.platform === 'win32' ? await mountRootsInDistro(mounts.map((m) => m.hostPath)) : mounts.map((m) => m.hostPath);
    const hidden = new Set<string>();
    for (const m of mounts) for (const f of findSecretFiles(m.hostPath)) hidden.add(f);
    for (const h of spec.hidden ?? []) if (fs.existsSync(h) && mounts.some((m) => isPathWithinRoot(path.resolve(h), m.hostPath))) hidden.add(h);
    const state = this.agents.get(cid);
    if (state) state.hidden = [...new Set([...state.hidden, ...hidden])];
    const args = this.createArgs(cid, spec, mounts, sources, [...hidden]);
    const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
    const current = await this.cli.run(['container', 'inspect', '--format', '{{index .Config.Labels "sfagents.spec"}} {{.State.Running}}', name]);
    const [label, running] = current.stdout.trim().split(' ');
    if (current.code === 0 && label === hash) {
      if (running !== 'true') await docker(this.cli, ['start', name]);
      return name;
    }
    if (current.code === 0) await docker(this.cli, ['rm', '-f', name]);
    await this.ensureWorkspaces();
    await docker(this.cli, ['create', '--label', `sfagents.spec=${hash}`, ...args]);
    await docker(this.cli, ['start', name]);
    return name;
  }

  private async ensureWorkspaces(): Promise<void> {
    if (process.platform === 'win32') return; // made by the distro setup
    const dir = hostWorkspacesDir();
    fs.mkdirSync(dir, { recursive: true });
    // The agent is uid 1000 in its container; when SF Agents runs as root, hand the folder over.
    if (process.getuid?.() === 0 && fs.statSync(dir).uid !== 1000) fs.chownSync(dir, 1000, 1000);
  }

  /** `docker create` arguments (without the spec label). */
  createArgs(cid: string, spec: AgentContainerSpec, mounts: readonly RootMount[], sources: readonly string[], hidden: readonly string[]): string[] {
    const workspaces = process.platform === 'win32' ? distroWorkspacesDir() : hostWorkspacesDir();
    const args = [
      '--name', containerName(cid), '--hostname', cid.slice(0, 63),
      '--label', 'sfagents=1', '--label', 'sfagents.role=agent', '--label', `sfagents.agent=${spec.agentId}`,
      // Without a network Docker leaves the hostname out of /etc/hosts, and sudo complains.
      '--network', 'none', '--add-host', 'sfa-proxy:127.0.0.1', '--add-host', `${cid.slice(0, 63)}:127.0.0.1`,
      '--cap-drop', 'ALL', ...CONTAINER_CAPS.flatMap((c) => ['--cap-add', c]),
      '--memory', `${spec.memoryMb ?? DEFAULT_MEMORY_MB}m`, '--cpus', String(spec.cpus ?? DEFAULT_CPUS), '--pids-limit', '4096',
      '--mount', `type=bind,src=${workspaces},dst=${CONTAINER_WORKSPACES}`,
      '--mount', `type=volume,src=${CACHE_VOLUME},dst=/cache`,
      '--mount', `type=volume,src=sfagents-home-${cid},dst=/home/agent`,
      '--mount', `type=volume,src=${RUN_VOLUME},dst=/run/sfa,volume-subpath=agents/${cid}`,
    ];
    mounts.forEach((m, i) => args.push('--mount', `type=bind,src=${sources[i]},dst=${m.containerPath},readonly`));
    for (const h of hidden) {
      const target = hostToContainerPath(h, mounts);
      if (!target || target.startsWith(CONTAINER_WORKSPACES)) continue;
      const isDir = fs.statSync(h, { throwIfNoEntry: false })?.isDirectory();
      args.push('--mount', isDir ? `type=tmpfs,dst=${target},tmpfs-size=65536` : `type=bind,src=/dev/null,dst=${target},readonly`);
    }
    args.push('-e', `SFA_DESKTOP=${spec.agentId === GIT_HELPER_AGENT ? '0' : '1'}`, '-e', 'DISPLAY=:99', '-e', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/sfa-desktop-bus', '-e', 'NO_AT_BRIDGE=0', '-e', 'NODE_USE_ENV_PROXY=1', '-e', 'ACCESSIBILITY_ENABLED=1', '-e', 'QT_ACCESSIBILITY=1', '-e', 'GTK_MODULES=gail:atk-bridge', '-e', 'QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1', '-e', `SFA_AGENT=${cid}`, this.image, 'node', '/run/sfa/bin/sfa-init.cjs');
    return args;
  }

  /** The agent's root mounts (for path mapping). */
  mountsFor(agentId: string): RootMount[] {
    return this.agents.get(containerIdFor(agentId))?.mounts ?? [];
  }

  /**
   * Notes a command the agent is running: SF Agents' commands it runs use
   * these host commands, and the network log names it. Call the result when
   * the command has ended.
   */
  beginCommand(agentId: string, context: { cmds: HostCommands; callId?: string; signal: AbortSignal; command?: string; images?: ToolImage[] }): () => void {
    const state = this.agents.get(containerIdFor(agentId));
    if (!state) return () => {};
    state.contexts.push(context);
    return () => {
      const i = state.contexts.indexOf(context);
      if (i >= 0) state.contexts.splice(i, 1);
    };
  }

  /** Revoke existing tunnels when an editor change takes effect; the container stays running. */
  setNetworkLevel(agentId: string, level: NetworkLevel): void {
    const state = this.agents.get(containerIdFor(agentId));
    if (!state || state.level === level) return;
    state.level = level;
    for (const stream of state.connections) stream.destroy();
    state.connections.clear();
  }

  private onConnection(cid: string, stream: Duplex): void {
    const state = this.agents.get(cid);
    if (!state) {
      stream.destroy();
      return;
    }
    state.connections.add(stream);
    stream.once('close', () => state.connections.delete(stream));
    handleProxyConnection(cid, stream, {
      level: () => this.agents.get(cid)?.level ?? 'off',
      command: () => state.contexts.at(-1)?.command,
      log: (event) => (this.options.onNetwork ?? ((e: NetworkEvent) => networkLog().add(e)))({ ...event, agent: state.agentId }),
      hostChannel: (_cid, s, head) => {
        state.connections.delete(s);
        this.hostChannel(state, s, head);
      },
    });
  }

  /** One request from SF Agents' commands in the container: a JSON line in, a JSON line out. */
  private hostChannel(state: AgentState, stream: Duplex, head: Buffer): void {
    let buffer = head.toString('utf8');
    // Large enough for sfa-view's images (base64).
    const MAX = 64 * 1024 * 1024;
    const answer = async (line: string) => {
      const context = state.contexts.at(-1);
      let reply;
      try {
        const request = JSON.parse(line) as { argv?: unknown; cwd?: unknown; stdin?: unknown };
        if (!Array.isArray(request.argv) || !request.argv.length || !request.argv.every((a) => typeof a === 'string')) throw new Error('Malformed request.');
        const [name, ...rest] = request.argv as string[];
        if (!CONTAINER_COMMANDS.includes(name!) && !SCRIPT_COMMANDS.includes(name!)) throw new Error(`Unknown command ${name}.`);
        if (!context) throw new Error(`${name} works only while SF Agents runs one of this agent's commands.`);
        const cwd = typeof request.cwd === 'string' ? containerToHostPath(request.cwd, state.mounts) : undefined;
        reply = await runHostCommand([name!, ...rest.map((a) => name === 'sfa-ui' ? a : this.argToHost(a, request.cwd as string, state.mounts))], context.cmds, {
          ...(cwd ? { cwd } : {}),
          ...(typeof request.stdin === 'string' ? { stdin: request.stdin } : {}),
          callId: context.callId,
          signal: context.signal,
          ...(context.images ? { images: context.images } : {}),
          ...(typeof request.cwd === 'string' ? { containerCwd: request.cwd } : {}),
          container: { appHost: `${containerIdOf(state)}${APP_HOST_SUFFIX}`, writeRoots: [hostWorkspacesDir()], readRoots: state.mounts.map((m) => m.hostPath), hidden: state.hidden, show: (h) => hostToContainerPath(h, state.mounts) ?? h },
        });
      } catch (error) {
        reply = { ok: false, error: getErrorMessage(error) };
      }
      stream.end(`${JSON.stringify(reply)}\n`);
    };
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      // Only the new part can hold the end of the line (requests with images are large).
      const at = text.indexOf('\n');
      const end = at < 0 ? (chunk === '' ? buffer.indexOf('\n') : -1) : buffer.length + at;
      buffer += text;
      if (buffer.length > MAX) return stream.destroy();
      if (end < 0) return;
      stream.off('data', onData);
      void answer(buffer.slice(0, end));
    };
    stream.on('data', onData);
    if (buffer.includes('\n')) onData('');
  }

  /** Absolute container paths in arguments (an artifact's file) become the path SF Agents reads. */
  private argToHost(arg: string, _cwd: string | undefined, mounts: readonly RootMount[]): string {
    if (!arg.startsWith('/')) return arg;
    return containerToHostPath(arg, mounts) ?? arg;
  }

  /** A connection to a server an agent runs in its container (app artifacts), by container id. */
  openPort(cid: string, port: number): Promise<Duplex> {
    return this.bridge.openPort(cid, port);
  }

  /** Stops every agent container (SF Agents is quitting); they start again on their next command. */
  async stopAll(): Promise<void> {
    this.bridge.stop();
    const list = await this.cli.run(['ps', '-q', '--filter', 'label=sfagents.role=agent']);
    const ids = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    // Quitting has a few seconds for everything; kill instead of a graceful stop.
    if (ids.length) await this.cli.run(['kill', ...ids], { timeoutMs: 15_000 });
    this.agents.clear();
    this.ready.clear();
  }
}

let shared: ContainerManager | undefined;

/** The manager SF Agents shares (created on first use). */
export function containerManager(options?: ContainerManagerOptions): ContainerManager {
  shared ??= new ContainerManager(options);
  return shared;
}

/** Replaces the shared manager (tests). */
export function setContainerManagerForTesting(manager: ContainerManager | undefined): void {
  shared = manager;
}

