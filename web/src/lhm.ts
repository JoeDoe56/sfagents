/**
 * Hardware sensor readings in Libre Hardware Monitor's terms
 * (https://github.com/LibreHardwareMonitor/LibreHardwareMonitor, MPL-2.0).
 *
 * SF Agents' own sensor programs report them: on Windows the bundled
 * LibreHardwareMonitorLib adapter (web/native/windows), on Linux the bundled
 * LibreHardwareMonitor-Linux collectors (web/native/linux). Both answer over
 * stdin/stdout (sensor-process.ts) with a flat list of sensors: the hardware
 * they belong to (HardwareId, e.g. "/intelcpu/0", "/gpu-nvidia/0", "/ram",
 * "/nvme/0", "/nic/{guid}"), the sensor's id ("/intelcpu/0/load/0"), its
 * type ("Load", "Temperature", ...) and its value in base units. This module
 * picks out what the resource monitor shows.
 */

export interface LhmSensor {
  hardwareId: string;
  hardware: string;
  id: string;
  name: string;
  type: string;
  /** In base units: °C, %, bytes, bytes per second, W, MHz, RPM. */
  value: number | null;
}

export interface LhmReader {
  read(): Promise<LhmSensor[] | null>;
  readonly hint?: string | null;
  readonly processes?: number | null;
  close?(): Promise<void>;
}

export interface LhmReadings {
  /** PSU/BMC-reported system power only; CPU/GPU power is not a system total. */
  power: { watts: number; kind: 'input' | 'output' | 'total' } | null;
  cpu: { usage: number | null; temperature: number | null; cores: number | null; name: string } | null;
  gpu: { usage: number | null; temperature: number | null; name: string; memory: { used: number; total: number } | null } | null;
  memory: { used: number; total: number } | null;
  /** read and write: fractions of time the busiest drive spent reading or writing; rates in bytes per second. */
  disk: { read: number | null; write: number | null; readRate: number; writeRate: number } | null;
  network: { down: number; up: number } | null;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.max(0, Math.min(1, v / 100)));

function find(sensors: LhmSensor[], type: string, names: (string | RegExp)[]): LhmSensor | undefined {
  for (const name of names) {
    const hit = sensors.find((s) => s.type === type && s.value !== null && (typeof name === 'string' ? s.name === name : name.test(s.name)));
    if (hit) return hit;
  }
  return undefined;
}

function byHardware(sensors: LhmSensor[]): Map<string, LhmSensor[]> {
  const map = new Map<string, LhmSensor[]>();
  for (const s of sensors) {
    const list = map.get(s.hardwareId) ?? [];
    list.push(s);
    map.set(s.hardwareId, list);
  }
  return map;
}

const VIRTUAL_NIC = /^(vEthernet|Loopback|Bluetooth|isatap|Teredo|WAN Miniport)|Virtual|VMware|VirtualBox|Hyper-V|TAP-|Npcap|WireGuard|Tailscale|ZeroTier/i;

