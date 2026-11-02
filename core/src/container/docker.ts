/**
 * How SF Agents runs Docker. On Linux (and macOS) it is the docker CLI on the
 * PATH, talking to whatever engine its context points at. On Windows it is
 * the Docker Engine inside SF Agents' own WSL distro "sfagents": every call
 * goes through `wsl.exe -d sfagents`, to SF Agents' copy of the CLI and its
 * own socket, so it can never reach the Docker Desktop engine (Immich's) even
 * if Docker Desktop integrates with the distro.
 *
 * `wsl.exe --exec` runs the program directly with the arguments as given
 * (`--` would hand one joined line to a shell, which re-splits it).
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export const WSL_DISTRO = 'sfagents';
/** SF Agents' docker CLI and engine socket inside the distro. */
export const WSL_DOCKER_CLI = '/opt/sfagents/bin/docker';
export const WSL_DOCKER_SOCKET = 'unix:///run/sfagents/docker.sock';

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface DockerCli {
  /** Executable and arguments that run `docker <args>`. */
  argv(args: readonly string[]): { executable: string; args: string[] };
  /** Runs `docker <args>` to completion. */
  run(args: readonly string[], options?: { stdin?: string | Buffer; timeoutMs?: number }): Promise<DockerResult>;
  /** Starts `docker <args>` with piped stdio (the bridge). */
  spawn(args: readonly string[], options?: SpawnOptions): ChildProcess;
}

export function windowsWslExe(): string {
  return `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\wsl.exe`;
}

/** The docker CLI for this machine. `SFAGENTS_DOCKER` overrides the executable (tests, other engines). */
export function defaultDockerCli(): DockerCli {
  const override = process.env['SFAGENTS_DOCKER'];
  if (process.platform === 'win32' && !override) {
    return new CommandDockerCli(windowsWslExe(), ['-d', WSL_DISTRO, '-u', 'root', '--exec', WSL_DOCKER_CLI, '-H', WSL_DOCKER_SOCKET]);
  }
  return new CommandDockerCli(override || 'docker', []);
}

export class CommandDockerCli implements DockerCli {
  constructor(
    private readonly executable: string,
    private readonly prefix: readonly string[],
  ) {}

  argv(args: readonly string[]) {
    return { executable: this.executable, args: [...this.prefix, ...args] };
  }

  spawn(args: readonly string[], options: SpawnOptions = {}): ChildProcess {
    const { executable, args: full } = this.argv(args);
    return spawn(executable, full, { windowsHide: true, ...options });
  }

  run(args: readonly string[], options: { stdin?: string | Buffer; timeoutMs?: number } = {}): Promise<DockerResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawn(args, { stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (c: Buffer) => out.push(c));
      child.stderr?.on('data', (c: Buffer) => err.push(c));
      const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : undefined;
      if (options.stdin !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(options.stdin);
      }
      const done = (code: number | null, extra = '') => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + extra });
      };
      child.on('error', (error) => done(null, error.message));
      child.on('close', (code) => done(code));
    });
  }
}

/** Throws with docker's own message when a call failed. */
export async function docker(cli: DockerCli, args: readonly string[], options?: { stdin?: string | Buffer; timeoutMs?: number }): Promise<string> {
  const result = await cli.run(args, options);
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
    throw new Error(`docker ${args[0]}: ${message}`);
  }
  return result.stdout;
}
