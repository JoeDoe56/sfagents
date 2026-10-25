/**
 * One administrator approval each time `sfagents web` starts, covering
 * everything SF Agents does with administrator rights, so that no feature
 * asks again when it is first used.
 *
 * What it covers:
 *
 *   - one-time installs that are still missing: on Windows the signed PawnIO
 *     driver that CPU temperatures are read through (sensor-driver.ts);
 *   - the programs that run elevated while SF Agents runs: on Windows the
 *     read-only sensor worker, on Linux the sensor collectors (smartctl and
 *     ipmitool read drive temperatures and the BMC only as root).
 *
 * On Windows that is one UAC prompt: an elevated PowerShell runs the installs
 * in turn, then starts the workers and exits. Each worker connects back to a
 * named pipe that an unelevated broker made for it, restricted to this
 * Windows account (web/native/windows/Program.cs). On Linux it is one `sudo`
 * password prompt in the terminal (`sudo -v`), whose cached credentials then
 * run the installs and start the collectors (`sudo -n`). macOS needs nothing.
 *
 * SF Agents itself, its web server and the agents' tools stay at the user's
 * own level. A declined or failed approval leaves each feature working
 * without administrator rights where it can (the sensors then show what the
 * operating system gives an ordinary user).
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage, sfagentsHome } from '@sfagents/core';
import { pawnioInstalled, pawnioStep } from './sensor-driver.js';
import { LINUX_SENSORS_PYTHON } from './linux-sensors.js';
import { WINDOWS_SENSORS_EXE } from './windows-sensors.js';

export interface ElevatedStep {
  file: string;
  args: string[];
}

export interface Privileges {
  /** Windows: the elevated sensor worker's pipe, and whether the approval started it. */
  windowsSensors?: { pipe: string; approved: Promise<boolean> };
  /** Linux: sudo's credentials are cached; the sensor collectors run as root. */
  linuxSudo?: boolean;
  /** Settles when the approval and the installs are done (or declined). */
  done: Promise<void>;
}

export interface PrivilegeOptions {
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  /** Linux: may sudo ask for a password? (Only when there is a terminal to ask in.) */
  interactive?: boolean;
  /** Where downloaded installers go. */
  setupDir?: string;
}

/**
 * Asks for the approval, at startup. On Linux this waits for the password
 * (it is typed into the terminal SF Agents was started from); on Windows the
 * prompt is shown and the result arrives through the returned promises.
 */
export async function acquirePrivileges(options: PrivilegeOptions = {}): Promise<Privileges> {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  const setupDir = options.setupDir ?? path.join(sfagentsHome(), 'setup');
  if (platform === 'win32') {
    const worker = fs.existsSync(WINDOWS_SENSORS_EXE);
    if (!worker && pawnioInstalled()) return { done: Promise.resolve() };
    const pipe = `sfagents-sensors-${crypto.randomBytes(16).toString('hex')}`;
    const done = (async () => {
      const installs: ElevatedStep[] = [];
      if (!pawnioInstalled()) {
        try {
          installs.push(await pawnioStep(setupDir));
        } catch (error) {
          log(`The sensor driver could not be downloaded: ${getErrorMessage(error)}`);
        }
      }
      if (!installs.length && !worker) throw new Error('nothing to do.');
      await runElevatedWindows(installs, worker ? [{ file: WINDOWS_SENSORS_EXE, args: ['--pipe-worker', pipe] }] : []);
    })();
    const approved = done.then(
      () => true,
      (error) => {
        log(`Administrator rights were not given: ${getErrorMessage(error)}`);
        return false;
      },
    );
    return { ...(worker ? { windowsSensors: { pipe, approved } } : {}), done: approved.then(() => undefined) };
  }
  if (platform === 'linux') {
    // Only when something would use it: no prompt on a machine with neither tool.
    if (!fs.existsSync(LINUX_SENSORS_PYTHON) || !['smartctl', 'ipmitool'].some(hasCommand)) return { done: Promise.resolve() };
    const ok = await sudoValidate(options.interactive ?? Boolean(process.stdin.isTTY), log);
    return { linuxSudo: ok, done: Promise.resolve() };
  }
  return { done: Promise.resolve() };
}

/**
 * Windows: one UAC prompt. An elevated PowerShell runs @p installs in turn,
 * then starts @p workers without waiting for them, and exits with the first
 * install's failure, if any.
 */
export function runElevatedWindows(installs: ElevatedStep[], workers: ElevatedStep[] = []): Promise<void> {
  const ps = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const list = (args: string[]) => (args.length ? ` -ArgumentList @(${args.map(ps).join(',')})` : '');
  const inner = [
    '$failed = 0',
    ...installs.map((st) => `$p = Start-Process -FilePath ${ps(st.file)}${list(st.args)} -Wait -PassThru; if ($p.ExitCode -ne 0 -and $failed -eq 0) { $failed = $p.ExitCode }`),
    ...workers.map((st) => `Start-Process -FilePath ${ps(st.file)}${list(st.args)} -WindowStyle Hidden`),
    'exit $failed',
  ].join('; ');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  // WaitForExit, not -Wait: -Wait would also wait for the workers it started.
  const outer = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'); $p.WaitForExit(); exit $p.ExitCode`;
  const exe = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', outer], 'ignore').catch((error) => {
    throw new Error(/canceled|cancelled|1223/i.test(getErrorMessage(error)) ? 'the administrator approval was declined.' : getErrorMessage(error));
  });
}

/** Linux: caches sudo's credentials, asking for the password in the terminal when there is one. */
async function sudoValidate(interactive: boolean, log: (line: string) => void): Promise<boolean> {
  if (!hasCommand('sudo')) return false;
  if (spawnSync('sudo', ['-n', '-v'], { stdio: 'ignore' }).status === 0) return true;
  if (!interactive) {
    log('Administrator rights: no terminal to ask for the sudo password in; drive and BMC sensors are read without them.');
    return false;
  }
  process.stderr.write('SF Agents asks once for administrator rights, for its hardware sensors.\n');
  try {
    await run('sudo', ['-v', '-p', '[sudo] password for %p: '], 'inherit');
    return true;
  } catch {
    log('Administrator rights were not given; drive and BMC sensors are read without them.');
    return false;
  }
}

function run(cmd: string, args: string[], stdio: 'ignore' | 'inherit'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${path.basename(cmd)} exited with code ${code}`))));
  });
}

function hasCommand(cmd: string): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}
