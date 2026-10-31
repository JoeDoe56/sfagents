/**
 * The operating-system sandbox that every shell command runs in.
 *
 * A policy is a list of canonical paths with an access mode; the longest
 * matching path decides. Anything no rule covers is unreachable, except the
 * system folders a command needs to run at all (read-only). The shell is
 * offline unless the policy allows the network. The host channel is the one
 * way out: a local socket the host serves (web access through `sf-web`).
 *
 * There is no unsandboxed fallback. Where no backend is available, commands
 * are refused with the reason.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isPathWithinRoot } from '../permissions/workspace.js';

/**
 * What commands may do under a path: "write" is read, write and delete;
 * "edit" is read and write without deleting (or renaming) anything, which
 * Linux cannot enforce (there it is "write").
 */
export type SandboxAccess = 'read' | 'edit' | 'write' | 'none';

/** Commands may change files under it ("edit" or "write"). */
export function isWritable(access: SandboxAccess): boolean {
  return access === 'write' || access === 'edit';
}

export interface SandboxRule {
  /** Canonical absolute path. */
  path: string;
  access: SandboxAccess;
  /**
   * For a protected path inside a writable one that does not exist yet:
   * create it before the command runs, so the backend can protect it (a
   * Linux bind mount needs something to mount over). Without `ensure`, a
   * missing path's rule is skipped.
   */
  ensure?: { kind: 'file'; content?: string } | { kind: 'dir' };
}

export interface SandboxPolicy {
  rules: readonly SandboxRule[];
  network: boolean;
  /** A Unix socket (named pipe on Windows) served by the host, reachable from inside. */
  hostChannel?: { path: string };
  /** Host files a command may run inside the sandbox (read-only), e.g. the `sf-web` helper. */
  tools?: readonly { path: string; name: string }[];
}

export interface SandboxCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WrappedCommand extends SandboxCommand {
  /** Called once the command has exited. */
  cleanup?: () => void;
}

export interface Sandbox {
  /** "bubblewrap", "Seatbelt", ... */
  readonly name: string;
  wrap(command: SandboxCommand, policy: SandboxPolicy): WrappedCommand;
}

export type SandboxStatus = { ok: true; sandbox: Sandbox } | { ok: false; reason: string };

/** Where the host channel and helper tools appear inside a sandbox that can remap paths. */
export const SANDBOX_RUN_DIR = '/run/sfagents';
/** Environment variable naming the host channel inside the sandbox. */
export const HOST_CHANNEL_ENV = 'SFAGENTS_HOST';

/** The access the policy gives `p` (canonical): the longest matching rule (the last one for a path), or none. */
export function accessFor(rules: readonly SandboxRule[], p: string): SandboxAccess {
  let best: SandboxRule | undefined;
  for (const rule of rules) {
    if (!isPathWithinRoot(p, rule.path)) continue;
    if (!best || rule.path.length >= best.path.length) best = rule;
  }
  return best?.access ?? 'none';
}

/**
 * Rules in mount order (parents before children), without duplicates (the
 * last rule for a path wins), creating `ensure` targets that are missing and
 * dropping rules whose path still does not exist.
 */
export function prepareRules(rules: readonly SandboxRule[]): SandboxRule[] {
  const byPath = new Map<string, SandboxRule>();
  for (const rule of rules) byPath.set(rule.path, rule);
  const out: SandboxRule[] = [];
  for (const rule of byPath.values()) {
    if (!fs.existsSync(rule.path) && rule.ensure && isWritable(accessFor([...byPath.values()], path.dirname(rule.path)))) {
      try {
        if (rule.ensure.kind === 'dir') fs.mkdirSync(rule.path, { recursive: true, mode: 0o700 });
        else fs.writeFileSync(rule.path, rule.ensure.content ?? '', { flag: 'wx', mode: 0o600 });
      } catch {
        // checked below
      }
    }
    if (fs.existsSync(rule.path)) out.push(rule);
  }
  return out.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
}

function depth(p: string): number {
  return p.split(path.sep).filter(Boolean).length;
}

/** Runs a probe command and resolves with its stderr when it fails. */
export function probe(executable: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail: detail.trim() });
    };
    let child;
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      done(false, error instanceof Error ? error.message : String(error));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(false, 'timed out');
    }, timeoutMs);
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (error) => done(false, error.message));
    child.on('close', (code) => done(code === 0, stderr || `exit code ${code}`));
  });
}

let detected: Promise<SandboxStatus> | undefined;

/** The sandbox backend for this machine, checked once per process. */
export function detectSandbox(): Promise<SandboxStatus> {
  detected ??= (async (): Promise<SandboxStatus> => {
    if (process.platform === 'linux') return (await import('./linux.js')).detectBubblewrap();
    if (process.platform === 'darwin') return (await import('./macos.js')).detectSeatbelt();
    if (process.platform === 'win32') return (await import('./windows.js')).detectWindowsSandbox();
    return { ok: false, reason: `No sandbox is available for ${process.platform} yet, so shell commands are refused.` };
  })();
  return detected;
}

/** Replaces the detected backend (tests). */
export function setSandboxForTesting(status: SandboxStatus | undefined): void {
  detected = status ? Promise.resolve(status) : undefined;
}
