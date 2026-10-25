#!/usr/bin/env node
/**
 * Static audit for the SF Agents workspace:
 *  1. No import specifier, manifest dependency or lockfile entry refers to
 *     @qwen-code/* or a path into another upstream package.
 *  2. Relative imports never leave their own package's src directory.
 *  3. The CLI and the web server reach Core only through "@sfagents/core";
 *     Core never imports the CLI, the web server or terminal modules
 *     (node:readline), and the web server never imports the CLI.
 *  4. Every declared dependency is imported (or located with require.resolve,
 *     for packages that ship only a binary) somewhere in that package, and
 *     every bare import is declared (or is a Node builtin / the sibling package).
 * Exits non-zero and prints each violation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\.resolve\(\s*['"]([^'"]+)['"]\s*\)/gm;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FORBIDDEN = /@qwen-code\/|qwen-code-core|packages\/(acp-bridge|browser-use|sdk-typescript|web-shell|web-templates|audio-capture|channels)/;

for (const pkg of ['core', 'web', 'cli']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, pkg, 'package.json'), 'utf8'));
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
  for (const dep of declared) if (FORBIDDEN.test(dep)) problems.push(`${pkg}/package.json declares forbidden dependency ${dep}`);
  for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
    if (/\.\.\/\.\.\//.test(script)) problems.push(`${pkg}/package.json script "${name}" reaches outside the workspace: ${script}`);
  }
  const srcDir = path.join(root, pkg, 'src');
  const used = new Set();
  for (const file of walk(srcDir)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(root, file);
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (FORBIDDEN.test(spec)) problems.push(`${rel}: forbidden import "${spec}"`);
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(srcDir + path.sep)) problems.push(`${rel}: relative import leaves ${pkg}/src: "${spec}"`);
        continue;
      }
      if (builtins.has(spec) || builtins.has(spec.split('/')[0])) {
        if (pkg === 'core' && (spec === 'node:readline' || spec === 'readline')) problems.push(`${rel}: Core must not import terminal modules ("${spec}")`);
        if (pkg === 'web' && (spec === 'node:readline' || spec === 'readline')) problems.push(`${rel}: the web server must not import terminal modules ("${spec}")`);
        continue;
      }
      const name = packageName(spec);
      used.add(name);
      if (pkg === 'core' && (name === '@sfagents/cli' || name === '@sfagents/web')) problems.push(`${rel}: Core must not import the CLI or the web server`);
      if (pkg === 'web' && name === '@sfagents/cli') problems.push(`${rel}: the web server must not import the CLI`);
      if (!declared.has(name)) problems.push(`${rel}: imports "${name}", which ${pkg}/package.json does not declare`);
    }
  }
  for (const dep of declared) {
    if (!used.has(dep)) problems.push(`${pkg}/package.json declares "${dep}" but ${pkg}/src never imports it`);
  }
}

// Tests and fixtures may use relative paths but never Qwen packages. The
// audit's own test embeds forbidden imports as fixture text on purpose.
for (const file of walk(path.join(root, 'tests')).filter((f) => !/audit\.test\.[jt]s$/.test(f))) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (FORBIDDEN.test(spec)) problems.push(`${path.relative(root, file)}: forbidden import "${spec}"`);
  }
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const dep of Object.keys({ ...rootManifest.dependencies, ...rootManifest.devDependencies })) {
  if (FORBIDDEN.test(dep)) problems.push(`package.json declares forbidden dependency ${dep}`);
}
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  for (const key of Object.keys(lock.packages ?? {})) {
    if (FORBIDDEN.test(key)) problems.push(`package-lock.json contains ${key}`);
  }
}

if (problems.length) {
  console.error(`Import/dependency audit failed (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Import/dependency audit passed: no @qwen-code references, package boundaries respected, all dependencies used and declared.');
