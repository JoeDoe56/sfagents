#!/usr/bin/env node
// Publish the Windows adapter with its own .NET runtime. No SDK/runtime or
// separate LibreHardwareMonitor application is required on the end user's PC.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rid = `win-${process.arch}`;
if (!['win-x64', 'win-arm64'].includes(rid)) throw new Error(`Windows sensors do not support ${rid}.`);
const project = path.join(root, 'web/native/windows');
const output = path.join(root, 'web/native/bin', rid);
const stamp = path.join(output, '.source-hash');
const sourceHash = createHash('sha256');
sourceHash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
for (const name of ['SfAgents.Sensors.csproj', 'Program.cs', 'NuGet.Config']) sourceHash.update(fs.readFileSync(path.join(project, name)));
sourceHash.update(rid);
const expected = sourceHash.digest('hex');
if (fs.existsSync(path.join(output, 'SfAgents.Sensors.exe')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === expected) process.exit(0);

const sdkVersion = '10.0.402';
const tools = path.join(root, '.tools');
const sdkDir = path.join(tools, 'dotnet');
let dotnet = 'dotnet';
const installed = spawnSync(dotnet, ['--version'], { encoding: 'utf8', windowsHide: true });
if (installed.status !== 0 || Number(installed.stdout?.split('.')[0]) < 10) {
  dotnet = path.join(sdkDir, 'dotnet.exe');
  if (!fs.existsSync(path.join(sdkDir, 'sdk', sdkVersion))) {
    console.log(`Preparing local .NET SDK ${sdkVersion} for the Windows sensors build…`);
    fs.mkdirSync(sdkDir, { recursive: true });
    const metadata = await (await fetch('https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json')).json();
    const sdk = metadata.releases.flatMap(r => r.sdks ?? []).find(s => s.version === sdkVersion);
    const archive = sdk?.files.find(f => f.rid === rid && f.name.endsWith('.zip'));
    if (!archive || !archive.url.startsWith('https://builds.dotnet.microsoft.com/')) throw new Error('Official SDK archive not found.');
    const response = await fetch(archive.url);
    if (!response.ok) throw new Error(`SDK download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha512').update(bytes).digest('hex').toLowerCase() !== archive.hash.toLowerCase()) throw new Error('SDK checksum mismatch.');
    const zip = path.join(tools, `dotnet-${sdkVersion}-${rid}.zip`);
    fs.writeFileSync(zip, bytes);
    const unpack = spawnSync('tar.exe', ['-xf', zip, '-C', sdkDir], { stdio: 'inherit', windowsHide: true });
    if (unpack.status !== 0) throw new Error('Could not extract the local SDK.');
    fs.unlinkSync(zip);
  }
}
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_CLI_HOME: path.join(tools, 'dotnet-home'), NUGET_PACKAGES: path.join(tools, 'nuget') };
const result = spawnSync(dotnet, ['publish', path.join(project, 'SfAgents.Sensors.csproj'), '--configfile', path.join(project, 'NuGet.Config'), '-c', 'Release', '-r', rid, '--self-contained', 'true', '-o', output], { env, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
// Keep upstream license texts and package provenance beside the redistributed
// assemblies, including the self-contained .NET runtime.
const notices = path.join(output, 'licenses');
fs.mkdirSync(notices, { recursive: true });
for (const entry of fs.readdirSync(path.join(root, 'web/native/licenses'))) {
  fs.copyFileSync(path.join(root, 'web/native/licenses', entry), path.join(notices, entry));
}
const deps = JSON.parse(fs.readFileSync(path.join(output, 'SfAgents.Sensors.deps.json'), 'utf8'));
for (const [identity, library] of Object.entries(deps.libraries)) {
  if (library.type !== 'package' && library.type !== 'runtimepack') continue;
  const [name, version] = identity.split('/');
  const packageName = name.replace(/^runtimepack\./, '');
  const directory = path.join(env.NUGET_PACKAGES, packageName.toLowerCase(), version);
  if (!fs.existsSync(directory)) continue;
  const destination = path.join(notices, `${name}-${version}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /license|notice|\.nuspec$/i.test(entry.name)) fs.copyFileSync(path.join(directory, entry.name), path.join(destination, entry.name));
  }
}
fs.copyFileSync(path.join(root, 'web/native/NOTICE.md'), path.join(output, 'NOTICE.md'));
fs.writeFileSync(stamp, expected);
console.log(`Windows sensor adapter published to ${path.relative(root, output)}.`);
