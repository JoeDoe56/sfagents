/**
 * Windows: the signed PawnIO driver that CPU temperatures (and some storage
 * counters) are read through. SF Agents installs it at its first start, in
 * the same administrator approval as Remote Desktop's display driver, from
 * the official, pinned and checksum-verified installer (the same one
 * scripts/setup-sensors.ps1 uses).
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe';
const SHA256 = '1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032';

export function pawnioInstalled(): boolean {
  if (process.platform !== 'win32') return true;
  const r = spawnSync('sc.exe', ['query', 'PawnIO'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && /SERVICE_NAME/i.test(r.stdout ?? '');
}

/** Downloads the PawnIO installer; the step to run it silently, elevated. */
export async function pawnioStep(dir: string, fetchImpl: typeof fetch = fetch): Promise<{ file: string; args: string[] }> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'PawnIO_setup-2.2.0.exe');
  if (!fs.existsSync(file)) {
    const res = await fetchImpl(URL_, { headers: { 'User-Agent': 'SF-Agents' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`Downloading the PawnIO driver installer failed: HTTP ${res.status}.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (crypto.createHash('sha256').update(buf).digest('hex') !== SHA256) throw new Error('The PawnIO installer did not match its checksum.');
    fs.writeFileSync(file, buf);
  }
  return { file, args: ['-install', '-silent'] };
}
