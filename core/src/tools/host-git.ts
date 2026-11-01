/**
 * `sf-git`: Git's network operations, run by SF Agents on the host with the
 * person's own Git credentials, which never enter the sandbox. Inside the
 * sandbox Git has no credential helper and (offline) reaches Git hosts only
 * through the package proxy, so it can fetch public repositories but not push.
 *
 * Only `push`, `fetch` and `ls-remote`, only to a remote the repository already
 * names (its config is read-only to commands) whose URL is HTTPS to an allowed
 * Git host, never a URL given on the command line. Pushes that rewrite or
 * delete history are refused (--force and its variants, +refspecs, --mirror,
 * --delete, :branch). Options that run programs are refused, and the host's
 * Git runs with hooks off. Every call is logged in the network log.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageProxy, hostAllowed } from '../sandbox/package-proxy.js';
import type { WorkspaceContext } from '../permissions/workspace.js';

export const GIT_COMMAND = 'sf-git';

export const GIT_USAGE = `Usage (run in a repository in your workspace):
  sf-git push [<remote> [<branch>...]] [-u] [--tags]   push with the person's credentials
  sf-git fetch [<remote>] [<args>]                        fetch (then merge or rebase yourself)
  sf-git ls-remote [<remote>]
Only remotes the repository already has, over HTTPS to GitHub, GitLab or Bitbucket.
Force pushes, deletes (--delete, :branch), --mirror and +refspecs are refused.`;

export interface GitGrant {
  agent: string;
  workspace: WorkspaceContext;
}

const OPS = new Set(['push', 'fetch', 'ls-remote']);
/** Options that would run a program, or point Git somewhere else. */
const REFUSED_ANYWHERE = [/^--(upload|receive)-pack/, /^--exec\b/, /^-c$/, /^--config/, /^--git-dir/, /^--work-tree/, /^--repo\b/, /^-C$/];
const REFUSED_PUSH = [/^-f$/, /^--force/, /^--mirror$/, /^-d$/, /^--delete$/, /^--prune$/, /^--all$/];
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 5 * 60_000;

function run(args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      // The person's own credential manager answers, without prompting.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const take = (c: Buffer) => {
      if (out.length < MAX_OUTPUT) out += c.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => resolve({ code: null, out: out + error.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function config(cwd: string, key: string, signal: AbortSignal): Promise<string | undefined> {
  const r = await run(['config', '--get', key], cwd, signal);
  return r.code === 0 ? r.out.trim() : undefined;
}

/** The host of an HTTPS Git URL, or undefined for anything else (ssh, file, ext). */
export function httpsHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Why @p args are refused, if they are. */
export function refusal(op: string, args: readonly string[]): string | undefined {
  for (const a of args) {
    if (REFUSED_ANYWHERE.some((r) => r.test(a))) return `${a} is not allowed.`;
    if (op === 'push') {
      if (REFUSED_PUSH.some((r) => r.test(a))) return `${a} is not allowed: sf-git does not force, delete or mirror.`;
      if (!a.startsWith('-') && (a.startsWith('+') || a.startsWith(':') || /:\+?$/.test(a))) return `${a}: force and delete refspecs are not allowed.`;
    }
    // A URL instead of a remote name.
    if (!a.startsWith('-') && /^[a-z][a-z0-9+.-]*:\/\/|^[^/\\]+@[^:]+:|::/i.test(a)) return 'Use a remote the repository already has, not a URL.';
  }
  return undefined;
}

export async function runGit(grant: GitGrant, args: readonly string[], o: { cwd?: string; command?: string; signal: AbortSignal }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const [op, ...rest] = args;
  if (!op || op === '-h' || op === '--help' || !OPS.has(op)) return op && op !== '-h' && op !== '--help' ? { ok: false, error: GIT_USAGE } : { ok: true, text: GIT_USAGE };
  const log = (host: string, allowed: boolean, reason?: string) => packageProxy().add({ agent: grant.agent, command: o.command ?? `sf-git ${args.join(' ')}`, host, port: 443, allowed, reason: reason ? `sf-git ${op}: ${reason}` : `sf-git ${op}` });
  const cwd = o.cwd ? grant.workspace.check(o.cwd, 'write') : undefined;
  if (!cwd?.ok) return { ok: false, error: 'Run sf-git in a repository inside your workspace.' };
  const why = refusal(op, rest);
  if (why) {
    log('(git)', false, why);
    return { ok: false, error: why };
  }
  const dir = cwd.resolvedPath ?? o.cwd!;
  const top = await run(['rev-parse', '--show-toplevel'], dir, o.signal);
  if (top.code !== 0) return { ok: false, error: `Not a Git repository: ${dir}` };
  const repo = path.resolve(top.out.trim());
  if (!grant.workspace.check(repo, 'write').ok) return { ok: false, error: 'The repository is not inside your workspace.' };
  // The remote: the first word that is not an option, or the branch's / "origin".
  const named = rest.find((a) => !a.startsWith('-'));
  const branch = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo, o.signal)).out.trim();
  const remote = named ?? (branch ? await config(repo, `branch.${branch}.remote`, o.signal) : undefined) ?? 'origin';
  if (!/^[\w.-]+$/.test(remote)) return { ok: false, error: `Not a remote name: ${remote}` };
  const urls = [await config(repo, `remote.${remote}.url`, o.signal), ...(op === 'push' ? [await config(repo, `remote.${remote}.pushurl`, o.signal)] : [])].filter((u): u is string => !!u);
  if (!urls.length) return { ok: false, error: `This repository has no remote "${remote}".` };
  for (const url of urls) {
    const host = httpsHost(url);
    if (!host || !hostAllowed(host, 443)) {
      log(host ?? url.slice(0, 80), false, 'remote is not HTTPS to an allowed Git host');
      return { ok: false, error: `Remote "${remote}" (${url}) is not HTTPS to an allowed Git host.` };
    }
  }
  const host = httpsHost(urls[0]!)!;
  // Hooks off: the sandbox cannot change them, but a push must not run anything.
  const noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'sfagents-git-nohooks-'));
  try {
    const r = await run(['-c', `core.hooksPath=${noHooks}`, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', op, ...(named ? [] : [remote]), ...rest], repo, o.signal);
    log(host, r.code === 0, r.code === 0 ? undefined : `exit ${r.code}`);
    const text = r.out.trim() || `git ${op}: done`;
    return r.code === 0 ? { ok: true, text } : { ok: false, error: text };
  } finally {
    fs.rmSync(noHooks, { recursive: true, force: true });
  }
}
