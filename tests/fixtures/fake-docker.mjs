#!/usr/bin/env node
// A stand-in for the docker CLI in tests (SFAGENTS_DOCKER points here). It
// keeps no engine: containers are entries in a state file, the bridge is SF
// Agents' real bridge program run as a local process, and a command "in" an
// agent container runs here with bash, with /run/sfa mapped to the agent's
// run folder and container paths mapped back to the folders they mount.
// Isolation is not tested here (tests/containers.test.ts checks the flags).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STATE_DIR = process.env.SFA_FAKE_DOCKER_STATE;
if (!STATE_DIR) {
  process.stderr.write('fake docker: SFA_FAKE_DOCKER_STATE is not set\n');
  process.exit(2);
}
fs.mkdirSync(path.join(STATE_DIR, 'agents'), { recursive: true });
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const BRIDGE = 'sfagents-bridge';

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { containers: {} };
  }
}
function save(state) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
const ok = (out = '') => {
  if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  process.exit(0);
};
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const after = (args, flag) => args[args.indexOf(flag) + 1];

/** Lets node programs in a command find /run/sfa (SF Agents' commands) in the agent's run folder. */
const PRELOAD = `'use strict';
const RUN = '/run/sfa';
const LOCAL = process.env.SFA_FAKE_RUN;
const map = (p) => (typeof p === 'string' && (p === RUN || p.startsWith(RUN + '/')) ? LOCAL + p.slice(RUN.length) : p);
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return resolve.call(this, map(request), ...rest); };
const net = require('node:net');
const connect = net.connect;
const mounts = JSON.parse(process.env.SFA_FAKE_MOUNTS || '[]');
const toContainer = (c) => {
  for (const [src, dst] of mounts) if (c === src || c.startsWith(src + '/')) return dst + c.slice(src.length);
  return c;
};
// SF Agents' commands send their folder as the container sees it.
net.connect = net.createConnection = function (target, ...rest) {
  const socket = connect.call(this, map(target), ...rest);
  if (typeof target === 'string' && target.startsWith(RUN)) {
    const write = socket.write;
    socket.write = function (data, ...more) {
      if (typeof data === 'string' && data.startsWith('{"argv"')) {
        const request = JSON.parse(data);
        if (typeof request.cwd === 'string') request.cwd = toContainer(request.cwd);
        data = JSON.stringify(request) + '\\n';
      }
      return write.call(this, data, ...more);
    };
  }
  return socket;
};
`;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Bind mounts of a container, longest container path first: [hostPath, containerPath]. */
function mountsOf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--mount') continue;
    const fields = Object.fromEntries(args[i + 1].split(',').map((kv) => kv.split('=')));
    if (fields.type === 'bind' && fields.src && fields.src !== '/dev/null') out.push([fields.src, fields.dst]);
  }
  return out.sort((a, b) => b[1].length - a[1].length);
}

function toHost(p, mounts) {
  for (const [src, dst] of mounts) if (p === dst || p.startsWith(`${dst}/`)) return src + p.slice(dst.length);
  return p;
}

