#!/usr/bin/env node
// A pinned, relocatable CPython runtime gives the Linux backend the same
// install-and-run packaging as the self-contained Windows adapter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const LINUX_PYTHON = {
  version: '3.12.15', release: '20261013',
  x64: { target: 'x86_64-unknown-linux-gnu', sha256: '178d3d83b6e8e99285a65d3fce9c16b87952cc5efdb4d1a0e3ff3be18ff0fc9c' },
  arm64: { target: 'aarch64-unknown-linux-gnu', sha256: '9467a99bacc7d90b64b02de7fa9ecfc99b72905e64e74f7ff6b460ad95cfed5a' },
};

export async function buildLinuxSensors(root, arch = process.arch) {
  const release = LINUX_PYTHON[arch];
  if (!release) throw new Error(`Bundled Linux sensors do not support ${arch}; the resource monitor uses native readers.`);
  const output = path.join(root, 'web/native/bin', `linux-${arch}`);
  // npm excludes symlinks: invoke the real versioned executable directly.
  const executable = path.join(output, 'python/bin/python3.12');
  const stamp = path.join(output, '.runtime-sha256');
  if (fs.existsSync(executable) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === release.sha256) return;
  const asset = `cpython-${LINUX_PYTHON.version}+${LINUX_PYTHON.release}-${release.target}-install_only_stripped.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${LINUX_PYTHON.release}/${encodeURIComponent(asset)}`;
  console.log(`Preparing bundled Linux sensor runtime: CPython ${LINUX_PYTHON.version} (${arch})…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Python runtime download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Python runtime checksum mismatch.');
  fs.mkdirSync(path.join(root, '.tools'), { recursive: true });
  const archive = path.join(root, '.tools', asset);
  fs.writeFileSync(archive, bytes);
  const stage = fs.mkdtempSync(path.join(root, '.tools/linux-sensors-'));
  try {
    const result = spawnSync('tar', ['-xzf', archive, '-C', stage], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Could not extract the bundled Python runtime.');
    const check = spawnSync(path.join(stage, 'python/bin/python3.12'), ['-I', '-c', 'import sys; assert sys.version_info[:2] == (3, 12)'], { stdio: 'inherit' });
    if (check.status !== 0) throw new Error('Bundled Python cannot run on this Linux system (requires glibc).');
    // Destination is fixed beneath this workspace; replace only its Python
    // runtime so an interrupted download never destroys the existing copy.
    fs.mkdirSync(output, { recursive: true });
    fs.rmSync(path.join(output, 'python'), { recursive: true, force: true });
    fs.renameSync(path.join(stage, 'python'), path.join(output, 'python'));
    fs.copyFileSync(path.join(root, 'web/native/NOTICE.md'), path.join(output, 'NOTICE.md'));
    fs.copyFileSync(path.join(root, 'web/native/linux/vendor/LICENSE'), path.join(output, 'LHM-Linux-LICENSE.txt'));
    fs.writeFileSync(stamp, release.sha256);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
  console.log(`Linux sensor runtime bundled in ${path.relative(root, output)}.`);
}

if (process.platform === 'linux' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLinuxSensors(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
