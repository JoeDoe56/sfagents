/**
 * The monitor's windows (Task Manager's Performance and Processes tabs, in
 * Apple's style). Each stat in the monitor opens one: CPU, GPU, memory,
 * disk, network, processes (with users, services and startup apps), the
 * system, and SF Agents itself. They poll while open and stop when closed.
 */

import { getJson, postJson } from './api.js';
import { createChart, COLORS } from './charts.js';
import { openPeek, group, row, figures, segmented, button, el, symbol } from './peek.js';
import { createButton, createField } from './vendor/sfgl/src/ui/index.js';
import { showMenu } from './menu.js';
import { confirmDialog, showError } from './dialogs.js';
import {
  DASH,
  bytesText,
  rateText,
  bitsText,
  clockDuration,
  formatDuration,
  formatUsedTotal,
  percentText,
  temperature,
  mhzText,
  dateText,
  fullDate,
  plural,
} from './format.js';

const SECONDS = 60;

const WINDOWS = {
  cpu: { title: 'CPU', symbol: 'speedometer', build: cpuWindow },
  gpu: { title: 'GPU', symbol: 'cube', build: gpuWindow },
  memory: { title: 'Memory', symbol: 'rectangle.stack', build: memoryWindow },
  disk: { title: 'Disk', symbol: 'tray.2.fill', build: diskWindow },
  network: { title: 'Network', symbol: 'wifi', build: networkWindow },
  processes: { title: 'Processes', symbol: 'list.bullet', build: processesWindow },
  uptime: { title: 'System', symbol: 'desktopcomputer', build: systemWindow },
  sfagents: { title: 'SF Agents', symbol: 'sparkles', build: sfagentsWindow },
};

export const WINDOW_KEYS = Object.keys(WINDOWS);

let env = { openInFiles: null };

/** Opens the window for a monitor stat, growing out of `from`. */
export function openMonitorWindow(key, { from, openInFiles } = {}) {
  const w = WINDOWS[key];
  if (!w) return null;
  env = { openInFiles: openInFiles ?? null };
  return openPeek({ from, title: w.title, symbol: w.symbol, build: w.build });
}

// ------------------------------------------------------------------ helpers

/** Readings on a one-second grid for the last minute (gaps where nothing was read). */
function lastMinute(points, pick, now = Date.now()) {
  const out = new Array(SECONDS).fill(null);
  let j = points.length - 1;
  for (let i = SECONDS - 1; i >= 0; i--) {
    const t = now - (SECONDS - 1 - i) * 1000;
    while (j >= 0 && points[j].t > t + 500) j--;
    if (j >= 0 && t - points[j].t < 2600) {
      const v = pick(points[j]);
      out[i] = Number.isFinite(v) ? v : null;
    }
  }
  return out;
}

function chartBox(className = 'ui-chart') {
  const box = el('div', className);
  return box;
}

function detailFeed(ctx, onDetail, ms = 1000) {
  ctx.every(ms, async () => onDetail(await getJson('/api/system/detail')));
}

function setRows(container, rows) {
  container.replaceChildren(...rows.filter(Boolean));
}

/** A grouped list whose rows are replaced on each update without rebuilding its section. */
function liveGroup(title) {
  const section = group([], title);
  const list = section.querySelector('.sf-group');
  return { element: section, set: (rows) => setRows(list, rows) };
}

const pctMax = (v) => `${Math.round(v * 100)}%`;

// ------------------------------------------------------------------ CPU

function cpuWindow(ctx) {
  const figs = figures([{ label: 'Utilization' }, { label: 'Speed' }, { label: 'Temperature' }]);
  const box = chartBox();
  const chart = createChart(box, { series: [{ color: COLORS.blue }], max: 1, format: pctMax });
  const coresTitle = el('h3', 'sf-section-title', 'Logical processors');
  const coresGrid = el('div', 'ui-cores');
  const facts = liveGroup();
  const temps = liveGroup('Temperatures');
  ctx.body.append(figs.element, box, coresTitle, coresGrid, facts.element, temps.element);
  const mini = [];
  detailFeed(ctx, (d) => {
    const s = d.snapshot;
    figs.set(0, percentText(s.cpu.usage));
    figs.set(1, mhzText(d.cpu.speed));
    figs.set(2, temperature(s.cpu.temperature) ?? DASH);
    chart.update([lastMinute(d.history, (p) => p.cpu)]);
    // One small graph per logical processor.
    const n = d.cpu.cores.length;
    while (mini.length < n) {
      const cell = el('div', 'ui-core');
      const label = el('span', 'ui-core-label');
      const graph = el('div', 'ui-core-graph');
      cell.append(graph, label);
      coresGrid.append(cell);
      mini.push({ label, chart: createChart(graph, { series: [{ color: COLORS.blue }], max: 1, compact: true }) });
    }
    mini.forEach((m, i) => {
      m.label.textContent = `${i + 1}  ${percentText(d.cpu.cores[i])}`;
      m.chart.update([lastMinute(d.detailHistory, (p) => p.cores[i])]);
    });
    facts.set([
      row('Model', s.cpu.model || DASH),
      row('Cores', s.cpu.cores ? String(s.cpu.cores) : DASH),
      row('Logical processors', String(s.cpu.threads)),
      row('Base speed', mhzText(d.cpu.baseSpeed)),
      row('Package power', Number.isFinite(d.cpu.power) ? `${d.cpu.power.toFixed(1)} W` : DASH),
      row('Processes', Number.isFinite(s.processes) ? s.processes.toLocaleString() : DASH),
      row('Up time', clockDuration(s.uptime.system)),
    ]);
    temps.element.hidden = !d.cpu.temperatures.length;
    temps.set(d.cpu.temperatures.map((t) => row(t.name, temperature(t.value))));
  });
  ctx.onLeave(() => {
    chart.destroy();
    mini.forEach((m) => m.chart.destroy());
  });
}

