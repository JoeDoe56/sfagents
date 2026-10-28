// Writes web/dist/version.json with the commit this build is made from, so
// the Settings sheet can show which commit is running.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
const commit = git.status === 0 ? git.stdout.trim() : null;
const dist = path.join(root, 'web', 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ commit, built: new Date().toISOString() }) + '\n');
