import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type os from 'node:os';
import {
  LhmClient,
  SystemMonitor,
  lhmReadings,
  parseCpuinfo,
  parseLhmTree,
  parseLhmValue,
  parseDiskstats,
  parseIoregDisk,
  parseIoregGpu,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseNetstatIb,
  parseNvidiaSmi,
  parseVmStat,
  type SystemSource,
} from '@sfagents/web';
import { REPO_ROOT } from './helpers.js';

const LHM_FIXTURE = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'lhm-data.json'), 'utf8');

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1024000 kB
MemAvailable:    8192000 kB
Buffers:          100000 kB
Cached:          4000000 kB
`;

const DISKSTATS = `   7       0 loop0 10 0 800 0 0 0 0 0 0 5 5 0 0 0 0
   8       0 sda 1000 0 20000 300 500 0 10000 200 0 400 500 0 0 0 0
   8       1 sda1 900 0 18000 280 480 0 9000 190 0 380 470 0 0 0 0
 259       0 nvme0n1 2000 0 40000 100 100 0 2000 50 0 1200 150 0 0 0 0
 259       1 nvme0n1p1 1900 0 39000 90 90 0 1900 40 0 1100 130 0 0 0 0
 253       0 dm-0 5 0 40 0 0 0 0 0 0 1 1 0 0 0 0
`;

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  999999      13    0    0    0     0          0         0   999999      13    0    0    0     0       0          0
  eth0: 1000000    1000    0    0    0     0          0         0   250000     800    0    0    0     0       0          0
 wlan0:  500000     500    0    0    0     0          0         0   100000     400    0    0    0     0       0          0
docker0:  77777      10    0    0    0     0          0         0    77777      10    0    0    0     0       0          0
`;

const NETSTAT_IB = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                         12345     0    9999999    12345     0    9999999     0
lo0        16384 127           127.0.0.1          12345     -    9999999    12345     -    9999999     -
en0        1500  <Link#6>    a4:83:e7:00:00:01   400000     0  500000000   300000     0   40000000     0
en0        1500  192.168.1     192.168.1.20       400000     -  500000000   300000     -   40000000     -
utun0      1380  <Link#14>                          100     0      20000      100     0      20000     0
en1        1500  <Link#7>    a4:83:e7:00:00:02       10     0       1000       10     0       2000     0
`;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12000.
Pages active:                            300000.
Pages inactive:                          290000.
Pages speculative:                         5000.
Pages wired down:                        100000.
Pages purgeable:                          10000.
Anonymous pages:                         250000.
Pages occupied by compressor:             50000.
`;

const MOUNTS = `/dev/nvme0n1p2 / ext4 rw,relatime 0 0
proc /proc proc rw 0 0
/dev/nvme0n1p1 /boot/efi vfat rw 0 0
/dev/sdb1 /media/me/My\\040Passport exfat rw 0 0
/dev/nvme0n1p2 /var/lib/docker ext4 rw 0 0
/dev/loop3 /snap/core/1 squashfs ro 0 0
tmpfs /run tmpfs rw 0 0
/dev/sdc1 /data xfs rw 0 0
`;

