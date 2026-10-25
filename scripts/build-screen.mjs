#!/usr/bin/env node
// Builds sfagents-screen, SF Agents' screen mirroring helper
// (web/native/screen), from the MoonlightWeb sources in the repository and
// the dependencies below, fetched at the commits MoonlightWeb pins them at.
// Needs CMake, a C++17 compiler, Qt 6 (Core, Network, WebSockets) and
// OpenSSL. Releases are built by .github/workflows/screen.yml; SF Agents
// downloads those (web/src/screen.ts), so users never run this.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screen = path.join(root, 'web/native/screen');
const mw = path.join(screen, 'moonlight-web/backend');

export const DEPENDENCIES = [
  { dir: 'third_party/libdatachannel', url: 'https://github.com/paullouisageneau/libdatachannel.git', commit: 'ca9a141f84393355f4af7a6c7b6645d2f1fc49b8', submodules: true },
  { dir: 'third_party/moonlight-common-c', url: 'https://github.com/linckosz/moonlight-common-c.git', commit: '349369445795ab85dad57e30e118f0d50b5ca9a9', submodules: true },
  { dir: 'native-host/third_party/opus', url: 'https://github.com/xiph/opus.git', commit: 'ddbe48383984d56acd9e1ab6a090c54ca6b735a6' },
  { dir: 'native-host/third_party/openh264', url: 'https://github.com/cisco/openh264.git', commit: '652bdb7719f30b52b08e506645a7322ff1b2cc6f' },
];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
}

function head(dir) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function fetchDependencies() {
  for (const dep of DEPENDENCIES) {
    const dir = path.join(mw, dep.dir);
    if (fs.existsSync(path.join(dir, '.git')) && head(dir) === dep.commit) continue;
    console.log(`Fetching ${dep.url} at ${dep.commit.slice(0, 12)}…`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q'], dir);
    git(['remote', 'add', 'origin', dep.url], dir);
    git(['fetch', '-q', '--depth', '1', 'origin', dep.commit], dir);
    git(['checkout', '-q', 'FETCH_HEAD'], dir);
    if (dep.submodules) git(['submodule', 'update', '-q', '--init', '--recursive', '--depth', '1'], dir);
  }
}

export function buildScreen({ buildType = 'Release', jobs } = {}) {
  fetchDependencies();
  const build = path.join(screen, 'build');
  const configure = ['-S', screen, '-B', build, `-DCMAKE_BUILD_TYPE=${buildType}`];
  if (spawnSync('ninja', ['--version'], { stdio: 'ignore' }).status === 0) configure.push('-G', 'Ninja');
  if (process.env.CMAKE_PREFIX_PATH) configure.push(`-DCMAKE_PREFIX_PATH=${process.env.CMAKE_PREFIX_PATH}`);
  for (const args of [configure, ['--build', build, '--config', buildType, '--target', 'sfagents-screen', ...(jobs ? ['-j', String(jobs)] : [])]]) {
    const r = spawnSync('cmake', args, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`cmake ${args[0]} failed`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildScreen();