// ------------------------------------------------------------------ GPU

const UNIT = { Temperature: (v) => temperature(v), Load: (v) => `${v.toFixed(0)}%`, Clock: (v) => mhzText(v), Power: (v) => `${v.toFixed(1)} W`, Fan: (v) => `${Math.round(v)} RPM`, Control: (v) => `${Math.round(v)}%`, Voltage: (v) => `${v.toFixed(3)} V`, Current: (v) => `${v.toFixed(2)} A`, Data: (v) => bytesText(v), SmallData: (v) => bytesText(v), Throughput: (v) => rateText(v), Level: (v) => `${v.toFixed(0)}%`, Factor: (v) => v.toFixed(2), Frequency: (v) => `${v.toFixed(0)} Hz`, Energy: (v) => `${v.toFixed(0)} mWh`, TimeSpan: (v) => formatDuration(v), Flow: (v) => `${v.toFixed(1)} L/h`, Noise: (v) => `${v.toFixed(0)} dBA`, Humidity: (v) => `${v.toFixed(0)}%` };
const sensorText = (type, v) => (v === null || v === undefined ? DASH : (UNIT[type] ?? ((x) => x.toFixed(1)))(v));
const TYPE_ORDER = ['Load', 'Temperature', 'Clock', 'Power', 'Fan', 'Control', 'Data', 'SmallData', 'Throughput', 'Voltage', 'Current', 'Level', 'Factor'];
const TYPE_TITLE = { Load: 'Load', Temperature: 'Temperatures', Clock: 'Clocks', Power: 'Power', Fan: 'Fans', Control: 'Fan control', Data: 'Memory', SmallData: 'Memory', Throughput: 'Throughput', Voltage: 'Voltages', Current: 'Currents', Level: 'Levels', Factor: 'Factors' };

function sensorGroups(sensors) {
  const byType = new Map();
  for (const s of sensors) {
    if (!byType.has(s.type)) byType.set(s.type, []);
    byType.get(s.type).push(s);
  }
  return [...byType].sort((a, b) => (TYPE_ORDER.indexOf(a[0]) + 99) % 99 - (TYPE_ORDER.indexOf(b[0]) + 99) % 99).map(([type, list]) => group(list.map((s) => row(s.name, sensorText(type, s.value))), TYPE_TITLE[type] ?? type));
}

function gpuWindow(ctx) {
  const figs = figures([{ label: 'Utilization', color: COLORS.green }, { label: 'Temperature' }, { label: 'VRAM', color: COLORS.teal }]);
  const box = chartBox();
  const chart = createChart(box, { series: [{ color: COLORS.green }, { color: COLORS.teal, fill: false }], max: 1, format: pctMax });
  const name = el('p', 'ui-caption');
  const sensors = el('div');
  ctx.body.append(figs.element, box, name, sensors);
  detailFeed(ctx, (d) => {
    const g = d.snapshot.gpu;
    if (!g) {
      ctx.body.replaceChildren(el('p', 'ui-empty', 'No GPU readings are available on this computer.'));
      return;
    }
    figs.set(0, percentText(g.usage));
    figs.set(1, temperature(g.temperature) ?? DASH);
    figs.set(2, g.memory ? formatUsedTotal(g.memory.used, g.memory.total) : DASH);
    name.textContent = g.name;
    chart.update([lastMinute(d.history, (p) => p.gpu), lastMinute(d.history, (p) => p.vram)]);
    sensors.replaceChildren(...(d.gpu?.sensors.length ? sensorGroups(d.gpu.sensors) : []));
  });
  ctx.onLeave(() => chart.destroy());
}

// ------------------------------------------------------------------ memory

