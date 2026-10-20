/**
 * Detailed readings and history for the monitor's windows (Task Manager's
 * Performance tab): per-core CPU use and clock speed, a memory breakdown,
 * each drive's and each network adapter's activity, the GPU's sensors,
 * every hardware sensor Libre Hardware Monitor reports, and system facts.
 *
 * History is kept for the last few minutes of readings, recorded whenever
 * the monitor or a window asks for them (nothing is sampled in the
 * background while nobody is looking).
 */

import os from 'node:os';
import type { SystemMonitor, SystemSnapshot } from './system.js';

const HISTORY = 180;

export interface Point {
  t: number;
  cpu: number | null;
  mem: number | null;
  gpu: number | null;
  vram: number | null;
  diskRead: number | null;
  diskWrite: number | null;
  readRate: number | null;
  writeRate: number | null;
  down: number | null;
  up: number | null;
}

export interface DetailPoint {
  t: number;
  cores: (number | null)[];
  /** Per adapter: [down, up] bytes per second. */
  nics: Record<string, [number, number]>;
  /** Per drive: [read, write] bytes per second and the share of time busy. */
  disks: Record<string, [number, number, number | null]>;
}

export interface AdapterDetail {
  name: string;
  down: number;
  up: number;
  received: number | null;
  sent: number | null;
  addresses: { address: string; family: string; netmask: string; internal: boolean }[];
  mac: string | null;
  speed: number | null;
}

export interface DiskDetail {
  name: string;
  read: number | null;
  write: number | null;
  active: number | null;
  readRate: number;
  writeRate: number;
  temperature: number | null;
  usedSpace: number | null;
  /** Remaining life (SSD), when the drive reports it. */
  life: number | null;
}

export interface Detail {
  snapshot: SystemSnapshot;
  cpu: { cores: (number | null)[]; speed: number | null; baseSpeed: number | null; power: number | null; temperatures: { name: string; value: number }[] };
  memory: { used: number; total: number; available: number; cached: number | null; buffers: number | null; swap: { used: number; total: number } | null; committed: { used: number; limit: number } | null; compressed: number | null; wired: number | null };
  gpu: { sensors: { name: string; type: string; value: number }[] } | null;
  adapters: AdapterDetail[];
  disks: DiskDetail[];
  sensors: { hardware: string; id: string; sensors: { name: string; type: string; value: number | null }[] }[];
  system: { os: string; release: string; version: string; arch: string; hostname: string; user: string; bootedAt: number; node: string; cpus: number };
  history: Point[];
  detailHistory: DetailPoint[];
}

interface Counters {
  at: number;
  cores: { idle: number; total: number }[];
  nics: Record<string, { rx: number; tx: number }>;
  disks: Record<string, { read: number; write: number; busy: number }>;
}

/** /proc/net/dev per interface: cumulative bytes received and sent. */
export function parseNetDevByInterface(text: string): Record<string, { rx: number; tx: number }> {
  const out: Record<string, { rx: number; tx: number }> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    if (f.length >= 9) out[m[1]!] = { rx: f[0]!, tx: f[8]! };
  }
  return out;
}

const PARTITION = /^(?:(?:sd|hd|vd|xvd)[a-z]+\d+|nvme\d+n\d+p\d+|mmcblk\d+p\d+)$/;
const VIRTUAL_DISK = /^(?:loop|ram|zram|dm-|sr|fd|md)\d*/;

/** /proc/diskstats per whole disk: bytes read and written and busy milliseconds. */
export function parseDiskstatsByDisk(text: string): Record<string, { read: number; write: number; busy: number }> {
  const out: Record<string, { read: number; write: number; busy: number }> = {};
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2]!;
    if (PARTITION.test(name) || VIRTUAL_DISK.test(name)) continue;
    out[name] = { read: Number(f[5]) * 512, write: Number(f[9]) * 512, busy: Number(f[12]) };
  }
  return out;
}

/** /proc/meminfo, every field in bytes. */
export function parseMeminfoFields(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s*kB)?$/gm)) out[m[1]!] = Number(m[2]) * 1024;
  return out;
}