/** What the monitor shows, picked out of the sensor list. */
export function lhmReadings(sensors: LhmSensor[]): LhmReadings {
  const groups = byHardware(sensors);
  const hardwareOf = (re: RegExp) => [...groups].filter(([id]) => re.test(id)).map(([id, list]) => ({ id, list }));

  // CPU: total load; the package (Intel) or Tctl/Tdie (AMD) temperature, else the hottest; physical cores from the per-core loads.
  let cpu: LhmReadings['cpu'] = null;
  const cpus = hardwareOf(/^\/(intel|amd|generic)?cpu\//);
  if (cpus.length) {
    let usage: number | null = null;
    let temperature: number | null = null;
    let cores = 0;
    const name = cpus[0]!.list[0]?.hardware ?? '';
    for (const { list } of cpus) {
      const load = find(list, 'Load', ['CPU Total']);
      if (load) usage = Math.max(usage ?? 0, load.value!);
      const temp = find(list, 'Temperature', ['CPU Package', 'Core (Tctl/Tdie)', 'Core (Tdie)', 'Core (Tctl)', 'Package', 'Core Max', 'CCDs Max (Tdie)']);
      const hottest = temp?.value ?? Math.max(...list.filter((s) => s.type === 'Temperature' && s.value !== null).map((s) => s.value!), -Infinity);
      if (Number.isFinite(hottest)) temperature = Math.max(temperature ?? -Infinity, hottest);
      const coreIds = new Set(list.filter((s) => s.type === 'Load').map((s) => /^CPU Core #(\d+)/.exec(s.name)?.[1]).filter(Boolean));
      cores += coreIds.size;
    }
    cpu = { usage: pct(usage), temperature, cores: cores || null, name };
  }

  // GPU: a separate card before integrated graphics; the busiest if there are several.
  let gpu: LhmReadings['gpu'] = null;
  const gpus = hardwareOf(/^\/gpu-/).map(({ id, list }) => {
    const load = find(list, 'Load', ['GPU Core', 'D3D 3D', /^GPU/, /3D/]);
    const temp = find(list, 'Temperature', ['GPU Core', 'GPU Hot Spot', /GPU/]);
    const used = find(list, 'Data', ['GPU Memory Used', 'D3D Dedicated Memory Used']) ?? find(list, 'SmallData', ['GPU Memory Used', 'D3D Dedicated Memory Used']);
    const totalSensor = find(list, 'Data', ['GPU Memory Total', 'D3D Dedicated Memory Total']) ?? find(list, 'SmallData', ['GPU Memory Total', 'D3D Dedicated Memory Total']);
    let memory = used && totalSensor && totalSensor.value! > 0 ? { used: used.value!, total: totalSensor.value! } : null;
    if (!memory) {
      const shared = find(list, 'Data', ['D3D Shared Memory Used']);
      const sharedTotal = find(list, 'Data', ['D3D Shared Memory Total']);
      if (shared && sharedTotal && sharedTotal.value! > 0) memory = { used: shared.value!, total: sharedTotal.value! };
    }
    return {
      integrated: /integrated/.test(id),
      reading: { usage: pct(load?.value), temperature: temp?.value ?? null, name: list[0]?.hardware || 'GPU', memory },
    };
  });
  if (gpus.length) {
    const pool = gpus.some((g) => !g.integrated) ? gpus.filter((g) => !g.integrated) : gpus;
    gpu = pool.reduce((a, b) => ((b.reading.usage ?? 0) > (a.reading.usage ?? 0) ? b : a)).reading;
  }

  // Memory: the physical memory ("/ram"), not virtual memory ("/vram").
  let memory: LhmReadings['memory'] = null;
  const ram = groups.get('/ram');
  if (ram) {
    const used = find(ram, 'Data', ['Memory Used']) ?? find(ram, 'SmallData', ['Memory Used']);
    const available = find(ram, 'Data', ['Memory Available']) ?? find(ram, 'SmallData', ['Memory Available']);
    if (used && available) memory = { used: used.value!, total: used.value! + available.value! };
  }

  // Drives: the busiest drive's read and write activity; rates summed.
  let disk: LhmReadings['disk'] = null;
  for (const { list } of hardwareOf(/^\/(hdd|ssd|nvme|storage|ata|scsi|usb)/)) {
    const read = find(list, 'Load', ['Read Activity']);
    const write = find(list, 'Load', ['Write Activity']);
    const readRate = find(list, 'Throughput', ['Read Rate']);
    const writeRate = find(list, 'Throughput', ['Write Rate']);
    if (!read && !write && !readRate && !writeRate) continue;
    disk ??= { read: null, write: null, readRate: 0, writeRate: 0 };
    if (read) disk.read = Math.max(disk.read ?? 0, pct(read.value)!);
    if (write) disk.write = Math.max(disk.write ?? 0, pct(write.value)!);
    disk.readRate += readRate?.value ?? 0;
    disk.writeRate += writeRate?.value ?? 0;
  }

  // Network: physical adapters only (virtual switches would count the same traffic twice).
  let network: LhmReadings['network'] = null;
  for (const { list } of hardwareOf(/^\/nic\//)) {
    if (VIRTUAL_NIC.test(list[0]?.hardware ?? '')) continue;
    const down = find(list, 'Throughput', ['Download Speed']);
    const up = find(list, 'Throughput', ['Upload Speed']);
    if (!down && !up) continue;
    network ??= { down: 0, up: 0 };
    network.down += down?.value ?? 0;
    network.up += up?.value ?? 0;
  }

  let powerWatts = 0;
  const powerKinds = new Set<'input' | 'output' | 'total'>();
  for (const { list } of hardwareOf(/^\/psu\//)) {
    const input = find(list, 'Power', ['Input Power', 'Total Input', 'Total Input Power', 'PSU In']);
    const total = find(list, 'Power', ['Total watts', 'Total Power', 'Total']);
    const output = find(list, 'Power', ['Total Output', 'PSU Out']);
    const reading = input ?? total ?? output;
    if (!reading || reading.value === null || reading.value < 0) continue;
    const kind = input ? 'input' : total ? 'total' : 'output';
    powerWatts += reading.value;
    powerKinds.add(kind);
  }
  // LibreHardwareMonitor-Linux exposes a whole-machine DCMI reading under
  // the BMC. Do not add it to PSU totals or its rolling System Average.
  if (!powerKinds.size) {
    const system = find(groups.get('/lpc/bmc') ?? [], 'Power', ['System Total']);
    if (system?.value !== null && system?.value !== undefined && system.value >= 0) {
      powerWatts = system.value;
      powerKinds.add('total');
    }
  }

  const power: LhmReadings['power'] = powerKinds.size
    ? { watts: powerWatts, kind: powerKinds.size === 1 ? [...powerKinds][0]! : 'total' }
    : null;
  return { cpu, gpu, memory, disk, network, power };
}