function memoryWindow(ctx) {
  const figs = figures([{ label: 'In use' }, { label: 'Available' }, { label: 'Committed' }]);
  const box = chartBox();
  const chart = createChart(box, { series: [{ color: COLORS.purple }], max: 1, format: pctMax });
  const comp = el('div', 'ui-composition');
  const legend = el('div', 'ui-legend');
  const facts = liveGroup();
  ctx.body.append(figs.element, box, el('h3', 'sf-section-title', 'Memory composition'), comp, legend, facts.element);
  detailFeed(ctx, (d) => {
    const m = d.memory;
    figs.set(0, bytesText(m.used));
    figs.set(1, bytesText(m.available));
    figs.set(2, m.committed ? bytesText(m.committed.used) : DASH);
    chart.update([lastMinute(d.history, (p) => p.mem)]);
    // In use, cached (reclaimable), free: Task Manager's composition bar.
    const cached = Math.min(m.cached ?? 0, Math.max(0, m.total - m.used));
    const parts = [
      { label: 'In use', value: m.used, color: COLORS.purple },
      ...(m.wired ? [{ label: 'Wired', value: m.wired, color: COLORS.orange, within: true }] : []),
      ...(m.compressed ? [{ label: 'Compressed', value: m.compressed, color: COLORS.yellow, within: true }] : []),
      { label: 'Cached', value: cached, color: COLORS.indigo },
      { label: 'Free', value: Math.max(0, m.total - m.used - cached), color: 'rgba(120,120,128,0.36)' },
    ];
    comp.replaceChildren(
      ...parts
        .filter((p) => !p.within)
        .map((p) => {
          const seg = el('span');
          seg.style.width = `${(p.value / m.total) * 100}%`;
          seg.style.background = p.color;
          seg.title = `${p.label}: ${bytesText(p.value)}`;
          return seg;
        }),
    );
    legend.replaceChildren(
      ...parts.map((p) => {
        const item = el('span', 'ui-legend-item');
        const dot = el('span', 'ui-dot');
        dot.style.background = p.color;
        item.append(dot, `${p.label} ${bytesText(p.value)}`);
        return item;
      }),
    );
    facts.set([
      row('Total', bytesText(m.total)),
      row('In use', `${bytesText(m.used)} (${percentText(m.used / m.total)})`),
      row('Available', bytesText(m.available)),
      m.cached !== null ? row('Cached', bytesText(m.cached)) : null,
      m.buffers !== null ? row('Buffers', bytesText(m.buffers)) : null,
      m.wired !== null ? row('Wired', bytesText(m.wired)) : null,
      m.compressed !== null ? row('Compressed', bytesText(m.compressed)) : null,
      m.committed ? row('Committed', formatUsedTotal(m.committed.used, m.committed.limit)) : null,
      m.swap ? row(d.snapshot.platform === 'win32' ? 'Page file' : 'Swap', formatUsedTotal(m.swap.used, m.swap.total)) : null,
    ]);
  });
  ctx.onLeave(() => chart.destroy());
}

// ------------------------------------------------------------------ disk

function diskWindow(ctx) {
  const figs = figures([{ label: 'Read', color: COLORS.green }, { label: 'Write', color: COLORS.teal }, { label: 'Active time' }]);
  const box = chartBox();
  const chart = createChart(box, { series: [{ color: COLORS.green }, { color: COLORS.teal, fill: false }], max: 'auto', format: rateText });
  const disks = el('div');
  const volumes = liveGroup('Volumes');
  ctx.body.append(figs.element, box, disks, volumes.element);
  const cards = new Map();
  detailFeed(ctx, (d) => {
    const s = d.snapshot;
    figs.set(0, rateText(s.disk?.readRate));
    figs.set(1, rateText(s.disk?.writeRate));
    const busiest = Math.max(-1, ...d.disks.map((x) => x.active ?? -1));
    figs.set(2, busiest >= 0 ? percentText(busiest) : s.disk?.read !== null && s.disk?.read !== undefined ? percentText(Math.max(s.disk.read, s.disk.write ?? 0)) : DASH);
    chart.update([lastMinute(d.history, (p) => p.readRate), lastMinute(d.history, (p) => p.writeRate)]);
    for (const disk of d.disks) {
      let card = cards.get(disk.name);
      if (!card) {
        const section = el('section', 'sf-section');
        const title = el('h3', 'sf-section-title', disk.name);
        const graph = el('div', 'ui-chart small');
        const list = el('div', 'sf-group');
        section.append(title, graph, list);
        disks.append(section);
        card = { list, chart: createChart(graph, { series: [{ color: COLORS.green }], max: 1, format: pctMax, span: 'Active time' }) };
        cards.set(disk.name, card);
      }
      card.chart.update([lastMinute(d.detailHistory, (p) => p.disks[disk.name]?.[2])]);
      setRows(card.list, [
        row('Active time', percentText(disk.active)),
        disk.read !== null ? row('Reading', percentText(disk.read)) : null,
        disk.write !== null ? row('Writing', percentText(disk.write)) : null,
        row('Read speed', rateText(disk.readRate)),
        row('Write speed', rateText(disk.writeRate)),
        disk.temperature !== null ? row('Temperature', temperature(disk.temperature)) : null,
        disk.usedSpace !== null ? row('Used space', percentText(disk.usedSpace)) : null,
        disk.life !== null ? row('Remaining life', percentText(disk.life)) : null,
      ]);
    }
    volumes.set(
      s.drives.map((v) => {
        const bar = el('span', 'ui-mini-bar');
        const fill = el('span');
        fill.style.width = `${(v.used / v.total) * 100}%`;
        bar.append(fill);
        const value = el('span', 'ui-volume');
        value.append(bar, formatUsedTotal(v.used, v.total, s.platform !== 'darwin'));
        return row(v.name, value, { title: v.mount, chevron: !!env.openInFiles, onClick: env.openInFiles ? () => env.openInFiles(v.mount) : undefined });
      }),
    );
  });
  ctx.onLeave(() => {
    chart.destroy();
    cards.forEach((c) => c.chart.destroy());
  });
}

