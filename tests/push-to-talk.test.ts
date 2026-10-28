import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AppSettings, HOTKEY_KEYS, formatHotkey, parseHotkey, type Hotkey } from '@sfagents/core';
import { PushToTalk, SOUNDS_DIR, KeyboardProcess, windowsHotkeyLine, modifierMask, pcmToWav, readWav, windowsVirtualKey, type Chimes, type Keyboard, type KeyboardEvents, type Microphone } from '@sfagents/web';
import { makeTempDir } from './helpers.js';

describe('push-to-talk hotkeys', () => {
  test('hotkeys are parsed and written back in one form', () => {
    assert.deepEqual(parseHotkey('F13'), { modifiers: [], key: 'F13' });
    assert.deepEqual(parseHotkey('shift + ctrl+space'), { modifiers: ['Ctrl', 'Shift'], key: 'Space' });
    assert.deepEqual(parseHotkey('Cmd+Option+k'), { modifiers: ['Alt', 'Meta'], key: 'K' });
    assert.equal(parseHotkey('Off'), null);
    assert.equal(parseHotkey(''), null);
    assert.equal(formatHotkey(parseHotkey('alt+ctrlright')), 'Alt+CtrlRight');
    assert.equal(formatHotkey(null), 'Off');
    assert.throws(() => parseHotkey('Ctrl'), /not a key/);
    assert.throws(() => parseHotkey('Hyper+A'), /not a modifier/);
    assert.throws(() => parseHotkey('F25'), /not a key/);
  });

  test('the setting defaults to F13, is normalized, and rejects what no keyboard has', () => {
    const settings = new AppSettings(makeTempDir());
    assert.equal(settings.get('dictation.hotkey'), 'F13');
    settings.set({ 'dictation.hotkey': 'ctrl+shift+space' });
    assert.equal(settings.get('dictation.hotkey'), 'Ctrl+Shift+Space');
    settings.set({ 'dictation.hotkey': 'off' });
    assert.equal(settings.get('dictation.hotkey'), 'Off');
    assert.throws(() => settings.set({ 'dictation.hotkey': 'Ctrl+Banana' }), /Hotkey/);
    assert.throws(() => settings.set({ 'dictation.hotkey': 13 }), /Hotkey/);
  });

  test('every hotkey key has a Windows virtual key and a libuiohook code', () => {
    assert.equal(windowsVirtualKey('F13'), 0x7c);
    assert.equal(windowsVirtualKey('F24'), 0x87);
    assert.equal(windowsVirtualKey('A'), 0x41);
    assert.equal(windowsVirtualKey('7'), 0x37);
    assert.equal(windowsVirtualKey('Numpad3'), 0x63);
    assert.equal(windowsVirtualKey('CtrlRight'), 0xa3);
    assert.equal(modifierMask(parseHotkey('Ctrl+Alt+Shift+Meta+A')!), 15);
    const codes = new Set<number>();
    for (const k of HOTKEY_KEYS) codes.add(windowsVirtualKey(k));
    assert.equal(codes.size, HOTKEY_KEYS.length, 'no two keys share a virtual key');
    let uiohook: { UiohookKey: Record<string, number> } | null = null;
    try {
      // Loading libuiohook without a display fails the process on Linux.
      if (process.platform !== 'linux' || process.env['DISPLAY']) uiohook = createRequire(import.meta.url)('uiohook-napi');
    } catch {
      // the optional dependency is not installed for this platform
    }
    if (uiohook) for (const k of HOTKEY_KEYS) assert.equal(typeof uiohook.UiohookKey[k], 'number', k);
  });
});

describe('push-to-talk audio', () => {
  test('PCM goes into a WAV file and comes back out', () => {
    const pcm = Int16Array.from({ length: 1600 }, (_, i) => Math.round(Math.sin(i / 10) * 8000));
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.length, 44 + 3200);
    const back = readWav(wav);
    assert.equal(back.rate, 16000);
    assert.deepEqual(Array.from(back.samples), Array.from(pcm));
  });

  test('the two chimes are short, mono and not silent', () => {
    for (const name of ['ptt-start.wav', 'ptt-stop.wav']) {
      const { rate, samples } = readWav(fs.readFileSync(path.join(SOUNDS_DIR, name)));
      assert.equal(rate, 44100, name);
      const seconds = samples.length / rate;
      assert.ok(seconds > 0.3 && seconds < 0.6, `${name}: ${seconds}s`);
      assert.ok(samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0) > 4000, `${name} is audible`);
    }
  });
});

