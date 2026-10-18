import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir, REPO_ROOT, writeJson } from './helpers.js';

const AUDIT = path.join(REPO_ROOT, 'scripts', 'audit-imports.mjs');

describe('static import and dependency audit', () => {
  test('the SF Agents workspace passes', () => {
    const r = spawnSync(process.execPath, [AUDIT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('violations are detected', () => {
    const dir = makeTempDir();
    writeJson(path.join(dir, 'package.json'), { name: 'x', devDependencies: {} });
    writeJson(path.join(dir, 'core', 'package.json'), { name: '@sfagents/core', dependencies: { '@qwen-code/qwen-code-core': '1.0.0', unused: '1.0.0' } });
    writeJson(path.join(dir, 'cli', 'package.json'), { name: '@sfagents/cli', dependencies: {} });
    fs.mkdirSync(path.join(dir, 'core', 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'cli', 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'core', 'src', 'a.ts'),
      "import { Config } from '@qwen-code/qwen-code-core';\nimport readline from 'node:readline';\nimport x from '../../cli/src/b.js';\n",
    );
    fs.writeFileSync(path.join(dir, 'cli', 'src', 'b.ts'), "import { thing } from 'undeclared-pkg';\n");
    const r = spawnSync(process.execPath, [AUDIT, dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    for (const expected of [
      /declares forbidden dependency @qwen-code\/qwen-code-core/,
      /forbidden import "@qwen-code\/qwen-code-core"/,
      /Core must not import terminal modules/,
      /relative import leaves core\/src/,
      /imports "undeclared-pkg", which cli\/package.json does not declare/,
      /declares "unused" but core\/src never imports it/,
    ]) {
      assert.match(r.stderr, expected);
    }
  });
});
