/** Windows backend. Setup is explicit; detection and commands never elevate. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRules, probe, type Sandbox, type SandboxCommand, type SandboxPolicy, type SandboxStatus, type WrappedCommand } from './sandbox.js';
import { spawnSync } from 'node:child_process';

export function windowsSandboxPath(): string {
  return fileURLToPath(new URL(`../../native/bin/win-${process.arch}/sfagents-sandbox.exe`, import.meta.url));
}

export class WindowsSandbox implements Sandbox {
  readonly name = 'Windows restricted user';
  constructor(readonly executable = windowsSandboxPath()) {}

  wrap(command: SandboxCommand, policy: SandboxPolicy): WrappedCommand {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-policy-'));
    const policyFile = path.join(dir, 'policy.json');
    try {
      fs.writeFileSync(policyFile, JSON.stringify({
        version: 1,
        ...policy,
        rules: prepareRules(policy.rules),
        cwd: command.cwd,
        // The helper merges only an explicit allowlist into the account's own environment.
        env: Object.fromEntries(Object.entries(command.env).filter(([k, v]) => v !== undefined && ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM'].includes(k.toUpperCase()))),
      }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return {
      executable: this.executable,
      args: ['run', '--policy', policyFile, '--', command.executable, ...command.args],
      cwd: command.cwd,
      env: command.env,
      cleanup: () => {
        // A timeout can kill the broker before its Rust guards run. Its job has
        // already killed the command; recover the journal before deleting policy.
        const recovered = spawnSync(this.executable, ['recover'], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
        fs.rmSync(dir, { recursive: true, force: true });
        if (recovered.status !== 0) throw new Error(`Windows sandbox permission cleanup failed: ${recovered.stderr || recovered.error?.message}`);
      },
    };
  }
}

export async function detectWindowsSandbox(executable = windowsSandboxPath()): Promise<SandboxStatus> {
  if (!fs.existsSync(executable)) return { ok: false, reason: 'Windows sandbox helper is missing. Run npm run build:sandbox. Shell commands are refused.' };
  const result = await probe(executable, ['probe'], 20_000);
  if (!result.ok) return { ok: false, reason: `Windows sandbox is unavailable: ${result.detail}. Run npm run sandbox:setup to approve setup, then run SF Agents from an ordinary terminal. Undo: npm run sandbox:uninstall. Shell commands are refused.` };
  return { ok: true, sandbox: new WindowsSandbox(executable) };
}
