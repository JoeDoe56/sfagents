import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  AgentRuntime,
  buildSandboxPolicy,
  bubblewrapCommand,
  detectSandbox,
  findPython,
  landlockCommand,
  LINUX_SYSTEM_PATHS,
  loadAgentTree,
  seatbeltProfile,
  setSandboxForTesting,
  ToolErrorType,
  WorkspaceContext,
  type AnyDeclarativeTool,
  type ToolResult,
} from '@sfagents/core';
import { baseAgent, makeTempDir, writeAgent } from './helpers.js';

const status = await detectSandbox();
const linuxSandbox = process.platform === 'linux' && status.ok;

interface Fixture {
  dir: string;
  outside: string;
  home: string;
  tools: Map<string, AnyDeclarativeTool>;
}

/** A project whose root is the workspace (".", the default), so its own files sit inside it. */
async function fixture(extra: Record<string, unknown> = {}): Promise<Fixture> {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=sk-env-secret\n');
  fs.mkdirSync(path.join(dir, '.sfagents'));
  fs.writeFileSync(path.join(dir, '.sfagents', 'conversation.md'), 'private conversation\n');
  const outside = makeTempDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
  const home = makeTempDir('sfagents-home-');
  fs.writeFileSync(path.join(home, '.ssh-key'), 'PRIVATE KEY\n');
  writeAgent(dir, baseAgent('main', { tools: { allow: ['shell'], ...(extra['tools'] as object) }, ...(extra['workspace'] ? { workspace: extra['workspace'] } : {}) }));
  return { dir, outside, home, tools: await buildTools(dir) };
}

async function buildTools(dir: string): Promise<Map<string, AnyDeclarativeTool>> {
  const tree = loadAgentTree(dir);
  const runtime = new AgentRuntime({ tree, providerFactory: () => { throw new Error('unused'); } });
  return runtime.buildTools(tree.root, ['main'], () => {});
}

async function sh(f: Fixture, command: string): Promise<{ permission: string; result: ToolResult; reason?: string }> {
  const invocation = f.tools.get('shell')!.build({ command });
  const permission = await invocation.getDefaultPermission();
  const savedHome = process.env['HOME'];
  process.env['HOME'] = f.home;
  try {
    return { permission, reason: invocation.getDenialReason?.(), result: await invocation.execute(new AbortController().signal) };
  } finally {
    process.env['HOME'] = savedHome;
  }
}

const stdout = (r: ToolResult) => /Stdout: ([\s\S]*?)\nStderr:/.exec(r.llmContent)?.[1] ?? '';
/** What the command printed (the result without its echo of the command). */
const output = (r: ToolResult) => r.llmContent.split('\n').slice(1).join('\n');
const exitCode = (r: ToolResult) => Number(/Exit Code: (\d+)/.exec(r.llmContent)?.[1] ?? NaN);

