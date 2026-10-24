# Built-in Windows hardware monitoring

On Windows, SF Agents starts its bundled LibreHardwareMonitor library adapter
when the resource monitor first requests a reading. No LibreHardwareMonitor
desktop app or web server is needed. The adapter includes its .NET runtime.
It reads sensors only, and cannot change fans, execute commands or serve HTTP.
It closes when SF Agents closes. The agent's API keys are not passed to it.

Linux uses its own [bundled Linux backend](LINUX-SENSORS.md), supplemented by
native readers. macOS continues using `vm_stat`, `netstat`, `ioreg` and the
other native readers. Neither platform downloads or starts the Windows adapter.

The Processes cell counts all operating-system processes. Its smaller wattage
line uses a PSU-reported whole-system reading when available (preferring input
power, otherwise the reported total/output). Hover text identifies the power
reading. CPU/GPU package wattage is never substituted for a system total. A
power supply without readable telemetry shows `— W`.

## Build and distribution

`npm install` / `npm run build` publish the Windows adapter automatically on
Windows. The first build needs network access for official NuGet packages
and, if necessary, a local Microsoft .NET 10 SDK in `.tools/dotnet`. The SDK
archive is checked against Microsoft's SHA-512 release metadata; nothing
is installed globally. Later builds reuse unchanged output. The build is
skipped on Linux and macOS. Windows x64 and ARM64 outputs are selected by
the Node architecture; only x64 was tested on the development machine.

If preparing the sensors fails (offline, a proxy, an unsupported system), the
build prints a warning and carries on: the resource monitor then uses the
operating system's readings, and `npm run build:sensors` tries again. Set
`SFAGENTS_REQUIRE_SENSORS=1` when packaging so a failure stops the build.

The output is `web/native/bin/win-<architecture>/`. It is ignored by Git but
included in the web npm package, together with adapter source and license
notices. Build on the target Windows architecture before packaging. Publish
includes the .NET runtime, so users need no separate .NET installation.

## Hardware access

Ordinary-user mode reads the sensors Windows exposes. CPU temperatures and
some storage counters need the signed PawnIO driver and administrator access.
`sfagents web` installs PawnIO at its first start, silently, from the
official, pinned, checksum-verified installer, in the same administrator
approval as Remote Desktop's MoonlightWeb (`npm run sensors:setup` does the
same by hand). Opening the monitor never installs anything.

The `sensors.admin` setting (on by default on Windows; `--sensor-admin` for
one run) requests elevation for the sensor worker only. SF Agents, model tools, and its web server stay at their normal
privilege level. The broker uses a local named pipe restricted to the same
Windows account; closing the broker closes the elevated worker too.
Rejecting the prompt or a helper failure falls back to OS readings, with
a diagnostic hint on the monitor. Missing readings remain unavailable.

`--lhm <url>` still selects an explicit external LHM web server, including
its existing authentication support. `--lhm off` disables LHM and reads only
the OS. These overrides take precedence over the embedded adapter.
