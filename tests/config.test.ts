import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadAgentTree, describeTree, ConfigError } from '@sfagents/core';
import { baseAgent, makeTempDir, writeJson, stdioServerConfig } from './helpers.js';

function setup(files: Record<string, unknown>, mcp?: unknown): string {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'work', 'sub'), { recursive: true });
  for (const [name, value] of Object.entries(files)) writeJson(path.join(dir, name), value);
  if (mcp) writeJson(path.join(dir, 'mcp.json'), mcp);
  return dir;
}

function expectConfigError(dir: string, pattern: RegExp) {
  assert.throws(
    () => loadAgentTree(path.join(dir, 'agent.json')),
    (e: unknown) => e instanceof ConfigError && pattern.test(e.message),
  );
}

describe('agent JSON tree', () => {
  test('loads root, child and grandchild with resolved roots', () => {
    const dir = setup(
      {
        'agent.json': baseAgent('main', {
          workspace: { roots: ['work'] },
          tools: { allow: ['read_file', 'write_file', 'shell'], mcpServers: ['local'] },
          spawn: { children: ['agents/1-Subagent-Worker.json'], maxConcurrentChildren: 2 },
        }),
        'agents/1-Subagent-Worker.json': baseAgent('worker', {
          description: 'does work',
          workspace: { roots: ['../work/sub'] },
          tools: { allow: ['read_file'], mcpServers: [{ server: 'local', tools: ['echo'] }] },
          spawn: { children: ['2-Subagent-Helper.json'] },
        }),
        'agents/2-Subagent-Helper.json': baseAgent('helper'),
      },
      { mcpServers: { local: stdioServerConfig() } },
    );
    const tree = loadAgentTree(path.join(dir, 'agent.json'));
    assert.equal(tree.root.id, 'main');
    assert.deepEqual(tree.root.roots, [path.join(dir, 'work')]);
    const worker = tree.root.children[0]!;
    assert.equal(worker.id, 'worker');
    assert.equal(worker.depth, 1);
    assert.deepEqual(worker.roots, [path.join(dir, 'work', 'sub')]);
    const helper = worker.children[0]!;
    assert.equal(helper.id, 'helper');
    assert.equal(helper.depth, 2);
    assert.deepEqual(helper.roots, [], 'children get no filesystem access by default');
    assert.equal(tree.byId.size, 3);
    assert.ok(Object.isFrozen(tree.root.definition), 'definitions are frozen');
    assert.ok(Object.isFrozen(tree.root.children), 'child lists are frozen');
    assert.match(describeTree(tree), /worker[\s\S]*helper/);
    assert.ok(tree.protectedFiles.includes(path.join(dir, 'agents', '2-Subagent-Helper.json')));
  });

  test('root workspace defaults to the config directory', () => {
    const dir = setup({ 'agent.json': baseAgent('main') });
    assert.deepEqual(loadAgentTree(path.join(dir, 'agent.json')).root.roots, [dir]);
  });

  test('rejects unknown child files', () => {
    const dir = setup({ 'agent.json': baseAgent('main', { spawn: { children: ['agents/missing.json'] } }) });
    expectConfigError(dir, /unknown child: file not found/);
  });

  test('rejects cycles', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { spawn: { children: ['a.json'] } }),
      'a.json': baseAgent('a', { spawn: { children: ['b.json'] } }),
      'b.json': baseAgent('b', { spawn: { children: ['a.json'] } }),
    });
    expectConfigError(dir, /cycle in agent tree: agent.json -> a.json -> b.json -> a.json/);
  });

  test('rejects a root that lists itself', () => {
    const dir = setup({ 'agent.json': baseAgent('main', { spawn: { children: ['agent.json'] } }) });
    expectConfigError(dir, /cycle/);
  });

  test('rejects duplicate ids', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { spawn: { children: ['a.json', 'b.json'] } }),
      'a.json': baseAgent('dup'),
      'b.json': baseAgent('dup'),
    });
    expectConfigError(dir, /duplicate agent id "dup"/);
  });

  test('rejects a file used by two parents', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { spawn: { children: ['a.json', 'b.json'] } }),
      'a.json': baseAgent('a', { spawn: { children: ['shared.json'] } }),
      'b.json': baseAgent('b', { spawn: { children: ['shared.json'] } }),
      'shared.json': baseAgent('shared'),
    });
    expectConfigError(dir, /only one parent/);
  });

  test('rejects child paths outside the configuration directory', () => {
    const outside = makeTempDir();
    writeJson(path.join(outside, 'evil.json'), baseAgent('evil'));
    const dir = setup({ 'agent.json': baseAgent('main', { spawn: { children: [path.join(outside, 'evil.json')] } }) });
    expectConfigError(dir, /outside the configuration directory/);
    const dir2 = setup({ 'agent.json': baseAgent('main', { spawn: { children: [`../${path.basename(outside)}/evil.json`] } }) });
    expectConfigError(dir2, /outside the configuration directory/);
  });

  test('rejects child symlinks that point outside the configuration directory', { skip: process.platform === 'win32' }, () => {
    const outside = makeTempDir();
    writeJson(path.join(outside, 'evil.json'), baseAgent('evil'));
    const dir = setup({ 'agent.json': baseAgent('main', { spawn: { children: ['link.json'] } }) });
    fs.symlinkSync(path.join(outside, 'evil.json'), path.join(dir, 'link.json'));
    expectConfigError(dir, /outside the configuration directory/);
  });

  test('rejects shell on child agents', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { workspace: { roots: ['work'] }, tools: { allow: ['shell'] }, spawn: { children: ['c.json'] } }),
      'c.json': baseAgent('c', { workspace: { roots: ['work'] }, tools: { allow: ['shell'] } }),
    });
    expectConfigError(dir, /"shell" is only allowed on the root agent/);
  });

  test('rejects built-in tool escalation', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { workspace: { roots: ['work'] }, tools: { allow: ['read_file'] }, spawn: { children: ['c.json'] } }),
      'c.json': baseAgent('c', { workspace: { roots: ['work'] }, tools: { allow: ['read_file', 'write_file'] } }),
    });
    expectConfigError(dir, /permission escalation: parent "main" does not allow "write_file"/);
  });

  test('rejects workspace root escalation', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { workspace: { roots: ['work/sub'] }, tools: { allow: ['read_file'] }, spawn: { children: ['c.json'] } }),
      'c.json': baseAgent('c', { workspace: { roots: ['work'] }, tools: { allow: ['read_file'] } }),
    });
    expectConfigError(dir, /is not inside any workspace root of parent "main"/);
  });

  test('rejects MCP server and tool escalation', () => {
    const mcp = { mcpServers: { a: stdioServerConfig(), b: stdioServerConfig() } };
    const dir = setup(
      {
        'agent.json': baseAgent('main', { tools: { mcpServers: ['a'] }, spawn: { children: ['c.json'] } }),
        'c.json': baseAgent('c', { tools: { mcpServers: ['b'] } }),
      },
      mcp,
    );
    expectConfigError(dir, /no access to MCP server "b"/);
    const dir2 = setup(
      {
        'agent.json': baseAgent('main', { tools: { mcpServers: [{ server: 'a', tools: ['echo'] }] }, spawn: { children: ['c.json'] } }),
        'c.json': baseAgent('c', { tools: { mcpServers: ['a'] } }),
      },
      mcp,
    );
    expectConfigError(dir2, /must list a subset/);
    const dir3 = setup(
      {
        'agent.json': baseAgent('main', { tools: { mcpServers: [{ server: 'a', tools: ['echo'] }] }, spawn: { children: ['c.json'] } }),
        'c.json': baseAgent('c', { tools: { mcpServers: [{ server: 'a', tools: ['add'] }] } }),
      },
      mcp,
    );
    expectConfigError(dir3, /may not use "add"/);
  });

  test('rejects auto-approve escalation', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { workspace: { roots: ['work'] }, tools: { allow: ['edit'] }, spawn: { children: ['c.json'] } }),
      'c.json': baseAgent('c', { workspace: { roots: ['work'] }, tools: { allow: ['edit'], autoApprove: ['edit'] } }),
    });
    expectConfigError(dir, /does not auto-approve "edit"/);
  });

  test('rejects file tools on a child without roots', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { tools: { allow: ['read_file'] }, spawn: { children: ['c.json'] } }),
      'c.json': baseAgent('c', { tools: { allow: ['read_file'] } }),
    });
    expectConfigError(dir, /declares no workspace roots/);
  });

  test('rejects unknown fields, tools, providers and MCP servers with file and field', () => {
    let dir = setup({ 'agent.json': baseAgent('main', { tool: { allow: [] } }) });
    expectConfigError(dir, /agent.json \[tool\]: unknown field/);
    dir = setup({ 'agent.json': baseAgent('main', { tools: { allow: ['read_file', 'read_file'] } }) });
    expectConfigError(dir, /\[tools.allow\[1\]\]: duplicate entry/);
    dir = setup({ 'agent.json': baseAgent('main', { tools: { allow: ['web_fetch'] } }) });
    expectConfigError(dir, /unknown built-in tool "web_fetch"/);
    dir = setup({ 'agent.json': baseAgent('main', { provider: 'qwen-oauth' }) });
    expectConfigError(dir, /unsupported provider "qwen-oauth"/);
    dir = setup({ 'agent.json': baseAgent('main', { reasoning: 'extreme' }) });
    expectConfigError(dir, /\[reasoning\]: must be one of/);
    dir = setup({ 'agent.json': baseAgent('main', { tools: { mcpServers: ['nope'] } }) });
    expectConfigError(dir, /unknown MCP server "nope"/);
    dir = setup({ 'agent.json': baseAgent('main', { tools: { allow: ['read_file'], autoApprove: ['edit'] } }) });
    expectConfigError(dir, /"edit" is not in tools.allow/);
    dir = setup({ 'agent.json': baseAgent('main', { provider: 'openai-compatible' }) });
    expectConfigError(dir, /providerOptions\]: is required/);
    dir = setup({ 'agent.json': baseAgent('main', { id: '1bad id' }) });
    expectConfigError(dir, /\[id\]: must start with a letter/);
    dir = setup({ 'agent.json': baseAgent('main', { workspace: { roots: ['does-not-exist'] } }) });
    expectConfigError(dir, /workspace.roots\[0\]\]: Directory does not exist/);
  });

  test('rejects invalid JSON with the file name', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'agent.json'), '{ "id": "main", }');
    expectConfigError(dir, /agent.json: invalid JSON/);
  });

  test('enforces spawn.maxDepth', () => {
    const dir = setup({
      'agent.json': baseAgent('main', { spawn: { maxDepth: 1, children: ['a.json'] } }),
      'a.json': baseAgent('a', { spawn: { children: ['b.json'] } }),
      'b.json': baseAgent('b'),
    });
    expectConfigError(dir, /deeper than spawn.maxDepth \(1\)/);
  });

  test('validates mcp.json', () => {
    let dir = setup({ 'agent.json': baseAgent('main') }, { mcpServers: { 'bad__name': stdioServerConfig() } });
    expectConfigError(dir, /must not contain "__"/);
    dir = setup({ 'agent.json': baseAgent('main') }, { mcpServers: { x: { command: 'a', httpUrl: 'http://x' } } });
    expectConfigError(dir, /exactly one of/);
    dir = setup({ 'agent.json': baseAgent('main') }, { mcpServers: { x: { httpUrl: 'ftp://x' } } });
    expectConfigError(dir, /must be an http\(s\) URL/);
    dir = setup({ 'agent.json': baseAgent('main') }, { mcpServers: { x: { url: 'http://x/sse' } } });
    expectConfigError(dir, /legacy SSE servers are not supported/);
    dir = setup({ 'agent.json': baseAgent('main') }, { mcpServers: { x: { command: 'a', oauth: {} } } });
    expectConfigError(dir, /\[mcpServers.x.oauth\]: unknown field/);
  });
});
