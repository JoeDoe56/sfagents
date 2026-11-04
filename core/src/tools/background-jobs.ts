/**
 * Shell commands that keep running after the tool call returns: dev servers,
 * watchers, long builds. Each runs in the agent's container like any command;
 * its output is kept (the last part of it) so the agent can read it later,
 * and it runs until it exits, the agent stops it, or SF Agents quits.
 */

import type { ChildProcess } from 'node:child_process';
import { killProcessTree, spawnShell, type ShellSpawnOptions } from './shell.js';
import { stripAnsiAndControl } from '../utils/text-utils.js';

/** Output kept per job (the most recent part). */
const MAX_JOB_OUTPUT_CHARS = 256 * 1024;
/** Background jobs one agent may run at once. */
export const MAX_RUNNING_JOBS = 8;
/** Finished jobs remembered, for their output and exit code. */
const MAX_FINISHED_JOBS = 20;

export interface BackgroundJob {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly owner: string;
  readonly startedAt: number;
  /** When the command itself started in the container. */
  runningAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stopped?: boolean;
}

interface JobState extends BackgroundJob {
  child: ChildProcess;
  kill?: () => void;
  output: string;
  /** Characters dropped from the front of `output` so far. */
  dropped: number;
  /** Absolute position (dropped + index) the agent has read up to. */
  read: number;
  ended: Promise<void>;
  started: Promise<void>;
}

const jobs = new Map<string, JobState>();
let nextId = 1;

export function listJobs(owner: string): BackgroundJob[] {
  return [...jobs.values()].filter((j) => j.owner === owner).map(publicJob);
}

/** Every running job (status pages). */
export function runningJobCount(): number {
  return [...jobs.values()].filter((j) => j.endedAt === undefined).length;
}

function publicJob(j: JobState): BackgroundJob {
  const { child: _child, kill: _kill, output: _output, dropped: _dropped, read: _read, ended: _ended, started: _started, ...rest } = j;
  return { ...rest };
}

export function getJob(owner: string, id: string): BackgroundJob | undefined {
  const j = jobs.get(id);
  return j && j.owner === owner ? publicJob(j) : undefined;
}

/**
 * Starts @p command in the background. @p onEnd runs once it has exited (and
 * for resources tied to the job, such as its use of SF Agents' commands.
 */
export function startJob(command: string, owner: string, options: ShellSpawnOptions, onEnd?: () => void | Promise<void>): BackgroundJob {
  const running = [...jobs.values()].filter((j) => j.owner === owner && j.endedAt === undefined);
  if (running.length >= MAX_RUNNING_JOBS) {
    throw new Error(`${running.length} background commands are already running (${running.map((j) => j.id).join(', ')}); stop one first.`);
  }
  const id = `job-${nextId++}`;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let markEnded!: () => void;
  const ended = new Promise<void>((resolve) => (markEnded = resolve));
  const append = (text: string) => {
    state.output += text;
    if (state.output.length > MAX_JOB_OUTPUT_CHARS) {
      const cut = state.output.length - MAX_JOB_OUTPUT_CHARS;
      state.output = state.output.slice(cut);
      state.dropped += cut;
    }
  };
  const proc = spawnShell(command, options, (_stream, chunk) => append(stripAnsiAndControl(chunk.toString('utf8'))), () => {
    state.runningAt = Date.now();
    markStarted();
  });
  const state: JobState = { id, command, cwd: options.cwd, owner, startedAt: Date.now(), child: proc.child, kill: proc.kill, output: '', dropped: 0, read: 0, ended, started };
  jobs.set(id, state);
  let finished = false;
  const finish = async (result: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string }) => {
    if (finished) return;
    finished = true;
    try {
      await onEnd?.();
    } catch {
      // the job is over either way
    }
    Object.assign(state, result, { endedAt: Date.now() });
    markStarted();
    markEnded();
    pruneFinished();
  };
  proc.child.on('error', (error) => void finish({ error: error.message }));
  proc.child.on('close', (exitCode, signal) => void finish({ exitCode, signal }));
  return publicJob(state);
}

function pruneFinished() {
  const finished = [...jobs.values()].filter((j) => j.endedAt !== undefined).sort((a, b) => a.endedAt! - b.endedAt!);
  for (const j of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(j.id);
}

/**
 * Waits until the job has run for @p ms, has
 * exited, or @p signal aborts.
 */
export async function waitForJob(id: string, ms: number, signal?: AbortSignal): Promise<void> {
  const j = jobs.get(id);
  if (!j) return;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([j.started.then(() => new Promise<void>((resolve) => setTimeout(resolve, ms))), j.ended, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Output the agent has not read yet (the tail of it when there is more than @p maxChars). */
export function readNewOutput(owner: string, id: string, maxChars: number): { text: string; skipped: number } | undefined {
  const j = jobs.get(id);
  if (!j || j.owner !== owner) return undefined;
  const end = j.dropped + j.output.length;
  const from = Math.max(j.read, j.dropped, end - maxChars);
  const skipped = from - j.read;
  j.read = end;
  return { text: j.output.slice(from - j.dropped), skipped };
}

/** Stops a job and everything it started; resolves once it has exited. */
export async function stopJob(owner: string, id: string): Promise<boolean> {
  const j = jobs.get(id);
  if (!j || j.owner !== owner) return false;
  if (j.endedAt === undefined) {
    j.stopped = true;
    if (j.kill) j.kill();
    else killProcessTree(j.child);
    await Promise.race([j.ended, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  }
  return true;
}

/** Stops every job (SF Agents is quitting). */
export async function stopAllJobs(): Promise<void> {
  await Promise.all([...jobs.values()].filter((j) => j.endedAt === undefined).map((j) => stopJob(j.owner, j.id)));
}