describe('sandbox escapes (Linux, bubblewrap)', { skip: !linuxSandbox && 'bubblewrap is not available' }, () => {
  test('the workspace is readable and writable', async () => {
    const f = await fixture();
    const r = await sh(f, 'cat src/a.txt && echo made > src/new.txt && pwd');
    assert.equal(exitCode(r.result), 0, r.result.llmContent);
    assert.match(stdout(r.result), /alpha/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'src', 'new.txt'), 'utf8'), 'made\n');
  });

  test('system folders are readable but not writable', async () => {
    const f = await fixture();
    const r = await sh(f, 'ls /usr/bin >/dev/null && echo listed; touch /usr/sfagents-escape 2>/dev/null || echo blocked');
    assert.match(stdout(r.result), /listed\nblocked/);
    assert.equal(fs.existsSync('/usr/sfagents-escape'), false);
  });

  test('files outside the workspace cannot be read or written', async () => {
    const f = await fixture();
    const r = await sh(f, `cat ${f.outside}/secret.txt; echo x > ${f.outside}/planted.txt; ls ${f.outside}`);
    assert.doesNotMatch(output(r.result), /TOP SECRET/);
    assert.equal(fs.existsSync(path.join(f.outside, 'planted.txt')), false);
  });

  test('the home folder is empty', async () => {
    const f = await fixture();
    const r = await sh(f, 'echo "home=$HOME"; ls -A "$HOME"; cat "$HOME/.ssh-key"');
    assert.match(stdout(r.result), new RegExp(`home=${f.home}`));
    assert.doesNotMatch(output(r.result), /PRIVATE KEY|\.ssh-key\n/);
  });

  test('symlinks that leave the workspace lead nowhere', async () => {
    const f = await fixture();
    fs.symlinkSync(path.join(f.outside, 'secret.txt'), path.join(f.dir, 'link.txt'));
    fs.symlinkSync(f.outside, path.join(f.dir, 'linkdir'));
    const r = await sh(f, 'cat link.txt; cat linkdir/secret.txt; echo x > linkdir/planted.txt');
    assert.doesNotMatch(output(r.result), /TOP SECRET/);
    assert.equal(fs.existsSync(path.join(f.outside, 'planted.txt')), false);
  });

  test('.env and conversation state are hidden and cannot be replaced', async () => {
    const f = await fixture();
    const r = await sh(f, 'cat .env; ls -A .sfagents; cat .sfagents/conversation.md; echo NODE_OPTIONS=--require=/x > .env; rm -f .env; mv .env gone; echo forged > .sfagents/conversation.md');
    assert.doesNotMatch(output(r.result), /sk-env-secret|private conversation|conversation\.md\n/);
    assert.equal(fs.readFileSync(path.join(f.dir, '.env'), 'utf8'), 'OPENROUTER_API_KEY=sk-env-secret\n');
    assert.equal(fs.readFileSync(path.join(f.dir, '.sfagents', 'conversation.md'), 'utf8'), 'private conversation\n');
  });

  test('agents and mcp.json are read-only, and a missing mcp.json is created first so it can be protected', async () => {
    const f = await fixture();
    const before = fs.readFileSync(path.join(f.dir, 'agents', 'main.json'), 'utf8');
    const r = await sh(f, 'cat agents/main.json >/dev/null && echo readable; echo {} > agents/main.json; echo {} > agents/evil.json; echo \'{"mcpServers":{"x":{"command":"sh"}}}\' > mcp.json; rm -rf agents');
    assert.match(stdout(r.result), /readable/);
    assert.equal(fs.readFileSync(path.join(f.dir, 'agents', 'main.json'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(f.dir, 'agents', 'evil.json')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'mcp.json'), 'utf8')), { mcpServers: {} });
  });

  test('git hooks and config are read-only; the rest of .git is writable', async () => {
    const f = await fixture();
    fs.mkdirSync(path.join(f.dir, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(f.dir, '.git', 'objects'));
    fs.writeFileSync(path.join(f.dir, '.git', 'config'), '[core]\n');
    // The policy is built with the tools: rebuild them now that .git exists.
    const g = { ...f, tools: await buildTools(f.dir) };
    await sh(g, 'echo "#!/bin/sh" > .git/hooks/pre-commit; printf "[core]\\n\\thooksPath = /tmp\\n" > .git/config; echo blob > .git/objects/x');
    assert.equal(fs.existsSync(path.join(f.dir, '.git', 'hooks', 'pre-commit')), false);
    assert.equal(fs.readFileSync(path.join(f.dir, '.git', 'config'), 'utf8'), '[core]\n');
    assert.equal(fs.readFileSync(path.join(f.dir, '.git', 'objects', 'x'), 'utf8'), 'blob\n');
  });

  test('there is no network unless the agent allows it', async () => {
    const f = await fixture();
    const r = await sh(f, 'ls /sys/class/net 2>/dev/null; cat /proc/net/dev | tail -n +3 | cut -d: -f1');
    assert.doesNotMatch(stdout(r.result), /eth|ens|enp|wlan/);
    const online = await fixture({ workspace: { roots: ['.'], network: true } });
    const policy = (online.tools.get('shell') as unknown as { ctx: { sandbox: { network: boolean } } }).ctx.sandbox;
    assert.equal(policy.network, true);
  });

  test('background processes do not outlive the command', async () => {
    const f = await fixture();
    const r = await sh(f, '(sleep 2; echo late > late.txt) & echo started');
    assert.match(stdout(r.result), /started/);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(fs.existsSync(path.join(f.dir, 'late.txt')), false);
  });
});

