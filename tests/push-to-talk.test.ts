import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AppSettings, HOTKEY_KEYS, formatHotkey, parseHotkey, type Hotkey } from '@sfagents/core';
import { PushToTalk, Segmenter, joinPiece, SOUNDS_DIR, hasSpeech, isFiller, KeyboardProcess, KEYBOARD_WORKER, namedHotkeyLine, windowsHotkeyLine, modifierMask, pcmToWav, readWav, windowsVirtualKey, type Chimes, type Keyboard, type KeyboardEvents, type Microphone } from '@sfagents/web';
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
  test('silence, and the start chime alone, are not speech', () => {
    assert.equal(hasSpeech(speech(2), 16000), true);
    assert.equal(hasSpeech(speech(2, false), 16000), false);
    assert.equal(hasSpeech(new Int16Array(32000), 16000), false);
    // A loud chime in the first half second, then quiet.
    const chimeOnly = speech(2, false);
    for (let i = 1600; i < 8000; i++) chimeOnly[i] = Math.round(Math.sin(i / 5) * 8000);
    assert.equal(hasSpeech(chimeOnly, 16000), false);
  });

  test('a hesitation alone is not typed', () => {
    for (const t of ['嗯。', 'Um.', 'uh...', '。', 'Hmm']) assert.equal(isFiller(t), true, t);
    for (const t of ['Hello.', '你好', 'Um, hello']) assert.equal(isFiller(t), false, t);
  });

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

/** A recording: quiet room noise, then a loud tone from 0.8 s on (stands in for speech). */
function speech(seconds: number, loud = true): Int16Array {
  return Int16Array.from({ length: Math.round(16000 * seconds) }, (_, i) =>
    Math.round((Math.random() - 0.5) * 60 + (loud && i > 16000 * 0.8 ? Math.sin(i / 7) * 6000 : 0)),
  );
}

/** A keyboard, microphone and chimes that record what push-to-talk does with them. */
function fakes(seconds = 2) {
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
      return speech(seconds);
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

const xdotool = process.platform === 'linux' && Boolean(process.env['DISPLAY']) && spawnSync('which', ['xdotool']).status === 0;
describe('the keyboard worker on X11', { skip: !xdotool && 'needs an X display and xdotool' }, () => {
  test('sees the hotkey go down and up, and only with its modifiers', async () => {
    let downs = 0;
    let ups = 0;
    const logs: string[] = [];
    const kb = new KeyboardProcess(
      { down: () => downs++, up: () => ups++, failed: (e) => logs.push(e.message), log: (l) => logs.push(l) },
      { exe: process.execPath, args: [KEYBOARD_WORKER], hotkeyLine: namedHotkeyLine },
    );
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 30));
    };
    try {
      kb.setHotkey(parseHotkey('Ctrl+F9'));
      await new Promise((r) => setTimeout(r, 800));
      spawnSync('xdotool', ['key', 'F9']);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(downs, 0, 'F9 without Ctrl is not the hotkey');
      spawnSync('xdotool', ['keydown', 'ctrl+F9']);
      await until(() => downs === 1);
      spawnSync('xdotool', ['keyup', 'F9']);
      spawnSync('xdotool', ['keyup', 'ctrl']);
      await until(() => ups === 1);
      assert.deepEqual([downs, ups], [1, 1], logs.join(' | '));
    } finally {
      kb.close();
    }
  });
});

/** Quiet room noise and loud tones (speech) of the given lengths, alternating, starting quiet. */
function talk(...seconds: number[]): Int16Array {
  const out: number[] = [];
  seconds.forEach((s, k) => {
    for (let i = 0; i < Math.round(16000 * s); i++) out.push(Math.round((Math.random() - 0.5) * 60 + (k % 2 ? Math.sin(i / 7) * 6000 : 0)));
  });
  return Int16Array.from(out);
}

function frames(pcm: Int16Array, size = 512): Int16Array[] {
  const out: Int16Array[] = [];
  for (let at = 0; at < pcm.length; at += size) out.push(pcm.subarray(at, at + size));
  return out;
}