// ------------------------------------------------------------------ network

function networkWindow(ctx) {
  const figs = figures([{ label: 'Receive', color: COLORS.orange }, { label: 'Send', color: COLORS.teal }]);
  const box = chartBox();
  const chart = createChart(box, { series: [{ color: COLORS.orange }, { color: COLORS.teal, fill: false }], max: 'auto', format: rateText });
  const adapters = el('div');
  ctx.body.append(figs.element, box, adapters);
  const cards = new Map();
  detailFeed(ctx, (d) => {
    const s = d.snapshot;
    figs.set(0, rateText(s.network?.down));
    figs.set(1, rateText(s.network?.up));
    chart.update([lastMinute(d.history, (p) => p.down), lastMinute(d.history, (p) => p.up)]);
    for (const a of d.adapters) {
      let card = cards.get(a.name);
      if (!card) {
        const section = el('section', 'sf-section');
        const graph = el('div', 'ui-chart small');
        const list = el('div', 'sf-group');
        section.append(el('h3', 'sf-section-title', a.name), graph, list);
        adapters.append(section);
        card = { list, chart: createChart(graph, { series: [{ color: COLORS.orange }, { color: COLORS.teal, fill: false }], max: 'auto', format: rateText }) };
        cards.set(a.name, card);
      }
      card.chart.update([lastMinute(d.detailHistory, (p) => p.nics[a.name]?.[0]), lastMinute(d.detailHistory, (p) => p.nics[a.name]?.[1])]);
      const v4 = a.addresses.filter((x) => x.family === 'IPv4' || x.family === '4').map((x) => x.address);
      const v6 = a.addresses.filter((x) => x.family === 'IPv6' || x.family === '6').map((x) => x.address);
      setRows(card.list, [
        row('Receive', rateText(a.down)),
        row('Send', rateText(a.up)),
        v4.length ? row('IPv4 address', v4.join(', ')) : null,
        v6.length ? row('IPv6 address', v6[0], { title: v6.join('\n') }) : null,
        a.mac ? row('Hardware address', a.mac.toUpperCase()) : null,
        a.speed ? row('Link speed', bitsText(a.speed)) : null,
        a.received !== null ? row('Received', bytesText(a.received, false)) : null,
        a.sent !== null ? row('Sent', bytesText(a.sent, false)) : null,
      ]);
    }
  });
  ctx.onLeave(() => {
    chart.destroy();
    cards.forEach((c) => c.chart.destroy());
  });
}

// ------------------------------------------------------------------ system

function systemWindow(ctx) {
  const figs = figures([{ label: 'Up time' }, { label: 'Started' }]);
  const facts = liveGroup();
  const sensors = el('div');
  ctx.body.append(figs.element, facts.element, sensors);
  let snapshot = null;
  let bootedAt = null;
  ctx.every(1000, () => {
    if (bootedAt) figs.set(0, clockDuration((Date.now() - bootedAt) / 1000));
  });
  detailFeed(ctx, (d) => {
    snapshot = d.snapshot;
    bootedAt = d.system.bootedAt;
    figs.set(0, clockDuration(snapshot.uptime.system));
    figs.set(1, dateText(bootedAt));
    facts.set([
      row('Name', d.system.hostname),
      row('System', `${d.system.os} ${d.system.release}`),
      d.system.version ? row('Version', d.system.version) : null,
      row('Architecture', d.system.arch),
      row('Signed in as', d.system.user || DASH),
      row('Processor', snapshot.cpu.model || DASH),
      row('Logical processors', String(d.system.cpus)),
      row('Memory', bytesText(snapshot.memory.total)),
      snapshot.gpu ? row('Graphics', snapshot.gpu.name) : null,
      row('Sensors', snapshot.source === 'lhm' ? 'Libre Hardware Monitor' : 'Operating system'),
      row('Node.js', d.system.node),
    ]);
    // Every hardware sensor, by device (as Libre Hardware Monitor lists them).
    if (d.sensors.length) {
      sensors.replaceChildren(
        el('h3', 'sf-section-title big', 'Sensors'),
        ...d.sensors.map((hw) => {
          const details = el('details', 'ui-disclosure');
          const summary = el('summary', '', hw.hardware);
          details.append(summary, ...sensorGroups(hw.sensors.filter((s) => s.value !== null)));
          return details;
        }),
      );
    }
  }, 3000);
}

