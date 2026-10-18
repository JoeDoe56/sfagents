#!/usr/bin/env node
// Runs the compiled node:test suites in tests/dist. Pass --live to run only
// the live provider tests (requires OPENROUTER_API_KEY); extra arguments
// filter test files by substring.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'tests', 'dist');
const args = process.argv.slice(2);
const live = args.includes('--live');
const filters = args.filter((a) => !a.startsWith('--'));

const files = fs
  .readdirSync(dist)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => (live ? f.startsWith('live') : !f.startsWith('live')))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .map((f) => path.join(dist, f));

if (files.length === 0) {
  console.error('No test files matched.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
