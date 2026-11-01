import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PackageProxy, hostAllowed, parseTarget } from '@sfagents/core';

/** Sends one CONNECT through the proxy and returns its status line. */
function connect(port: number, target: string, credential?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const auth = credential ? `Proxy-Authorization: Basic ${Buffer.from(credential).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    socket.once('data', (d) => {
      resolve(d.toString('latin1').split('\r\n')[0]!);
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

describe('package and Git proxy', () => {
  test('allows only HTTPS to listed host names', () => {
    assert.equal(hostAllowed('registry.npmjs.org', 443), true);
    assert.equal(hostAllowed('GitHub.com.', 443), true);
    assert.equal(hostAllowed('github.com', 22), false);
    assert.equal(hostAllowed('github.com', 80), false);
    assert.equal(hostAllowed('evil.github.com.attacker.net', 443), false);
    assert.equal(hostAllowed('gist.github.com', 443), false);
    assert.equal(hostAllowed('140.82.112.3', 443), false);
    assert.equal(hostAllowed('example.com', 443), false);
    assert.deepEqual(parseTarget('pypi.org:443'), { host: 'pypi.org', port: 443 });
    assert.deepEqual(parseTarget('[::1]:443'), { host: '::1', port: 443 });
    assert.equal(parseTarget('pypi.org'), undefined);
  });

  test('refuses requests without the agent credential, other hosts and plain HTTP, and logs them', async () => {
    // A local "registry" so the allowed path needs no Internet.
    const upstream = net.createServer((s) => s.end());
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const proxy = new PackageProxy(['localhost']);
    try {
      const url = new URL(await proxy.urlFor('main'));
      const port = Number(url.port);
      assert.ok(port >= 1024);
      const cred = `${url.username}:${url.password}`;
      proxy.setCommand('main', 'npm install');
      assert.match(await connect(port, 'example.com:443'), /^HTTP\/1\.1 407/);
      assert.match(await connect(port, 'example.com:443', cred), /^HTTP\/1\.1 403/);
      assert.match(await connect(port, 'localhost:80', cred), /^HTTP\/1\.1 403/);
      assert.match(await connect(port, 'localhost:443', 'sfagents:wrong'), /^HTTP\/1\.1 407/);
      const plain = await new Promise<number>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write('GET http://localhost/ HTTP/1.1\r\nHost: localhost\r\n\r\n'));
        s.once('data', (d) => { resolve(Number(d.toString().split(' ')[1])); s.destroy(); });
      });
      assert.equal(plain, 403);
      const log = proxy.entries('main');
      assert.ok(log.every((e) => !e.allowed));
      assert.ok(log.some((e) => e.host === 'example.com' && e.command === 'npm install' && /not a package registry/.test(e.reason ?? '')));
      assert.ok(proxy.entries().some((e) => e.agent === '(unknown)'));
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});