// ------------------------------------------------------------------ SF Agents

function sfagentsWindow(ctx) {
  const figs = figures([{ label: 'CPU', color: COLORS.blue }, { label: 'Memory', color: COLORS.purple }, { label: 'Up time' }]);
  const box = chartBox();
  const chart = createChart(box, { series: [{ color: COLORS.purple }], max: 'auto', format: (v) => bytesText(v) });
  const facts = liveGroup();
  const convo = liveGroup('Conversation');
  ctx.body.append(figs.element, box, facts.element, convo.element);
  const history = [];
  ctx.every(2000, async () => {
    const s = await getJson('/api/system/sfagents');
    history.push({ t: Date.now(), rss: s.memory.rss });
    if (history.length > 120) history.shift();
    figs.set(0, percentText(s.cpu));
    figs.set(1, bytesText(s.memory.rss));
    figs.set(2, formatDuration(s.uptime));
    chart.update([lastMinute(history, (p) => p.rss)]);
    facts.set([
      row('Status', s.running ? 'Working on a reply' : s.approvals ? `Waiting for ${plural(s.approvals, 'approval')}` : 'Idle'),
      row('Agent', s.agent.id),
      row('Model', s.agent.model),
      row('Provider', s.agent.provider),
      row('Agents in the tree', String(s.agent.agents)),
      row('Address', s.url),
      ...(s.publicOrigins ?? (s.publicOrigin ? [s.publicOrigin] : [])).map((o, i, all) => row(all.length > 1 ? `Public address ${i + 1}` : 'Public address', o)),
      row('Open windows', String(s.clients)),
      row('Process ID', String(s.pid)),
      row('JavaScript memory', `${bytesText(s.memory.heapUsed)} of ${bytesText(s.memory.heapTotal)}`),
      row('Node.js', `${s.node} (${s.platform}, ${s.arch})`),
    ]);
    convo.set([
      row('File', s.conversation.file ? s.conversation.file.split(/[\\/]/).pop() : DASH, {
        title: s.conversation.file ?? '',
        chevron: !!env.openInFiles,
        onClick: env.openInFiles && s.conversation.file ? () => env.openInFiles(s.conversation.file.replace(/[\\/][^\\/]*$/, ''), { select: s.conversation.file }) : undefined,
      }),
      row('Size', bytesText(s.conversation.size, false)),
      row('Messages', s.conversation.messages.toLocaleString()),
      row('Topics', s.conversation.sections.toLocaleString()),
      row('Artifacts', s.conversation.artifacts.toLocaleString()),
    ]);
  });
  ctx.onLeave(() => chart.destroy());
}

// ------------------------------------------------------------------ processes