const VIRTUAL_NIC = /^(lo|docker\d*|br-|veth|virbr|vnet|ifb|tun|tap|utun|awdl|llw|gif|stf|anpi|bridge|dummy|sit|ip6tnl)/;

export class PerformanceMonitor {
  private readonly history: Point[] = [];
  private readonly detailHistory: DetailPoint[] = [];
  private previous: Counters | undefined;
  private lastRecorded = 0;

  constructor(private readonly system: SystemMonitor) {}

  /** Adds a snapshot to the history (at most one point a second). */
  record(s: SystemSnapshot): void {
    if (s.at - this.lastRecorded < 900) return;
    this.lastRecorded = s.at;
    this.history.push({
      t: s.at,
      cpu: s.cpu.usage,
      mem: s.memory.total ? s.memory.used / s.memory.total : null,
      gpu: s.gpu?.usage ?? null,
      vram: s.gpu?.memory ? s.gpu.memory.used / s.gpu.memory.total : null,
      diskRead: s.disk?.read ?? null,
      diskWrite: s.disk?.write ?? null,
      readRate: s.disk?.readRate ?? null,
      writeRate: s.disk?.writeRate ?? null,
      down: s.network?.down ?? null,
      up: s.network?.up ?? null,
    });
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
  }

  private counters(): Counters {
    const src = this.system.systemSource;
    const cores = src.cpus().map((c) => ({ idle: c.times.idle, total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }));
    let nics: Counters['nics'] = {};
    let disks: Counters['disks'] = {};
    if (src.platform === 'linux') {
      nics = parseNetDevByInterface(src.readFile('/proc/net/dev') ?? '');
      disks = parseDiskstatsByDisk(src.readFile('/proc/diskstats') ?? '');
    }
    return { at: Date.now(), cores, nics, disks };
  }

