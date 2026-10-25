# MoonlightWeb — installs (or removes) "MoonlightWeb Virtual HID" on a TEST machine.
# Copyright (C) 2026 Bruno Martin. GPLv3.
#
# For the bench, until the product installer does it (plan P2): run elevated, from the package
# folder build.ps1 made (or give -Package). The driver is test-signed, so the machine must be in
# test mode first (bcdedit /set testsigning on, then a reboot) — this script checks, never sets it.
#
#   .\install.ps1                 trust the test certificate, add the root device, install the driver
#   .\install.ps1 -Uninstall      remove the device and the driver package (the certificate stays)
#
# What it changes: the test certificate in LocalMachine Root and TrustedPublisher, one
# root-enumerated System device ROOT\MoonlightWebVHid, the driver package in the driver store.

param(
    [string]$Package = (Join-Path $PSScriptRoot 'build\package'),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$hwid = 'Root\MoonlightWebVHid'
$inf = Join-Path $Package 'MoonlightWebVHid.inf'
$cer = Join-Path $Package 'MoonlightWebVHid-test.cer'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'run elevated'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MwDevice {
    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVINFO_DATA { public uint cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid classGuid, IntPtr hwnd);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string name, ref Guid classGuid, string desc, IntPtr hwnd, uint flags, ref SP_DEVINFO_DATA data);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data, uint property, byte[] buffer, uint size);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiCallClassInstaller(uint function, IntPtr set, ref SP_DEVINFO_DATA data);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr hwnd, string hwid, string inf, uint flags, out bool reboot);

    const uint DICD_GENERATE_ID = 1, SPDRP_HARDWAREID = 1, DIF_REGISTERDEVICE = 0x19, INSTALLFLAG_FORCE = 1;

    // A root-enumerated System device with this hardware id, as devcon install makes it.
    public static void CreateRootDevice(string hwid) {
        Guid system = new Guid("4d36e97d-e325-11ce-bfc1-08002be10318");
        IntPtr set = SetupDiCreateDeviceInfoList(ref system, IntPtr.Zero);
        if (set == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        try {
            SP_DEVINFO_DATA d = new SP_DEVINFO_DATA();
            d.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
            if (!SetupDiCreateDeviceInfoW(set, "System", ref system, null, IntPtr.Zero, DICD_GENERATE_ID, ref d))
                throw new System.ComponentModel.Win32Exception();
            byte[] multi = System.Text.Encoding.Unicode.GetBytes(hwid + "\0\0");
            if (!SetupDiSetDeviceRegistryPropertyW(set, ref d, SPDRP_HARDWAREID, multi, (uint)multi.Length))
                throw new System.ComponentModel.Win32Exception();
            if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, ref d))
                throw new System.ComponentModel.Win32Exception();
        } finally { SetupDiDestroyDeviceInfoList(set); }
    }

    public static bool InstallDriver(string hwid, string inf) {
        bool reboot;
        if (!UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, hwid, inf, INSTALLFLAG_FORCE, out reboot))
            throw new System.ComponentModel.Win32Exception();
        return reboot;
    }
}
'@

function OurDevices {
    # No class filter: a node made by an earlier run that never got its driver has no class yet.
    Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains $hwid }
}

if ($Uninstall) {
    foreach ($d in OurDevices) {
        Write-Host "removing $($d.InstanceId)"
        & pnputil.exe /remove-device $d.InstanceId | Out-Host
    }
    $published = (& pnputil.exe /enum-drivers) -join "`n"
    foreach ($m in [regex]::Matches($published, '(?ms)Published Name:\s+(oem\d+\.inf)\s+Original Name:\s+moonlightwebvhid\.inf')) {
        Write-Host "deleting $($m.Groups[1].Value)"
        & pnputil.exe /delete-driver $m.Groups[1].Value /uninstall /force | Out-Host
    }
    return
}

if (-not (Test-Path $inf)) { throw "no package at $Package (run build.ps1)" }
$bcd = (& bcdedit.exe /enum '{current}') -join "`n"
if ($bcd -notmatch '(?m)^testsigning\s+Yes') {
    throw 'this machine is not in test mode: bcdedit /set testsigning on, then reboot (with the owner''s go)'
}

Write-Host '== test certificate -> LocalMachine Root and TrustedPublisher'
foreach ($store in 'Root', 'TrustedPublisher') {
    Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
}

if (-not (OurDevices)) {
    Write-Host "== root device $hwid"
    [MwDevice]::CreateRootDevice($hwid)
}
Write-Host '== driver'
$reboot = [MwDevice]::InstallDriver($hwid, (Resolve-Path $inf).Path)
OurDevices | Format-Table Status, FriendlyName, InstanceId -AutoSize
if ($reboot) { Write-Host 'Windows asks for a reboot to finish.' }
