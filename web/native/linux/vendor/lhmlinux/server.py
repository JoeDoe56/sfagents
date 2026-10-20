#!/usr/bin/env python3
"""
lhm-linux — a LibreHardwareMonitor-compatible sensor web server for Linux.

LibreHardwareMonitor (LHM) is Windows-only: it relies on a Ring-0 kernel driver
and WMI. A whole ecosystem of clients speaks its simple HTTP/JSON protocol,
though — Elgato Stream Deck plugins, yasb, Home Assistant, Grafana
dashboards and more.

This project does not port the application. It re-implements the *protocol* on
top of native Linux sensor sources, so any existing LHM client can read a Linux
box exactly as if it were a Windows PC. Point the client at this host and port.

Endpoints
    GET /data.json    LHM-compatible sensor tree
    GET /metrics.txt  Prometheus exposition (also served at /metrics)
    GET /             HTML dashboard
    GET /healthz      liveness probe

Sensor sources (each is optional and skipped when unavailable)
    nvidia-smi   NVIDIA GPU temperature, load, VRAM, power, clocks, fan
    lm-sensors   CPU package and per-core temperatures (coretemp/k10temp)
    ipmitool     BMC board/DIMM/VRM temperatures, fans, voltages, PSU watts
    smartctl     Disk temperatures
    /proc        Memory usage and load average

Author:  Dominic Ballenthin <admin@insight-it.de>
Company: Insight-IT GmbH, Berlin — https://www.insight-it.de
SPDX-License-Identifier: MIT
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

__version__ = "1.2.0"
__author__ = "Dominic Ballenthin, Insight-IT GmbH"
__license__ = "MIT"

# Version string reported to clients in /data.json. Some clients compare this
# against a minimum, so we advertise a realistic LibreHardwareMonitor version.
LHM_VERSION = "0.9.4"

DEFAULT_PORT = 8085          # LibreHardwareMonitor's default port
DEFAULT_INTERVAL = 2.0       # seconds between fast sensor polls

# Some sources are far too slow to sit in the fast loop. A BMC answers
# "ipmitool sdr" in anything from 5 to 13 seconds, and SMART can spin up disks.
# Polling them at the fast interval would stall CPU and GPU updates behind them,
# which looks exactly like a frozen display on a hardware panel. Each source
# therefore runs on its own cadence in its own thread.
SLOW_INTERVAL = 30.0         # BMC/IPMI: board temps, fans, voltages, PSU watts
DISK_INTERVAL = 300.0        # SMART is expensive and can spin up disks

_lock = threading.Lock()
_snapshot: dict = {"ts": 0.0, "hardware": []}
_results: dict[str, list] = {}         # source key -> its most recent readings
_minmax: dict[str, list[float]] = {}   # SensorId -> [min, max] since start

# Populated from CLI arguments in main().
CONFIG = {"decimal_comma": True, "hostname": None, "interval": DEFAULT_INTERVAL}


def run(cmd: list[str], timeout: int = 20) -> str:
    """Run a command and return stdout, or "" on any failure."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout, check=False)
        return proc.stdout if proc.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def to_float(value) -> float | None:
    """Parse a number that may use either a dot or a comma as separator."""
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def has(cmd: str) -> bool:
    return bool(run(["sh", "-c", f"command -v {cmd}"]).strip())


# ---------------------------------------------------------------------------
# Value formatting
#
# Verified byte-for-byte against a running LibreHardwareMonitor 0.9.x instance
# and against the upstream source (UI/TypeNode.cs, Hardware/ISensor.cs).
# ---------------------------------------------------------------------------

# Format string and unit per sensor type.
FORMATS: dict[str, tuple[str, str]] = {
    "Voltage":     ("{:.3f}", "V"),
    "Current":     ("{:.3f}", "A"),
    "Power":       ("{:.1f}", "W"),
    "Clock":       ("{:.1f}", "MHz"),
    "Temperature": ("{:.1f}", "°C"),
    "Load":        ("{:.1f}", "%"),
    "Fan":         ("{:.0f}", "RPM"),
    "Control":     ("{:.1f}", "%"),
    "Level":       ("{:.1f}", "%"),
    "Factor":      ("{:.3f}", ""),
    "Data":        ("{:.1f}", "GB"),
    "SmallData":   ("{:.1f}", "MB"),
    "Throughput":  ("{:.1f}", "KB/s"),
}

