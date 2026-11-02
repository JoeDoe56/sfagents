/**
 * `sfagents containers setup|status`: gets this machine ready to run agents
 * in containers. On Windows that is SF Agents' own WSL distro (no
 * administrator rights) plus a few .wslconfig settings; everywhere it pulls
 * the agent image once. Nothing here restarts WSL: a changed .wslconfig takes
 * effect after the person runs `wsl --shutdown` (which also restarts Docker
 * Desktop's containers), so they choose when.
 */

import fs from 'node:fs';
import {
  containerManager,
  getErrorMessage,
  mergeWslConfig,
  setupDistro,
  wslConfigPath,
  wslStatus,
  WSLCONFIG_SETTINGS,
} from '@sfagents/core';
import type { Streams } from './main.js';

const SETUP_HELP = `Usage: sfagents containers [status|setup]
  status   Show whether agent containers can run here
  setup    Windows: create the sfagents WSL distro and add its .wslconfig settings;
           all systems: download the agent image (about 4 GB, once)`;

export async function containersCommand(args: string[], streams: Streams): Promise<number> {
  const [action = 'status'] = args;
  const out = (line: string) => streams.stdout.write(`${line}\n`);
  try {
    if (action === 'status') return await status(out);
    if (action === 'setup') return await setup(out);
    streams.stderr.write(`${SETUP_HELP}\n`);
    return 2;
  } catch (error) {
    streams.stderr.write(`${getErrorMessage(error)}\n`);
    return 1;
  }
}

async function status(out: (line: string) => void): Promise<number> {
  if (process.platform === 'win32') {
    const s = await wslStatus();
    const text = {
      ready: 'The sfagents WSL distro and its Docker Engine are running.',
      'no-wsl': `WSL is not available${'detail' in s ? `: ${s.detail}` : ''}.`,
      'no-distro': 'The sfagents WSL distro is not set up. Run: sfagents containers setup',
      'no-docker': `The sfagents distro is there but its Docker Engine does not answer${'detail' in s ? `: ${s.detail}` : ''}.`,
    }[s.state];
    out(text);
    if (s.state !== 'ready') return 1;
  }
  const manager = containerManager();
  const image = await manager.cli.run(['image', 'inspect', '--format', '{{.Id}}', manager.image]);
  if (image.code !== 0 && /cannot connect|is the docker daemon running|not found/i.test(image.stderr)) {
    out(`Docker does not answer: ${image.stderr.trim()}`);
    return 1;
  }
  out(image.code === 0 ? `Agent image ${manager.image} is downloaded.` : `Agent image ${manager.image} is not downloaded yet. Run: sfagents containers setup`);
  return image.code === 0 ? 0 : 1;
}

async function setup(out: (line: string) => void): Promise<number> {
  if (process.platform === 'win32') {
    const file = wslConfigPath();
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const { text, changed } = mergeWslConfig(before, WSLCONFIG_SETTINGS);
    if (changed.length) {
      if (before) fs.copyFileSync(file, `${file}.sfagents-backup`);
      fs.writeFileSync(file, text);
      out(`Added to ${file}: ${changed.join(', ')}.`);
      if (before) out(`The previous file is saved as ${file}.sfagents-backup (copy it back to undo).`);
      out('These take effect after "wsl --shutdown", which also restarts Docker Desktop (Immich). Run it when that suits you.');
    }
    await setupDistro({ report: out });
  }
  const manager = containerManager({ log: out });
  await manager.ensureImage();
  out(`Agent image ${manager.image} is ready.`);
  out('Start SF Agents with SFAGENTS_CONTAINERS=1 to run agents in containers.');
  return 0;
}
