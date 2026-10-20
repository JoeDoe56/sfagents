# Bundled Windows sensors

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
