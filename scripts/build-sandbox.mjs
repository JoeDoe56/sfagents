#!/usr/bin/env node
// Source builds need Rust + the Windows SDK (VS C++ Build Tools). The packaged
// helper has no Rust/runtime requirement and never installs machine settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function buildWindowsSandbox({ required = false } = {}) {
  if (process.platform !== 'win32') return;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const crate = path.join(root, 'core/native/windows-sandbox');
  const output = path.join(root, 'core/native/bin', `win-${process.arch}`);
  const exe = path.join(output, 'sfagents-sandbox.exe');
  const stamp = path.join(output, '.source-hash');
  const sources = ['Cargo.toml', 'Cargo.lock', ...fs.readdirSync(path.join(crate, 'src')).filter(n => n.endsWith('.rs')).map(n => `src/${n}`)];
  const hash = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).update(process.arch);
  for (const source of sources) hash.update(fs.readFileSync(path.join(crate, source)));
  const expected = hash.digest('hex');
  if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === expected) return;
  const local = path.join(root, '.tools/rust');
  const localCargo = path.join(local, 'cargo/bin/cargo.exe');
  const cargo = fs.existsSync(localCargo) ? localCargo : 'cargo';
  const temp = path.join(local, 'tmp');
  fs.mkdirSync(temp, { recursive: true });
  const env = { ...process.env, TEMP: temp, TMP: temp, ...(cargo === localCargo ? { CARGO_HOME: path.join(local, 'cargo'), RUSTUP_HOME: path.join(local, 'rustup') } : {}) };
  const target = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[process.arch];
  if (!target) throw new Error(`Windows sandbox does not support ${process.arch}`);
  const result = spawnSync(cargo, ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(crate, 'Cargo.toml')], { env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    const message = `Windows sandbox build failed (${result.error?.message ?? result.status}). Install Rust and the Windows C++ Build Tools, then run npm run build:sandbox. Shell commands remain refused without a working sandbox.`;
    // Never silently use an old binary after its sources changed.
    if (fs.existsSync(exe)) fs.unlinkSync(exe);
    if (required || process.env.SFAGENTS_REQUIRE_SANDBOX === '1') throw new Error(message);
    console.warn(`warning: ${message}`);
    return;
  }
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(crate, 'target', target, 'release/sfagents-sandbox.exe'), exe);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  // Not --offline: the build fetched only this target's crates, and metadata
  // lists every platform's (a fresh machine has the others nowhere yet).
  const metadata = spawnSync(cargo, ['metadata', '--locked', '--format-version=1', '--manifest-path', path.join(crate, 'Cargo.toml')], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (metadata.status !== 0) throw new Error(`Cannot collect sandbox dependency licenses: ${metadata.stderr}`);
  const licenseDir = path.join(output, 'licenses');
  fs.mkdirSync(licenseDir, { recursive: true });
  const notices = ['# Windows sandbox dependencies', '', 'The helper is GPL-3.0-only. Its Rust dependencies retain their own licenses:', ''];
  for (const pkg of JSON.parse(metadata.stdout).packages) {
    if (!pkg.source) continue;
    const source = path.dirname(pkg.manifest_path);
    notices.push(`- ${pkg.name} ${pkg.version}: ${pkg.license}; ${pkg.repository ?? pkg.source}`);
    for (const name of fs.readdirSync(source).filter(n => /^(license|copying|copyright)/i.test(n))) {
      if (fs.statSync(path.join(source, name)).isFile()) fs.copyFileSync(path.join(source, name), path.join(licenseDir, `${pkg.name}-${pkg.version}-${name}`));
    }
  }
  const rustc = cargo === localCargo ? path.join(local, 'cargo/bin/rustc.exe') : 'rustc';
  const sysroot = spawnSync(rustc, ['--print', 'sysroot'], { env, encoding: 'utf8', windowsHide: true });
  if (sysroot.status !== 0) throw new Error('Cannot collect Rust runtime license notices.');
  for (const name of ['COPYRIGHT', 'LICENSE-APACHE', 'LICENSE-MIT']) fs.copyFileSync(path.join(sysroot.stdout.trim(), 'share/doc/rust', name), path.join(licenseDir, `rust-${name}`));
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.md'), notices.join('\n') + '\n');
  fs.writeFileSync(stamp, expected);
  console.log(`Windows sandbox helper built: ${path.relative(root, exe)}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWindowsSandbox({ required: true });
