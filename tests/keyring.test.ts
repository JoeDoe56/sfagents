import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KeyringSecretStore } from '@sfagents/core';

test('Windows keyring checks do not interfere across concurrent stores or delete saved credentials', { skip: process.platform !== 'win32' }, async () => {
  const { AsyncEntry, findCredentialsAsync } = await import('@napi-rs/keyring');
  const service = `SF Agents test ${randomUUID()}`;
  const stores = Array.from({ length: 16 }, () => new KeyringSecretStore(service));
  const saved = new AsyncEntry(service, 'saved-provider');
  const value = randomUUID();
  try {
    await saved.setPassword(value);
    // Keep checking while independent store instances all write/read/delete
    // probes in the same service, as the provider and sign-in routes do.
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled(stores.map(store => store.check()));
      assert.deepEqual(results.filter(r => r.status === 'rejected'), []);
      assert.equal(await saved.getPassword(), value);
    }
    assert.deepEqual(await findCredentialsAsync(service), [{ account: 'saved-provider', password: value }]);
  } finally {
    // This random service belongs only to this test. Clean up even on failure.
    for (const entry of await findCredentialsAsync(service)) await new AsyncEntry(service, entry.account).deleteCredential();
  }
});

test('Windows keyring saves and removes concurrent provider secrets, and recovers after an error', { skip: process.platform !== 'win32' }, async () => {
  const { AsyncEntry, findCredentialsAsync } = await import('@napi-rs/keyring');
  const service = `SF Agents test ${randomUUID()}`;
  const stores = Array.from({ length: 16 }, () => new KeyringSecretStore(service));
  try {
    // Reject an invalid target without leaving the shared queue rejected.
    await assert.rejects(stores[0]!.get('x'.repeat(32768)), /No system keyring/);
    await Promise.all(stores.map(async (store, i) => {
      const account = `provider-${i}`;
      // OAuth tokens can span several Credential Manager entries.
      const value = JSON.stringify({ token: `${randomUUID()}${'é🔑'.repeat(900)}` });
      await store.set(account, value);
      await store.check();
      assert.equal(await new KeyringSecretStore(service).get(account), value);
      await store.set(account, 'replacement');
      assert.equal(await store.get(account), 'replacement');
      await store.delete(account);
      assert.equal(await store.get(account), null);
    }));
    assert.deepEqual(await findCredentialsAsync(service), []);
  } finally {
    for (const entry of await findCredentialsAsync(service)) await new AsyncEntry(service, entry.account).deleteCredential();
  }
});
