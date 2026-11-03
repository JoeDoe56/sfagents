import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentContainerSpec } from '../container/containers.js';
import type { ToolImage } from '../tools/tools.js';
import type { FullControlManager } from '../runtime/full-control.js';
import { sanitizeChildEnv } from '../utils/child-env.js';
import { StartLux, type DecisionAnswer, type UiDecider } from './startlux.js';

export const UI_COMMAND = 'sfa-ui';
export const UI_USAGE = `Usage (your own container desktop is always available):
  sfa-ui apps
  sfa-ui open <executable> [args...]
  sfa-ui tree <app-id>
  sfa-ui screenshot <app-id>
  sfa-ui act <app-id> <control-id> <invoke|set_value|toggle|expand|select|scroll> [value]
  sfa-ui click <app-id> <x> <y>         window-relative fallback for canvas apps
  sfa-ui task <app-id> "goal" [--values '{"control-id or name":"text to type"}']
Add --host for the person's apps (only the main agent, during an approved full-control session).
task uses StartLux 4B Instant; it picks controls and actions, never writes text. You provide values.
On uncertainty it returns the tree, screenshot and history so you can continue with act or click.
Your own desktop never asks the person: act, click and type freely there.
With --host, buttons that send, delete, submit, pay or publish ask the person once each, and the person types host passwords themselves. Clicks by coordinates do not ask.`;

export interface UiControl { id: string; name: string; role: string; actions: string[]; password?: boolean; context?: string; value?: string; bounds?: number[] }
export interface UiReply { text?: string; error?: string; controls?: UiControl[]; apps?: Array<{ id: string; name: string; title?: string }>; image?: { mime: string; data: string } }
export interface UiAdapter { request(p: Record<string, unknown>, signal: AbortSignal): Promise<UiReply> }
/** Asks the person; only host actions have one. */
export type Approve = (question: string, signal: AbortSignal) => Promise<boolean>;
export interface UiGrant {
  container: UiAdapter;
  host?: UiAdapter;
  fullControl?: { manager: FullControlManager; owner: object };
  service: UiService;
}

function kill(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') { const p = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); p.on('error', () => child.kill()); }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
async function response(child: ChildProcess, p: Record<string, unknown>, signal: AbortSignal): Promise<UiReply> {
  return new Promise((resolve, reject) => {
    const abort = () => { kill(child); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    let out = ''; let err = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); if (out.length > 24_000_000) { kill(child); reject(new Error('UI response exceeded its image limit.')); } });
    child.stderr?.on('data', (c: Buffer) => { if (err.length < 5000) err += c.toString('utf8'); });
    child.stdin?.on('error', () => {}); child.stdin?.end(JSON.stringify(p));
    child.once('error', (e) => { signal.removeEventListener('abort', abort); reject(e); });
    child.once('close', () => {
      signal.removeEventListener('abort', abort);
      try { const data = JSON.parse(out.replace(/^\uFEFF/, '').trim()) as UiReply; if (data.error !== undefined) reject(new Error(data.error || 'Native UI operation failed.')); else resolve(data); }
      catch (e) { reject(new Error(`UI driver: ${err || (e instanceof Error ? e.message : String(e))}`)); }
    });
  });
}

export class WindowsUiAdapter implements UiAdapter {
  async request(p: Record<string, unknown>, signal: AbortSignal): Promise<UiReply> {
    if (process.platform !== 'win32') throw new Error('Host UI driving currently supports Windows. Container UI works on Windows and Linux.');
    signal.throwIfAborted();
    const script = fileURLToPath(new URL('../../native/ui/windows.ps1', import.meta.url));
    return response(spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: 'pipe', env: sanitizeChildEnv(process.env, Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))) }), p, signal);
  }
}