describe('workspace.access (Linux, bubblewrap)', { skip: !linuxSandbox && 'bubblewrap is not available' }, () => {
  test('entries share folders read-only, read-write or not at all; the longest path wins', async () => {
    const shared = makeTempDir();
    fs.writeFileSync(path.join(shared, 'lib.txt'), 'shared lib\n');
    const drop = makeTempDir();
    const f = await fixture({
      workspace: {
        roots: ['.'],
        access: [
          { path: shared, mode: 'read' },
          { path: drop, mode: 'write' },
          { path: 'private', mode: 'none' },
          { path: 'src', mode: 'read' },
        ],
      },
    });
    fs.mkdirSync(path.join(f.dir, 'private'));
    fs.writeFileSync(path.join(f.dir, 'private', 'diary.txt'), 'dear diary\n');
    const g = { ...f, tools: await buildTools(f.dir) };
    const r = await sh(g, `cat ${shared}/lib.txt; echo x > ${shared}/planted.txt; echo out > ${drop}/out.txt; cat private/diary.txt; echo y > src/a.txt; echo z > top.txt`);
    assert.match(stdout(r.result), /shared lib/);
    assert.doesNotMatch(output(r.result), /dear diary/);
    assert.equal(fs.existsSync(path.join(shared, 'planted.txt')), false);
    assert.equal(fs.readFileSync(path.join(drop, 'out.txt'), 'utf8'), 'out\n');
    assert.equal(fs.readFileSync(path.join(f.dir, 'src', 'a.txt'), 'utf8'), 'alpha\n');
    assert.equal(fs.readFileSync(path.join(f.dir, 'top.txt'), 'utf8'), 'z\n');
  });
});

describe('without a sandbox', () => {
  after(() => setSandboxForTesting(undefined));

  test('every command is refused with the reason', async () => {
    setSandboxForTesting({ ok: false, reason: 'Shell commands are refused because no sandbox is installed.' });
    const f = await fixture();
    const r = await sh(f, 'echo should-not-run > ran.txt');
    assert.equal(r.permission, 'deny');
    assert.match(r.reason!, /no sandbox is installed/);
    assert.equal(r.result.error?.type, ToolErrorType.EXECUTION_DENIED);
    assert.equal(fs.existsSync(path.join(f.dir, 'ran.txt')), false);
  });
});

describe('approvals', { skip: !status.ok && 'no OS sandbox on this machine' }, () => {
  test('tools.ask turns the prompt back on', async () => {
    const f = await fixture({ tools: { ask: true } });
    assert.equal(await f.tools.get('shell')!.build({ command: 'true' }).getDefaultPermission(), 'ask');
  });
});