/** A keyboard, microphone and chimes that record what push-to-talk does with them. */
function fakes(seconds = 1) {
  const log: string[] = [];
  let events: KeyboardEvents | null = null;
  let hotkey: Hotkey | null = null;
  const keyboard = (e: KeyboardEvents): Keyboard => {
    events = e;
    return {
      setHotkey: (h) => {
        hotkey = h;
        log.push(`hotkey ${formatHotkey(h)}`);
      },
      type: async (text) => {
        log.push(`type ${text}`);
      },
      close: () => log.push('keyboard closed'),
    };
  };
  const microphone = (): Microphone => ({
    start: () => log.push('mic start'),
    stop: async () => {
      log.push('mic stop');
      return new Int16Array(Math.round(16000 * seconds));
    },
    close: () => log.push('mic closed'),
  });
  const chimes = (): Chimes => ({ play: (which) => log.push(`chime ${which}`), close: () => {} });
  return {
    log,
    keyboard,
    microphone,
    chimes,
    press: () => events!.down(),
    release: () => events!.up(),
    hotkey: () => hotkey,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('push-to-talk', () => {
  test('hold: start chime once recording; let go: stop chime, transcribe, type', async () => {
    const f = fakes();
    const wavs: Buffer[] = [];
    const ptt = new PushToTalk({
      transcribe: async (wav) => {
        wavs.push(wav);
        return '  Hello there. ';
      },
      keyboard: f.keyboard,
      microphone: f.microphone,
      chimes: f.chimes,
    });
    ptt.setHotkey('F13');
    assert.equal(ptt.status().state, 'idle');
    assert.equal(ptt.status().hotkey, 'F13');
    f.press();
    assert.equal(ptt.status().state, 'recording');
    f.press(); // a second "down" (auto-repeat) changes nothing
    f.release();
    await settle();
    assert.deepEqual(f.log, ['hotkey F13', 'mic start', 'chime start', 'mic stop', 'chime stop', 'type Hello there.']);
    assert.equal(wavs.length, 1);
    assert.equal(readWav(wavs[0]!).rate, 16000);
    assert.equal(ptt.status().state, 'idle');
    ptt.close();
  });

  test('a tap is not sent to the model', async () => {
    const f = fakes(0.1);
    let calls = 0;
    const ptt = new PushToTalk({ transcribe: async () => (calls++, 'x'), keyboard: f.keyboard, microphone: f.microphone, chimes: f.chimes });
    ptt.setHotkey('F13');
    f.press();
    f.release();
    await settle();
    assert.equal(calls, 0);
    assert.ok(f.log.includes('chime stop'));
    ptt.close();
  });

  test('nothing is typed when nothing was heard, and a failure is reported', async () => {
    const f = fakes();
    const answers = ['', new Error('llama-server is not running')];
    const ptt = new PushToTalk({
      transcribe: async () => {
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a ?? '';
      },
      keyboard: f.keyboard,
      microphone: f.microphone,
      chimes: f.chimes,
    });
    ptt.setHotkey('F13');
    f.press();
    f.release();
    await settle();
    assert.ok(!f.log.some((l) => l.startsWith('type')));
    f.press();
    f.release();
    await settle();
    assert.equal(ptt.status().error, 'llama-server is not running');
    ptt.close();
  });

  test('the hotkey follows the setting; Off and a bad value turn it off', () => {
    const f = fakes();
    const ptt = new PushToTalk({ transcribe: async () => '', keyboard: f.keyboard, microphone: f.microphone, chimes: f.chimes });
    ptt.setHotkey('Ctrl+Space');
    assert.deepEqual(f.hotkey(), { modifiers: ['Ctrl'], key: 'Space' });
    ptt.setHotkey('Off');
    assert.equal(f.hotkey(), null);
    assert.equal(ptt.status().state, 'off');
    ptt.setHotkey('F13');
    ptt.setHotkey('Nope+Nope');
    assert.equal(f.hotkey(), null);
    assert.equal(ptt.status().state, 'off');
    ptt.close();
  });

  test('without a keyboard hook it says why', () => {
    const ptt = new PushToTalk({
      transcribe: async () => '',
      keyboard: () => {
        throw new Error('The keyboard hook library is not installed');
      },
    });
    ptt.setHotkey('F13');
    assert.equal(ptt.status().state, 'unavailable');
    assert.match(ptt.status().error ?? '', /not installed/);
    ptt.close();
  });
});

/** Stands in for SfAgents.Input.exe: the same line protocol. */
const FAKE_INPUT = `
const fs = require('node:fs');
const out = process.argv[2];
const rl = require('node:readline').createInterface({ input: process.stdin });
process.stdout.write('ready\\n');
rl.on('line', (line) => {
  fs.appendFileSync(out, line + '\\n');
  if (line.startsWith('hotkey 124 ')) process.stdout.write('down\\nup\\n');
  else if (line.startsWith('type ')) {
    const text = Buffer.from(line.slice(5), 'base64').toString('utf8');
    process.stdout.write(text === 'fail' ? 'error that window refused\\n' : 'typed\\n');
  }
});
`;

describe('the Windows keyboard program protocol', () => {
  test('hotkey, down and up, typing; an elevated broker that fails falls back to the user level', async () => {
    const dir = makeTempDir();
    const script = path.join(dir, 'fake-input.cjs');
    const record = path.join(dir, 'lines.txt');
    fs.writeFileSync(script, FAKE_INPUT);
    const seen: string[] = [];
    const logs: string[] = [];
    let downs = 0;
    let ups = 0;
    const kb = new KeyboardProcess(
      { down: () => downs++, up: () => ups++, failed: (e) => seen.push(`failed ${e.message}`), log: (l) => logs.push(l) },
      // node --broker <pipe> fails at once, as an elevated worker that never connects would.
      { exe: process.execPath, args: [script, record], hotkeyLine: windowsHotkeyLine, elevated: { pipe: 'sfagents-input-test', approved: new Promise(() => {}) } },
    );
    try {
      kb.setHotkey(parseHotkey('F13'));
      for (let i = 0; i < 200 && downs === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(downs, 1);
      assert.equal(ups, 1);
      assert.equal(kb.elevated, false, 'running at the user level now');
      assert.ok(logs.some((l) => /elevated keyboard program stopped/.test(l)));
      await kb.type('Grüße, world');
      await assert.rejects(kb.type('fail'), /that window refused/);
      const lines = fs.readFileSync(record, 'utf8').trim().split('\n');
      assert.equal(lines[0], 'hotkey 124 0');
      assert.equal(Buffer.from(lines[1]!.slice(5), 'base64').toString('utf8'), 'Grüße, world');
      assert.deepEqual(seen, []);
    } finally {
      kb.close();
    }
  });
});
