import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadAgentTree, describeTree, ConfigError, ensureProject, locateProject, withRoot, buildSandboxPolicy, accessFor } from '@sfagents/core';
import { baseAgent, makeTempDir, writeJson, stdioServerConfig } from './helpers.js';

/** A project: files are relative to it (agents go in "agents/"). */
function setup(files: Record<string, unknown>, mcp?: unknown): string {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'work', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    if (typeof value === 'string') fs.writeFileSync(path.join(dir, name), value);
    else writeJson(path.join(dir, name), value);
  }
  if (mcp) writeJson(path.join(dir, 'mcp.json'), mcp);
  return dir;
}

/** The single agent file's error, as the loader reports a skipped file. */
function skippedError(dir: string, pattern: RegExp, extra: Record<string, unknown> = { 'agents/ok.json': baseAgent('ok') }) {
  for (const [name, value] of Object.entries(extra)) writeJson(path.join(dir, name), value);
  const tree = loadAgentTree(dir);
  assert.ok(tree.skipped.some((s) => pattern.test(`${s.file}: ${s.error}`)), `expected a skipped file matching ${pattern}; got ${JSON.stringify(tree.skipped)}`);
}

describe('agents folder', () => {
  test('loads every valid file, named by its file name, with grants and roots', () => {
    const dir = setup(
      {
        'agents/main.json': baseAgent('main', {
          workspace: { roots: ['work'] },
          tools: { allow: ['shell', '2-Research Helper.json'], mcpServers: ['local'] },
        }),
        'agents/Research Helper.json': {
          ...baseAgent('ignored-label'),
          description: 'does research',
          workspace: { roots: ['work/sub'] },
          tools: { allow: ['shell', '1-main.json'], mcpServers: [{ server: 'local', tools: ['echo'] }] },
        },
        'agents/plain.json': baseAgent('plain'),
      },
      { mcpServers: { local: stdioServerConfig() } },
    );
    const tree = loadAgentTree(dir);
    assert.equal(tree.root.id, 'main', '"main" replies by default');
    assert.deepEqual([...tree.byId.keys()].sort(), ['Research Helper', 'main', 'plain']);
    assert.deepEqual(tree.root.roots, [path.join(dir, 'work')]);
    const helper = tree.byId.get('Research Helper')!;
    assert.equal(helper.definition.name, 'ignored-label', 'an id that differs from the file name is a label');
    assert.deepEqual(helper.roots, [path.join(dir, 'work', 'sub')]);
    assert.deepEqual([...tree.root.grants], [['Research Helper', 2]]);
    assert.deepEqual([...helper.grants], [['main', 1]], 'grants may point back: any graph is allowed');
    assert.ok(helper.definition.tools?.allow?.includes('shell'), 'any agent may have the shell');
    assert.deepEqual(tree.byId.get('plain')!.roots, [dir], 'the project directory by default');
    assert.ok(Object.isFrozen(tree.root.definition), 'definitions are frozen');
    assert.match(describeTree(tree), /\* main[\s\S]*message:Research Helper×2/);
    assert.ok(tree.protectedFiles.includes(path.join(dir, 'agents', 'plain.json')));
  });

  test('an agent with file tools and no roots works in the project directory', () => {
    const dir = setup({ 'agents/main.json': baseAgent('main') });
    assert.deepEqual(loadAgentTree(dir).root.roots, [dir]);
  });

  test('picks the agent to start with: --agent, an agent file, "main", else the first', () => {
    const dir = setup({ 'agents/zed.json': baseAgent('zed'), 'agents/alpha.json': baseAgent('alpha') });
    assert.equal(loadAgentTree(dir).root.id, 'alpha');
    assert.equal(loadAgentTree(dir, { agent: 'zed' }).root.id, 'zed');
    assert.equal(loadAgentTree(path.join(dir, 'agents', 'zed.json')).root.id, 'zed');
    assert.equal(loadAgentTree(path.join(dir, 'agents')).root.id, 'alpha');
    assert.throws(() => loadAgentTree(dir, { agent: 'nobody' }), /no agent named "nobody"/);
    const tree = loadAgentTree(dir);
    assert.equal(withRoot(tree, 'zed').root.id, 'zed');
    assert.deepEqual(locateProject(path.join(dir, 'agents', 'alpha.json')), { projectDir: dir, agent: 'alpha' });
  });

  test('skips invalid files and keeps the rest', () => {
    const dir = setup({
      'agents/main.json': baseAgent('main'),
      'agents/broken.json': '{ "model": ',
      'agents/old.json': baseAgent('old', { spawn: { children: ['x.json'] } }),
      'agents/typo.json': baseAgent('typo', { tool: { allow: [] } }),
      'agents/notes.txt': 'not an agent',
    });
    const tree = loadAgentTree(dir);
    assert.deepEqual([...tree.byId.keys()], ['main']);
    const why = Object.fromEntries(tree.skipped.map((s) => [path.basename(s.file), s.error]));
    assert.match(why['broken.json']!, /invalid JSON/);
    assert.match(why['old.json']!, /spawn.*N-name\.json/);
    assert.match(why['typo.json']!, /\[tool\]: unknown field/);
    assert.equal(why['notes.txt'], undefined, 'only .json files are read');
    assert.match(describeTree(tree), /skipped agents[/\\]broken\.json/);
  });

  test('a grant to an agent that is not loaded is dropped with a note', () => {
    const dir = setup({ 'agents/main.json': baseAgent('main', { tools: { allow: ['3-ghost.json', '1-bad.json'] } }), 'agents/bad.json': '{' });
    const tree = loadAgentTree(dir);
    assert.equal(tree.root.grants.size, 0);
    assert.equal(tree.warnings.length, 2);
    assert.match(tree.warnings[0]!, /"3-ghost.json"|"ghost.json"/);
  });

  test('fails only when no agent is usable, or there is no agents folder', () => {
    const empty = setup({ 'agents/bad.json': '{' });
    assert.throws(() => loadAgentTree(empty), (e: unknown) => e instanceof ConfigError && /no valid agent definitions.*bad\.json/.test(e.message));
    const none = makeTempDir();
    assert.throws(() => loadAgentTree(none), /no "agents" folder/);
    const legacy = makeTempDir();
    writeJson(path.join(legacy, 'agent.json'), baseAgent('main'));
    assert.throws(() => loadAgentTree(legacy), /move this file to .*agents.*main\.json/);
  });

  test('validates fields, grants and MCP servers per file', () => {
    let dir = setup({});
    skippedError(dir, /\[tools.allow\[1\]\]: duplicate entry/, { 'agents/a.json': baseAgent('a', { tools: { allow: ['shell', 'shell'] } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /unknown tool "web_fetch"/, { 'agents/a.json': baseAgent('a', { tools: { allow: ['web_fetch'] } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /agent grants name a file in the agents folder/, { 'agents/a.json': baseAgent('a', { tools: { allow: ['1-../x.json'] } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /\[provider\]: must name at least one provider/, { 'agents/a.json': baseAgent('a', { provider: [] }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /\[provider\[1\]\]: duplicate entry/, { 'agents/a.json': baseAgent('a', { provider: ['Claude 1', 'claude 1'] }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /\[reasoning\]: must be one of/, { 'agents/a.json': baseAgent('a', { reasoning: 'extreme' }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /unknown MCP server "nope"/, { 'agents/a.json': baseAgent('a', { tools: { mcpServers: ['nope'] } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /"shell" is not in tools.allow/, { 'agents/a.json': baseAgent('a', { tools: { allow: [], autoApprove: ['shell'] } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /\[workspace.access\[0\].mode\]: must be "read", "write" or "none"/, { 'agents/a.json': baseAgent('a', { workspace: { roots: ['.'], access: [{ path: 'x', mode: 'rw' }] } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /\[workspace.network\]: must be true or false/, { 'agents/a.json': baseAgent('a', { workspace: { roots: ['.'], network: 'yes' } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /\[tools.ask\]: must be true or false/, { 'agents/a.json': baseAgent('a', { tools: { ask: 1 } }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /providerOptions\]: is required/, { 'agents/a.json': baseAgent('a', { provider: 'openai-compatible' }), 'agents/ok.json': baseAgent('ok') });
    dir = setup({});
    skippedError(dir, /workspace.roots\[0\]\]: Directory does not exist/, { 'agents/a.json': baseAgent('a', { workspace: { roots: ['does-not-exist'] } }), 'agents/ok.json': baseAgent('ok') });
  });

  test('workspace.paths: absolute folders with r/w/d letters; the outermost granted ones are the roots, in order', () => {
    const outside = makeTempDir();
    fs.mkdirSync(path.join(outside, 'a', 'sensitive'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'b', 'project'), { recursive: true });
    const dir = setup({});
    const real = (p: string) => fs.realpathSync(p);
    writeJson(path.join(dir, 'agents', 'main.json'), baseAgent('main', {
      workspace: {
        paths: {
          [path.join(outside, 'b')]: 'rw',
          [path.join(outside, 'a')]: 'r',
          [path.join(outside, 'a', 'sensitive')]: '',
          [path.join(outside, 'b', 'project')]: 'rwd',
          [dir]: 'rwd',
        },
      },
    }));
    const tree = loadAgentTree(dir);
    const main = tree.byId.get('main')!;
    assert.deepEqual(main.roots, [real(path.join(outside, 'b')), real(path.join(outside, 'a')), real(dir)]);
    assert.deepEqual(main.access.map((r) => [path.relative(real(outside), r.path) || '.', r.access]).slice(0, 4), [
      ['b', 'edit'],
      ['a', 'read'],
      [path.join('a', 'sensitive'), 'none'],
      [path.join('b', 'project'), 'write'],
    ]);
    if (process.platform === 'linux') assert.ok(tree.warnings.some((w) => /cannot let commands write without deleting/.test(w)));
    const policy = buildSandboxPolicy({ roots: main.roots, access: main.access });
    const at = (...p: string[]) => accessFor(policy.rules, path.join(real(outside), ...p));
    assert.deepEqual([at('a', 'sensitive', 'x'), at('a', 'notes.md'), at('b', 'x.md'), at('b', 'project', 'x.md'), at('c')], ['none', 'read', 'edit', 'write', 'none']);

    const bad = (paths: unknown, pattern: RegExp) => {
      const d = setup({});
      skippedError(d, pattern, { 'agents/a.json': baseAgent('a', { workspace: { paths } }), 'agents/ok.json': baseAgent('ok') });
    };
    bad({ work: 'rw' }, /must be an absolute path/);
    bad({ [outside]: 'wr' + 'x' }, /may only use the letters r \(read\), w \(write\) and d \(delete\)/);
    bad({ [outside]: 'w' }, /"w" needs "r" too/);
    bad({ [outside]: 'rd' }, /"d" needs "w" too/);
    bad({ [outside]: '' }, /must give at least one folder a permission/);
    bad({ [path.join(outside, 'missing')]: 'r' }, /Directory does not exist/);
    bad(['x'], /must be an object of folder/);
    const both = setup({});
    skippedError(both, /replaces roots and access/, { 'agents/a.json': baseAgent('a', { workspace: { roots: ['.'], paths: { [outside]: 'r' } } }), 'agents/ok.json': baseAgent('ok') });
  });

  test('a new project\'s agent gets the project folder by absolute path, with every permission', () => {
    const dir = makeTempDir();
    ensureProject(dir);
    const def = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'main.json'), 'utf8')) as { workspace: unknown };
    assert.deepEqual(def.workspace, { paths: { [fs.realpathSync(dir)]: 'rwd' } });
    assert.deepEqual(loadAgentTree(dir).root.roots, [fs.realpathSync(dir)]);
  });

  test('validates mcp.json, leaving out invalid servers', () => {
    const expectLeftOut = (servers: Record<string, unknown>, pattern: RegExp) => {
      const dir = setup({ 'agents/main.json': baseAgent('main') }, { mcpServers: { ...servers, ok: stdioServerConfig() } });
      const tree = loadAgentTree(dir);
      assert.deepEqual(Object.keys(tree.mcp.servers), ['ok'], 'the valid server still loads');
      assert.ok(tree.warnings.some((w) => pattern.test(w)), `expected a warning matching ${pattern}; got ${JSON.stringify(tree.warnings)}`);
    };
    expectLeftOut({ 'bad__name': stdioServerConfig() }, /must not contain "__"/);
    expectLeftOut({ x: { command: 'a', httpUrl: 'http://x' } }, /exactly one of/);
    expectLeftOut({ x: { httpUrl: 'ftp://x' } }, /must be an http\(s\) URL/);
    expectLeftOut({ x: { url: 'http://x/sse' } }, /legacy SSE servers are not supported/);
    expectLeftOut({ x: { command: 'a', oauth: {} } }, /"x" was left out: \[mcpServers.x.oauth\]: unknown field/);
  });

  test('an agent granted a broken MCP server loads without it; a broken mcp.json loads no servers', () => {
    let dir = setup({ 'agents/main.json': baseAgent('main', { tools: { mcpServers: ['x', 'ok'] } }) }, { mcpServers: { x: { url: 'http://x/sse' }, ok: stdioServerConfig() } });
    let tree = loadAgentTree(dir);
    assert.deepEqual(tree.root.definition.tools?.mcpServers, ['ok']);
    assert.ok(tree.warnings.some((w) => /main\.json: MCP server "x" is not available until mcp\.json is fixed/.test(w)));
    dir = setup({ 'agents/main.json': baseAgent('main', { tools: { mcpServers: ['ok'] } }) });
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{ "mcpServers": ');
    tree = loadAgentTree(dir);
    assert.equal(tree.root.id, 'main');
    assert.deepEqual(tree.mcp.servers, {});
    assert.ok(tree.warnings.some((w) => /mcp\.json could not be used, so no MCP server is available: invalid JSON/.test(w)), JSON.stringify(tree.warnings));
    // A server named nowhere is still a mistake in the agent file.
    dir = setup({ 'agents/main.json': baseAgent('main') });
    skippedError(dir, /unknown MCP server "nope"/, { 'agents/a.json': baseAgent('a', { tools: { mcpServers: ['nope'] } }) });
  });

  test('a new project gets the agents folder and a default agent with no provider', () => {
    const dir = makeTempDir();
    const created = ensureProject(dir);
    assert.deepEqual(created.filter((f) => !f.includes(`${path.sep}prompts`)), [path.join(dir, 'agents'), path.join(dir, 'agents', 'main.json')]);
    const tree = loadAgentTree(dir);
    assert.equal(tree.root.id, 'main');
    assert.equal(tree.root.definition.provider, '');
    assert.deepEqual(tree.root.definition.providers, []);
    assert.equal(tree.root.definition.model, '');
    assert.match(describeTree(tree), /main {2}\(no provider\)/);
    assert.deepEqual(ensureProject(dir), [], 'nothing to create the second time');
    // An empty agents folder gets the default agent; one with files (even broken ones) is left alone.
    const empty = setup({});
    assert.deepEqual(ensureProject(empty), [path.join(empty, 'agents', 'main.json')]);
    const broken = setup({ 'agents/main.json': '{' });
    assert.deepEqual(ensureProject(broken), []);
    assert.equal(fs.readFileSync(path.join(broken, 'agents', 'main.json'), 'utf8'), '{');
  });

  test('with fallback, a project whose agent files are all broken starts with the built-in default agent', () => {
    const dir = setup({ 'agents/main.json': '{', 'agents/other.json': baseAgent('other', { provider: [] }) });
    assert.throws(() => loadAgentTree(dir), /no valid agent definitions/);
    const tree = loadAgentTree(dir, { fallback: true });
    assert.deepEqual([...tree.byId.keys()], ['main']);
    assert.equal(tree.root.definition.provider, '');
    assert.equal(tree.skipped.length, 2);
    assert.ok(tree.warnings.some((w) => /built-in default agent/.test(w)));
  });

  test('a model without a provider is allowed; a provider without a model is not', () => {
    const dir = setup({ 'agents/main.json': baseAgent('main') });
    const { provider: _p, ...modelOnly } = baseAgent('m');
    const { model: _m, ...providerOnly } = baseAgent('p');
    writeJson(path.join(dir, 'agents', 'm.json'), modelOnly);
    writeJson(path.join(dir, 'agents', 'p.json'), providerOnly);
    const tree = loadAgentTree(dir);
    assert.equal(tree.byId.get('m')!.definition.model, 'test/model');
    assert.ok(tree.skipped.some((s) => /p\.json/.test(s.file) && /\[model\]/.test(s.error)));
  });
});

describe('prompts folder', () => {
  test('systemPrompt lines and list entries reference prompt files, filled in in order', () => {
    const dir = setup({
      'prompts/rules.txt': 'Rule one.\n@style\n',
      'prompts/style.md': 'Be brief.',
      'prompts/Code Review.txt': 'Review carefully.',
      'agents/a.json': { ...baseAgent('a'), systemPrompt: ['@rules.txt', 'You are a.', '@Code Review.txt'] },
      'agents/b.json': { ...baseAgent('b'), systemPrompt: 'You are b.\n@rules\nMail @someone if stuck.\n@nobody' },
    });
    const tree = loadAgentTree(dir);
    assert.equal(tree.byId.get('a')!.definition.systemPrompt, 'Rule one.\nBe brief.\n\nYou are a.\n\nReview carefully.');
    assert.deepEqual(tree.byId.get('a')!.definition.prompts, ['prompts/rules.txt', 'prompts/style.md', 'prompts/Code Review.txt']);
    // A bare "@name" that names no file is ordinary text.
    assert.equal(tree.byId.get('b')!.definition.systemPrompt, 'You are b.\nRule one.\nBe brief.\nMail @someone if stuck.\n@nobody');
    // Prompt files are protected from agents, like agent files.
    assert.ok(tree.protectedFiles.some((f) => f.endsWith('style.md')));
    assert.match(describeTree(tree), /prompts: prompts\/rules\.txt, prompts\/style\.md, prompts\/Code Review\.txt/);
  });

  test('a missing, escaping or circular reference skips the agent with the reason', () => {
    const dir = setup({ 'prompts/loop.txt': '@loop.txt' });
    skippedError(dir, /x\.json.*\[systemPrompt\].*"@gone\.txt" was not found/, { 'agents/x.json': { ...baseAgent('x'), systemPrompt: '@gone.txt' }, 'agents/ok.json': baseAgent('ok') });
    skippedError(dir, /y\.json.*inside the prompts folder/, { 'agents/y.json': { ...baseAgent('y'), systemPrompt: ['@../agents/ok.json.txt'] }, 'agents/ok.json': baseAgent('ok') });
    skippedError(dir, /z\.json.*references itself/, { 'agents/z.json': { ...baseAgent('z'), systemPrompt: '@loop.txt' }, 'agents/ok.json': baseAgent('ok') });
  });

  test('a new project gets the default prompt files, and its default agent uses them', () => {
    const dir = makeTempDir();
    ensureProject(dir);
    for (const name of ['main-agent.txt', 'worker-agent.txt', 'working-rules.txt', 'coding.txt']) assert.ok(fs.existsSync(path.join(dir, 'prompts', name)), name);
    const main = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'main.json'), 'utf8')) as { systemPrompt: unknown };
    assert.deepEqual(main.systemPrompt, ['@main-agent.txt', '@working-rules.txt']);
    const tree = loadAgentTree(dir);
    assert.match(tree.root.definition.systemPrompt, /^You are the main agent in SF Agents[\s\S]*Verify before you report/);
    // An existing prompts folder is left alone.
    fs.writeFileSync(path.join(dir, 'prompts', 'coding.txt'), 'mine');
    ensureProject(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'prompts', 'coding.txt'), 'utf8'), 'mine');
  });
});
