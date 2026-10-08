import test from 'node:test';
import assert from 'node:assert/strict';
import { getWelcomeConfig, saveWelcomeConfig, updateWelcomeConfig } from '../src/utils/database.js';

test('welcome saves stop before writing after an authoritative read failure', async t => {
  const set = t.mock.fn(async () => true);
  const client = { db: { get: async () => { throw new Error('read failed'); }, set } };
  assert.equal(await saveWelcomeConfig(client, 'welcome-read-failure', { enabled: true }), false);
  assert.equal(set.mock.callCount(), 0);
});

test('welcome saves reject false persistence results', async () => {
  const client = { db: { get: async (_key, fallback) => fallback, set: async () => false } };
  assert.equal(await saveWelcomeConfig(client, 'welcome-write-failure', { enabled: true }), false);
  await assert.rejects(updateWelcomeConfig(client, 'welcome-write-failure', { enabled: true }));
});

test('concurrent welcome updates preserve independent settings and return saved config', async () => {
  let stored = { welcomeMessage: 'Original message', roleIds: ['existing-role'] };
  const client = { db: {
    get: async () => structuredClone(stored),
    set: async (_key, value) => { stored = structuredClone(value); return true; },
  } };
  const results = await Promise.all([
    updateWelcomeConfig(client, 'welcome-race', { enabled: true }),
    updateWelcomeConfig(client, 'welcome-race', { goodbyeEnabled: true }),
  ]);
  assert.equal(stored.enabled, true);
  assert.equal(stored.goodbyeEnabled, true);
  assert.equal(stored.welcomeMessage, 'Original message');
  assert.deepEqual(stored.roleIds, ['existing-role']);
  assert.equal(results[0].enabled, true);
  assert.equal(results[1].goodbyeEnabled, true);
});

test('welcome display reads retain soft defaults during a storage outage', async () => {
  const client = { db: { get: async () => { throw new Error('read failed'); } } };
  assert.equal((await getWelcomeConfig(client, 'welcome-soft-read')).enabled, false);
});