export class ContainerUiAdapter implements UiAdapter {
  private started?: Promise<string>;
  constructor(private readonly spec: AgentContainerSpec | (() => AgentContainerSpec)) {}
  async request(p: Record<string, unknown>, signal: AbortSignal): Promise<UiReply> {
    signal.throwIfAborted();
    const { containerManager } = await import('../container/containers.js');
    const manager = containerManager();
    this.started ??= (async () => {
      const name = await manager.prepare(typeof this.spec === 'function' ? this.spec() : this.spec);
      const start = await manager.cli.run(['exec', '-d', '-u', 'agent', name, 'bash', '/run/sfa/bin/sfa-desktop'], { timeoutMs: 15_000 });
      if (start.code !== 0) throw new Error('The container desktop could not start. Pull the new agent image and Reset Environment.');
      for (let i = 0; i < 30; i++) {
        signal.throwIfAborted();
        const ready = await manager.cli.run(['exec', '-u', 'agent', name, 'bash', '-c', 'test -S /tmp/sfa-desktop-bus && xdpyinfo -display :99 >/dev/null 2>&1'], { timeoutMs: 5000 });
        if (ready.code === 0) return name;
        await delay(100, undefined, { signal });
      }
      throw new Error('No container desktop bus. Use the updated image (Xvfb, D-Bus, AT-SPI and Openbox).');
    })().catch((e) => { this.started = undefined; throw e; });
    const name = await this.started;
    const child = manager.cli.spawn(['exec', '-i', '-u', 'agent', '-e', 'DISPLAY=:99', '-e', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/sfa-desktop-bus', name, '/usr/bin/python3', '/run/sfa/bin/sfa-ui-native.py'], { stdio: 'pipe', detached: process.platform !== 'win32' });
    return response(child, p, signal);
  }
}

export const uiNativeFile = (name: string): string => fs.readFileSync(new URL(`../../native/ui/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export const riskyControl = (c: UiControl): boolean => !!c.password || /\b(send|delete|remove|pay|purchase|buy|checkout|publish|post|submit|transfer|confirm order|password)\b/i.test(`${c.name} ${c.role}`);
const accepted = (a: DecisionAnswer | undefined, gate: number): string | undefined => {
  if (!a?.choice || !Number.isFinite(a.confidence) || a.confidence! < gate || (a.none_probability ?? 0) >= .2) return undefined;
  return a.choice;
};

/** Actions, approvals and verification are independent of the decision model. */
export class UiService {
  constructor(readonly decider: UiDecider = new StartLux(), readonly gate = .8) {}
  async warm(signal: AbortSignal): Promise<() => void> { return this.decider instanceof StartLux ? this.decider.acquire(signal) : () => {}; }
  stop(): void { if (this.decider instanceof StartLux) this.decider.stop(); }
  /**
   * `approve` is undefined for the agent's own container desktop: nothing
   * there asks the person. On the host, irreversible buttons (send, delete,
   * submit, pay...) and password fields ask once each.
   */
  async act(adapter: UiAdapter, p: { app: string; id: string; action: string; value?: string }, approve: Approve | undefined, signal: AbortSignal): Promise<UiReply> {
    const tree = await adapter.request({ op: 'tree', app: p.app }, signal);
    const c = tree.controls?.find((c) => c.id === p.id);
    if (!c || !c.actions.includes(p.action)) throw new Error('Control changed or action unsupported. Read the tree again.');
    if (approve && riskyControl(c) && !await approve(`${p.action} on ${c.password ? 'a password field' : `${c.role} “${c.name}”${c.context ? ` in ${c.context}` : ''}`} in app ${p.app}?${c.password ? ' Enter it directly in the app, then allow; do not give the password to the agent.' : ''}`, signal)) throw new Error('The person did not approve this action.');
    signal.throwIfAborted();
    if (approve && c.password && p.action === 'set_value') return { text: 'Enter the password directly in the app. The UI driver did not type a password.' };
    const outcome = await adapter.request({ op: 'act', ...p, expectedName: c.name, expectedRole: c.role, expectedPassword: !!c.password, expectedContext: c.context ?? '' }, signal);
    if (outcome.error !== undefined) throw new Error(outcome.error || 'Native UI operation failed.');
    return outcome;
  }
  async task(adapter: UiAdapter, app: string, goal: string, values: Record<string, string>, approve: Approve | undefined, signal: AbortSignal): Promise<{ text: string; image?: UiReply['image'] }> {
    let release: (() => void) | undefined;
    const history: Array<{ control: string; action: string; changed: boolean }> = [];
    let tree: UiReply = { controls: [] };
    let screenshot: UiReply['image'];
    const handoff = async (reason: string) => {
      try { screenshot = (await adapter.request({ op: 'screenshot', app }, signal)).image; } catch { /* Some windows refuse capture. */ }
      return { text: JSON.stringify({ status: 'handoff', reason, goal, controls: tree.controls, history }), ...(screenshot ? { image: screenshot } : {}) };
    };
    try {
      if (this.decider instanceof StartLux) release = await this.decider.acquire(signal);
      let failures = 0;
      for (let step = 0; step < 40; step++) {
        signal.throwIfAborted();
        tree = await adapter.request({ op: 'tree', app }, signal);
        const controls = (tree.controls ?? []).slice(0, 150);
        if (!controls.length) return await handoff('No accessibility controls; continue with the main agent and window-relative click.');
        const candidates = controls.filter((c) => c.actions.length);
        const evidence = { goal, controls: controls.map((c) => ({ ...(c.actions.length ? { id: String(candidates.indexOf(c) + 1) } : {}), name: c.name.slice(0, 100), role: c.role, context: c.context?.slice(0, 140), actions: c.actions, ...(c.password ? { password: true } : c.value ? { value: c.value.slice(0, 160) } : {}) })), history: history.slice(-8), availableValues: candidates.flatMap((c, i) => values[c.id] !== undefined || values[c.name] !== undefined ? [String(i + 1)] : []) };
        const pictures = screenshot ? [`data:${screenshot.mime};base64,${screenshot.data}`] : [];
        const choices = Object.fromEntries(candidates.map((c, i) => [String(i + 1), `${c.role}: ${c.name}${c.context ? ` in ${c.context.slice(-100)}` : ''}`]));
        const answer = await this.decider.decide(evidence, { control: { type: 'choice', instructions: 'Which control should be acted on next to meet the goal? DONE only if achieved; STUCK if no supported action can progress.', criteria: { ...choices, DONE: 'Goal already met', STUCK: 'Need main-agent help' } } }, pictures, signal);
        const id = accepted(answer['control'], this.gate);
        if (id === 'DONE') {
          const verify = await this.decider.decide(evidence, { done: { type: 'noul', instructions: 'Is the requested goal actually met in this observed app state?' } }, pictures, signal);
          if ((verify['done']?.noul ?? 0) >= this.gate) return { text: JSON.stringify({ status: 'done', goal, controls, history }) };
        } else if (id && id !== 'STUCK') {
          const c = candidates[Number(id) - 1];
          if (c) {
            const value = values[c.id] ?? values[c.name];
            const meanings: Record<string, string> = { invoke: 'Activate or click; does not type text', set_value: 'Replace this field’s text with the supplied value', toggle: 'Switch this checkbox or toggle', expand: 'Expand or collapse this control', select: 'Select this row or tab', scroll: 'Scroll this control' };
            const a = await this.decider.decide({ goal, control: { name: c.name, role: c.role, context: c.context, value: c.password ? undefined : c.value }, supplied_value_available: value !== undefined }, { action: { type: 'choice', instructions: `Which supported action on ${c.name} advances the goal? Use set_value to enter supplied text.`, criteria: Object.fromEntries(c.actions.map((a) => [a, meanings[a] ?? a])) } }, pictures, signal);
            const action = accepted(a['action'], this.gate);
            if (action && c.actions.includes(action)) {
              if (approve && action === 'set_value' && c.password) {
                await this.act(adapter, { app, id: c.id, action }, approve, signal);
                return await handoff('Password entry is reserved for the person in the app. Continue after they have entered it.');
              }
              if (action === 'set_value' && value === undefined) return await handoff(`Provide text through --values for ${c.name || c.id}; the decision model never writes text.`);
              await this.act(adapter, { app, id: c.id, action, ...(value !== undefined ? { value } : {}) }, approve, signal);
              await delay(200, undefined, { signal });
              const next = await adapter.request({ op: 'tree', app }, signal);
              const changed = JSON.stringify(tree.controls) !== JSON.stringify(next.controls);
              history.push({ control: c.name || c.id, action, changed }); tree = next;
              if (changed) { failures = 0; screenshot = undefined; continue; }
            }
          }
        }
        if (++failures >= 2) return await handoff('Two uncertain decisions or unchanged states. Continue with the main agent.');
        screenshot = (await adapter.request({ op: 'screenshot', app }, signal)).image;
      }
      return await handoff('Reached the 40-step limit.');
    } catch (e) {
      signal.throwIfAborted();
      return await handoff(e instanceof Error ? e.message : String(e));
    } finally { release?.(); }
  }
}

export async function runUiCommand(grant: UiGrant | undefined, args: readonly string[], o: { signal: AbortSignal; images?: ToolImage[] }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (args.includes('--help') || args.includes('-h')) return { ok: true, text: UI_USAGE };
  if (!grant) return { ok: false, error: 'UI driving is unavailable.' };
  try {
    const host = args[0] === '--host'; const rest = host ? args.slice(1) : [...args];
    const [op, app, id, action, value] = rest;
    // The agent's own container desktop never asks; only host actions do.
    let signal = o.signal; let approve: Approve | undefined;
    if (host) {
      if (!grant.fullControl || !grant.host) throw new Error('Only the main agent can drive the host UI during a full-control session.');
      signal = AbortSignal.any([signal, grant.fullControl.manager.require(grant.fullControl.owner)]);
      const fc = grant.fullControl;
      approve = (q, s) => fc.manager.approveAction(fc.owner, fc.manager.status()!.agent, q, s);
    }
    const adapter = host ? grant.host! : grant.container;
    let reply: UiReply;
    if (op === 'act' && app && id && action) reply = await grant.service.act(adapter, { app, id, action, ...(value !== undefined ? { value } : {}) }, approve, signal);
    else if (op === 'task' && app && id) {
      const i = rest.indexOf('--values');
      const values: unknown = i >= 0 ? JSON.parse(rest[i + 1] || '') : {};
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some((v) => typeof v !== 'string')) throw new Error('--values must be an object of text values.');
      reply = await grant.service.task(adapter, app, id, values as Record<string, string>, approve, signal);
    } else if (op === 'click' && app && id !== undefined && action !== undefined) {
      const x = Number(id); const y = Number(action);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Give window-relative x and y coordinates.');
      reply = await adapter.request({ op, app, x, y }, signal);
    } else if (op === 'apps' || (['open', 'tree', 'screenshot'].includes(op ?? '') && app)) reply = await adapter.request({ op, ...(app ? { app } : {}), ...(op === 'open' ? { args: rest.slice(2) } : {}) }, signal);
    else return { ok: false, error: UI_USAGE };
    if (reply.error !== undefined) throw new Error(reply.error || 'Native UI operation failed.');
    if (reply.image) o.images?.push({ mime: reply.image.mime, data: Buffer.from(reply.image.data, 'base64'), label: `${host ? 'Host' : 'Container'} app ${app}` });
    return { ok: true, text: reply.text ?? JSON.stringify(reply.controls ?? reply.apps ?? reply) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
