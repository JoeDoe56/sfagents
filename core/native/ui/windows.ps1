$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SfaWindow {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mouse; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] input, int size);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    var inputs = new INPUT[] { new INPUT { mouse = new MOUSEINPUT { flags = 2 } }, new INPUT { mouse = new MOUSEINPUT { flags = 4 } } };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("SendInput was refused.");
  }
  public static string QuoteArgument(string value) {
    var b = new System.Text.StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '\"') b.Append('\\', slashes * 2 + 1).Append(c);
      else b.Append('\\', slashes).Append(c);
      slashes = 0;
    }
    return b.Append('\\', slashes * 2).Append('\"').ToString();
  }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[SfaWindow]::SetProcessDPIAware() | Out-Null
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$trueCondition = [System.Windows.Automation.Condition]::TrueCondition

function Windows {
  $out = @()
  $all = $AE::RootElement.FindAll($TS::Children, $trueCondition)
  foreach ($w in $all) {
    try {
      if ($w.Current.IsOffscreen -or -not $w.Current.Name) { continue }
      $proc = Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue
      $out += @{ element=$w; id=[string]$w.Current.NativeWindowHandle; name=$proc.ProcessName; title=$w.Current.Name; process=$w.Current.ProcessId }
    } catch { }
  }
  return $out
}
function Find-Window($name) {
  $found = @(Windows | Where-Object { $_.id -eq $name -or $_.name -eq $name -or $_.title -eq $name })
  if ($found.Count -ne 1) { throw 'Choose one window id from sfa-ui apps (name absent or ambiguous).' }
  return $found[0].element
}
function Controls($window) {
  $out = [System.Collections.Generic.List[object]]::new()
  $queue = [System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
  $queue.Enqueue($window)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt 2500 -and $out.Count -lt 150) {
    $a = $queue.Dequeue(); $visited++
    try {
      $c = $a.Current
      if (-not $c.IsOffscreen -and $c.IsEnabled) {
        $actions = @()
        $patterns = @($a.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
        $legacy = $null
        if ($patterns -contains 'LegacyIAccessiblePatternIdentifiers.Pattern') { $legacy = $a.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).Current }
        if ($patterns -contains 'InvokePatternIdentifiers.Pattern') { $actions += 'invoke' }
        if ($patterns -contains 'ValuePatternIdentifiers.Pattern') { $actions += 'set_value' }
        if ($patterns -contains 'TogglePatternIdentifiers.Pattern') { $actions += 'toggle' }
        if ($patterns -contains 'ExpandCollapsePatternIdentifiers.Pattern') { $actions += 'expand' }
        if ($patterns -contains 'SelectionItemPatternIdentifiers.Pattern') { $actions += 'select' }
        if ($patterns -contains 'ScrollPatternIdentifiers.Pattern') { $actions += 'scroll' }
        if ($legacy) {
          if ($legacy.DefaultAction -and $actions -notcontains 'invoke') { $actions += 'invoke' }
          if ($legacy.Role -in @(42,46) -and ($legacy.State -band 64) -eq 0 -and $actions -notcontains 'set_value') { $actions += 'set_value' }
          if ($legacy.Role -eq 44 -and $actions -notcontains 'toggle') { $actions += 'toggle' }
        }
        $controlName = if ($c.Name) { $c.Name } elseif ($legacy) { $legacy.Name } else { '' }
        $controlRole = if ($legacy -and $c.ControlType -eq [System.Windows.Automation.ControlType]::Pane) { ([System.Windows.Forms.AccessibleRole]$legacy.Role).ToString() } else { $c.ControlType.ProgrammaticName.Replace('ControlType.','') }
        if ($actions.Count -gt 0 -or $controlName) {
          $r = $c.BoundingRectangle
          $parents = @(); $parent = $walker.GetParent($a)
          for ($i = 0; $i -lt 4 -and $parent; $i++) { if ($parent.Current.Name) { $parents = @($parent.Current.Name) + $parents }; $parent = $walker.GetParent($parent) }
          $item = @{ context=($parents -join ' > '); id=($a.GetRuntimeId() -join '.'); name=$controlName; role=$controlRole; password=($c.IsPassword -or ($legacy -and ($legacy.State -band 536870912) -ne 0)); actions=@($actions); bounds=@($r.X,$r.Y,$r.Width,$r.Height) }
          if (-not $item.password -and $actions -contains 'set_value') {
            $v = if ($patterns -contains 'ValuePatternIdentifiers.Pattern') { $a.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } else { [string]$legacy.Value }
            $item.value = if ($v.Length -gt 1000) { $v.Substring(0,1000) } else { $v }
          }
          $out.Add(@{data=$item; element=$a})
        }
      }
      $child = $walker.GetFirstChild($a)
      while ($child) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    } catch { }
  }
  return $out
}
function Screenshot($w) {
  $r = $w.Current.BoundingRectangle
  if ($r.Width -lt 1 -or $r.Height -lt 1) { throw 'The window has no visible bounds.' }
  $bitmap = [System.Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $dc = $g.GetHdc()
  try { $ok = [SfaWindow]::PrintWindow([IntPtr]$w.Current.NativeWindowHandle,$dc,2) }
  finally { $g.ReleaseHdc($dc) }
  if (-not $ok) { $g.Dispose(); $bitmap.Dispose(); throw 'This window cannot be captured with PrintWindow.' }
  $stream = [System.IO.MemoryStream]::new()
  try {
    $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
    return @{ mime='image/png'; data=[Convert]::ToBase64String($stream.ToArray()) }
  } finally { $stream.Dispose(); $g.Dispose(); $bitmap.Dispose() }
}
try {
  $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
  switch ($p.op) {
    'apps' { $result = @{ apps=@(Windows | ForEach-Object { @{id=$_.id; name=$_.name; title=$_.title; process=$_.process} }) } }
    'open' {
      $si = [System.Diagnostics.ProcessStartInfo]::new()
      $si.FileName = [string]$p.app; $si.UseShellExecute = $true
      $arguments = @($p.args | ForEach-Object { [SfaWindow]::QuoteArgument([string]$_) })
      if ($p.app -match '(?i)(electron|chrome|chromium|code)(\.exe)?$') { $arguments += '--force-renderer-accessibility' }
      $si.Arguments = $arguments -join ' '
      [System.Diagnostics.Process]::Start($si) | Out-Null
      $result = @{text='Opened. Run sfa-ui --host apps for its window id.'}
    }
    default {
      $w = Find-Window ([string]$p.app)
      switch ($p.op) {
        'tree' { $result = @{ controls=@(Controls $w | ForEach-Object { $_.data }) } }
        'screenshot' { $result = @{ image=(Screenshot $w) } }
        'act' {
          $found = @(Controls $w | Where-Object { $_.data.id -eq $p.id })
          if ($found.Count -ne 1) { throw 'Control changed. Read the tree again.' }
          if ($found[0].data.name -cne $p.expectedName -or $found[0].data.role -cne $p.expectedRole -or [bool]$found[0].data.password -ne [bool]$p.expectedPassword -or $found[0].data.context -cne $p.expectedContext) { throw 'Control changed after approval. Read the tree again.' }
          $a = $found[0].element
          if ($found[0].data.actions -notcontains $p.action) { throw 'Action not supported by this control.' }
          switch ($p.action) {
            'invoke' { $pattern = $null; if ($a.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() } else { $a.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).DoDefaultAction() } }
            'set_value' { $pattern = $null; if ($a.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $pattern.SetValue([string]$p.value) } else { $a.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).SetValue([string]$p.value) } }
            'toggle' { $pattern = $null; if ($a.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle() } else { $a.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).DoDefaultAction() } }
            'expand' {
              $pattern = $a.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
              if ($pattern.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $pattern.Collapse() } else { $pattern.Expand() }
            }
            'select' { $a.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
            'scroll' { $a.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Scroll([System.Windows.Automation.ScrollAmount]::NoAmount,[System.Windows.Automation.ScrollAmount]::LargeIncrement) }
          }
          $result = @{text='Action completed.'}
        }
        'click' {
          $r = $w.Current.BoundingRectangle
          if ($p.x -lt 0 -or $p.y -lt 0 -or $p.x -ge $r.Width -or $p.y -ge $r.Height) { throw 'Coordinates outside this window.' }
          [SfaWindow]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null
          [SfaWindow]::Click([int]($r.X+$p.x),[int]($r.Y+$p.y))
          $result = @{text='Clicked using the coordinate fallback.'}
        }
        default { throw 'Unknown UI operation.' }
      }
    }
  }
  $result | ConvertTo-Json -Depth 12 -Compress
} catch {
  @{error=$_.Exception.Message} | ConvertTo-Json -Compress
  exit 1
}
