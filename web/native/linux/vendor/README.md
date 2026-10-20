# LibreHardwareMonitor-Linux

**Read Linux hardware sensors with LibreHardwareMonitor clients.**

[![CI](https://github.com/insight-it-gmbh/LibreHardwareMonitor-Linux/actions/workflows/ci.yml/badge.svg)](https://github.com/insight-it-gmbh/LibreHardwareMonitor-Linux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/Python-3.9%2B-blue.svg)](https://www.python.org/)
[![Dependencies: none](https://img.shields.io/badge/Dependencies-none-brightgreen.svg)](#)
[![Made by Insight-IT GmbH](https://img.shields.io/badge/Made%20by-Insight--IT%20GmbH-9DCD5A.svg)](https://www.insight-it.de)

> Built at **[Insight-IT GmbH](https://www.insight-it.de)** in Berlin, where we run a
> GPU cluster for **sovereign, self-hosted AI** — and needed a way to watch it from the
> same panels everyone already uses. *We run your AI.*

The [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) (LHM)
application runs only on Windows — it depends on a Ring-0 kernel driver and WMI. But a whole ecosystem of clients
speaks its simple HTTP/JSON protocol: Elgato Stream Deck plugins, yasb, Home Assistant,
Grafana dashboards, and more.

This project does not port the application. It re-implements the **protocol** on top of native
Linux sensor sources, so any existing LHM client can read a Linux machine exactly as if it were
a Windows PC. Point the client at the host and port — nothing else changes.

```
┌─────────────────┐   HTTP GET /data.json   ┌──────────────────────────────┐
│  LHM client     │ ──────────────────────► │  lhm-linux (Linux host)      │
│  Stream Deck    │                         │                              │
│  Grafana        │ ◄────────────────────── │  nvidia-smi · lm-sensors     │
│  Home Assistant │   LHM-compatible JSON   │  ipmitool  · smartctl · proc │
└─────────────────┘                         └──────────────────────────────┘
```

- **Zero dependencies** — Python 3.9+ standard library only. No pip install, no venv.
- **Byte-compatible output** — verified field by field against a live LHM 0.9.x instance.
- **Servers included** — reads BMC/IPMI board temperatures, fans, voltages and PSU wattage,
  not just CPU and GPU.
- **Prometheus built in** — `/metrics.txt` with the same `lhm_*` metric names as upstream.
- Lightweight: ~25 MB RSS and well under 1 % CPU.

## Why this exists

Monitoring a Windows PC from a Stream Deck is a solved problem. Doing the same for the Linux
box in the rack is not — the clients only speak LHM. Rather than writing a
new client for every panel, this server makes the Linux box speak the protocol the panels
already understand.

## Quick start

```bash
git clone https://github.com/insight-it-gmbh/LibreHardwareMonitor-Linux.git
cd LibreHardwareMonitor-Linux
sudo python3 lhmlinux/server.py
```

Then open `http://<host>:8085/` in a browser, or point your LHM client at that address.

Port 8085 is LHM's default, so most clients need only the hostname.

Check what is detected without starting a server:

```bash
sudo python3 lhmlinux/server.py --list-sensors
```

### Install as a service

```bash
sudo ./install.sh          # installs to /opt/lhm-linux + enables systemd unit
systemctl status lhm-linux
```

Uninstall with `sudo ./install.sh --uninstall`.

## Why root?

| Source | Provides | Root required |
|---|---|---|
| `nvidia-smi` | GPU temperature, load, VRAM, power, clocks, fan | no |
| `sensors` (lm-sensors) | CPU package and per-core temperatures | no |
| `/proc` | Memory usage, load average | no |
| `ipmitool` | Board/DIMM/VRM temperatures, fans, voltages, PSU watts | **yes** (`/dev/ipmi0`) |
| `smartctl` | Disk temperatures | **yes** (ATA passthrough) |

Without root you still get GPU, CPU and memory readings; IPMI and SMART sensors are skipped
with a note on startup. Every source is optional — a desktop without a BMC simply reports no
mainboard node.

Install whichever tools you want to use:

```bash
# Debian/Ubuntu
sudo apt install lm-sensors ipmitool smartmontools
# Fedora/RHEL
sudo dnf install lm_sensors ipmitool smartmontools
```

## Client setup

Any client that talks to LibreHardwareMonitor's web server works. Replace
`http://localhost:8085` with `http://<linux-host>:8085`.

| Client | Where to set it |
|---|---|
| Stream Deck "System Vitals" | Plugin settings → *Libre Webserver* URL |
| yasb `libre_monitor` widget | `libre_monitor_url` in the widget config |
| Home Assistant | *LibreHardwareMonitor* integration → host + port |
| Prometheus | Scrape `http://<host>:8085/metrics.txt` |
| Grafana | Add the Prometheus scrape above as a data source, then query `lhm_*` |

Sensor IDs follow upstream conventions, so existing client configs keep working:

```
/gpu-nvidia/0/temperature/0     first NVIDIA GPU, core temperature
/intelcpu/0/temperature/1       first CPU socket, core 1
/lpc/bmc/fan/2                  third BMC fan
/hdd/0/temperature/0            first disk
/ram/load/0                     memory utilisation
```

## Endpoints

| Path | Content |
|---|---|
| `/` | HTML dashboard, auto-refreshing |
| `/data.json` | LHM-compatible sensor tree |
| `/metrics.txt` (`/metrics`) | Prometheus exposition |
| `/healthz` | `ok` — liveness probe |

## Configuration

Every option has a CLI flag and an environment variable.

| Flag | Environment variable | Default | Meaning |
|---|---|---|---|
| `-p, --port` | `LHM_PORT` | `8085` | Listen port |
| `-b, --bind` | `LHM_BIND` | `0.0.0.0` | Bind address |
| `-i, --interval` | `LHM_INTERVAL` | `2.0` | Poll interval for fast sensors, in seconds |
| `--decimal` | `LHM_DECIMAL` | `comma` | `comma` or `dot` (see below) |
| `--hostname` | `LHM_HOSTNAME` | system hostname | Name of the computer node |
| `--list-sensors` | — | — | Print detected sensors and exit |
| `-V, --version` | — | — | Print the version and exit |

For the systemd unit, edit the `Environment=` lines in
`/etc/systemd/system/lhm-linux.service`, then
`systemctl daemon-reload && systemctl restart lhm-linux`.

### Polling cadence

Sources are polled in separate threads at different rates, because they differ wildly
in cost:

| Source | Interval | Why |
|---|---|---|
| CPU, GPU, memory | `--interval` (2 s) | Cheap: a few milliseconds per read |
| BMC / IPMI | 30 s | `ipmitool sdr` can take 5-13 seconds to answer |
| Disks (SMART) | 300 s | Expensive, and can spin up sleeping disks |

This matters more than it sounds. With a single shared loop, one slow BMC drags the
whole cycle out to its own speed, and CPU and GPU readings update far slower than
configured — on a hardware panel that looks like a frozen display.

### Decimal separator

LibreHardwareMonitor formats values using the Windows locale, so a German host emits
`"63,0 °C"` and an English host `"63.0 °C"`. Clients parse that string. The default here is a
comma; switch with `--decimal dot` if your client expects a point.

## Protocol notes

These cost real debugging time and are documented nowhere upstream. If you write your own
LHM-compatible server, save yourself the trouble:

1. **`RawMin` / `RawValue` / `RawMax` are formatted strings, not numbers.**
   Upstream emits `"RawValue": "1,288 V"`, not `"RawValue": 1.288`, despite the `Raw` prefix.
2. **The decimal separator comes from the host locale.** See above.
3. **The `Load` group node is singular.** Every other label is plural — `Temperatures`,
   `Fans`, `Powers`, `Voltages`, `Clocks`, `Controls` — but it is `Load`, not `Loads`.
4. **`Data` and `SmallData` share one node** labelled `Data`.
5. **`id` is a pre-order counter across the whole tree**, starting at `0` on the root.
6. **Leaf nodes still carry `"Children": []`.** Some clients break on `undefined`.
7. Sensors without a reading render as `"-"`; upstream also emits `"NaN %"` in some cases.
8. Responses set `Access-Control-Allow-Origin: *` and `Cache-Control: no-cache`.

The tree shape is:

```
root (Text: "Sensor", Version)
└── computer (Text: hostname)
    └── hardware (HardwareId: "/gpu-nvidia/0")
        └── type group (Text: "Temperatures")
            └── sensor (SensorId, Type, Value, Min, Max, Raw*)
```

## Platform notes

Two environments need a second look before you install.

**Virtual machines report almost nothing.** In a VM there is no BMC (`/dev/ipmi0` is
absent), `/sys/class/hwmon` is empty and there are no physical disks, so CPU
temperatures, fans, voltages and SMART all disappear — those readings stay with the
hypervisor. `sensors` printing *"No sensors found!"* is expected here, not a fault worth
debugging. A passed-through GPU still reports fully, as do memory and load. Check what
you will get before installing:

```bash
ls /sys/class/hwmon | wc -l    # 0 = no hardware sensors in this guest
ls /dev/ipmi* 2>/dev/null      # missing = no BMC
```

**Appliances with a read-only root** (TrueNAS SCALE, and other ZFS-on-root systems)
reject `/opt`. Install to a writable data pool instead:

```bash
sudo ./install.sh --prefix /mnt/pool/lhm-linux
```

On TrueNAS the unit in `/etc/systemd/system` also does not survive a system update,
because the boot pool is replaced wholesale. Register a small restore script as a
POSTINIT init script so the service comes back on its own.

## Compatibility

Tested on Ubuntu 24.04 and 26.04 (Python 3.12 / 3.14), Debian 12 on TrueNAS SCALE, and
inside a Hyper-V guest — against NVIDIA GPUs, Intel CPUs, a Supermicro BMC and SATA/SAS
disks, and validated field by field against LibreHardwareMonitor 0.9.4 on Windows 11.
It should work on any Linux with Python 3.9 or newer; the sensor tooling is
distribution-independent.

## Security

The server serves **read-only** sensor data and has **no authentication**, matching
LibreHardwareMonitor's own web server. Bind it to a trusted network. Do not expose it to the
internet — put it behind a reverse proxy with authentication, or restrict it with
`--bind 127.0.0.1` plus an SSH tunnel.

## Contributing

Issues and pull requests are welcome. Useful additions: AMD GPU support via `amdgpu` hwmon,
Nouveau, network throughput sensors, and reports from clients not yet listed above.

Please keep the zero-dependency, standard-library-only constraint.

## About the authors

<a href="https://www.insight-it.de">
  <img src=".assets/brand.png" alt="Insight-IT GmbH — IT-Systemhaus Berlin" height="60">
</a>

**[Insight-IT GmbH](https://www.insight-it.de)** is an IT service provider in Berlin,
Germany. Since 2002 we have been running IT infrastructure for companies of any
size — from small and mid-sized businesses to enterprises and public-sector clients.

Today we also run **sovereign AI**: large language models, speech and document AI on our
**own GPU cluster**, hosted in Germany. EU AI Act compliant, with auditable data handling.

That is where this tool comes from. Operating a GPU cluster means watching thermals,
power draw and VRAM continuously — but the panels we wanted to use read their data from
LibreHardwareMonitor, and the LibreHardwareMonitor application runs only on Windows. So we taught Linux
to speak that protocol, and released the result under the MIT license.

Built and maintained by **[Dominic Ballenthin](https://github.com/subbie5000)**.

*We run your AI.* → **[insight-it.de](https://www.insight-it.de)**

[![Website](https://img.shields.io/badge/Website-insight--it.de-9DCD5A?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://www.insight-it.de)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Insight--IT-0A66C2?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/insight-it-gmbh/)
[![Facebook](https://img.shields.io/badge/Facebook-Insight--IT-1877F2?style=flat-square&logo=facebook&logoColor=white)](https://www.facebook.com/insightitberlin/)
[![GitHub](https://img.shields.io/badge/GitHub-insight--it--gmbh-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/insight-it-gmbh)

## License

MIT — see [LICENSE](LICENSE).

Copyright © 2026 Insight-IT GmbH, Berlin — Dominic Ballenthin.

LibreHardwareMonitor-Linux is an independent, clean-room implementation of the
LibreHardwareMonitor JSON endpoint. It contains no upstream code. LibreHardwareMonitor
itself is licensed under the MPL-2.0 and is not affiliated with this project.
