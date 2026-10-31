/**
 * Linux sandbox: bubblewrap. Each command gets new namespaces (user, pid,
 * mount, network, ipc, uts) and a root made only of what the policy grants:
 * the system folders read-only, the writable roots bound read-write, read
 * rules bound read-only and `none` rules masked. The home folder and /tmp are
 * empty, and there is no network unless the policy allows it. Paths keep
 * their real names, so a symlink that leaves the workspace finds nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  HOST_CHANNEL_ENV,
  SANDBOX_RUN_DIR,
  prepareRules,
  probe,
  type Sandbox,
  type SandboxCommand,
  type SandboxPolicy,
  type SandboxStatus,
  type WrappedCommand,
} from './sandbox.js';

/** System folders every command may read. */
export const LINUX_SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/nix/store'];
/** Extra paths that DNS needs when the network is allowed (systemd-resolved stub). */
const NETWORK_PATHS = ['/run/systemd/resolve'];

export function findBubblewrap(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = ['/usr/bin', '/usr/local/bin', '/bin', ...(env['PATH'] ?? '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'bwrap');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export class BubblewrapSandbox implements Sandbox {
  readonly name = 'bubblewrap';
  constructor(readonly executable: string) {}

  wrap(command: SandboxCommand, policy: SandboxPolicy): WrappedCommand {
    return { ...command, ...bubblewrapCommand(this.executable, command, policy) };
  }
}

/** The bwrap command line for one command (exported for tests). */
export function bubblewrapCommand(bwrap: string, command: SandboxCommand, policy: SandboxPolicy): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL'];
  if (policy.network) args.push('--share-net');

  for (const p of LINUX_SYSTEM_PATHS) systemPath(args, p);
  if (policy.network) for (const p of NETWORK_PATHS) if (fs.existsSync(p)) args.push('--ro-bind', p, p);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');

  // An empty home: tools find their usual paths, none of the user's files.
  const home = command.env['HOME'] || os.homedir();
  const env: NodeJS.ProcessEnv = { ...command.env, HOME: home, TMPDIR: '/tmp' };
  if (!LINUX_SYSTEM_PATHS.some((s) => home === s || home.startsWith(s + '/'))) args.push('--tmpfs', home);

  for (const rule of prepareRules(policy.rules)) {
    // A bind mount cannot allow writing but not deleting: "edit" is "write" here (the loader warns).
    if (rule.access === 'write' || rule.access === 'edit') args.push('--bind', rule.path, rule.path);
    else if (rule.access === 'read') args.push('--ro-bind', rule.path, rule.path);
    else if (fs.statSync(rule.path).isDirectory()) args.push('--tmpfs', rule.path, '--remount-ro', rule.path);
    else args.push('--ro-bind', '/dev/null', rule.path);
  }

  if (policy.hostChannel || policy.tools?.length) {
    args.push('--dir', SANDBOX_RUN_DIR);
    if (policy.hostChannel) {
      const inside = `${SANDBOX_RUN_DIR}/host.sock`;
      args.push('--bind', policy.hostChannel.path, inside);
      env[HOST_CHANNEL_ENV] = inside;
    }
    if (policy.tools?.length) {
      const bin = `${SANDBOX_RUN_DIR}/bin`;
      args.push('--dir', bin);
      for (const tool of policy.tools) args.push('--ro-bind', tool.path, `${bin}/${tool.name}`);
      env['PATH'] = [bin, env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'].join(':');
    }
  }

  args.push('--chdir', command.cwd, '--', command.executable, ...command.args);
  return { executable: bwrap, args, env };
}

/** Binds a system folder read-only, or recreates it as a symlink (merged /usr: /bin -> usr/bin). */
function systemPath(args: string[], p: string): void {
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    args.push('--symlink', fs.readlinkSync(p), p);
    return;
  }
  args.push('--ro-bind', p, p);
}

const INSTALL_HINT =
  'Install bubblewrap to use the shell: `sudo apt install bubblewrap` (Debian, Ubuntu), `sudo dnf install bubblewrap` (Fedora), `sudo pacman -S bubblewrap` (Arch).';

export async function detectBubblewrap(): Promise<SandboxStatus> {
  const bwrap = findBubblewrap();
  if (!bwrap) return { ok: false, reason: `Shell commands are refused because no sandbox is installed. ${INSTALL_HINT}` };
  const result = await probe(bwrap, ['--die-with-parent', '--unshare-all', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--', '/bin/sh', '-c', 'exit 0']);
  if (!result.ok) {
    const userns = /uid map|user namespace|Operation not permitted|Permission denied/i.test(result.detail)
      ? ' This system blocks unprivileged user namespaces. On Ubuntu 24.04 and later, the bubblewrap package\'s AppArmor profile allows it; check that it is loaded (`sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`) or that `kernel.apparmor_restrict_unprivileged_userns` is 0.'
      : '';
    return { ok: false, reason: `Shell commands are refused because the sandbox (bubblewrap) does not start here: ${result.detail}.${userns}` };
  }
  return { ok: true, sandbox: new BubblewrapSandbox(bwrap) };
}