describe('system: parsers', () => {
  test('meminfo: used is total minus available', () => {
    assert.deepEqual(parseMeminfo(MEMINFO), { total: 16384000 * 1024, available: 8192000 * 1024 });
    assert.equal(parseMeminfo('nothing'), null);
  });

  test('diskstats: whole disks only, bytes from sectors, reading and writing ms per disk', () => {
    const d = parseDiskstats(DISKSTATS);
    assert.equal(d.read, (20000 + 40000) * 512);
    assert.equal(d.write, (10000 + 2000) * 512);
    assert.deepEqual(d.readMs, { sda: 300, nvme0n1: 100 });
    assert.deepEqual(d.writeMs, { sda: 200, nvme0n1: 50 });
  });

  test('cpuinfo: physical cores across packages', () => {
    const block = (pkg: number, core: number) => `processor\t: x\nphysical id\t: ${pkg}\ncore id\t\t: ${core}\n`;
    assert.equal(parseCpuinfo([block(0, 0), block(0, 0), block(0, 1), block(0, 1), block(1, 0)].join('\n')), 3);
    assert.equal(parseCpuinfo('processor : 0\n'), null);
  });

  test('net/dev: physical interfaces only', () => {
    assert.deepEqual(parseNetDev(NET_DEV), { rx: 1500000, tx: 350000 });
  });

  test('netstat -ib (macOS): link rows of physical interfaces, rows without an address too', () => {
    assert.deepEqual(parseNetstatIb(NETSTAT_IB), { rx: 500001000, tx: 40002000 });
  });

  test('vm_stat (macOS): app memory, wired and compressed', () => {
    assert.equal(parseVmStat(VM_STAT), (250000 - 10000 + 100000 + 50000) * 16384);
  });

  test('nvidia-smi: the busiest GPU, usage as a fraction, VRAM in bytes', () => {
    assert.deepEqual(parseNvidiaSmi('12, 45, 1024, 10240, NVIDIA GeForce RTX 3080\n87, 71, 2048, 49152, NVIDIA RTX A6000\n'), {
      usage: 0.87,
      temperature: 71,
      name: 'NVIDIA RTX A6000',
      memory: { used: 2048 * 1024 ** 2, total: 49152 * 1024 ** 2 },
    });
    assert.deepEqual(parseNvidiaSmi('[N/A], 40, [N/A], [N/A], Tesla T4\n'), { usage: null, temperature: 40, name: 'Tesla T4', memory: null });
  });

  test('ioreg (macOS): GPU utilization and disk byte counters', () => {
    const gpu = parseIoregGpu('+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X>\n    "model" = "Apple M2"\n    "PerformanceStatistics" = {"Device Utilization %"=37,"Renderer Utilization %"=30}\n');
    assert.deepEqual(gpu, { usage: 0.37, temperature: null, name: 'Apple M2', memory: null });
    const disk = parseIoregDisk('"Statistics" = {"Operations (Write)"=1,"Bytes (Read)"=1000,"Bytes (Write)"=200}\n"Statistics" = {"Bytes (Read)"=50,"Bytes (Write)"=5}');
    assert.deepEqual(disk, { read: 1050, write: 205 });
  });

  test('mounts: one entry per real drive, shortest mount, escapes decoded, /boot and snaps skipped', () => {
    assert.deepEqual(parseMounts(MOUNTS), [
      { device: '/dev/nvme0n1p2', mount: '/' },
      { device: '/dev/sdc1', mount: '/data' },
      { device: '/dev/sdb1', mount: '/media/me/My Passport' },
    ]);
  });
});

