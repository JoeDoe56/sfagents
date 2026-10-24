/**
 * Provider secrets (API keys, sign-in tokens) live only in the operating
 * system's keyring: Windows Credential Manager, the macOS Keychain, or the
 * Secret Service on Linux (GNOME Keyring, KWallet, KeePassXC). They are never
 * written to a file, sent to a model, or put in an agent's environment.
 *
 * Without a keyring, adding a provider is refused with an explanation. (The
 * Linux kernel keyring is not used: it forgets everything on reboot.)
 */

import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../utils/errors.js';

export const KEYRING_SERVICE = 'SF Agents';

export interface SecretStore {
  /** Throws KeyringUnavailableError (with the reason) when the store cannot be used. */
  check(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** A short description, e.g. "Windows Credential Manager". */
  readonly label: string;
}

export class KeyringUnavailableError extends Error {
  constructor(reason: string) {
    super(`No system keyring is available, so SF Agents can't store provider keys or sign-ins (it never writes them to a file). ${reason}`);
    this.name = 'KeyringUnavailableError';
  }
}

// Windows Credential Manager holds at most 2,560 bytes per credential (stored
// as UTF-16), so long values are split across numbered entries.
const CHUNK = 1000;

interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}
type EntryCtor = new (service: string, account: string, options?: unknown) => KeyringEntry;

// The Windows backend can lose writes/deletes when native tasks overlap,
// even for different entries. Share a queue across store instances and keep
// each operation (including chunked values and probes) together.
let keyringQueue: Promise<void> = Promise.resolve();

function platformLabel(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows Credential Manager';
  if (platform === 'darwin') return 'macOS Keychain';
  return 'Secret Service keyring';
}

function linuxHint(): string {
  return process.env['DBUS_SESSION_BUS_ADDRESS']
    ? 'Start a Secret Service provider (GNOME Keyring, KWallet or KeePassXC with Secret Service on) and unlock it, then try again.'
    : 'This session has no desktop bus (DBUS_SESSION_BUS_ADDRESS is not set), as on a headless server. Run SF Agents in a desktop session, or start one with a Secret Service provider (for example `dbus-run-session` with `gnome-keyring-daemon --unlock`).';
}

/** The OS keyring, through @napi-rs/keyring. */
export class KeyringSecretStore implements SecretStore {
  readonly label = platformLabel(process.platform);
  private ctor: Promise<EntryCtor> | null = null;

  // SFAGENTS_KEYRING_SERVICE keeps tests away from the real entries.
  constructor(private readonly service = process.env['SFAGENTS_KEYRING_SERVICE'] || KEYRING_SERVICE) {}

  private load(): Promise<EntryCtor> {
    this.ctor ??= import('@napi-rs/keyring')
      .then((m) => (m as unknown as { AsyncEntry: EntryCtor }).AsyncEntry)
      .catch((error: unknown) => {
        this.ctor = null;
        throw new KeyringUnavailableError(`The keyring module could not be loaded (${getErrorMessage(error)}). Reinstall SF Agents' dependencies.`);
      });
    return this.ctor;
  }

  private async entry(account: string): Promise<KeyringEntry> {
    const Entry = await this.load();
    try {
      return new Entry(this.service, account, process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): KeyringUnavailableError {
    const message = getErrorMessage(error);
    if (process.platform === 'linux') return new KeyringUnavailableError(linuxHint());
    return new KeyringUnavailableError(`The ${this.label} refused access (${message}).`);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = keyringQueue.then(fn);
    // A refused operation must not prevent the next attempt from running.
    keyringQueue = result.then(() => {}, () => {});
    return result;
  }

  async check(): Promise<void> {
    // Settings, sign-in and other processes may check the same store at once.
    // A shared entry lets one check delete another's value before it is read.
    await this.serial(async () => {
      const e = await this.entry(`sfagents-probe:${randomUUID()}`);
      await this.call(async () => {
        try {
          await e.setPassword('ok');
          if ((await e.getPassword()) !== 'ok') throw new Error('the keyring did not return what was stored');
        } finally {
          await e.deleteCredential();
        }
      });
    });
  }

  async get(key: string): Promise<string | null> {
    return this.serial(async () => {
      const head = await this.call(async () => (await this.entry(key)).getPassword());
      if (head === null) return null;
      const m = /^sfagents-chunks:(\d+)$/.exec(head);
      if (!m) return head;
      let out = '';
      for (let i = 0; i < Number(m[1]); i++) {
        const part = await this.call(async () => (await this.entry(`${key}#${i}`)).getPassword());
        if (part === null) return null;
        out += part;
      }
      return out;
    });
  }

  async set(key: string, value: string): Promise<void> {
    await this.serial(async () => {
      await this.erase(key);
      if (value.length <= CHUNK) {
        await this.call(async () => (await this.entry(key)).setPassword(value));
        return;
      }
      const parts = Math.ceil(value.length / CHUNK);
      for (let i = 0; i < parts; i++) {
        const part = value.slice(i * CHUNK, (i + 1) * CHUNK);
        await this.call(async () => (await this.entry(`${key}#${i}`)).setPassword(part));
      }
      await this.call(async () => (await this.entry(key)).setPassword(`sfagents-chunks:${parts}`));
    });
  }

  async delete(key: string): Promise<void> {
    await this.serial(() => this.erase(key));
  }

  private async erase(key: string): Promise<void> {
    const e = await this.entry(key);
    const head = await this.call(() => e.getPassword());
    if (head === null) return;
    const m = /^sfagents-chunks:(\d+)$/.exec(head);
    if (m) for (let i = 0; i < Number(m[1]); i++) await this.call(async () => (await this.entry(`${key}#${i}`)).deleteCredential());
    await this.call(() => e.deleteCredential());
  }
}

/** In-memory secrets, for tests and embedding. */
export class MemorySecretStore implements SecretStore {
  readonly label = 'memory';
  readonly values = new Map<string, string>();
  constructor(private readonly available = true) {}
  async check(): Promise<void> {
    if (!this.available) throw new KeyringUnavailableError('(test store marked unavailable)');
  }
  async get(key: string): Promise<string | null> {
    await this.check();
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.check();
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
