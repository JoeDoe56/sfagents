/**
 * Opens an address in this computer's default browser (for sign-ins, which
 * must finish on the computer SF Agents runs on).
 */

import { spawn } from 'node:child_process';

export function openInBrowser(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.resolve(false);
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', u.href]]
      : process.platform === 'darwin'
        ? ['open', [u.href]]
        : ['xdg-open', [u.href]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