const SORTS = {
  cpu: { label: 'CPU', cmp: (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || (b.memory ?? 0) - (a.memory ?? 0) },
  memory: { label: 'Memory', cmp: (a, b) => (b.memory ?? -1) - (a.memory ?? -1) },
  name: { label: 'Name', cmp: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.pid - b.pid },
  pid: { label: 'PID', cmp: (a, b) => a.pid - b.pid },
};

function searchField(placeholder, onInput) {
  const field = createField({
    placeholder,
    look: 'card',
    multiline: false,
    maxRows: 1,
    inputMode: 'search',
    autocapitalize: 'off',
    aria: placeholder,
    leading: [symbol('magnifyingglass', 15)],
    onInput,
  });
  field.input.spellcheck = false;
  field.input.autocomplete = 'off';
  field.input.setAttribute('enterkeyhint', 'search');
  return field.el;
}

function processesWindow(ctx) {
  let tab = 'processes';
  const tabs = segmented(
    [
      { label: 'Processes', value: 'processes' },
      { label: 'Users', value: 'users' },
      { label: 'Services', value: 'services' },
      { label: 'Startup', value: 'startup' },
    ],
    tab,
    (v) => {
      tab = v;
      show();
    },
  );
  const panes = { processes: el('div'), users: el('div'), services: el('div'), startup: el('div') };
  ctx.body.append(tabs.element, ...Object.values(panes));
  const built = new Set();
  function show() {
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== tab;
    if (built.has(tab)) return;
    built.add(tab);
    ({ processes: processList, users: usersPane, services: servicesPane, startup: startupPane })[tab](ctx, panes[tab]);
  }
  show();
}

function processList(ctx, pane) {
  let query = '';
  let sort = 'cpu';
  let data = null;
  const tools = el('div', 'ui-toolbar');
  const sort_ = createButton({ symbol: 'arrow.up.arrow.down', label: 'CPU', aria: 'Sort by', className: 'ui-sort' });
  const sortBtn = sort_.el;
  sortBtn.addEventListener('click', () =>
    showMenu({
      anchor: sortBtn,
      align: 'end',
      title: 'Sort By',
      groups: [Object.entries(SORTS).map(([k, s]) => ({ label: s.label, checked: k === sort, action: () => ((sort = k), sort_.setLabel(s.label), draw()) }))],
    }),
  );
  tools.append(searchField('Search processes', (v) => ((query = v.toLowerCase()), draw())), sortBtn);
  const summary = el('p', 'ui-caption');
  const head = el('div', 'proc-head');
  head.append(el('span', '', 'Name'), el('span', '', 'CPU'), el('span', '', 'Memory'));
  const list = el('div', 'sf-group proc-list');
  pane.append(tools, summary, head, list);
  const rows = new Map();

  function draw() {
    if (!data) return;
    const shown = data.processes.filter((p) => !query || p.name.toLowerCase().includes(query) || String(p.pid).startsWith(query) || (p.user ?? '').toLowerCase().includes(query)).sort(SORTS[sort].cmp);
    const cpu = data.processes.reduce((a, p) => a + (p.cpu ?? 0), 0);
    const mem = data.processes.reduce((a, p) => a + (p.memory ?? 0), 0);
    summary.textContent = `${plural(data.processes.length, 'process', 'processes')} · CPU ${percentText(cpu)} · ${bytesText(mem)} in use`;
    const keep = new Set();
    let prev = null;
    for (const p of shown.slice(0, 400)) {
      keep.add(p.pid);
      let r = rows.get(p.pid);
      if (!r) {
        const node = el('button', 'proc-row');
        node.type = 'button';
        const name = el('span', 'proc-name');
        const title = el('span', 'proc-title');
        const sub = el('span', 'proc-sub');
        name.append(title, sub);
        const c = el('span', 'proc-num');
        const m = el('span', 'proc-num');
        node.append(name, c, m);
        node.addEventListener('click', () => ctx.push(processView(p.pid, p.name)));
        r = { node, title, sub, c, m };
        rows.set(p.pid, r);
      }
      if (r.title.textContent !== p.name) r.title.textContent = p.name;
      const subText = `${p.pid}${p.user ? ` · ${p.user}` : ''}`;
      if (r.sub.textContent !== subText) r.sub.textContent = subText;
      r.c.textContent = p.cpu === null ? DASH : `${(p.cpu * 100).toFixed(p.cpu >= 0.1 ? 0 : 1)}%`;
      r.c.classList.toggle('hot', (p.cpu ?? 0) >= 0.25);
      r.m.textContent = p.memory === null ? DASH : bytesText(p.memory);
      // Keep DOM order equal to the sort order with as few moves as possible.
      const want = prev ? prev.nextSibling : list.firstChild;
      if (want !== r.node) list.insertBefore(r.node, want);
      prev = r.node;
    }
    for (const [pid, r] of rows) {
      if (!keep.has(pid)) {
        r.node.remove();
        rows.delete(pid);
      }
    }
    if (!shown.length) list.replaceChildren(el('p', 'ui-empty', query ? 'No processes match.' : 'No processes.'));
  }

  ctx.every(2000, async () => {
    data = await getJson('/api/processes');
    draw();
  });
}

const PRIORITY_NAMES = [
  ['high', 'High', -14],
  ['aboveNormal', 'Above normal', -7],
  ['normal', 'Normal', 0],
  ['belowNormal', 'Below normal', 10],
  ['low', 'Low', 19],
];

function priorityName(n) {
  if (!Number.isFinite(n)) return DASH;
  let best = PRIORITY_NAMES[2];
  for (const p of PRIORITY_NAMES) if (Math.abs(p[2] - n) < Math.abs(best[2] - n)) best = p;
  return best[1];
}

function processView(pid, name) {
  return {
    title: name,
    build(ctx) {
      const figs = figures([{ label: 'CPU', color: COLORS.blue }, { label: 'Memory', color: COLORS.purple }, { label: 'Threads' }]);
      const box = chartBox('ui-chart small');
      const chart = createChart(box, { series: [{ color: COLORS.blue }], max: 'auto', format: (v) => `${Math.round(v * 100)}%` });
      const facts = liveGroup();
      const command = liveGroup('Command');
      const children = liveGroup('Started by this process');
      const actions = el('div', 'ui-actions');
      const note = el('p', 'ui-caption');
      ctx.body.append(figs.element, box, facts.element, command.element, children.element, actions, note);
      const history = [];
      let detail = null;
      let gone = false;

      const end = async (force, tree) => {
        if (!detail) return;
        const what = tree ? `"${detail.name}" and everything it started` : `"${detail.name}"`;
        const ok = await confirmDialog(force ? `Force quit ${what}?` : tree ? `End ${what}?` : `End "${detail.name}"?`, force ? 'Unsaved work in it will be lost.' : 'It will be asked to quit; unsaved work may be lost.', force ? 'Force Quit' : 'End', true);
        if (!ok) return;
        try {
          const out = await postJson(`/api/processes/${pid}/end`, { force, tree });
          if (out.failed?.length) await showError(out.failed.map((f) => f.error).join('\n'), 'Some processes were not ended');
          if (!tree || !out.failed?.length) ctx.pop();
        } catch (error) {
          await showError(error.message, `Couldn't end "${detail.name}"`);
        }
      };

      const priorityMenu = (anchor) =>
        showMenu({
          anchor,
          title: 'Priority',
          groups: [
            PRIORITY_NAMES.map(([key, label, value]) => ({
              label,
              checked: detail && priorityName(detail.priority) === label,
              detail: value < 0 ? 'Needs administrator rights' : undefined,
              action: async () => {
                try {
                  await postJson(`/api/processes/${pid}/priority`, { level: key });
                } catch (error) {
                  await showError(error.message, "Couldn't change the priority");
                }
              },
            })),
          ],
        });

      const buildActions = () => {
        actions.replaceChildren();
        if (!detail) return;
        if (detail.protected) {
          note.textContent = detail.protected;
          return;
        }
        note.textContent = '';
        const priority = button('Set Priority', { symbol: 'slider.horizontal.3' });
        priority.addEventListener('click', () => priorityMenu(priority));
        actions.append(
          button('End Task', { symbol: 'stop.circle', role: 'destructive', onClick: () => end(false, false) }),
          button('Force Quit', { symbol: 'xmark.octagon', role: 'destructive', onClick: () => end(true, false) }),
          ...(detail.children.length ? [button('End Process Tree', { symbol: 'xmark.octagon', role: 'destructive', onClick: () => end(true, true) })] : []),
          priority,
          ...(detail.path && env.openInFiles ? [button('Show in Files', { symbol: 'folder', onClick: () => env.openInFiles(detail.path.replace(/[\\/][^\\/]*$/, ''), { select: detail.path }) })] : []),
        );
      };

      ctx.every(2000, async () => {
        if (gone) return;
        try {
          detail = await getJson(`/api/processes/${pid}`);
        } catch (error) {
          if (error.status === 404) {
            gone = true;
            actions.replaceChildren();
            note.textContent = 'This process has ended.';
            figs.set(0, DASH);
            return;
          }
          throw error;
        }
        ctx.setTitle(detail.name);
        history.push({ t: Date.now(), cpu: detail.cpu });
        figs.set(0, detail.cpu === null ? DASH : percentText(detail.cpu));
        figs.set(1, bytesText(detail.memory));
        figs.set(2, detail.threads === null ? DASH : String(detail.threads));
        chart.update([lastMinute(history, (p) => p.cpu)]);
        facts.set([
          row('Process ID', String(detail.pid)),
          detail.parent
            ? row('Parent', `${detail.parent.name} (${detail.parent.pid})`, { chevron: true, onClick: () => ctx.push(processView(detail.parent.pid, detail.parent.name)) })
            : row('Parent', detail.ppid ? String(detail.ppid) : DASH),
          row('User', detail.user ?? DASH),
          detail.state ? row('Status', detail.state) : null,
          row('Started', detail.started ? dateText(detail.started, true) : DASH, { title: detail.started ? fullDate(detail.started) : '' }),
          row('Priority', priorityName(detail.priority), detail.protected ? {} : { chevron: true, onClick: (e) => priorityMenu(e.currentTarget) }),
          detail.virtual !== null ? row('Virtual memory', bytesText(detail.virtual)) : null,
          detail.swap !== null ? row('Swapped out', bytesText(detail.swap)) : null,
          detail.ioRead !== null ? row('Read from disk', bytesText(detail.ioRead, false)) : null,
          detail.ioWrite !== null ? row('Written to disk', bytesText(detail.ioWrite, false)) : null,
          detail.files !== null ? row('Open files', String(detail.files)) : null,
          detail.handles !== null ? row('Handles', detail.handles.toLocaleString()) : null,
          detail.path
            ? row('Program', detail.path.split(/[\\/]/).pop(), { title: detail.path, chevron: !!env.openInFiles, onClick: env.openInFiles ? () => env.openInFiles(detail.path.replace(/[\\/][^\\/]*$/, ''), { select: detail.path }) : undefined })
            : null,
          detail.cwd ? row('Working folder', detail.cwd.split(/[\\/]/).filter(Boolean).pop() ?? detail.cwd, { title: detail.cwd, chevron: !!env.openInFiles, onClick: env.openInFiles ? () => env.openInFiles(detail.cwd) : undefined }) : null,
        ]);
        const cmd = el('code', 'ui-code', detail.command ?? DASH);
        command.set([cmd]);
        command.element.hidden = !detail.command;
        children.element.hidden = !detail.children.length;
        children.set(detail.children.map((c) => row(c.name, `${c.pid}`, { chevron: true, onClick: () => ctx.push(processView(c.pid, c.name)) })));
        if (!actions.childElementCount && !note.textContent) buildActions();
      });
      ctx.onLeave(() => chart.destroy());
    },
  };
}

function usersPane(ctx, pane) {
  const list = el('div', 'sf-group');
  pane.append(list);
  ctx.every(4000, async () => {
    const { users } = await getJson('/api/system/users');
    setRows(
      list,
      users.length
        ? users.map((u) => {
            const node = el('div', 'user-row');
            const name = el('span', 'proc-name');
            name.append(el('span', 'proc-title', u.name), el('span', 'proc-sub', u.sessions.map((s) => [s.terminal, s.since, s.from].filter(Boolean).join(' · ')).join('; ')));
            node.append(symbol('person.crop.circle', 26), name, el('span', 'proc-num', `${u.processes} · ${percentText(u.cpu)} · ${bytesText(u.memory)}`));
            return node;
          })
        : [el('p', 'ui-empty', 'Nobody is signed in.')],
    );
  });
}

function servicesPane(ctx, pane) {
  let query = '';
  let data = null;
  const list = el('div', 'sf-group');
  const note = el('p', 'ui-caption');
  pane.append(searchField('Search services', (v) => ((query = v.toLowerCase()), draw())), note, list);
  function draw() {
    if (!data) return;
    const shown = data.filter((s) => !query || s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query));
    note.textContent = `${plural(data.filter((s) => s.state === 'running').length, 'running service')} of ${data.length}`;
    setRows(
      list,
      shown.slice(0, 500).map((s) => {
        const node = el('button', 'proc-row service');
        node.type = 'button';
        const name = el('span', 'proc-name');
        name.append(el('span', 'proc-title', s.description || s.name), el('span', 'proc-sub', `${s.name}${s.scope === 'user' ? ' · yours' : ''}${s.startup ? ` · ${s.startup}` : ''}`));
        const badge = el('span', `ui-badge ${s.state}`, s.state === 'running' ? 'Running' : s.state === 'failed' ? 'Failed' : 'Stopped');
        node.append(name, badge);
        node.addEventListener('click', () =>
          showMenu({
            anchor: node,
            title: s.description || s.name,
            groups: [
              [
                { label: 'Start', symbol: 'play.fill', disabled: s.state === 'running', action: () => act(s, 'start') },
                { label: 'Stop', symbol: 'stop.circle', role: 'destructive', disabled: s.state !== 'running', action: () => act(s, 'stop') },
                { label: 'Restart', symbol: 'arrow.clockwise', disabled: s.state !== 'running', action: () => act(s, 'restart') },
              ],
            ],
          }),
        );
        return node;
      }),
    );
  }
  async function act(s, action) {
    try {
      await postJson('/api/system/services', { name: s.name, action, scope: s.scope });
      data = (await getJson('/api/system/services')).services;
      draw();
    } catch (error) {
      await showError(error.message, `Couldn't ${action} ${s.description || s.name}`);
    }
  }
  ctx.every(6000, async () => {
    try {
      data = (await getJson('/api/system/services')).services;
      draw();
    } catch (error) {
      list.replaceChildren(el('p', 'ui-empty', error.message));
    }
  });
}

