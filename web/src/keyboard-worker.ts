/**
 * Push-to-talk's keyboard on macOS and Linux (and on Windows when
 * SfAgents.Input.exe is missing): its own process, started by push-to-talk.ts,
 * so that a native failure in the keyboard hook cannot take SF Agents down.
 * It speaks SfAgents.Input.exe's protocol (web/native/windows-input), with
 * the hotkey given by name:
 *
 *   in:  "hotkey <key name>|Off <mods>"  (mods: 1 Ctrl, 2 Alt, 4 Shift, 8 Meta)
 *        "type <base64 UTF-8>"
 *   out: "ready", "down", "up", "typed", "error <message>" (a "type" failed),
 *        "warning <message>"
 *
 * The hotkey is watched with libuiohook (uiohook-napi): on macOS through an
 * event tap, which needs Accessibility access for the app SF Agents runs in;
 * on Linux through X11's RECORD extension, so under Wayland it only sees
 * XWayland apps. The text is typed:
 *
 *   - macOS: pasted (clipboard, Cmd+V, clipboard put back);
 *   - Linux: with xdotool on X11, wtype or ydotool on Wayland (whichever is
 *     installed), as Unicode text;
 *   - Windows: pasted (clipboard, Ctrl+V, clipboard put back).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

interface UiohookModule {
  uIOhook: {
    on(event: 'keydown' | 'keyup', fn: (e: { keycode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) => void): void;
    start(): void;
    stop(): void;
    keyTap(key: number, modifiers?: number[]): void;
  };
  UiohookKey: Record<string, number>;
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ');

const { uIOhook, UiohookKey: K } = createRequire(import.meta.url)('uiohook-napi') as UiohookModule;
const MODIFIER: Record<number, number> = {
  [K['Ctrl']!]: 1, [K['CtrlRight']!]: 1, [K['Alt']!]: 2, [K['AltRight']!]: 2,
  [K['Shift']!]: 4, [K['ShiftRight']!]: 4, [K['Meta']!]: 8, [K['MetaRight']!]: 8,
};

let hotkey: { code: number; mods: number } | null = null;
let active = false;
const held = new Set<number>();

uIOhook.on('keydown', (e) => {
  const was = held.has(e.keycode);
  held.add(e.keycode);
  if (!hotkey || e.keycode !== hotkey.code || was || active) return;
  const mods = (e.ctrlKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  // A hotkey that is a right-hand modifier does not count itself as held.
  if ((mods & ~(MODIFIER[e.keycode] ?? 0)) !== hotkey.mods) return;
  active = true;
  out('down');
});
uIOhook.on('keyup', (e) => {
  held.delete(e.keycode);
  if (active && hotkey && e.keycode === hotkey.code) {
    active = false;
    out('up');
  }
});
uIOhook.start();

function has(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // xdotool reads the text in the locale's encoding: make that UTF-8.
    const locale = process.env['LC_ALL'] || process.env['LC_CTYPE'] || process.env['LANG'] || '';
    const env = /utf-?8/i.test(locale) ? process.env : { ...process.env, LC_ALL: 'C.UTF-8' };
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd}: ${err.trim() || `exit code ${code}`}`))));
  });
}

async function paste(text: string, modifier: number): Promise<void> {
  const { default: clipboard } = await import('clipboardy');
  const before = await clipboard.read().catch(() => null);
  await clipboard.write(text);
  await sleep(40);
  uIOhook.keyTap(K['V']!, [modifier]);
  // The app reads the clipboard as it handles the paste: give it a moment before putting it back.
  await sleep(400);
  if (before !== null) await clipboard.write(before).catch(() => {});
}

async function type(text: string): Promise<void> {
  // Typed while Ctrl or Alt is still held, the letters would be shortcuts.
  for (let i = 0; i < 150 && [...held].some((c) => c in MODIFIER); i++) await sleep(20);
  if (process.platform === 'darwin') return paste(text, K['Meta']!);
  if (process.platform === 'win32') return paste(text, K['Ctrl']!);
  const wayland = Boolean(process.env['WAYLAND_DISPLAY']);
  if (wayland && has('wtype')) return run('wtype', ['--', text]);
  if (!wayland && has('xdotool')) return run('xdotool', ['type', '--clearmodifiers', '--delay', '4', '--', text]);
  if (has('ydotool')) return run('ydotool', ['type', '--', text]);
  if (wayland && has('xdotool')) return run('xdotool', ['type', '--clearmodifiers', '--delay', '4', '--', text]);
  throw new Error(`Typing needs ${wayland ? 'wtype or ydotool' : 'xdotool'}; install it with your package manager.`);
}

const queue: string[] = [];
let busy = false;
async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const line = queue.shift()!;
    try {
      await handle(line);
    } catch (e) {
      // "error" answers a "type"; anything else is only worth a line in the log.
      out(`${line.startsWith('type ') ? 'error' : 'warning'} ${message(e)}`);
    }
  }
  busy = false;
}

async function handle(line: string): Promise<void> {
  const [command, ...rest] = line.split(' ');
  if (command === 'hotkey') {
    const [name, mods] = rest;
    if (!name || name === 'Off') hotkey = null;
    else {
      const code = K[name];
      if (code === undefined) throw new Error(`The keyboard hook has no key ${name}.`);
      hotkey = { code, mods: Number(mods) & 15 };
    }
    active = false;
  } else if (command === 'type') {
    await type(Buffer.from(rest.join(' '), 'base64').toString('utf8'));
    out('typed');
  } else throw new Error('Unsupported request.');
}

// Lines on stdin (not node:readline: the web package keeps out of terminal modules).
const decoder = new StringDecoder('utf8');
let pending = '';
process.stdin.on('data', (d: Buffer) => {
  pending += decoder.write(d);
  let nl: number;
  while ((nl = pending.indexOf('\n')) !== -1) {
    queue.push(pending.slice(0, nl).trim());
    pending = pending.slice(nl + 1);
  }
  void drain();
});
process.stdin.on('end', () => {
  uIOhook.stop();
  process.exit(0);
});
out('ready');