describe('policy', () => {
  test('protects SF Agents files and git hooks inside the roots', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, '.git'));
    const policy = buildSandboxPolicy({
      roots: [dir],
      secretFiles: [path.join(dir, '.env')],
      stateDirs: [path.join(dir, '.sfagents')],
      protectedFiles: [path.join(dir, 'mcp.json'), path.join(dir, 'agents', 'main.json')],
      agentsDir: path.join(dir, 'agents'),
    });
    const access = Object.fromEntries(policy.rules.map((r) => [path.relative(dir, r.path).split(path.sep).join('/') || '.', r.access]));
    assert.deepEqual(access, {
      '.': 'write',
      '.git/hooks': 'read',
      '.git/config': 'read',
      '.git/modules': 'read',
      agents: 'read',
      'mcp.json': 'read',
      '.env': 'none',
      '.sfagents': 'none',
    });
    assert.equal(policy.network, false);
  });

  test('guards never open up paths outside what the agent was given', () => {
    const dir = makeTempDir();
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    const policy = buildSandboxPolicy({ roots: [work], secretFiles: [path.join(dir, '.env')], protectedFiles: [path.join(dir, 'mcp.json')], agentsDir: path.join(dir, 'agents') });
    assert.deepEqual(policy.rules.map((r) => r.path), [work]);
  });

  test('file checks in the host (artifacts) follow the same rules', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'docs'));
    const policy = buildSandboxPolicy({ roots: [dir], access: [{ path: path.join(dir, 'docs'), access: 'read' }], secretFiles: [path.join(dir, '.env')], agentsDir: path.join(dir, 'agents') });
    const ws = new WorkspaceContext([dir], [], [path.join(dir, '.env')], policy.rules);
    assert.equal(ws.check('notes.md', 'write').ok, true);
    assert.equal(ws.check('docs/plan.md', 'read').ok, true);
    assert.match(ws.check('docs/plan.md', 'write').reason!, /read-only/);
    assert.match(ws.check('agents/new.json', 'write').reason!, /read-only/);
    assert.match(ws.check('.env', 'read').reason!, /credentials/);
    // An entry for a root itself overrides it (the example worker: a read-only workspace).
    const ro = buildSandboxPolicy({ roots: [dir], access: [{ path: dir, access: 'read' }] });
    assert.match(new WorkspaceContext([dir], [], [], ro.rules).check('notes.md', 'write').reason!, /read-only/);
  });

  test('the Seatbelt profile denies by default and carves protected paths out of the roots', () => {
    const profile = seatbeltProfile(
      {
        rules: [
          { path: '/Users/me/work', access: 'write' },
          { path: '/Users/me/work/.env', access: 'none' },
          { path: '/Users/me/work/agents', access: 'read' },
        ],
        network: false,
        hostChannel: { path: '/private/tmp/sf "host".sock' },
      },
      '/private/var/folders/x/T/sfagents-sandbox-1',
    );
    assert.match(profile, /^\(version 1\)\n\(deny default\)/);
    assert.match(profile, /\(allow file-read\* file-write\* \(require-all \(subpath "\/Users\/me\/work"\) \(require-not \(subpath "\/Users\/me\/work\/\.env"\)\) \(require-not \(subpath "\/Users\/me\/work\/agents"\)\)\)\)/);
    assert.match(profile, /\(allow file-read\* \(subpath "\/Users\/me\/work\/agents"\)\)/);
    assert.doesNotMatch(profile, /\(allow [^)]*\(subpath "\/Users\/me\/work\/\.env"\)/);
    assert.doesNotMatch(profile, /\(subpath "\/Users"\)|\(subpath "\/Users\/me"\)/);
    assert.match(profile, /\(path-literal "\/private\/tmp\/sf \\"host\\"\.sock"\)/);
    assert.doesNotMatch(profile, /\(allow network-outbound\)/);
    // "rw" without "d": writes, but no deleting or renaming.
    const edit = seatbeltProfile({ rules: [{ path: '/Users/me/notes', access: 'edit' }], network: false }, '/private/var/folders/x/T/sfagents-sandbox-2');
    assert.match(edit, /\(allow file-read\* file-write\* \(subpath "\/Users\/me\/notes"\)\)\n\(deny file-write-unlink \(subpath "\/Users\/me\/notes"\)\)/);
  });
});