function startupPane(ctx, pane) {
  const list = el('div', 'sf-group');
  pane.append(el('p', 'ui-caption', 'Apps that start when you sign in.'), list);
  const load = async () => {
    const { startup } = await getJson('/api/system/startup');
    setRows(
      list,
      startup.length
        ? startup.map((s) => {
            const node = el('div', 'proc-row startup');
            const name = el('span', 'proc-name');
            name.append(el('span', 'proc-title', s.name), el('span', 'proc-sub', s.command || s.location));
            node.title = `${s.command}\n${s.location}`;
            node.append(name);
            if (s.toggle) {
              const sw = el('input', 'ui-switch');
              sw.type = 'checkbox';
              sw.setAttribute('role', 'switch');
              sw.checked = s.enabled;
              sw.setAttribute('aria-label', `Start ${s.name} at sign-in`);
              sw.addEventListener('change', async () => {
                try {
                  await postJson('/api/system/startup', { id: s.id, enabled: sw.checked });
                } catch (error) {
                  sw.checked = !sw.checked;
                  await showError(error.message, "Couldn't change it");
                }
              });
              node.append(sw);
            } else node.append(el('span', `ui-badge ${s.enabled ? 'running' : 'stopped'}`, s.enabled ? 'On' : 'Off'));
            return node;
          })
        : [el('p', 'ui-empty', 'No startup apps.')],
    );
  };
  load().catch((error) => list.replaceChildren(el('p', 'ui-empty', error.message)));
}
