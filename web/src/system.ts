/**
 * System resources for the web client's monitor: CPU, GPU, memory, disk and
 * network activity, uptimes and how full each drive is.
 *
 * Readings come from Libre Hardware Monitor's web server when it is running
 * (see lhm.ts): CPU load, temperature and core count, GPU load, temperature
 * and VRAM, memory, each drive's read and write activity and the network.
 * Without it, the monitor falls back to what the operating system exposes
 * to an ordinary user, without extra packages: Node's os module everywhere;
 * /proc and /sys on Linux; vm_stat, netstat and ioreg on macOS; nvidia-smi
 * wherever it is installed. Anything unavailable is null and the client
 * shows a dash. Drive capacity always comes from statfs (per volume, as the
 * file manager shows it) and uptimes from the OS and this process.
 *
 * Without Libre Hardware Monitor, rates (CPU use, disk and network activity)
 * come from the difference between two samples. The monitor only samples
 * when asked: the first request (or one after a long gap) takes two samples
 * a moment apart, later requests compare with the previous one.
 *
 * The parsers are pure functions over the text the system gives, exported
 * for tests.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { LhmClient, lhmReadings, type LhmReadings } from './lhm.js';

export interface SystemSnapshot {
  host: string;
  platform: NodeJS.Platform;
  /** When this snapshot was taken (ms since the epoch). */
  at: number;
  /** Where the readings came from: Libre Hardware Monitor, or the operating system. */
  source: 'lhm' | 'os';
  /** A note for the reader when readings are missing that Libre Hardware Monitor would add. */
  hint: string | null;
  /** cores: physical cores when known; threads: logical processors. */
  cpu: { usage: number | null; temperature: number | null; cores: number | null; threads: number; model: string };
  gpu: { usage: number | null; temperature: number | null; name: string; memory: { used: number; total: number } | null } | null;
  memory: { used: number; total: number };
  /** read and write: fraction of time the busiest drive spent reading or writing; rates in bytes per second. */
  disk: { read: number | null; write: number | null; readRate: number; writeRate: number } | null;
  /** Bytes per second over all physical interfaces. */
  network: { down: number; up: number } | null;
  uptime: { system: number; sfagents: number };
  drives: DriveUsage[];
}

export interface DriveUsage {
  name: string;
  mount: string;
  /** Bytes in use and the size available to this user (used + free). */
  used: number;
  total: number;
}

interface Sample {
  at: number;
  cpu: { idle: number; total: number };
  cpuTemperature: number | null;
  gpu: SystemSnapshot['gpu'];
  memory: { used: number; total: number };
  disk: DiskCounters | null;
  network: { rx: number; tx: number } | null;
}

export interface DiskCounters {
  read: number;
  write: number;
  /** Milliseconds each disk spent reading and writing, by device (Linux only). */
  readMs?: Record<string, number>;
  writeMs?: Record<string, number>;
}

/** What the monitor reads from the machine; tests replace it. */
export interface SystemSource {
  platform: NodeJS.Platform;
  readFile(file: string): string | null;
  listDir(dir: string): string[];
  readLink(file: string): string | null;
  run(command: string, args: string[]): Promise<string | null>;
  statfs(mount: string): { blocks: number; bfree: number; bavail: number; bsize: number } | null;
  cpus(): os.CpuInfo[];
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  hostname(): string;
}

