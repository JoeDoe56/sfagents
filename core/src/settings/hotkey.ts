/**
 * Push-to-talk hotkeys as the Settings sheet stores them: modifiers, then
 * one key, joined with "+" ("F13", "Ctrl+Shift+Space", "CtrlRight"), or
 * "Off". The key names are the ones every platform's keyboard hook maps
 * (web/src/push-to-talk.ts maps each to libuiohook's codes and to Windows'
 * virtual keys).
 */

export const HOTKEY_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
export type HotkeyModifier = (typeof HOTKEY_MODIFIERS)[number];

export const HOTKEY_KEYS: readonly string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen',
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal',
  'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote',
  // The right-hand modifiers, held on their own.
  'CtrlRight', 'AltRight', 'ShiftRight', 'MetaRight',
];

export const HOTKEY_OFF = 'Off';

export interface Hotkey {
  modifiers: HotkeyModifier[];
  key: string;
}

const ALIASES: Record<string, string> = {
  control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Meta', win: 'Meta', windows: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta',
};

/** The hotkey a setting names, or null for "Off". Throws on anything else. */
export function parseHotkey(value: string): Hotkey | null {
  const s = value.trim();
  if (!s || s.toLowerCase() === 'off' || s.toLowerCase() === 'none') return null;
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty');
  const keyName = parts.pop()!;
  const key = HOTKEY_KEYS.find((k) => k.toLowerCase() === keyName.toLowerCase());
  if (!key) throw new Error(`"${keyName}" is not a key push-to-talk can use`);
  const modifiers = new Set<HotkeyModifier>();
  for (const p of parts) {
    const m = ALIASES[p.toLowerCase()];
    if (!m) throw new Error(`"${p}" is not a modifier (Ctrl, Alt, Shift or Meta)`);
    modifiers.add(m as HotkeyModifier);
  }
  return { modifiers: HOTKEY_MODIFIERS.filter((m) => modifiers.has(m)), key };
}

export function formatHotkey(hotkey: Hotkey | null): string {
  return hotkey ? [...hotkey.modifiers, hotkey.key].join('+') : HOTKEY_OFF;
}
