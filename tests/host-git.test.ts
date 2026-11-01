import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gitRefusal, httpsGitHost } from '@sfagents/core';

describe('sf-git', () => {
  test('refuses force pushes, deletes, mirrors and options that run programs', () => {
    for (const args of [['-f'], ['--force'], ['--force-with-lease'], ['--force-if-includes'], ['--mirror'], ['--delete', 'main'], ['-d', 'x'], ['origin', '+main'], ['origin', ':main'], ['origin', 'main:'], ['--receive-pack=evil'], ['--exec=evil'], ['--prune'], ['--all']]) {
      assert.ok(gitRefusal('push', args), args.join(' '));
    }
    assert.ok(gitRefusal('fetch', ['--upload-pack=evil']));
    assert.ok(gitRefusal('fetch', ['https://evil.example/repo.git']));
    assert.ok(gitRefusal('push', ['git@github.com:me/x.git']));
    assert.equal(gitRefusal('push', ['origin', 'feature', '-u']), undefined);
    assert.equal(gitRefusal('push', ['origin', 'HEAD:feature', '--tags']), undefined);
    assert.equal(gitRefusal('fetch', ['origin', '--prune']), undefined);
  });

  test('accepts only HTTPS remotes', () => {
    assert.equal(httpsGitHost('https://github.com/JoeDoe56/sfgl.git'), 'github.com');
    assert.equal(httpsGitHost('git@github.com:JoeDoe56/sfgl.git'), undefined);
    assert.equal(httpsGitHost('file:///C:/repo'), undefined);
    assert.equal(httpsGitHost('ext::sh -c evil'), undefined);
  });
});