# Node order follows the SensorType enum in Hardware/ISensor.cs.
TYPE_ORDER = ["Voltage", "Current", "Power", "Clock", "Temperature", "Load",
              "Fan", "Control", "Level", "Factor", "Data", "SmallData",
              "Throughput"]

# Display label of the grouping node, from UI/TypeNode.cs.
# Note two quirks that clients depend on:
#   * "Load" is SINGULAR while every other label is plural.
#   * "Data" and "SmallData" share a single node labelled "Data".
TYPE_LABEL = {
    "Voltage": "Voltages", "Current": "Currents", "Power": "Powers",
    "Clock": "Clocks", "Temperature": "Temperatures", "Load": "Load",
    "Fan": "Fans", "Control": "Controls", "Level": "Levels",
    "Factor": "Factors", "Data": "Data", "SmallData": "Data",
    "Throughput": "Throughput",
}

TYPE_ICON = {
    "Voltage": "voltage.png", "Current": "voltage.png", "Power": "power.png",
    "Clock": "clock.png", "Temperature": "temperature.png", "Load": "load.png",
    "Fan": "fan.png", "Control": "control.png", "Level": "level.png",
    "Factor": "factor.png", "Data": "power.png", "SmallData": "power.png",
    "Throughput": "throughput.png",
}


def fmt(sensor_type: str, value: float | None) -> str:
    """Format a value the way LHM does, e.g. "63,0 °C".

    LibreHardwareMonitor formats using the host's Windows locale, so a German
    system emits a decimal comma. Clients parse that string, which is why the
    separator is configurable and defaults to a comma.
    Sensors without a reading render as "-", matching upstream behaviour.
    """
    if value is None:
        return "-"
    spec, unit = FORMATS.get(sensor_type, ("{:.1f}", ""))
    text = spec.format(value)
    if CONFIG["decimal_comma"]:
        text = text.replace(".", ",")
    return f"{text} {unit}" if unit else text


class Sensor:
    __slots__ = ("name", "sid", "type", "value")

    def __init__(self, name: str, sensor_type: str, value, sid: str):
        self.name = name
        self.type = sensor_type
        self.value = value
        self.sid = sid


class Hardware:
    __slots__ = ("hwid", "icon", "name", "sensors")

    def __init__(self, name: str, hwid: str, icon: str = "computer.png"):
        self.name = name
        self.hwid = hwid
        self.icon = icon
        self.sensors: list[Sensor] = []

    def add(self, name: str, sensor_type: str, value, index: int) -> None:
        sid = f"{self.hwid}/{sensor_type.lower()}/{index}"
        self.sensors.append(Sensor(name, sensor_type, value, sid))


# ---------------------------------------------------------------------------
# Sensor source: NVIDIA GPUs
# ---------------------------------------------------------------------------

GPU_QUERY = ("index,name,temperature.gpu,utilization.gpu,utilization.memory,"
             "memory.used,memory.total,power.draw,power.limit,fan.speed,"
             "clocks.sm,clocks.mem")


def poll_gpus() -> list[Hardware]:
    out = run(["nvidia-smi", f"--query-gpu={GPU_QUERY}",
               "--format=csv,noheader,nounits"])
    result = []
    for line in out.strip().splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 12:
            continue

        def val(index: int, _cols=cols):
            return to_float(_cols[index])

        hw = Hardware(cols[1], f"/gpu-nvidia/{cols[0]}", "nvidia.png")
        hw.add("GPU Core", "Temperature", val(2), 0)
        hw.add("GPU Core", "Load", val(3), 0)
        hw.add("GPU Memory", "Load", val(4), 1)
        used, total = val(5), val(6)
        if used is not None and total is not None and total > 0:
            hw.add("GPU Memory Used", "SmallData", used, 0)
            hw.add("GPU Memory Total", "SmallData", total, 1)
            hw.add("GPU Memory Free", "SmallData", total - used, 2)
        hw.add("GPU Package", "Power", val(7), 0)
        hw.add("GPU Power Limit", "Power", val(8), 1)
        if val(9) is not None:
            hw.add("GPU Fan", "Control", val(9), 0)
        hw.add("GPU Core", "Clock", val(10), 0)
        hw.add("GPU Memory", "Clock", val(11), 1)
        result.append(hw)
    return result