  async detail(): Promise<Detail> {
    const snapshot = await this.system.read();
    this.record(snapshot);
    let before = this.previous;
    if (!before || Date.now() - before.at > 15_000) {
      before = this.counters();
      await new Promise((r) => setTimeout(r, 300));
    }
    const now = this.counters();
    this.previous = now;
    const seconds = Math.max(0.001, (now.at - before.at) / 1000);
    const cores = now.cores.map((c, i) => {
      const b = before!.cores[i];
      const total = b ? c.total - b.total : 0;
      return total > 0 ? Math.min(1, Math.max(0, 1 - (c.idle - b!.idle) / total)) : null;
    });
    const sensors = this.system.lastSensors();
    const src = this.system.systemSource;

    // CPU: clocks and power from the hardware sensors; the OS's speeds otherwise.
    const cpuSensors = sensors?.filter((s) => /^\/(intel|amd|generic)?cpu\//.test(s.hardwareId)) ?? [];
    const clocks = cpuSensors.filter((s) => s.type === 'Clock' && /^(Core|CPU Core|P-Core|E-Core) #?\d+$/.test(s.name) && s.value);
    const osSpeeds = src.cpus().map((c) => c.speed).filter((v) => v > 0);
    const speed = clocks.length ? clocks.reduce((a, s) => a + s.value!, 0) / clocks.length : osSpeeds.length ? osSpeeds.reduce((a, b) => a + b, 0) / osSpeeds.length : null;
    const power = cpuSensors.find((s) => s.type === 'Power' && /^(CPU )?Package$/.test(s.name))?.value ?? null;
    const temperatures = cpuSensors.filter((s) => s.type === 'Temperature' && s.value !== null).map((s) => ({ name: s.name, value: s.value! }));

    // Memory breakdown.
    const memory: Detail['memory'] = {
      used: snapshot.memory.used,
      total: snapshot.memory.total,
      available: Math.max(0, snapshot.memory.total - snapshot.memory.used),
      cached: null,
      buffers: null,
      swap: null,
      committed: null,
      compressed: null,
      wired: null,
    };
    if (src.platform === 'linux') {
      const f = parseMeminfoFields(src.readFile('/proc/meminfo') ?? '');
      if (f.MemAvailable !== undefined) memory.available = f.MemAvailable;
      if (f.Cached !== undefined) memory.cached = f.Cached + (f.SReclaimable ?? 0);
      if (f.Buffers !== undefined) memory.buffers = f.Buffers;
      if (f.SwapTotal) memory.swap = { used: f.SwapTotal - (f.SwapFree ?? 0), total: f.SwapTotal };
      if (f.Committed_AS !== undefined && f.CommitLimit) memory.committed = { used: f.Committed_AS, limit: f.CommitLimit };
    } else if (src.platform === 'darwin') {
      const [vm, swap] = await Promise.all([src.run('vm_stat', []), src.run('sysctl', ['-n', 'vm.swapusage'])]);
      const page = Number(/page size of (\d+)/.exec(vm ?? '')?.[1]) || 4096;
      const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(vm ?? '')?.[1] ?? NaN) * page;
      const wired = pages('Pages wired down');
      const compressed = pages('Pages occupied by compressor');
      const cached = pages('File-backed pages');
      if (Number.isFinite(wired)) memory.wired = wired;
      if (Number.isFinite(compressed)) memory.compressed = compressed;
      if (Number.isFinite(cached)) memory.cached = cached;
      const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(swap ?? '');
      if (m) memory.swap = { used: Number(m[2]) * 1024 ** 2, total: Number(m[1]) * 1024 ** 2 };
    }
    const vram = sensors?.filter((s) => s.hardwareId === '/vram') ?? [];
    const vUsed = vram.find((s) => s.name === 'Memory Used')?.value;
    const vAvail = vram.find((s) => s.name === 'Memory Available')?.value;
    if (!memory.committed && vUsed != null && vAvail != null) memory.committed = { used: vUsed, limit: vUsed + vAvail };

    // GPU sensors (the same GPU the snapshot shows).
    let gpu: Detail['gpu'] = null;
    if (sensors && snapshot.gpu) {
      const gpuSensors = sensors.filter((s) => /^\/gpu-/.test(s.hardwareId) && s.hardware === snapshot.gpu!.name && s.value !== null);
      gpu = { sensors: gpuSensors.map((s) => ({ name: s.name, type: s.type, value: s.value! })) };
    } else if (snapshot.gpu && src.platform !== 'darwin') {
      const out = await src.run('nvidia-smi', ['--query-gpu=power.draw,clocks.gr,clocks.mem,fan.speed,driver_version', '--format=csv,noheader,nounits']);
      const [pw, gr, mem, fan] = (out?.split('\n')[0] ?? '').split(',').map((x) => Number(x.trim()));
      const list: { name: string; type: string; value: number }[] = [];
      if (Number.isFinite(pw)) list.push({ name: 'GPU Power', type: 'Power', value: pw! });
      if (Number.isFinite(gr)) list.push({ name: 'GPU Core', type: 'Clock', value: gr! });
      if (Number.isFinite(mem)) list.push({ name: 'GPU Memory', type: 'Clock', value: mem! });
      if (Number.isFinite(fan)) list.push({ name: 'GPU Fan', type: 'Control', value: fan! });
      gpu = { sensors: list };
    }

    // Network adapters.
    const ifaces = os.networkInterfaces();
    const adapters: AdapterDetail[] = [];
    const lhmNics = sensors ? [...new Set(sensors.filter((s) => s.hardwareId.startsWith('/nic/')).map((s) => s.hardwareId))] : [];
    if (lhmNics.length) {
      for (const id of lhmNics) {
        const list = sensors!.filter((s) => s.hardwareId === id);
        const name = list[0]!.hardware;
        const v = (n: string) => list.find((s) => s.name === n)?.value ?? null;
        adapters.push({ ...this.addresses(name, ifaces), name, down: v('Download Speed') ?? 0, up: v('Upload Speed') ?? 0, received: v('Data Downloaded'), sent: v('Data Uploaded'), speed: null });
      }
    } else {
      for (const [name, c] of Object.entries(now.nics)) {
        if (VIRTUAL_NIC.test(name)) continue;
        const b = before.nics[name];
        const speedMbps = Number(src.readFile(`/sys/class/net/${name}/speed`));
        adapters.push({
          ...this.addresses(name, ifaces),
          name,
          down: b ? Math.max(0, (c.rx - b.rx) / seconds) : 0,
          up: b ? Math.max(0, (c.tx - b.tx) / seconds) : 0,
          received: c.rx,
          sent: c.tx,
          speed: speedMbps > 0 ? speedMbps * 1e6 : null,
        });
      }
    }

    // Drives.
    const disks: DiskDetail[] = [];
    const lhmDisks = sensors ? [...new Set(sensors.filter((s) => /^\/(hdd|ssd|nvme|storage|ata|scsi|usb)/.test(s.hardwareId)).map((s) => s.hardwareId))] : [];
    if (lhmDisks.length) {
      for (const id of lhmDisks) {
        const list = sensors!.filter((s) => s.hardwareId === id);
        const v = (n: string, type?: string) => list.find((s) => s.name === n && (!type || s.type === type))?.value ?? null;
        const pct = (x: number | null) => (x === null ? null : Math.max(0, Math.min(1, x / 100)));
        const temp = list.find((s) => s.type === 'Temperature' && s.value !== null)?.value ?? null;
        const life = v('Remaining Life') ?? (v('Percentage Used', 'Level') !== null ? 100 - v('Percentage Used', 'Level')! : null);
        disks.push({ name: list[0]!.hardware, read: pct(v('Read Activity')), write: pct(v('Write Activity')), active: pct(v('Total Activity')), readRate: v('Read Rate') ?? 0, writeRate: v('Write Rate') ?? 0, temperature: temp, usedSpace: pct(v('Used Space')), life: life === null ? null : pct(life) });
      }
    } else {
      for (const [name, c] of Object.entries(now.disks)) {
        const b = before.disks[name];
        disks.push({
          name,
          read: null,
          write: null,
          active: b ? Math.min(1, Math.max(0, (c.busy - b.busy) / (seconds * 1000))) : null,
          readRate: b ? Math.max(0, (c.read - b.read) / seconds) : 0,
          writeRate: b ? Math.max(0, (c.write - b.write) / seconds) : 0,
          temperature: null,
          usedSpace: null,
          life: null,
        });
      }
    }

    const point: DetailPoint = {
      t: now.at,
      cores,
      nics: Object.fromEntries(adapters.map((a) => [a.name, [a.down, a.up]])),
      disks: Object.fromEntries(disks.map((d) => [d.name, [d.readRate, d.writeRate, d.active]])),
    };
    const lastDetail = this.detailHistory[this.detailHistory.length - 1];
    if (!lastDetail || point.t - lastDetail.t >= 900) {
      this.detailHistory.push(point);
      if (this.detailHistory.length > HISTORY) this.detailHistory.splice(0, this.detailHistory.length - HISTORY);
    }

    // Every sensor, by hardware.
    const grouped: Detail['sensors'] = [];
    for (const s of sensors ?? []) {
      let g = grouped.find((x) => x.id === s.hardwareId);
      if (!g) grouped.push((g = { hardware: s.hardware, id: s.hardwareId, sensors: [] }));
      g.sensors.push({ name: s.name, type: s.type, value: s.value });
    }

    let user = '';
    try {
      user = os.userInfo().username;
    } catch {
      user = '';
    }
    return {
      snapshot,
      cpu: { cores, speed, baseSpeed: osSpeeds.length ? Math.max(...osSpeeds) : null, power, temperatures },
      memory,
      gpu,
      adapters,
      disks,
      sensors: grouped,
      system: {
        os: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[src.platform as string] ?? os.type(),
        release: os.release(),
        version: typeof os.version === 'function' ? os.version() : '',
        arch: os.arch(),
        hostname: snapshot.host,
        user,
        bootedAt: Date.now() - snapshot.uptime.system * 1000,
        node: process.version,
        cpus: src.cpus().length,
      },
      history: this.history,
      detailHistory: this.detailHistory,
    };
  }

  private addresses(name: string, ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): Pick<AdapterDetail, 'addresses' | 'mac'> {
    const list = ifaces[name] ?? [];
    const mac = list.find((a) => a.mac && a.mac !== '00:00:00:00:00:00')?.mac ?? null;
    return { addresses: list.map((a) => ({ address: a.address, family: String(a.family), netmask: a.netmask, internal: a.internal })), mac };
  }

}