export function nodeSystemSource(): SystemSource {
  const missing = new Set<string>();
  return {
    platform: process.platform,
    readFile(file) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    listDir(dir) {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    readLink(file) {
      try {
        return fs.readlinkSync(file);
      } catch {
        return null;
      }
    },
    run(command, args) {
      if (missing.has(command)) return Promise.resolve(null);
      return new Promise((resolve) => {
        execFile(command, args, { timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) {
            // Not installed: do not try again. Other failures may pass.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.add(command);
            resolve(null);
            return;
          }
          resolve(stdout);
        });
      });
    },
    statfs(mount) {
      try {
        const s = fs.statfsSync(mount);
        return { blocks: Number(s.blocks), bfree: Number(s.bfree), bavail: Number(s.bavail), bsize: Number(s.bsize) };
      } catch {
        return null;
      }
    },
    cpus: () => os.cpus(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    uptime: () => os.uptime(),
    hostname: () => os.hostname(),
  };
}

// ------------------------------------------------------------------ parsers

/** /proc/meminfo: total and available memory in bytes. */
export function parseMeminfo(text: string): { total: number; available: number } | null {
  const field = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = field('MemTotal');
  if (!total) return null;
  const available = field('MemAvailable') ?? (field('MemFree') ?? 0) + (field('Buffers') ?? 0) + (field('Cached') ?? 0);
  return { total, available };
}

// Whole disks only: partitions repeat their disk's counts, and loop, RAM,
// device-mapper and optical devices are not drives the reader thinks of.
const PARTITION = /^(?:(?:sd|hd|vd|xvd)[a-z]+\d+|nvme\d+n\d+p\d+|mmcblk\d+p\d+)$/;
const VIRTUAL_DISK = /^(?:loop|ram|zram|dm-|sr|fd|md)\d*/;

/** /proc/diskstats: bytes read and written and busy milliseconds, over whole disks. */
export function parseDiskstats(text: string): DiskCounters {
  let read = 0;
  let write = 0;
  const readMs: Record<string, number> = {};
  const writeMs: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2]!;
    if (PARTITION.test(name) || VIRTUAL_DISK.test(name)) continue;
    // Fields after the name: reads, merged, sectors read, ms, writes, merged, sectors written, ms, in flight, io ms, …
    read += Number(f[5]) * 512;
    write += Number(f[9]) * 512;
    readMs[name] = Number(f[6]);
    writeMs[name] = Number(f[10]);
  }
  return { read, write, readMs, writeMs };
}

const VIRTUAL_INTERFACE = /^(?:lo|ifb\d*|docker\d*|br-|veth|virbr|vnet|tun|tap|utun|awdl|llw|gif|stf|anpi|bridge|ap\d|p2p|dummy|sit|ip6tnl|tailscale|wg|zt)/;

/** /proc/net/dev: bytes received and sent over physical interfaces. */
export function parseNetDev(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let any = false;
  for (const line of text.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (VIRTUAL_INTERFACE.test(m[1]!)) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    rx += f[0]!;
    tx += f[8]!;
    any = true;
  }
  return any ? { rx, tx } : null;
}

/** macOS `netstat -ibn`: bytes in and out per physical interface (link rows only). */
export function parseNetstatIb(text: string): { rx: number; tx: number } | null {
  const lines = text.split('\n').filter((l) => l.trim());
  const header = lines.shift()?.trim().split(/\s+/) ?? [];
  const ib = header.indexOf('Ibytes');
  const ob = header.indexOf('Obytes');
  if (ib < 0 || ob < 0) return null;
  const seen = new Set<string>();
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    const name = f[0]!.replace(/\*$/, '');
    if (!f[2]?.startsWith('<Link#') || seen.has(name) || VIRTUAL_INTERFACE.test(name)) continue;
    // Rows without an address have one column fewer before the counters.
    const shift = f.length < header.length ? header.length - f.length : 0;
    const r = Number(f[ib - shift]);
    const t = Number(f[ob - shift]);
    if (!Number.isFinite(r) || !Number.isFinite(t)) continue;
    seen.add(name);
    rx += r;
    tx += t;
  }
  return seen.size ? { rx, tx } : null;
}

/** macOS `vm_stat`: memory in use the way Activity Monitor counts it (app, wired and compressed). */
export function parseVmStat(text: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!size) return null;
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN);
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable');
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  if (![wired, compressed].every(Number.isFinite)) return null;
  const app = Number.isFinite(anonymous) ? anonymous - (Number.isFinite(purgeable) ? purgeable : 0) : pages('Pages active');
  return Math.max(0, (app + wired + compressed) * size);
}

