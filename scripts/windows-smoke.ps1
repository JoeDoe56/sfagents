# SF Agents Windows smoke test.
# Run from the repository root in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\windows-smoke.ps1
# Optional: set $env:OPENROUTER_API_KEY first to include the live tests.

$ErrorActionPreference = 'Stop'
$failures = @()

function Step($name, [scriptblock]$block) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $name (exit $LASTEXITCODE)" -ForegroundColor Red
    $script:failures += $name
  } else {
    Write-Host "OK: $name" -ForegroundColor Green
  }
}

Step 'Node version (needs >= 20.12)' { node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)"; node --version }
Step 'Clean install and build (npm ci)' { npm ci }
Step 'Deterministic tests' { npm test }
Step 'Import and dependency audit' { npm run audit:imports }
Step 'CLI: version' { npx sfagents --version }
Step 'CLI: agents validate' { npx sfagents agents validate }
Step 'CLI: mcp list' { npx sfagents mcp list }

# Persistent conversation smoke checks in a temporary project (no model calls).
$tmp = Join-Path $env:TEMP ("sfagents-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
Set-Content -Path (Join-Path $tmp 'agent.json') -Value '{ "id": "main", "provider": "openrouter", "model": "test/model", "systemPrompt": "smoke" }'
Step 'Conversation: info on a missing conversation reports it' { npx sfagents conversation info --config $tmp; if ($LASTEXITCODE -eq 1) { $global:LASTEXITCODE = 0 } }
Step 'Conversation: unlock with no lock' { npx sfagents conversation unlock --config $tmp }
Remove-Item -Recurse -Force $tmp

Write-Host "`nManual check (web): run 'npx sfagents web', open http://127.0.0.1:8093, send a message, attach a file with +, pull the handle up to the full sheet, then press Ctrl+C in the console (it should print 'Stopping...' and exit)." -ForegroundColor Yellow
Write-Host "`nManual check (needs a real console): run 'npx sfagents start', ask for a long shell command such as 'ping -n 30 127.0.0.1', approve it, press Ctrl+C once (the turn is cancelled and the prompt returns), then /exit and run 'npx sfagents conversation info' (lock: free)." -ForegroundColor Yellow

if ($env:OPENROUTER_API_KEY) {
  Step 'Live: one request' { npx sfagents run "Reply with exactly: windows smoke OK" }
  Step 'Live: test suite' { npm run test:live }
} else {
  Write-Host "`nOPENROUTER_API_KEY not set: live checks skipped (not verified)." -ForegroundColor Yellow
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host "Windows smoke test FAILED: $($failures -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host 'Windows smoke test passed.' -ForegroundColor Green