describe('workspace.paths through the shell (Linux, bubblewrap)', { skip: !linuxSandbox && 'bubblewrap is not available' }, () => {
  test('"r", "rw", "rwd" and "" do what they say, nested folders included', async () => {
    const f = await fixture();
    const base = fs.realpathSync(f.outside);
    for (const d of ['b/project', 'a/sensitive']) fs.mkdirSync(path.join(base, d), { recursive: true });
    fs.writeFileSync(path.join(base, 'a', 'read.txt'), 'readable\n');
    fs.writeFileSync(path.join(base, 'a', 'sensitive', 'key'), 'hidden\n');
    fs.writeFileSync(path.join(base, 'b', 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(base, 'b', 'project', 'old.txt'), 'old\n');
    writeAgent(f.dir, baseAgent('main', { tools: { allow: ['shell'] }, workspace: { paths: { [f.dir]: 'rwd', [path.join(base, 'a')]: 'r', [path.join(base, 'a', 'sensitive')]: '', [path.join(base, 'b')]: 'rw', [path.join(base, 'b', 'project')]: 'rwd' } } }));
    f.tools = await buildTools(f.dir);
    const run = async (cmd: string) => stdout((await sh(f, cmd)).result).trim();
    assert.equal(await run(`cat '${base}/a/read.txt'; echo x > '${base}/a/new' 2>/dev/null || echo a-readonly`), 'readable\na-readonly');
    assert.equal(await run(`cat '${base}/a/sensitive/key' 2>/dev/null || echo blocked`), 'blocked');
    assert.equal(await run(`cd '${base}/b' && echo more >> keep.txt && echo n > n.txt && echo wrote; rm keep.txt 2>/dev/null || echo no-delete; mv n.txt m.txt 2>/dev/null || echo no-rename`), 'wrote\nno-delete\nno-rename');
    assert.equal(await run(`rm '${base}/b/project/old.txt' && echo project-delete-ok; rm src/a.txt && echo root-delete-ok`), 'project-delete-ok\nroot-delete-ok');
    assert.equal(fs.readFileSync(path.join(base, 'b', 'keep.txt'), 'utf8'), 'keep\nmore\n');
    // Temporary files can still be deleted (the "rw" folder is inside /tmp here, so the command has its own).
    assert.equal(await run('t=$(mktemp) && rm "$t" && mkdir -p ~/.cache/x && rm -r ~/.cache && echo temp-ok'), 'temp-ok');
  });
});

describe('"rw" without delete on Linux (Landlock)', () => {
  const python = process.platform === 'linux' ? findPython(LINUX_SYSTEM_PATHS) : undefined;
  const landlock = python !== undefined && spawnSync(python, ['-I', '-c', 'import ctypes,sys; s=ctypes.CDLL(None).syscall; s.restype=ctypes.c_long; sys.exit(0 if s(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1)) >= 1 else 1)']).status === 0;

  test('bubblewrap starts commands through the launcher only when a folder is "rw"', { skip: !python && 'no python3 here' }, () => {
    const dir = fs.realpathSync(makeTempDir());
    const cmd = { executable: '/bin/sh', args: ['-c', 'true'], cwd: dir, env: { HOME: '/home/agent', PATH: '/usr/bin:/bin' } };
    const plain = bubblewrapCommand('/usr/bin/bwrap', cmd, { rules: [{ path: dir, access: 'write' }], network: false });
    assert.deepEqual(plain.args.slice(-4), ['--', '/bin/sh', '-c', 'true']);
    fs.mkdirSync(path.join(dir, 'notes'));
    const edit = bubblewrapCommand('/usr/bin/bwrap', cmd, { rules: [{ path: dir, access: 'read' }, { path: path.join(dir, 'notes'), access: 'edit' }], network: false });
    const at = edit.args.indexOf('--');
    assert.deepEqual(edit.args.slice(at + 1, at + 4), [python, '-I', '-c']);
    // The "rw" folder is inside /tmp here, so the command gets its own temporary folder, where it may delete.
    assert.deepEqual(JSON.parse(edit.args[at + 5]!), ['/dev', '/run/sfagents-scratch/tmp', '/home/agent']);
    assert.equal(edit.env['TMPDIR'], '/run/sfagents-scratch/tmp');
    assert.deepEqual(edit.args.slice(-3), ['/bin/sh', '-c', 'true']);
    assert.ok(edit.args.join(' ').includes(`--bind ${path.join(dir, 'notes')} ${path.join(dir, 'notes')}`));
  });

  test('the launcher lets commands write but not delete or rename outside the "rwd" folders', { skip: !landlock && 'Landlock is not available here' }, () => {
    const dir = fs.realpathSync(makeTempDir());
    for (const d of ['rwd', 'rw']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'rwd', 'x'), '1');
    fs.writeFileSync(path.join(dir, 'rw', 'y'), '1');
    const script = [
      'echo new > rw/new && echo more >> rw/y && mkdir rw/sub && echo wrote',
      'rm rw/y 2>/dev/null || echo rm-blocked',
      'mv rw/y rw/z 2>/dev/null || echo rename-blocked',
      'rmdir rw/sub 2>/dev/null || echo rmdir-blocked',
      'rm rwd/x && echo rwd-delete-ok',
    ].join('; ');
    const [exe, ...args] = landlockCommand(python!, [path.join(dir, 'rwd')], ['/bin/sh', '-c', `cd '${dir}'; ${script}`]);
    const r = spawnSync(exe!, args, { encoding: 'utf8' });
    assert.equal(r.stdout, 'wrote\nrm-blocked\nrename-blocked\nrmdir-blocked\nrwd-delete-ok\n', r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'rw', 'y'), 'utf8'), '1more\n');
  });
});