# ---------------------------------------------------------------------------
# Sensor source: CPU via lm-sensors
# ---------------------------------------------------------------------------

def poll_cpu() -> list[Hardware]:
    out = run(["sensors", "-j"])
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []

    result = []
    socket = 0
    for chip, features in data.items():
        if not isinstance(features, dict):
            continue
        driver = chip.split("-")[0]
        if driver not in ("coretemp", "k10temp", "zenpower"):
            continue
        vendor = "intelcpu" if driver == "coretemp" else "amdcpu"
        hw = Hardware(f"CPU #{socket}", f"/{vendor}/{socket}", "cpu.png")
        index = 0
        for feature, readings in sorted(features.items()):
            if not isinstance(readings, dict):
                continue
            for key, value in readings.items():
                if not (key.endswith("_input") and "temp" in key):
                    continue
                if not isinstance(value, (int, float)):
                    continue
                label = feature
                low = label.lower()
                if low.startswith("package"):
                    label = "CPU Package"
                elif low.startswith("core"):
                    label = f"CPU {label}"
                hw.add(label, "Temperature", round(float(value), 1), index)
                index += 1
        if hw.sensors:
            result.append(hw)
            socket += 1

    # Approximate overall CPU load from the 1-minute load average.
    if result:
        try:
            with open("/proc/loadavg", encoding="ascii") as handle:
                load1 = float(handle.read().split()[0])
            cores = os.cpu_count() or 1
            result[0].add("CPU Total", "Load", min(100.0, load1 / cores * 100.0), 0)
        except (OSError, ValueError, IndexError):
            pass
    return result


# ---------------------------------------------------------------------------
# Sensor source: BMC via IPMI (servers only; needs root and /dev/ipmi0)
# ---------------------------------------------------------------------------

IPMI_ROW = re.compile(
    r"^\s*(\S.*?)\s*\|\s*\w+h\s*\|\s*(\w+)\s*\|\s*[\d.]+\s*\|\s*(.*?)\s*$")


def _ipmi_rows(kind: str) -> list[tuple[str, float]]:
    rows = []
    for line in run(["ipmitool", "sdr", "type", kind]).splitlines():
        match = IPMI_ROW.match(line)
        if not match:
            continue
        name, state, raw = match.groups()
        if state.lower() != "ok":       # "ns" = no reading / not present
            continue
        number = re.match(r"^(-?[\d.,]+)", raw)
        if number:
            value = to_float(number.group(1))
            if value is not None:
                rows.append((name, value))
    return rows


def poll_ipmi() -> list[Hardware]:
    temps = _ipmi_rows("temperature")
    fans = _ipmi_rows("fan")
    volts = _ipmi_rows("voltage")
    if not (temps or fans or volts):
        return []

    hw = Hardware("Mainboard (BMC)", "/lpc/bmc", "mainboard.png")
    for i, (name, value) in enumerate(temps):
        hw.add(name.replace(" Temp", ""), "Temperature", value, i)
    for i, (name, value) in enumerate(fans):
        hw.add(name, "Fan", value, i)
    for i, (name, value) in enumerate(volts):
        hw.add(name, "Voltage", value, i)

    # Whole-system power draw via DCMI, where the BMC supports it.
    reading = run(["ipmitool", "dcmi", "power", "reading"])
    for pattern, label, index in (
            (r"Instantaneous power reading:\s*(\d+)\s*Watts", "System Total", 0),
            (r"Average power reading:\s*(\d+)\s*Watts", "System Average", 1)):
        match = re.search(pattern, reading)
        if match:
            hw.add(label, "Power", float(match.group(1)), index)
    return [hw]


# ---------------------------------------------------------------------------
# Sensor source: memory
# ---------------------------------------------------------------------------

