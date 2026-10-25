/**
 * macOS sandbox: Seatbelt through /usr/bin/sandbox-exec with a default-deny
 * profile. The system folders are readable, the policy's paths get exactly
 * their access (the longest matching rule wins, written out with
 * `require-not` so rule order does not matter), each command gets its own
 * temporary folder as HOME and TMPDIR, and the network is denied except the
 * host channel's socket unless the policy allows it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathWithinRoot } from '../permissions/workspace.js';
import {
  HOST_CHANNEL_ENV,
  prepareRules,
  probe,
  type Sandbox,
  type SandboxCommand,
  type SandboxPolicy,
  type SandboxRule,
  type SandboxStatus,
  type WrappedCommand,
} from './sandbox.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** System folders every command may read. */
export const MACOS_SYSTEM_PATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/opt',
  '/private/etc',
  '/private/var/db/timezone',
  '/private/var/db/dyld',
  '/Applications/Xcode.app',
  '/dev',
];

/** Single files commands commonly need to read or write. */
const DEVICE_FILES = ['/dev/null', '/dev/zero', '/dev/tty', '/dev/dtracehelper'];

/** Mach services for user lookups, logging and (with network) DNS and TLS. */
const MACH_SERVICES = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.logd',
  'com.apple.diagnosticd',
];
const NETWORK_MACH_SERVICES = ['com.apple.dnssd.service', 'com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.SystemConfiguration.configd', 'com.apple.SystemConfiguration.DNSConfiguration'];

export function sbString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `(subpath p)` minus every more specific rule below it. */
function scope(rule: SandboxRule, rules: readonly SandboxRule[]): string {
  const carve = rules.filter((r) => r.path !== rule.path && isPathWithinRoot(r.path, rule.path));
  const sub = `(subpath ${sbString(rule.path)})`;
  if (!carve.length) return sub;
  return `(require-all ${sub} ${carve.map((r) => `(require-not (subpath ${sbString(r.path)}))`).join(' ')})`;
}

/** Every ancestor of the given paths, so tools can stat their way down to them. */
function ancestors(paths: readonly string[]): string[] {
  const out = new Set<string>(['/']);
  for (const p of paths) {
    for (let dir = path.dirname(p); dir !== path.dirname(dir); dir = path.dirname(dir)) out.add(dir);
  }
  return [...out].sort();
}

/** The Seatbelt profile for one command (exported for tests). */
export function seatbeltProfile(policy: SandboxPolicy, tempDir: string, rules: readonly SandboxRule[] = policy.rules): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow pseudo-tty)',
    '(allow file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
    `(allow mach-lookup ${MACH_SERVICES.map((s) => `(global-name ${sbString(s)})`).join(' ')})`,
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    // Symlinks at the top level (/etc, /tmp, /var) and the folders above granted paths.
    `(allow file-read-metadata ${ancestors([...MACOS_SYSTEM_PATHS, ...rules.map((r) => r.path), tempDir]).map((p) => `(literal ${sbString(p)})`).join(' ')} (literal "/etc") (literal "/tmp") (literal "/var"))`,
    `(allow file-read* ${MACOS_SYSTEM_PATHS.map((p) => `(subpath ${sbString(p)})`).join(' ')})`,
    `(allow file-read* file-write* ${DEVICE_FILES.map((p) => `(literal ${sbString(p)})`).join(' ')} (subpath "/dev/fd") (regex #"^/dev/ttys[0-9]+$"))`,
    `(allow file-read* file-write* (subpath ${sbString(tempDir)}))`,
  ];
  for (const rule of rules) {
    if (rule.access === 'none') continue;
    const s = scope(rule, rules);
    lines.push(rule.access === 'write' ? `(allow file-read* file-write* ${s})` : `(allow file-read* ${s})`);
  }
  if (policy.tools?.length) lines.push(`(allow file-read* ${policy.tools.map((t) => `(literal ${sbString(t.path)})`).join(' ')})`);
  if (policy.hostChannel) {
    lines.push(`(allow network-outbound (remote unix-socket (path-literal ${sbString(policy.hostChannel.path)})))`);
  }
  if (policy.network) {
    lines.push('(allow network-outbound)', '(allow network-inbound)', '(allow system-socket)');
    lines.push(`(allow mach-lookup ${NETWORK_MACH_SERVICES.map((s) => `(global-name ${sbString(s)})`).join(' ')})`);
  }
  return lines.join('\n');
}

export class SeatbeltSandbox implements Sandbox {
  readonly name = 'Seatbelt';
  constructor(readonly executable = SANDBOX_EXEC) {}

  wrap(command: SandboxCommand, policy: SandboxPolicy): WrappedCommand {
    const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-sandbox-')));
    const env: NodeJS.ProcessEnv = { ...command.env, HOME: tempDir, TMPDIR: tempDir };
    if (policy.hostChannel) env[HOST_CHANNEL_ENV] = policy.hostChannel.path;
    if (policy.tools?.length) {
      // Seatbelt cannot remap paths, so the helpers are linked into the temp folder's bin.
      const bin = path.join(tempDir, '.sfagents-bin');
      fs.mkdirSync(bin);
      for (const tool of policy.tools) fs.symlinkSync(tool.path, path.join(bin, tool.name));
      env['PATH'] = [bin, env['PATH'] ?? '/usr/bin:/bin'].join(':');
    }
    const profile = seatbeltProfile(policy, tempDir, prepareRules(policy.rules));
    return {
      executable: this.executable,
      args: ['-p', profile, '--', command.executable, ...command.args],
      cwd: command.cwd,
      env,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  }
}

export async function detectSeatbelt(): Promise<SandboxStatus> {
  if (!fs.existsSync(SANDBOX_EXEC)) {
    return { ok: false, reason: `Shell commands are refused because ${SANDBOX_EXEC} is missing, so no sandbox is available.` };
  }
  const result = await probe(SANDBOX_EXEC, ['-p', '(version 1)\n(allow default)', '--', '/usr/bin/true']);
  if (!result.ok) return { ok: false, reason: `Shell commands are refused because the macOS sandbox does not start: ${result.detail}.` };
  return { ok: true, sandbox: new SeatbeltSandbox() };
}
