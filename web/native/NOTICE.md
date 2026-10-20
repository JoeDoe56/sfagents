# Bundled hardware sensors

## Windows

SF Agents includes the unmodified LibreHardwareMonitorLib 0.9.6 NuGet package
and its dependencies in the Windows sensor adapter. LibreHardwareMonitorLib
is licensed under MPL-2.0. The complete corresponding upstream source is at:

https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/tree/3d331e3370efb858411f19511373eff65a218701

The MPL-2.0 text is in `licenses/LibreHardwareMonitor-MPL-2.0.txt`.
The generated adapter's `licenses/` directory also includes NuGet metadata
and the license/notice files supplied by its dependencies and .NET runtime.
Those components retain their respective upstream licenses. NuGet metadata
identifies their versions, authors, licenses and source repositories.

The read-only adapter source (`windows/Program.cs`) is SF Agents code under
this repository's Apache-2.0 license. It does not modify the LHM library.

PawnIO is an optional, separately installed signed Windows driver, published
at https://github.com/namazso/PawnIO.Setup. It is not bundled or silently
installed. FanControl settings and drivers are not changed by this adapter.

## Linux

The Linux resource monitor includes the unmodified LibreHardwareMonitor-Linux
1.2.0 collectors and protocol tests, Copyright 2026 Insight-IT GmbH, Berlin —
Dominic Ballenthin, under the MIT License. The corresponding source is pinned at:

https://github.com/insight-it-gmbh/LibreHardwareMonitor-Linux/tree/d6646e75f617d61527911a7d446dc0cfce8b6932

Source, license and a hash manifest are in `linux/vendor/`. The stdio adapter
(`linux/adapter.py`) is SF Agents code under Apache-2.0. It does not modify
the upstream collectors or start the upstream HTTP service.

Linux builds include CPython 3.12.15 from python-build-standalone release
20261013, published by Astral at:
https://github.com/astral-sh/python-build-standalone/releases/tag/20261013

The runtime's original Python and third-party licenses/notices are retained
in its `python/` distribution. Runtime downloads are SHA-256 verified against
the architecture-specific hashes pinned in `scripts/build-linux-sensors.mjs`.
