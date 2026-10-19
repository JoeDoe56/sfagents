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
