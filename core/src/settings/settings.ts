/**
 * App settings: everything that is not an agent, an MCP server or a
 * provider. Stored as settings.json in the per-user folder; command-line
 * flags override them for one run. Each setting says whether it applies at
 * once or on the next start.
 */

import path from 'node:path';
import { formatHotkey, parseHotkey } from './hotkey.js';
import { readJsonFile, sfagentsHome, writeFileAtomic } from './home.js';

export type SettingValue = string | number | boolean | string[];

export interface SettingSpec {
  key: string;
  label: string;
  /** One line shown under the control. */
  hint: string;
  group: 'Web server' | 'Remote Desktop' | 'Push to Talk' | 'STT & TTS' | 'Terminal output';
  type: 'port' | 'host' | 'boolean' | 'hotkey' | 'number' | 'text' | 'origins';
  default: SettingValue;
  /** Applies on the next start of `sfagents web` (or `start`), not at once. */
  restart: boolean;
  /** Only meaningful on this platform. */
  platform?: NodeJS.Platform;
  /** A number's range and step. */
  min?: number;
  max?: number;
  step?: number;
}

export const SETTINGS: readonly SettingSpec[] = [
  { key: 'web.port', label: 'Port', hint: 'The port the web interface listens on.', group: 'Web server', type: 'port', default: 8093, restart: true },
  {
    key: 'web.host',
    label: 'Listen address',
    hint: '127.0.0.1 is this computer only. 0.0.0.0 (or a LAN or Tailscale address) lets other devices in: they get the agents, the files and the terminal.',
    group: 'Web server',
    type: 'host',
    default: '127.0.0.1',
    restart: true,
  },
  {
    key: 'web.publicOrigins',
    label: 'Public Origins',
    hint: 'Addresses a reverse proxy (or Tailscale Serve) shows the web interface at, such as https://sfagents.example.com. Pages there may use SF Agents.',
    group: 'Web server',
    type: 'origins',
    default: [],
    restart: true,
  },
  {
    key: 'dictation.hotkey',
    label: 'Hotkey',
    hint: 'Hold it to dictate into any app on this computer; let go to type what you said. Off turns push-to-talk off.',
    group: 'Push to Talk',
    type: 'hotkey',
    default: 'F13',
    restart: false,
  },
  {
    key: 'dictation.glossary',
    label: 'Glossary',
    hint: 'Names and terms Qwen3-ASR should spell your way, separated by commas.',
    group: 'STT & TTS',
    type: 'text',
    default: '',
    restart: false,
  },
  {
    key: 'speech.referenceText',
    label: 'Reference Transcript',
    hint: 'What is said in the reference voice clip (its first 15 seconds), which Qwen3-TTS needs to copy the voice. Qwen3-ASR fills it in when the clip is set; correct it where it misheard.',
    group: 'STT & TTS',
    type: 'text',
    default: '',
    restart: false,
  },
  { key: 'cli.showReasoning', label: 'Show reasoning', hint: 'Print model reasoning in the terminal when the provider returns it.', group: 'Terminal output', type: 'boolean', default: false, restart: false },
  { key: 'cli.showContext', label: 'Show context size', hint: 'Print the estimated size of each turn\'s working context in the terminal.', group: 'Terminal output', type: 'boolean', default: false, restart: false },
];

export class SettingsError extends Error {}

export function settingSpec(key: string): SettingSpec {
  const spec = SETTINGS.find((s) => s.key === key);
  if (!spec) throw new SettingsError(`Unknown setting "${key}". Settings: ${SETTINGS.map((s) => s.key).join(', ')}`);
  return spec;
}

/** Validates and normalizes one value (strings from the command line are accepted for every type). */
export function parseSetting(key: string, value: unknown): SettingValue {
  const spec = settingSpec(key);
  switch (spec.type) {
    case 'port': {
      const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) throw new SettingsError(`${spec.label} must be a whole number from 1 to 65535.`);
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'on' || value === '1') return true;
      if (value === 'false' || value === 'off' || value === '0') return false;
      throw new SettingsError(`${spec.label} must be true or false.`);
    }
    case 'host': {
      const s = typeof value === 'string' ? value.trim() : '';
      if (!s || s.length > 255 || /[\s/@]/.test(s)) throw new SettingsError(`${spec.label} must be an IP address or host name.`);
      return s;
    }
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n) || (spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        throw new SettingsError(`${spec.label} must be a number${spec.min !== undefined && spec.max !== undefined ? ` from ${spec.min} to ${spec.max}` : ''}.`);
      }
      return spec.step ? Number((Math.round(n / spec.step) * spec.step).toFixed(6)) : n;
    }
    case 'text': {
      if (typeof value !== 'string') throw new SettingsError(`${spec.label} must be text.`);
      if (value.length > 4000) throw new SettingsError(`${spec.label} is too long.`);
      return value.trim();
    }
    case 'origins': {
      // A list, or (from the command line) addresses separated by commas or spaces.
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
      if (!list || list.some((v) => typeof v !== 'string')) throw new SettingsError(`${spec.label} must be a list of addresses such as https://sfagents.example.com.`);
      const out: string[] = [];
      for (const v of list as string[]) {
        if (!v.trim()) continue;
        const origin = parseOrigin(v.trim());
        if (!origin) throw new SettingsError(`${spec.label}: "${v.trim()}" is not an http(s) address without a path, such as https://sfagents.example.com.`);
        if (!out.includes(origin)) out.push(origin);
      }
      if (out.length > 32) throw new SettingsError(`${spec.label}: at most 32 addresses.`);
      return out;
    }
    case 'hotkey': {
      if (typeof value !== 'string') throw new SettingsError(`${spec.label} must be a key, such as F13 or Ctrl+Shift+Space, or Off.`);
      try {
        return formatHotkey(parseHotkey(value));
      } catch (error) {
        throw new SettingsError(`${spec.label}: ${error instanceof Error ? error.message : String(error)}. Use a key such as F13 or Ctrl+Shift+Space, or Off.`);
      }
    }
  }
}

/** An HTTP(S) origin without credentials, a path, a query or a fragment, normalized; null when it is not one. */
export function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export class AppSettings {
  readonly file: string;

  constructor(dir: string = sfagentsHome()) {
    this.file = path.join(dir, 'settings.json');
  }

  /** Stored values only (unset settings are absent). */
  stored(): Record<string, SettingValue> {
    const raw = readJsonFile<Record<string, unknown>>(this.file, {});
    const out: Record<string, SettingValue> = {};
    for (const spec of SETTINGS) {
      if (!(spec.key in raw)) continue;
      try {
        out[spec.key] = parseSetting(spec.key, raw[spec.key]);
      } catch {
        // an invalid stored value falls back to the default
      }
    }
    return out;
  }

  get<T extends SettingValue>(key: string): T {
    const stored = this.stored();
    return (key in stored ? stored[key] : settingSpec(key).default) as T;
  }

  /** Every setting with its effective value. */
  all(): Array<SettingSpec & { value: SettingValue; isDefault: boolean }> {
    const stored = this.stored();
    return SETTINGS.map((s) => ({ ...s, value: key(stored, s), isDefault: !(s.key in stored) }));
    function key(st: Record<string, SettingValue>, s: SettingSpec) {
      return s.key in st ? st[s.key]! : s.default;
    }
  }

  /** Sets several values at once (null resets one to its default). Validates everything before writing. */
  set(values: Record<string, unknown>): void {
    const raw = readJsonFile<Record<string, unknown>>(this.file, {});
    const next: Record<string, unknown> = { ...raw };
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = parseSetting(k, v);
    }
    writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
  }
}
