/**
 * App settings: everything that is not an agent, an MCP server or a
 * provider. Stored as settings.json in the per-user folder; command-line
 * flags override them for one run. Each setting says whether it applies at
 * once or on the next start.
 */

import path from 'node:path';
import { readJsonFile, sfagentsHome, writeFileAtomic } from './home.js';

export type SettingValue = string | number | boolean;

export interface SettingSpec {
  key: string;
  label: string;
  /** One line shown under the control. */
  hint: string;
  group: 'Web server' | 'Remote Desktop' | 'Hardware sensors' | 'Terminal output';
  type: 'port' | 'host' | 'boolean' | 'lhm' | 'server';
  default: SettingValue;
  /** Applies on the next start of `sfagents web` (or `start`), not at once. */
  restart: boolean;
  /** Only meaningful on this platform. */
  platform?: NodeJS.Platform;
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
    key: 'remote.server',
    label: 'MoonlightWeb',
    hint: '"auto" finds MoonlightWeb on this computer (or starts the one installed); or the local address of a MoonlightWeb server, such as http://127.0.0.1:8080.',
    group: 'Remote Desktop',
    type: 'server',
    default: 'auto',
    restart: false,
  },
  {
    key: 'sensors.lhm',
    label: 'Sensor source',
    hint: '"auto" uses the bundled sensors; "off" uses the operating system\'s readings only; or the address of a Libre Hardware Monitor web server.',
    group: 'Hardware sensors',
    type: 'lhm',
    default: 'auto',
    restart: true,
  },
  {
    key: 'sensors.admin',
    label: 'Elevated sensor helper',
    hint: 'Ask to elevate only the read-only sensor helper (CPU temperatures need it on Windows).',
    group: 'Hardware sensors',
    type: 'boolean',
    default: process.platform === 'win32',
    restart: true,
    platform: 'win32',
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
    case 'server': {
      const s = typeof value === 'string' ? value.trim() : '';
      if (s === 'auto') return s;
      try {
        const u = new URL(s);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/') return u.origin;
      } catch {
        // fall through
      }
      throw new SettingsError(`${spec.label} must be "auto" or an http(s) address with no path.`);
    }
    case 'lhm': {
      const s = typeof value === 'string' ? value.trim() : '';
      if (s === 'auto' || s === 'off') return s;
      try {
        const u = new URL(s);
        if (u.protocol === 'http:' || u.protocol === 'https:') return s;
      } catch {
        // fall through
      }
      throw new SettingsError(`${spec.label} must be "auto", "off" or an http(s) address.`);
    }
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