function cpu(idle: number, busy: number): os.CpuInfo {
  return { model: ' Test CPU ', speed: 3000, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

function fakeLinux() {
  const state = { idle: 1000, busy: 1000, rx: 1000000, tx: 0, sectors: 0, readMs: 0, writeMs: 0 };
  const files: Record<string, () => string> = {
    '/proc/meminfo': () => MEMINFO,
    '/proc/diskstats': () => `   8       0 sda 1 0 ${state.sectors} ${state.readMs} 1 0 0 ${state.writeMs} 0 0 0 0 0 0 0\n`,
    '/proc/cpuinfo': () => 'processor : 0\nphysical id : 0\ncore id : 0\n\nprocessor : 1\nphysical id : 0\ncore id : 0\n',
    '/proc/net/dev': () => `h\nh\n  eth0: ${state.rx} 0 0 0 0 0 0 0 ${state.tx} 0 0 0 0 0 0 0\n`,
    '/proc/mounts': () => MOUNTS,
    '/sys/class/hwmon/hwmon0/name': () => 'coretemp\n',
    '/sys/class/hwmon/hwmon0/temp1_input': () => '52000\n',
    '/sys/class/hwmon/hwmon0/temp2_input': () => '61000\n',
  };
  const dirs: Record<string, string[]> = {
    '/sys/class/hwmon': ['hwmon0'],
    '/sys/class/hwmon/hwmon0': ['name', 'temp1_input', 'temp2_input'],
  };
  const sizes: Record<string, { blocks: number; bfree: number; bavail: number; bsize: number }> = {
    '/': { blocks: 1000, bfree: 400, bavail: 350, bsize: 1_000_000 },
    '/data': { blocks: 2000, bfree: 100, bavail: 100, bsize: 1_000_000 },
    '/media/me/My Passport': { blocks: 500, bfree: 250, bavail: 250, bsize: 1_000_000 },
  };
  const commands: string[] = [];
  const source: SystemSource = {
    platform: 'linux',
    readFile: (f) => files[f]?.() ?? null,
    listDir: (d) => dirs[d] ?? [],
    readLink: () => null,
    run: async (command) => {
      commands.push(command);
      return null;
    },
    statfs: (m) => sizes[m] ?? null,
    cpus: () => [cpu(state.idle, state.busy), cpu(state.idle, state.busy)],
    totalmem: () => 1,
    freemem: () => 0,
    uptime: () => 93784,
    hostname: () => 'workstation',
  };
  return { source, state, commands };
}

describe('system: monitor', () => {
  test('the first reading takes two samples; rates, temperatures, memory and drives come out right', async () => {
    const { source, state, commands } = fakeLinux();
    let calls = 0;
    const realCpus = source.cpus;
    source.cpus = () => {
      // The second sample (after the short gap) sees more busy and idle time.
      calls++;
      if (calls > 1) {
        state.idle = 1300;
        state.busy = 1100;
        state.rx = 1000000 + 400000;
        state.tx = 40000;
        state.sectors = 1000;
        state.readMs = 200;
        state.writeMs = 40;
      }
      return realCpus();
    };
    const monitor = new SystemMonitor(source, { lhm: null });
    const s = await monitor.read();
    assert.equal(s.host, 'workstation');
    assert.equal(s.source, 'os');
    assert.equal(s.hint, null);
    assert.equal(s.cpu.threads, 2);
    assert.equal(s.cpu.cores, 1);
    assert.equal(s.cpu.model, 'Test CPU');
    // 2 cores × (300 idle + 100 busy): a quarter busy.
    assert.ok(Math.abs((s.cpu.usage ?? 0) - 0.25) < 1e-9, String(s.cpu.usage));
    assert.equal(s.cpu.temperature, 61);
    assert.equal(s.gpu, null);
    assert.ok(commands.includes('nvidia-smi'));
    assert.deepEqual(s.memory, { used: (16384000 - 8192000) * 1024, total: 16384000 * 1024 });
    assert.ok(s.network && s.network.down > 0 && s.network.up > 0);
    assert.ok(s.disk && s.disk.readRate > 0 && s.disk.read !== null && s.disk.write !== null);
    // 200 ms reading and 40 ms writing over the short gap between the two samples.
    assert.ok(s.disk.read > s.disk.write! && s.disk.read <= 1, JSON.stringify(s.disk));
    assert.equal(s.uptime.system, 93784);
    assert.deepEqual(
      s.drives.map((d) => [d.name, d.mount, d.used, d.total]),
      [
        ['System', '/', 600_000_000, 950_000_000],
        ['data', '/data', 1_900_000_000, 2_000_000_000],
        ['My Passport', '/media/me/My Passport', 250_000_000, 500_000_000],
      ],
    );
  });

  test('readings within a second are shared; concurrent callers get one sample', async () => {
    const { source } = fakeLinux();
    let samples = 0;
    const cpus = source.cpus;
    source.cpus = () => {
      samples++;
      return cpus();
    };
    const monitor = new SystemMonitor(source, { lhm: null });
    const [a, b] = await Promise.all([monitor.read(), monitor.read()]);
    assert.equal(a, b);
    const c = await monitor.read();
    assert.equal(c, a);
    // Two samples plus the snapshot's thread count.
    assert.equal(samples, 3);
  });

  test('platforms without counters report nulls, not errors', async () => {
    const source: SystemSource = {
      platform: 'win32',
      readFile: () => null,
      listDir: () => [],
      readLink: () => null,
      run: async () => null,
      statfs: (m) => (m === 'C:\\' ? { blocks: 100, bfree: 25, bavail: 25, bsize: 4096 } : null),
      cpus: () => [cpu(10, 10)],
      totalmem: () => 8e9,
      freemem: () => 2e9,
      uptime: () => 60,
      hostname: () => 'pc',
    };
    const s = await new SystemMonitor(source, { lhm: null }).read();
    assert.equal(s.source, 'os');
    assert.match(s.hint ?? '', /Libre Hardware Monitor/);
    assert.equal(s.cpu.cores, null);
    assert.equal(s.disk, null);
    assert.equal(s.network, null);
    assert.equal(s.gpu, null);
    assert.equal(s.cpu.temperature, null);
    assert.deepEqual(s.memory, { used: 6e9, total: 8e9 });
    assert.deepEqual(s.drives, [{ name: 'C:', mount: 'C:\\', used: 75 * 4096, total: 100 * 4096 }]);
  });
});

describe('system: Libre Hardware Monitor', () => {
  test('the sensor tree: hardware ids, raw values in base units, NaN as no reading', () => {
    const sensors = parseLhmTree(JSON.parse(LHM_FIXTURE.replace(/:\s*NaN\b/g, ':null')))!;
    assert.ok(sensors.length > 40);
    const pkg = sensors.find((x) => x.id === '/intelcpu/0/temperature/8')!;
    assert.deepEqual(pkg, { hardwareId: '/intelcpu/0', hardware: 'Intel Core i7-11700K', id: '/intelcpu/0/temperature/8', name: 'CPU Package', type: 'Temperature', value: 61.25 });
    assert.equal(sensors.find((x) => x.hardware === 'Wi-Fi' && x.name === 'Upload Speed')!.value, null);
    assert.equal(parseLhmTree({ hello: 'world' }), null);
  });

  test('readings: CPU package temperature and cores, the separate GPU with VRAM, physical memory, busiest drive, physical adapters', () => {
    const r = lhmReadings(parseLhmTree(JSON.parse(LHM_FIXTURE.replace(/:\s*NaN\b/g, ':null')))!);
    assert.deepEqual(r.cpu, { usage: 0.235, temperature: 61.25, cores: 8, name: 'Intel Core i7-11700K' });
    // The integrated GPU is busier, but the card is the one people mean.
    assert.deepEqual(r.gpu, { usage: 0.37, temperature: 48, name: 'NVIDIA GeForce RTX 3070', memory: { used: 3758096384, total: 8589934592 } });
    // "/ram", not virtual memory ("/vram").
    assert.deepEqual(r.memory, { used: 15032385536, total: 15032385536 + 19327352832 });
    assert.deepEqual(r.disk, { read: 0.12, write: 0.27, readRate: 52428800, writeRate: 1048576 + 2097152 });
    // Ethernet and Wi-Fi; the Hyper-V switch carries the same traffic again.
    assert.deepEqual(r.network, { down: 2411724.8 + 1024, up: 184320 });
  });

  test('older servers: formatted values only, comma decimals, °F, Data in GB and SmallData in MB', () => {
    assert.equal(parseLhmValue('45,5 °C', 'Temperature'), 45.5);
    assert.ok(Math.abs(parseLhmValue('122.0 °F', 'Temperature')! - 50) < 1e-9);
    assert.equal(parseLhmValue('2,0 MB/s', 'Throughput'), 2 * 1024 ** 2);
    assert.equal(parseLhmValue('16.0 GB', 'Data'), 16 * 1024 ** 3);
    assert.equal(parseLhmValue('512 MB', 'SmallData'), 512 * 1024 ** 2);
    const s = (hw: string, type: string, i: number, name: string, value: string, raw?: number) => ({
      Text: name, Value: value, SensorId: `${hw}/${type.toLowerCase()}/${i}`, Type: type, ...(raw === undefined ? {} : { RawValue: raw }), Children: [],
    });
    const tree = {
      Text: 'Sensor',
      Children: [{ Text: 'PC', Children: [
        { Text: 'AMD Ryzen 7 5800X', Children: [{ Text: 'Load', Children: [s('/amdcpu/0', 'Load', 0, 'CPU Total', '12,5 %'), s('/amdcpu/0', 'Load', 1, 'CPU Core #1', '1 %'), s('/amdcpu/0', 'Load', 2, 'CPU Core #2', '1 %')] },
          { Text: 'Temperatures', Children: [s('/amdcpu/0', 'Temperature', 0, 'Core (Tctl/Tdie)', '149,0 °F')] }] },
        { Text: 'Radeon RX 6800', Children: [{ Text: 'Data', Children: [s('/gpu-amd/0', 'SmallData', 0, 'GPU Memory Used', '2048,0 MB', 2048), s('/gpu-amd/0', 'SmallData', 2, 'GPU Memory Total', '16384,0 MB', 16384), s('/gpu-amd/0', 'Load', 0, 'GPU Core', '5,0 %')] }] },
        { Text: 'Generic Memory', Children: [s('/ram', 'Data', 0, 'Memory Used', '8,0 GB', 8), s('/ram', 'Data', 1, 'Memory Available', '24,0 GB', 24)] },
      ] }],
    };
    const r = lhmReadings(parseLhmTree(tree)!);
    assert.equal(r.cpu?.usage, 0.125);
    assert.ok(Math.abs(r.cpu!.temperature! - 65) < 1e-9);
    assert.equal(r.cpu?.cores, 2);
    assert.deepEqual(r.gpu?.memory, { used: 2048 * 1024 ** 2, total: 16384 * 1024 ** 2 });
    assert.equal(r.gpu?.usage, 0.05);
    assert.deepEqual(r.memory, { used: 8 * 1024 ** 3, total: 32 * 1024 ** 3 });
    assert.equal(r.disk, null);
    assert.equal(r.network, null);
  });

  test('the monitor prefers a running server (with its sign-in), and falls back to the OS when it stops', async () => {
    let auth: string | undefined;
    let up = true;
    const server = http.createServer((req, res) => {
      auth = req.headers.authorization;
      if (!up || req.url !== '/data.json') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(LHM_FIXTURE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const source: SystemSource = {
        platform: 'win32', readFile: () => null, listDir: () => [], readLink: () => null, run: async () => null,
        statfs: (m) => (m === 'C:\\' ? { blocks: 100, bfree: 25, bavail: 25, bsize: 4096 } : null),
        cpus: () => Array.from({ length: 16 }, () => cpu(10, 10)), totalmem: () => 8e9, freemem: () => 2e9, uptime: () => 60, hostname: () => 'NEWPC',
      };
      const monitor = new SystemMonitor(source, { lhm: new LhmClient(`http://me:s%40cret@127.0.0.1:${port}`, 0) });
      const s = await monitor.read();
      assert.equal(auth, 'Basic ' + Buffer.from('me:s@cret').toString('base64'));
      assert.equal(s.source, 'lhm');
      assert.equal(s.hint, null);
      assert.deepEqual(s.cpu, { usage: 0.235, temperature: 61.25, cores: 8, threads: 16, model: 'Intel Core i7-11700K' });
      assert.equal(s.gpu?.name, 'NVIDIA GeForce RTX 3070');
      assert.equal(s.drives[0]?.name, 'C:');
      up = false;
      await new Promise((r) => setTimeout(r, 1050));
      const t = await monitor.read();
      assert.equal(t.source, 'os');
      assert.match(t.hint ?? '', /Remote Web Server/);
    } finally {
      server.close();
    }
  });
});