def poll_memory() -> list[Hardware]:
    try:
        info = {}
        with open("/proc/meminfo", encoding="ascii") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                info[key] = float(rest.strip().split()[0]) / 1024.0 / 1024.0
    except (OSError, ValueError, IndexError):
        return []

    total = info.get("MemTotal")
    if not total:
        return []
    available = info.get("MemAvailable", info.get("MemFree", 0.0))
    used = total - available

    hw = Hardware("Generic Memory", "/ram", "ram.png")
    hw.add("Memory", "Load", used / total * 100.0, 0)
    hw.add("Memory Used", "Data", used, 0)
    hw.add("Memory Available", "Data", available, 1)
    return [hw]


# ---------------------------------------------------------------------------
# Sensor source: disks via SMART
# ---------------------------------------------------------------------------

# ATA attribute row layout:
#   ID# NAME FLAG VALUE WORST THRESH TYPE UPDATED WHEN_FAILED RAW_VALUE
# The temperature lives in RAW_VALUE (last column). The VALUE column is a
# normalised health score and is NOT a temperature — reading it yields
# nonsense such as 139 for a disk that is actually at 43 °C.
SMART_ATTR = re.compile(
    r"^\s*(?:190|194)\s+\S+\s+\S+\s+\d+\s+\d+\s+\d+\s+\S+\s+\S+\s+\S+\s+(\d+)",
    re.MULTILINE)


def poll_disks() -> list[Hardware]:
    result = []
    index = 0
    for line in run(["lsblk", "-dno", "NAME,TYPE,SIZE,MODEL"]).splitlines():
        parts = line.split(None, 3)
        if len(parts) < 3 or parts[1] != "disk":
            continue
        device = "/dev/" + parts[0]
        model = (parts[3].strip() if len(parts) > 3 else "") or parts[0]

        temperature = None
        # "-d sat" is required behind Intel VROC/imsm, which otherwise blocks
        # the ATA passthrough that smartctl needs.
        for mode in ("sat", "nvme", "auto"):
            out = run(["smartctl", "-A", "-d", mode, device], timeout=25)
            if not out.strip():
                continue
            match = SMART_ATTR.search(out)
            if match:
                temperature = float(match.group(1))
            else:
                match = re.search(r"Temperature:\s+(\d+) Celsius", out)
                if match:
                    temperature = float(match.group(1))
            # Drop implausible readings rather than reporting a wrong number.
            if temperature is not None and not 0.0 < temperature < 120.0:
                temperature = None
            if temperature is not None:
                break

        if temperature is None:
            continue
        kind = "nvme" if parts[0].startswith("nvme") else "hdd"
        hw = Hardware(model, f"/{kind}/{index}", "hdd.png")
        hw.add("Temperature", "Temperature", temperature, 0)
        result.append(hw)
        index += 1

    return result


# Each source with the interval it is polled at. Slow sources must never
# delay fast ones — see the SLOW_INTERVAL comment above.
SOURCES = (
    (poll_cpu,    "cpu",    None),           # None = fast interval (CLI/--interval)
    (poll_gpus,   "gpus",   None),
    (poll_memory, "memory", None),
    (poll_ipmi,   "ipmi",   SLOW_INTERVAL),
    (poll_disks,  "disks",  DISK_INTERVAL),
)


def poll_all() -> list[Hardware]:
    """Poll every source once, in order. Used by --list-sensors and tests."""
    hardware = []
    for entry in SOURCES:
        source = entry[0] if isinstance(entry, tuple) else entry
        try:
            hardware.extend(source())
        except Exception:
            # A broken source must never take down the server or the others.
            continue
    return hardware


def _store(key: str, hardware: list[Hardware]) -> None:
    """Publish one source's readings and update its min/max bounds."""
    with _lock:
        for hw in hardware:
            for sensor in hw.sensors:
                if sensor.value is None:
                    continue
                bounds = _minmax.get(sensor.sid)
                if bounds is None:
                    _minmax[sensor.sid] = [sensor.value, sensor.value]
                else:
                    bounds[0] = min(bounds[0], sensor.value)
                    bounds[1] = max(bounds[1], sensor.value)
        _results[key] = hardware
        _snapshot["ts"] = time.time()