function runAgentCommand(container, job, env) {
  const run = path.join(STATE_DIR, 'agents', container.cid);
  fs.mkdirSync(path.join(run, 'exec'), { recursive: true });
  const preload = path.join(STATE_DIR, 'preload.cjs');
  if (!fs.existsSync(preload)) fs.writeFileSync(preload, PRELOAD);
  const home = path.join(STATE_DIR, 'home', container.cid);
  fs.mkdirSync(home, { recursive: true });
  const cwd = env.SFA_CWD ? toHost(env.SFA_CWD, container.mounts) : process.cwd();
  const script = [
    'echo $$ > "$SFA_FAKE_RUN/exec/$0.pid"',
    `trap 'rm -f "$SFA_FAKE_RUN/exec/$0.pid"' EXIT`,
    'cd "$SFA_FAKE_CWD" 2>/dev/null || { echo "The directory $SFA_CWD does not exist in the container (create it first, e.g. mkdir -p, or run from /workspaces)." >&2; exit 1; }',
    'unset SFA_CWD SFA_FAKE_CWD',
    '__sfa_c=$SFA_COMMAND; unset SFA_COMMAND; eval "$__sfa_c"',
  ].join('\n');
  const child = spawn('bash', ['-c', script, job], {
    stdio: 'inherit',
    detached: true,
    // A container does not inherit SF Agents' environment.
    env: {
      HOME: home,
      LANG: 'C.UTF-8',
      ...env,
      SFA_FAKE_CWD: cwd,
      SFA_FAKE_RUN: run,
      SFA_FAKE_MOUNTS: JSON.stringify(container.mounts),
      PATH: `${path.join(run, 'bin')}:${process.env.PATH}`,
      NODE_OPTIONS: `--require ${preload}`,
    },
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
}

function killJob(container, job) {
  const file = path.join(STATE_DIR, 'agents', container.cid, 'exec', `${job}.pid`);
  let pid;
  try {
    pid = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return ok();
  }
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
  let tries = 0;
  const timer = setInterval(() => {
    if (!alive() || ++tries > 10) {
      clearInterval(timer);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      fs.rmSync(file, { force: true });
      ok();
    }
  }, 200);
}

async function exec(args) {
  const env = {};
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-i' || a === '-t' || a === '-d') continue;
    if (a === '-u' || a === '-w') {
      i++;
      continue;
    }
    if (a === '-e') {
      const kv = args[++i];
      const eq = kv.indexOf('=');
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    break;
  }
  const name = args[i];
  const cmd = args.slice(i + 1);
  const state = load();
  const container = state.containers[name];
  if (!container || !container.running) fail(`Error response from daemon: No such container: ${name}`);
  if (name === BRIDGE) {
    const bridgeFile = path.join(STATE_DIR, 'bridge.cjs');
    if (cmd[0] === 'sh') {
      fs.writeFileSync(bridgeFile, await readStdin());
      return ok();
    }
    const child = spawn(process.execPath, [bridgeFile], { stdio: 'inherit', env: { ...process.env, SFA_RUN: path.join(STATE_DIR, 'agents') } });
    process.on('SIGTERM', () => child.kill());
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }
  if (cmd[0] === '/run/sfa/bin/sfa-exec') return runAgentCommand(container, cmd[1], env);
  if (cmd[0] === '/run/sfa/bin/sfa-kill') return killJob(container, cmd[1]);
  return ok();
}

async function main() {
  const args = process.argv.slice(2);
  const state = load();
  switch (args[0]) {
    case 'image':
      return ok('sha256:fake');
    case 'pull':
    case 'volume':
    case 'network':
      return ok();
    case 'container': {
      if (args[1] !== 'inspect') return ok();
      const name = args.at(-1);
      const c = state.containers[name];
      if (!c) fail(`Error: No such container: ${name}`);
      const format = after(args, '--format') ?? '';
      return ok(format.includes('sfagents.spec') ? `${c.label ?? ''} ${c.running}` : String(c.running));
    }
    case 'run':
    case 'create': {
      const name = after(args, '--name');
      const label = args.find((a) => a.startsWith('sfagents.spec='))?.slice('sfagents.spec='.length);
      const cid = args.find((a) => a.startsWith('SFA_AGENT='))?.slice('SFA_AGENT='.length);
      state.containers[name] = { label, cid, running: args[0] === 'run', mounts: mountsOf(args) };
      save(state);
      return ok();
    }
    case 'start':
      for (const n of args.slice(1)) if (state.containers[n]) state.containers[n].running = true;
      save(state);
      return ok();
    case 'kill':
    case 'stop':
      for (const n of args.slice(1)) if (state.containers[n]) state.containers[n].running = false;
      save(state);
      return ok();
    case 'rm':
      for (const n of args.slice(1).filter((a) => !a.startsWith('-'))) delete state.containers[n];
      save(state);
      return ok();
    case 'ps':
      return ok(Object.entries(state.containers).filter(([n, c]) => c.running && n !== BRIDGE).map(([n]) => n).join('\n'));
    case 'exec':
      return exec(args);
    default:
      return ok();
  }
}

await main();
