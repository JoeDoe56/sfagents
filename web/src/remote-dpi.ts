/**
 * Windows: the scaling ("Make everything bigger") of MoonlightWeb's virtual
 * display, read and set for the device that streams it.
 *
 * Windows keeps one scaling per monitor, and MoonlightWeb's virtual display
 * is one monitor whatever device streams it, so SF Agents keeps each
 * device's choice itself: it applies it when that device starts streaming
 * and reads it back when it stops (so a change made in Windows' own
 * Settings during the stream is kept for that device).
 *
 * This uses the display configuration API's DPI requests (the ones Windows'
 * Settings app uses; they are not in the public headers, so the numbers are
 * spelled out here). It runs in the signed-in user's session, as SF Agents
 * does, through PowerShell.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SfaDpi {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct SRC { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct RAT { public uint n; public uint d; }
  [StructLayout(LayoutKind.Sequential)] public struct TGT { public LUID adapterId; public uint id; public uint modeInfoIdx; public int tech; public int rotation; public int scaling; public RAT refresh; public int scan; public int available; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH { public SRC src; public TGT tgt; public uint flags; }
  [StructLayout(LayoutKind.Sequential, Size = 64)] public struct MODE { public int infoType; public uint id; public LUID adapterId; }
  [StructLayout(LayoutKind.Sequential)] public struct HDR { public int type; public int size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct TNAME {
    public HDR h; public uint flags; public int tech; public ushort mfg; public ushort product; public uint connector;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string friendly;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string path;
  }
  [StructLayout(LayoutKind.Sequential)] public struct DPIGET { public HDR h; public int min; public int cur; public int max; }
  [StructLayout(LayoutKind.Sequential)] public struct DPISET { public HDR h; public int rel; }
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint np, out uint nm);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint np, [Out] PATH[] p, ref uint nm, [Out] MODE[] m, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref TNAME r);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref DPIGET r);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(ref DPISET r);
  static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

  // MoonlightWeb's display: the Virtual Display Driver's monitor (MTT1337), or one named so.
  static PATH? Find() {
    uint np, nm;
    if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return null;
    var paths = new PATH[np]; var modes = new MODE[nm];
    if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return null;
    for (int i = 0; i < np; i++) {
      var t = new TNAME();
      t.h.type = 2; t.h.size = Marshal.SizeOf(typeof(TNAME)); t.h.adapterId = paths[i].tgt.adapterId; t.h.id = paths[i].tgt.id;
      if (DisplayConfigGetDeviceInfo(ref t) != 0) continue;
      string p = (t.path ?? "").ToLowerInvariant(), f = (t.friendly ?? "").ToLowerInvariant();
      if (p.Contains("mtt1337") || f.Contains("moonlightweb") || f.Contains("virtual display")) return paths[i];
    }
    return null;
  }

  public static string Get() {
    var p = Find();
    if (p == null) return "{\"found\":false}";
    var g = new DPIGET();
    g.h.type = -3; g.h.size = Marshal.SizeOf(typeof(DPIGET)); g.h.adapterId = p.Value.src.adapterId; g.h.id = p.Value.src.id;
    if (DisplayConfigGetDeviceInfo(ref g) != 0) return "{\"found\":true,\"error\":\"get\"}";
    int rec = Math.Abs(g.min);
    int idx = Math.Max(0, Math.Min(Steps.Length - 1, rec + g.cur));
    return "{\"found\":true,\"scale\":" + Steps[idx] + ",\"min\":" + Steps[0] + ",\"max\":" + Steps[Math.Min(Steps.Length - 1, rec + g.max)] + ",\"recommended\":" + Steps[Math.Min(Steps.Length - 1, rec)] + "}";
  }

  public static string Set(int percent) {
    var p = Find();
    if (p == null) return "{\"found\":false}";
    var g = new DPIGET();
    g.h.type = -3; g.h.size = Marshal.SizeOf(typeof(DPIGET)); g.h.adapterId = p.Value.src.adapterId; g.h.id = p.Value.src.id;
    if (DisplayConfigGetDeviceInfo(ref g) != 0) return "{\"found\":true,\"error\":\"get\"}";
    int want = Array.IndexOf(Steps, percent);
    if (want < 0) return "{\"found\":true,\"error\":\"value\"}";
    int rel = Math.Max(g.min, Math.Min(g.max, want - Math.Abs(g.min)));
    var s = new DPISET();
    s.h.type = -4; s.h.size = Marshal.SizeOf(typeof(DPISET)); s.h.adapterId = p.Value.src.adapterId; s.h.id = p.Value.src.id; s.rel = rel;
    if (DisplayConfigSetDeviceInfo(ref s) != 0) return "{\"found\":true,\"error\":\"set\"}";
    return Get();
  }
}
'@
`;

export interface DisplayScale {
  found: boolean;
  scale?: number;
  min?: number;
  max?: number;
  recommended?: number;
  error?: string;
}

function powershell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `PowerShell exited with ${code}`))));
    child.stdin.end(`${SCRIPT}\n${command}\n`);
  });
}

function parse(text: string): DisplayScale {
  const line = text.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  return line ? (JSON.parse(line) as DisplayScale) : { found: false, error: 'no answer' };
}

/** The virtual display's scaling now (Windows only; {found: false} elsewhere or when it is off). */
export async function getDisplayScale(): Promise<DisplayScale> {
  if (process.platform !== 'win32') return { found: false };
  return parse(await powershell('[SfaDpi]::Get()'));
}

/** Sets the virtual display's scaling, in percent. */
export async function setDisplayScale(percent: number): Promise<DisplayScale> {
  if (process.platform !== 'win32') return { found: false };
  if (!Number.isInteger(percent)) throw new Error('The scaling must be a whole percentage.');
  return parse(await powershell(`[SfaDpi]::Set(${percent})`));
}