def poller(stop: threading.Event, source=None, key: str = "", interval=None) -> None:
    """Refresh one source on its own cadence until stopped.

    One thread per source. A BMC that takes 13 seconds to answer therefore
    delays only its own readings — CPU and GPU keep updating at the fast
    interval, which is what a hardware panel needs to look alive.
    """
    while not stop.is_set():
        try:
            _store(key, source())
        except Exception:
            # Keep polling even if one cycle fails.
            pass
        stop.wait(interval if interval is not None else CONFIG["interval"])


# ---------------------------------------------------------------------------
# /data.json — the LibreHardwareMonitor tree
# ---------------------------------------------------------------------------

def _current() -> tuple[list, dict]:
    """Assemble the latest readings from every source, in SOURCES order."""
    with _lock:
        hardware = []
        for entry in SOURCES:
            key = entry[1] if isinstance(entry, tuple) else entry.__name__
            hardware.extend(_results.get(key, []))
        return hardware, dict(_minmax)


def build_data_json() -> dict:
    hardware, bounds = _current()

    counter = iter(range(10 ** 9))

    def next_id() -> int:
        return next(counter)

    root = {
        "id": next_id(),
        "Version": LHM_VERSION,
        "Text": "Sensor",
        "Min": "Min",
        "Value": "Value",
        "Max": "Max",
        "ImageURL": "",
    }
    computer = {
        "id": next_id(), "Text": CONFIG["hostname"],
        "Min": "", "Value": "", "Max": "",
        "ImageURL": "images_icon/computer.png", "Children": [],
    }

    for hw in hardware:
        hw_node = {
            "id": next_id(), "Text": hw.name,
            "Min": "", "Value": "", "Max": "",
            "HardwareId": hw.hwid,
            "ImageURL": "images_icon/" + hw.icon,
            "Children": [],
        }

        grouped: dict[str, list[Sensor]] = {}
        for sensor in hw.sensors:
            grouped.setdefault(sensor.type, []).append(sensor)

        # Data and SmallData share one node, so track nodes by label.
        nodes_by_label: dict[str, dict] = {}
        for sensor_type in TYPE_ORDER:
            if sensor_type not in grouped:
                continue
            label = TYPE_LABEL.get(sensor_type, sensor_type)
            type_node = nodes_by_label.get(label)
            if type_node is None:
                type_node = {
                    "id": next_id(), "Text": label,
                    "Min": "", "Value": "", "Max": "",
                    "ImageURL": "images_icon/" + TYPE_ICON.get(
                        sensor_type, "computer.png"),
                    "Children": [],
                }
                nodes_by_label[label] = type_node
                hw_node["Children"].append(type_node)

            for sensor in grouped[sensor_type]:
                low, high = bounds.get(sensor.sid, [sensor.value, sensor.value])
                # RawMin/RawValue/RawMax are formatted STRINGS upstream, not
                # numbers, despite the "Raw" prefix. Clients rely on this.
                type_node["Children"].append({
                    "id": next_id(), "Text": sensor.name,
                    "Min": fmt(sensor_type, low),
                    "Value": fmt(sensor_type, sensor.value),
                    "Max": fmt(sensor_type, high),
                    "SensorId": sensor.sid,
                    "Type": sensor_type,
                    "RawMin": fmt(sensor_type, low),
                    "RawValue": fmt(sensor_type, sensor.value),
                    "RawMax": fmt(sensor_type, high),
                    "ImageURL": "images/transparent.png",
                    "Children": [],
                })
        computer["Children"].append(hw_node)

    root["Children"] = [computer]
    return root


# ---------------------------------------------------------------------------
# /metrics.txt — Prometheus exposition, mirroring upstream's lhm_* naming
# ---------------------------------------------------------------------------

UNIT_SUFFIX = {"°C": "_celsius", "%": "_percent", "V": "_volts", "A": "_amperes",
               "W": "_watts", "RPM": "_rpm", "MHz": "_mhz", "GB": "_gb",
               "MB": "_mb", "KB/s": "_kbs"}


def escape(text: str) -> str:
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