export const NVIDIA_SMI_ARGS = ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name', '--format=csv,noheader,nounits'];

/** `nvidia-smi` with NVIDIA_SMI_ARGS: the busiest GPU (memory in MiB). */
export function parseNvidiaSmi(text: string): SystemSnapshot['gpu'] {
  let best: SystemSnapshot['gpu'] = null;
  for (const line of text.split('\n')) {
    const [u, t, mu, mt, ...name] = line.split(',').map((s) => s.trim());
    if (!u || name.length === 0) continue;
    const usage = Number(u);
    const temperature = Number(t);
    const used = Number(mu);
    const total = Number(mt);
    const gpu = {
      usage: Number.isFinite(usage) ? usage / 100 : null,
      temperature: Number.isFinite(temperature) ? temperature : null,
      name: name.join(', '),
      memory: Number.isFinite(used) && total > 0 ? { used: used * 1024 ** 2, total: total * 1024 ** 2 } : null,
    };
    if (!best || (gpu.usage ?? 0) > (best.usage ?? 0)) best = gpu;
  }
  return best;
}

/** macOS `ioreg -r -d 1 -w 0 -c IOAccelerator`: the GPU's "Device Utilization %". */
export function parseIoregGpu(text: string): SystemSnapshot['gpu'] {
  const usage = /"Device Utilization %"\s*=\s*(\d+)/.exec(text);
  if (!usage) return null;
  const model = /"model"\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? /"IOClass"\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? 'GPU';
  return { usage: Number(usage[1]) / 100, temperature: null, name: model, memory: null };
}

/** macOS `ioreg -c IOBlockStorageDriver -r -w 0`: total bytes read and written. */
export function parseIoregDisk(text: string): DiskCounters | null {
  let read = 0;
  let write = 0;
  let any = false;
  for (const m of text.matchAll(/"Statistics"\s*=\s*\{([^}]*)\}/g)) {
    const r = /"Bytes \(Read\)"\s*=\s*(\d+)/.exec(m[1]!);
    const w = /"Bytes \(Write\)"\s*=\s*(\d+)/.exec(m[1]!);
    if (!r || !w) continue;
    read += Number(r[1]);
    write += Number(w[1]);
    any = true;
  }
  return any ? { read, write } : null;
}

const DRIVE_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'zfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'hfsplus', 'apfs', 'bcachefs', 'jfs', 'reiserfs']);

/** /proc/mounts: one mount point per real drive, the shortest path first. */
export function parseMounts(text: string): { device: string; mount: string }[] {
  const byDevice = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [device, rawMount, type] = line.split(' ');
    if (!device || !rawMount || !type || !DRIVE_FS.has(type)) continue;
    if (!device.startsWith('/dev/') || device.startsWith('/dev/loop')) continue;
    const mount = rawMount.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (mount === '/boot' || mount.startsWith('/boot/') || mount.startsWith('/snap/')) continue;
    const known = byDevice.get(device);
    if (!known || mount.length < known.length) byDevice.set(device, mount);
  }
  return [...byDevice].map(([device, mount]) => ({ device, mount })).sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

// ------------------------------------------------------------------ monitor

/** /proc/cpuinfo: physical cores (distinct core ids per physical package). */
export function parseCpuinfo(text: string): number | null {
  const cores = new Set<string>();
  for (const block of text.split(/\n\s*\n/)) {
    const pkg = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (core !== undefined) cores.add(`${pkg ?? 0}:${core}`);
  }
  return cores.size || null;
}

const SAMPLE_GAP_MS = 400;
const STALE_MS = 15_000;
const DRIVE_TTL_MS = 10_000;
const WINDOWS_HINT = 'Start Libre Hardware Monitor with its web server (Options → Remote Web Server → Run) for temperatures, the GPU, and disk and network activity.';