describe('push-to-talk as you speak', () => {
  test('the recording is cut at each half-second pause, and a long one without a pause at twelve seconds', () => {
    const seg = new Segmenter(16000);
    const pieces = frames(talk(1, 1.5, 0.8, 1, 0.3, 0.5)).flatMap((f) => seg.push(f));
    assert.equal(pieces.length, 1, 'cut at the 0.8 s pause, not at the 0.3 s one');
    assert.equal(pieces[0]!.start, 0);
    assert.ok(Math.abs(pieces[0]!.pcm.length / 16000 - 3) < 0.1, `first piece: ${pieces[0]!.pcm.length / 16000} s`);
    const rest = seg.flush();
    assert.equal(rest.length, 1, 'the rest at the end');
    assert.ok(Math.abs(rest[0]!.start - pieces[0]!.pcm.length / 16000) < 0.001, 'it starts where the first ends');
    assert.ok(hasSpeech(rest[0]!.pcm, 16000, 0));
    const long = new Segmenter(16000);
    const cut = frames(talk(0.8, 20)).flatMap((f) => long.push(f));
    assert.equal(cut.length, 1);
    assert.ok(cut[0]!.pcm.length / 16000 <= 12.01 && cut[0]!.pcm.length / 16000 > 8.9);
    // Quiet before anything is said is not kept.
    const quiet = new Segmenter(16000);
    assert.deepEqual(frames(talk(6)).flatMap((f) => quiet.push(f)), []);
    assert.ok(quiet.flush()[0]!.pcm.length / 16000 < 2.1);
  });

  test('pieces follow each other with a space where the writing has spaces', () => {
    assert.equal(joinPiece('', 'Hello.'), 'Hello.');
    assert.equal(joinPiece('Hello.', 'How are you?'), ' How are you?');
    assert.equal(joinPiece('Hello ', 'there'), 'there');
    assert.equal(joinPiece('Hello', ', there'), ', there');
    assert.equal(joinPiece('你好。', '我很好'), '我很好');
  });

  /** A microphone that hands push-to-talk its frames as a test feeds them. */
  function liveMic(log: string[]) {
    let onFrame: ((f: Int16Array) => void) | undefined;
    const mic = (): Microphone => ({
      start: (f) => {
        onFrame = f;
        log.push('mic start');
      },
      stop: async () => {
        log.push('mic stop');
        return new Int16Array(0);
      },
      close: () => {},
    });
    return { mic, feed: (pcm: Int16Array) => frames(pcm).forEach((f) => onFrame!(f)) };
  }

  test('each phrase is typed while the key is still held, the last one when it is let go', async () => {
    const f = fakes();
    const live = liveMic(f.log);
    const heard: Array<string | undefined> = [];
    const answers = ['First phrase.', 'Second phrase.'];
    const ptt = new PushToTalk({
      transcribe: async (_wav, previous) => {
        heard.push(previous);
        return answers.shift() ?? '';
      },
      keyboard: f.keyboard,
      microphone: live.mic,
      chimes: f.chimes,
    });
    ptt.setHotkey('F13');
    f.press();
    live.feed(talk(1, 1.5, 0.8));
    await settle();
    assert.ok(f.log.includes('type First phrase.'), 'typed before the key is let go');
    assert.ok(!f.log.includes('mic stop'));
    assert.equal(ptt.status().state, 'recording');
    live.feed(talk(0, 1.2, 0.2));
    f.release();
    await settle();
    assert.deepEqual(f.log.filter((l) => l.startsWith('type')), ['type First phrase.', 'type  Second phrase.']);
    assert.deepEqual(heard, [undefined, 'First phrase.'], 'the phrase before as context');
    assert.equal(ptt.status().state, 'idle');
    ptt.close();
  });

  test('with a modifier in the hotkey, the phrases are typed when it is let go', async () => {
    const f = fakes();
    const live = liveMic(f.log);
    const answers = ['One.', 'Two.'];
    const ptt = new PushToTalk({ transcribe: async () => answers.shift() ?? '', keyboard: f.keyboard, microphone: live.mic, chimes: f.chimes });
    ptt.setHotkey('Ctrl+Space');
    f.press();
    live.feed(talk(1, 1.5, 0.8, 1, 0.2));
    await settle();
    assert.ok(!f.log.some((l) => l.startsWith('type')), 'nothing typed while Ctrl is held');
    f.release();
    await settle();
    assert.deepEqual(f.log.filter((l) => l.startsWith('type')), ['type One. Two.']);
    ptt.close();
  });
});
