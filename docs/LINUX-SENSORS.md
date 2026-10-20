# Built-in Linux hardware monitoring

On Linux, SF Agents starts its bundled LibreHardwareMonitor-Linux adapter when
the resource monitor first requests a reading. Its collectors and a private
CPython runtime ship with the web package. No Python installation, pip packages,
separate LHM server, systemd service or open sensor port is needed. The adapter
closes with SF Agents, including any in-flight sensor commands, and receives
no agent API keys. It runs at SF Agents' ordinary privilege level; it never
invokes sudo or requests elevation.

The backend is Insight-IT GmbH's independent MIT-licensed implementation,
version 1.2.0 at commit `d6646e75f617d61527911a7d446dc0cfce8b6932`:
https://github.com/insight-it-gmbh/LibreHardwareMonitor-Linux

Unmodified source, license, upstream protocol tests and a SHA-256 manifest
are in `web/native/linux/vendor/`. SF Agents' own `adapter.py` imports the
collectors and communicates over stdin/stdout, without starting their HTTP
server or installer.

## Sensor coverage and permissions

| Source | Readings | Availability |
| --- | --- | --- |
| `/proc` and `/sys` | Memory, actual CPU utilization, process count, physical cores, disk/network rates, CPU and AMD GPU sensors | Native readers remain enabled |
| `nvidia-smi` | NVIDIA GPU load, temperature, VRAM, power and clocks | Optional NVIDIA driver utility |
| `sensors -j` | CPU package and per-core temperatures | Optional lm-sensors package |
| `ipmitool` | BMC temperatures, fans, voltages and DCMI system power | Optional tool, compatible BMC and device permissions |
| `smartctl` | Drive temperatures | Optional smartmontools package and device permissions |

Tools are discovered on PATH and are not automatically installed. Missing
tools produce a diagnostic hint; missing sensors remain unavailable. A
desktop without a BMC generally cannot supply a whole-system power reading.
The Processes cell uses BMC `System Total` when no PSU total is present; it
does not add averages, CPU/GPU package watts or an overlapping PSU total.

Fast collectors refresh every two seconds, BMC readings every 30 seconds,
and SMART every five minutes. Slow commands run independently. The monitor
still uses native CPU utilization, rather than the upstream load-average
approximation, and keeps native disk/network and AMD GPU support.

`--lhm <url>` / `SFAGENTS_LHM_URL` selects an external LHM-compatible server;
`--lhm off` disables the bundled adapter and uses native readers alone.
Helper errors also fall back to native readings with a diagnostic hint.
`--sensor-admin` is Windows-only and does not elevate Linux processes.

## Build and distribution

`npm install` / `npm run build` automatically prepare the Linux runtime on
Linux x64 or ARM64 with glibc. The first build needs network access. The
build script downloads CPython 3.12.15 from the pinned 20261013 release of
Astral's python-build-standalone project and verifies a hard-coded SHA-256
checksum for each architecture. No global runtime is installed. Later builds
reuse the prepared runtime.

The generated runtime is in `web/native/bin/linux-<architecture>/`, ignored
by Git and included in the web npm package. Build on the target platform and
architecture before packaging, just as with the Windows adapter. Python's
versioned executable is used directly because npm omits symbolic links.
The distribution retains Python's license and third-party notices under its
`python/` directory, plus this project's backend notices. Alpine/musl and
other architectures are not supported by this bundled runtime. macOS keeps
its existing native readers.
