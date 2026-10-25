#!/usr/bin/env node
// Only this explicit setup/uninstall entry point requests UAC. Neither a build,
// probe nor a shell command ever does. No passwords appear on command lines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('Windows sandbox setup is Windows-only.');
const action = process.argv[2];
if (!['setup', 'uninstall'].includes(action)) throw new Error('Expected setup or uninstall.');
const exe = fileURLToPath(new URL(`../core/native/bin/win-${process.arch}/sfagents-sandbox.exe`, import.meta.url));
if (!fs.existsSync(exe)) throw new Error('Build the helper first: npm run build:sandbox');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-setup-'));
const log = path.join(dir, 'result.txt');
const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal = s => `'${s.replaceAll("'", "''")}'`;
// Windows PowerShell 5 turns native stderr into an ErrorRecord. Stop would
// abort before the native exit status and diagnostic log could be returned.
const inner = `$ErrorActionPreference='Continue'; & ${literal(exe)} ${action} *> ${literal(log)}; exit $LASTEXITCODE`;
const encoded = Buffer.from(inner, 'utf16le').toString('base64');
const script = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${literal(ps)} -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -PassThru -Wait; exit $p.ExitCode`;
console.log(`Windows will ask for administrator approval to ${action} the sandbox. Undo: npm run sandbox:uninstall`);
const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit', windowsHide: true });
try {
  if (fs.existsSync(log)) process.stdout.write(fs.readFileSync(log, 'utf16le').replace(/^\uFEFF/, ''));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
process.exit(result.status ?? 1);