def build_metrics() -> str:
    hardware, _ = _current()

    lines: list[str] = []
    declared: set[str] = set()
    host = escape(CONFIG["hostname"])

    for hw in hardware:
        group = re.sub(r"[^a-z0-9]+", "_", hw.hwid.strip("/").split("/")[0].lower())
        for sensor in hw.sensors:
            if sensor.value is None:
                continue
            _, unit = FORMATS.get(sensor.type, ("", ""))
            metric = f"lhm_{group}_{sensor.type.lower()}{UNIT_SUFFIX.get(unit, '')}"
            if metric not in declared:
                lines.append(f"# TYPE {metric} gauge")
                declared.add(metric)
            local_id = sensor.sid[len(hw.hwid):]
            lines.append(
                f'{metric} {{sensorName="{escape(sensor.name)}", '
                f'sensorAlias="{escape(sensor.name)} ({escape(local_id)})", '
                f'hardwareName="{escape(hw.name)}", '
                f'hardwareAlias="{escape(hw.name)}", '
                f'sensorId="{escape(local_id)}", '
                f'hardwareId="{escape(hw.hwid)}", '
                f'host="{host}"}} {sensor.value}')
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# HTML dashboard
# ---------------------------------------------------------------------------

PAGE = """<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lhm-linux &middot; __HOST__</title><style>
:root{--bg:#0e1116;--card:#161b22;--line:#272e38;--fg:#e6edf3;--mut:#8b949e;
--ok:#7ee787;--warn:#e3b341;--crit:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;
gap:14px;align-items:baseline;flex-wrap:wrap}
h1{margin:0;font-size:17px;font-weight:600}.sub{color:var(--mut);font-size:12px}
a{color:var(--ok);text-decoration:none}a:hover{text-decoration:underline}
main{padding:20px 24px;display:grid;gap:16px;
grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;
overflow:hidden}
h2{margin:0;padding:11px 15px;font-size:12px;font-weight:600;
text-transform:uppercase;letter-spacing:.7px;color:var(--mut);
border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse}
td,th{padding:5px 15px;border-bottom:1px solid rgba(255,255,255,.04)}
th{text-align:left;color:var(--mut);font-weight:500;font-size:11px;
text-transform:uppercase}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.ok{color:var(--ok)}.warn{color:var(--warn)}.crit{color:var(--crit)}
.mut{color:var(--mut)}
.grp{padding:6px 15px;font-size:11px;color:var(--mut);
background:rgba(255,255,255,.02);text-transform:uppercase;letter-spacing:.5px}
</style><header><h1>lhm-linux &middot; __HOST__</h1>
<span class="sub" id="ts">loading&hellip;</span>
<span class="sub">&middot; <a href="data.json">data.json</a>
&middot; <a href="metrics.txt">metrics</a></span></header>
<main id="main"></main><script>
// RawValue is a formatted string such as "63,0 °C" — extract the number.
function toNum(s){if(s==null)return null;
 const m=String(s).replace(',','.').match(/-?[\\d.]+/);return m?parseFloat(m[0]):null}
function cls(type,raw){const v=toNum(raw);if(v==null)return'mut';
 if(type=='Temperature')return v>=85?'crit':v>=70?'warn':'ok';
 if(type=='Load'||type=='Control')return v>=90?'warn':'ok';
 return 'ok'}
async function tick(){
 let d;try{d=await(await fetch('data.json',{cache:'no-store'})).json()}
 catch(e){document.getElementById('ts').textContent='connection lost';return}
 const pc=d.Children[0];
 document.getElementById('ts').textContent=
  new Date().toLocaleTimeString()+' \\u00b7 '+pc.Children.length+' components';
 let h='';
 for(const hw of pc.Children){
  h+='<section><h2>'+hw.Text+'</h2><table>';
  for(const t of hw.Children){
   h+='<tr><td class="grp" colspan="4">'+t.Text+'</td></tr>'
    +'<tr><th>Sensor</th><th class="n">Value</th>'
    +'<th class="n">Min</th><th class="n">Max</th></tr>';
   for(const s of t.Children){
    h+='<tr><td>'+s.Text+'</td><td class="n '+cls(s.Type,s.RawValue)+'">'
     +s.Value+'</td><td class="n mut">'+s.Min+'</td>'
     +'<td class="n mut">'+s.Max+'</td></tr>';}}
  h+='</table></section>';}
 document.getElementById('main').innerHTML=h;}
tick();setInterval(tick,2000);
</script></html>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"LibreHardwareMonitor/{LHM_VERSION}"

    def log_message(self, *args) -> None:      # keep the journal quiet
        pass

    def _respond(self, code: int, body: str, content_type: str) -> None:
        payload = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        path = self.path.split("?")[0].rstrip("/") or "/"
        try:
            if path in ("/data.json", "/api/data.json"):
                self._respond(200, json.dumps(build_data_json()),
                              "application/json; charset=utf-8")
            elif path in ("/metrics.txt", "/metrics"):
                self._respond(200, build_metrics(),
                              "text/plain; version=0.0.4; charset=utf-8")
            elif path in ("/", "/index.html"):
                self._respond(200, PAGE.replace("__HOST__", CONFIG["hostname"]),
                              "text/html; charset=utf-8")
            elif path == "/healthz":
                self._respond(200, "ok\n", "text/plain; charset=utf-8")
            else:
                self._respond(404, "not found\n", "text/plain; charset=utf-8")
        except Exception as exc:
            # Report the error class only; never leak a stack trace.
            self._respond(500, f"internal error: {type(exc).__name__}\n",
                          "text/plain; charset=utf-8")

    def do_HEAD(self) -> None:
        self.do_GET()


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="lhm-linux",
        description="LibreHardwareMonitor-compatible sensor server for Linux.")
    parser.add_argument("-p", "--port", type=int,
                        default=int(os.environ.get("LHM_PORT",
                                                   DEFAULT_PORT)),
                        help=f"listen port (default: {DEFAULT_PORT})")
    parser.add_argument("-b", "--bind",
                        default=os.environ.get("LHM_BIND", "0.0.0.0"),
                        help="bind address (default: 0.0.0.0)")
    parser.add_argument("-i", "--interval", type=float,
                        default=float(os.environ.get("LHM_INTERVAL",
                                                     DEFAULT_INTERVAL)),
                        help=f"poll interval in seconds (default: {DEFAULT_INTERVAL})")
    parser.add_argument("--decimal", choices=("comma", "dot"),
                        default=os.environ.get("LHM_DECIMAL", "comma"),
                        help="decimal separator in formatted values "
                             "(default: comma, matching a German-locale LHM host)")
    parser.add_argument("--hostname",
                        default=os.environ.get("LHM_HOSTNAME"),
                        help="name reported as the computer node "
                             "(default: the system hostname)")
    parser.add_argument("--list-sensors", action="store_true",
                        help="print detected sensors and exit")
    parser.add_argument("-V", "--version", action="version",
                        version=f"lhm-linux {__version__}")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    CONFIG["decimal_comma"] = args.decimal == "comma"
    CONFIG["interval"] = args.interval
    CONFIG["hostname"] = (args.hostname or run(["hostname"]).strip()
                          or "linux")

    if args.list_sensors:
        for hw in poll_all():
            print(f"{hw.name}  [{hw.hwid}]")
            for sensor in hw.sensors:
                print(f"    {sensor.sid:<40} {sensor.name:<22} "
                      f"{fmt(sensor.type, sensor.value)}")
        return 0

    missing = [c for c in ("sensors", "nvidia-smi", "ipmitool", "smartctl")
               if not has(c)]
    if missing:
        print(f"note: optional tools not found, related sensors are skipped: "
              f"{', '.join(missing)}", flush=True)
    if os.geteuid() != 0:
        print("note: not running as root — IPMI and SMART sensors are "
              "typically unavailable", flush=True)

    # One thread per source, each on its own cadence.
    stop = threading.Event()
    for source, key, interval in SOURCES:
        threading.Thread(target=poller, args=(stop, source, key, interval),
                         name=f"poll-{key}", daemon=True).start()

    # Wait briefly so the first request already has data. Only the fast
    # sources are awaited — a slow BMC must not delay startup.
    deadline = time.time() + 20
    fast = {key for source, key, interval in SOURCES if interval is None}
    while time.time() < deadline:
        with _lock:
            if any(_results.get(k) for k in fast):
                break
        time.sleep(0.25)

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"lhm-linux {__version__} listening on "
          f"http://{args.bind}:{args.port}/  (data.json, metrics.txt)",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