export interface SystemMonitorOptions {
  /** Libre Hardware Monitor's web server; null to read only the operating system. */
  lhm?: LhmClient | null;
}

export class SystemMonitor {
  private previous: Sample | undefined;
  private pending: Promise<SystemSnapshot> | undefined;
  private last: SystemSnapshot | undefined;
  private drives: { at: number; list: DriveUsage[] } | undefined;
  private physicalCores: Promise<number | null> | undefined;
  private readonly startedAt = Date.now();
  private readonly lhm: LhmClient | null;

  constructor(
    private readonly source: SystemSource = nodeSystemSource(),
    options: SystemMonitorOptions = {},
  ) {
    this.lhm = options.lhm === undefined ? new LhmClient() : options.lhm;
  }

  /** A fresh snapshot (at most one per second; concurrent callers share one). */
  read(): Promise<SystemSnapshot> {
    if (this.pending) return this.pending;
    if (this.last && Date.now() - this.last.at < 1000) return Promise.resolve(this.last);
    this.pending = this.take().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async take(): Promise<SystemSnapshot> {
    const sensors = this.lhm ? await this.lhm.read() : null;
    if (sensors) {
      // Libre Hardware Monitor keeps its own rates; the OS samples restart if it goes away.
      this.previous = undefined;
      this.last = await this.fromLhm(lhmReadings(sensors));
      return this.last;
    }
    let before = this.previous;
    if (!before || Date.now() - before.at > STALE_MS) {
      before = await this.sample();
      await new Promise((r) => setTimeout(r, SAMPLE_GAP_MS));
    }
    const now = await this.sample();
    this.previous = now;
    this.last = await this.snapshot(before, now);
    return this.last;
  }

  private async common(at: number) {
    const cpus = this.source.cpus();
    return {
      host: this.source.hostname(),
      platform: this.source.platform,
      at,
      threads: cpus.length,
      model: cpus[0]?.model.trim() ?? '',
      cores: await this.cores(),
      uptime: { system: Math.round(this.source.uptime()), sfagents: Math.round((at - this.startedAt) / 1000) },
      drives: this.driveList(),
    };
  }

  private async fromLhm(r: LhmReadings): Promise<SystemSnapshot> {
    const c = await this.common(Date.now());
    return {
      host: c.host,
      platform: c.platform,
      at: c.at,
      source: 'lhm',
      hint: null,
      cpu: { usage: r.cpu?.usage ?? null, temperature: r.cpu?.temperature ?? null, cores: r.cpu?.cores ?? c.cores, threads: c.threads, model: r.cpu?.name || c.model },
      gpu: r.gpu,
      memory: r.memory ?? { used: this.source.totalmem() - this.source.freemem(), total: this.source.totalmem() },
      disk: r.disk,
      network: r.network,
      uptime: c.uptime,
      drives: c.drives,
    };
  }

  private async snapshot(a: Sample, b: Sample): Promise<SystemSnapshot> {
    const seconds = Math.max(0.001, (b.at - a.at) / 1000);
    const rate = (x: number, y: number) => Math.max(0, (y - x) / seconds);
    const cpuTotal = b.cpu.total - a.cpu.total;
    // The busiest disk's share of the interval spent reading, and writing.
    const busiest = (x?: Record<string, number>, y?: Record<string, number>) => {
      if (!x || !y) return null;
      let most = 0;
      for (const [name, ms] of Object.entries(y)) {
        const was = x[name];
        if (was !== undefined) most = Math.max(most, Math.min(1, (ms - was) / (seconds * 1000)));
      }
      return most;
    };
    const c = await this.common(b.at);
    return {
      host: c.host,
      platform: c.platform,
      at: b.at,
      source: 'os',
      hint: this.source.platform === 'win32' ? WINDOWS_HINT : null,
      cpu: {
        usage: cpuTotal > 0 ? Math.min(1, Math.max(0, 1 - (b.cpu.idle - a.cpu.idle) / cpuTotal)) : null,
        temperature: b.cpuTemperature,
        cores: c.cores,
        threads: c.threads,
        model: c.model,
      },
      gpu: b.gpu,
      memory: b.memory,
      disk:
        a.disk && b.disk
          ? {
              read: busiest(a.disk.readMs, b.disk.readMs),
              write: busiest(a.disk.writeMs, b.disk.writeMs),
              readRate: rate(a.disk.read, b.disk.read),
              writeRate: rate(a.disk.write, b.disk.write),
            }
          : null,
      network: a.network && b.network ? { down: rate(a.network.rx, b.network.rx), up: rate(a.network.tx, b.network.tx) } : null,
      uptime: c.uptime,
      drives: c.drives,
    };
  }

  /** Physical cores, looked up once (Libre Hardware Monitor counts them itself). */
  private cores(): Promise<number | null> {
    this.physicalCores ??= (async () => {
      const src = this.source;
      if (src.platform === 'linux') return parseCpuinfo(src.readFile('/proc/cpuinfo') ?? '');
      if (src.platform === 'darwin') {
        const n = Number((await src.run('sysctl', ['-n', 'hw.physicalcpu']))?.trim());
        return n > 0 ? n : null;
      }
      return null;
    })();
    return this.physicalCores;
  }

  private async sample(): Promise<Sample> {
    const src = this.source;
    let idle = 0;
    let total = 0;
    for (const c of src.cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    const [gpu, extra] = await Promise.all([this.gpu(), this.platformSample()]);
    return { at: Date.now(), cpu: { idle, total }, gpu, ...extra };
  }

  private async platformSample(): Promise<Pick<Sample, 'cpuTemperature' | 'memory' | 'disk' | 'network'>> {
    const src = this.source;
    const fallbackMemory = { used: src.totalmem() - src.freemem(), total: src.totalmem() };
    if (src.platform === 'linux') {
      const mem = parseMeminfo(src.readFile('/proc/meminfo') ?? '');
      const disk = src.readFile('/proc/diskstats');
      const net = src.readFile('/proc/net/dev');
      return {
        cpuTemperature: this.linuxCpuTemperature(),
        memory: mem ? { used: mem.total - mem.available, total: mem.total } : fallbackMemory,
        disk: disk ? parseDiskstats(disk) : null,
        network: net ? parseNetDev(net) : null,
      };
    }
    if (src.platform === 'darwin') {
      const [vm, net, disk] = await Promise.all([src.run('vm_stat', []), src.run('netstat', ['-ibn']), src.run('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-w', '0'])]);
      const used = vm ? parseVmStat(vm) : null;
      return {
        cpuTemperature: null,
        memory: used !== null ? { used, total: src.totalmem() } : fallbackMemory,
        disk: disk ? parseIoregDisk(disk) : null,
        network: net ? parseNetstatIb(net) : null,
      };
    }
    return { cpuTemperature: null, memory: fallbackMemory, disk: null, network: null };
  }

  private async gpu(): Promise<SystemSnapshot['gpu']> {
    const src = this.source;
    const nvidia = await src.run('nvidia-smi', NVIDIA_SMI_ARGS);
    if (nvidia) {
      const gpu = parseNvidiaSmi(nvidia);
      if (gpu) return gpu;
    }
    if (src.platform === 'darwin') {
      const out = await src.run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
      return out ? parseIoregGpu(out) : null;
    }
    if (src.platform === 'linux') return this.linuxGpu();
    return null;
  }

  /** AMD (and other DRM drivers that report it) through sysfs. */
  private linuxGpu(): SystemSnapshot['gpu'] {
    const src = this.source;
    for (const card of src.listDir('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
      const base = `/sys/class/drm/${card}/device`;
      const busy = src.readFile(`${base}/gpu_busy_percent`);
      if (busy === null) continue;
      let temperature: number | null = null;
      for (const hw of src.listDir(`${base}/hwmon`)) {
        const t = Number(src.readFile(`${base}/hwmon/${hw}/temp1_input`));
        if (t > 0) temperature = t / 1000;
      }
      const name = src.readFile(`${base}/product_name`)?.trim() || 'GPU';
      const used = Number(src.readFile(`${base}/mem_info_vram_used`));
      const total = Number(src.readFile(`${base}/mem_info_vram_total`));
      return { usage: Number(busy) / 100, temperature, name, memory: total > 0 && Number.isFinite(used) ? { used, total } : null };
    }
    return null;
  }

  /** The package temperature from the CPU's hwmon driver, else a CPU thermal zone. */
  private linuxCpuTemperature(): number | null {
    const src = this.source;
    const CPU_HWMON = /^(coretemp|k10temp|zenpower|cpu_thermal|soc_thermal|cpu-thermal)$/;
    for (const hw of src.listDir('/sys/class/hwmon')) {
      const dir = `/sys/class/hwmon/${hw}`;
      if (!CPU_HWMON.test(src.readFile(`${dir}/name`)?.trim() ?? '')) continue;
      let hottest: number | null = null;
      for (const f of src.listDir(dir).filter((n) => /^temp\d+_input$/.test(n))) {
        const v = Number(src.readFile(`${dir}/${f}`));
        if (v > 0 && (hottest === null || v > hottest)) hottest = v;
      }
      if (hottest !== null) return hottest / 1000;
    }
    for (const zone of src.listDir('/sys/class/thermal').filter((n) => n.startsWith('thermal_zone'))) {
      const type = src.readFile(`/sys/class/thermal/${zone}/type`)?.trim() ?? '';
      if (!/x86_pkg_temp|cpu|soc|acpitz/i.test(type)) continue;
      const v = Number(src.readFile(`/sys/class/thermal/${zone}/temp`));
      if (v > 0) return v / 1000;
    }
    return null;
  }

  private driveList(): DriveUsage[] {
    if (this.drives && Date.now() - this.drives.at < DRIVE_TTL_MS) return this.drives.list;
    const src = this.source;
    const candidates: { name: string; mount: string }[] = [];
    if (src.platform === 'linux') {
      const labels = this.linuxLabels();
      for (const { device, mount } of parseMounts(src.readFile('/proc/mounts') ?? '')) {
        candidates.push({ name: labels.get(device) ?? (mount === '/' ? 'System' : path.posix.basename(mount)), mount });
      }
    } else if (src.platform === 'darwin') {
      for (const name of src.listDir('/Volumes')) candidates.push({ name, mount: `/Volumes/${name}` });
      if (!candidates.length) candidates.push({ name: 'Macintosh HD', mount: '/' });
    } else if (src.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') candidates.push({ name: `${letter}:`, mount: `${letter}:\\` });
    } else {
      candidates.push({ name: 'System', mount: '/' });
    }
    const seen = new Set<string>();
    const list: DriveUsage[] = [];
    for (const c of candidates) {
      const s = src.statfs(c.mount);
      if (!s || s.blocks <= 0) continue;
      // The same volume under two names (macOS lists the boot volume in /Volumes).
      const key = `${s.blocks}:${s.bfree}:${s.bsize}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const used = (s.blocks - s.bfree) * s.bsize;
      list.push({ name: c.name, mount: c.mount, used, total: used + s.bavail * s.bsize });
    }
    this.drives = { at: Date.now(), list };
    return list;
  }

  private linuxLabels(): Map<string, string> {
    const labels = new Map<string, string>();
    for (const label of this.source.listDir('/dev/disk/by-label')) {
      const link = this.source.readLink(`/dev/disk/by-label/${label}`);
      if (!link) continue;
      // udev escapes spaces and slashes in labels as \x20 and \x2f.
      labels.set(path.posix.resolve('/dev/disk/by-label', link), label.replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    }
    return labels;
  }
}
