# Explicit, one-time Windows driver setup. SF Agents never installs a kernel
# driver merely because somebody opens the resource monitor.
$ErrorActionPreference = 'Stop'
# A parent PowerShell 7 session may pass a module path that omits Windows
# PowerShell's built-in hashing, signature and CIM modules.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
if ($env:OS -ne 'Windows_NT') { throw 'This setup is for Windows only.' }
$driver = Get-CimInstance Win32_SystemDriver -Filter "Name = 'PawnIO'" -ErrorAction SilentlyContinue
if ($driver) { Write-Output 'PawnIO is already installed.'; exit 0 }
$setupDir = Join-Path $PSScriptRoot '..\.tools\sensor-setup'
New-Item -ItemType Directory -Path $setupDir -Force | Out-Null
$installer = Join-Path $setupDir 'PawnIO_setup-2.2.0.exe'
Invoke-WebRequest -UseBasicParsing 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe' -OutFile $installer
$expectedHash = '1F519A22E47187F70A1379A48CA604981C4FCF694F4E65B734AAA74A9FBA3032'
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedHash) { throw 'PawnIO installer checksum mismatch.' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid') { throw ('PawnIO installer signature could not be verified: ' + $signature.Status) }
Write-Output ('Opening the signed PawnIO installer from ' + $signature.SignerCertificate.Subject + '. Windows will ask for administrator approval.')
$setupProcess = Start-Process -FilePath $installer -Verb RunAs -WindowStyle Normal -PassThru -Wait
if ($setupProcess.ExitCode -ne 0) { throw ('PawnIO setup exited with code ' + $setupProcess.ExitCode) }
Write-Output 'Restart SF Agents and approve its administrator prompt to give its sensor worker access to the hardware.'
