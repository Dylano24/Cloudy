import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupExpiredApplications, saveApplicationSettings,
  getApplicationSettings, getJoinToCreateConfig, saveJoinToCreateConfig, addJoinToCreateTrigger,
} from '../src/utils/database.js';
import { getApplicationSettingsKey, getApplicationKey, getJoinToCreateConfigKey } from '../src/utils/database/keys.js';

test('application cleanup does not delete records using default retention after settings read failure', async t => {
  const guildId = 'retention-read-failure';
  const appKey = getApplicationKey(guildId, 'existing');
  const app = { id: 'existing', userId: 'member', status: 'approved',
    createdAt: Date.now() - 60 * 86_400_000, reviewedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() };
  const deleted = t.mock.fn(async () => true);
  const client = { db: {
    list: async () => [appKey],
    get: async (key, fallback) => {
      if (key === getApplicationSettingsKey(guildId)) throw new Error('settings read failed');
      return key === appKey ? structuredClone(app) : fallback;
    },
    delete: deleted, set: async () => true,
  } };

  await cleanupExpiredApplications(client, guildId);

  assert.equal(deleted.mock.callCount(), 0);
});

for (const [name, save] of [
  ['application settings', (client, guildId) => saveApplicationSettings(client, guildId, { enabled: true })],
  ['Join to Create settings', (client, guildId) => saveJoinToCreateConfig(client, guildId, { enabled: true })],
]) {
  test(`${name} save fails without overwriting stored settings when the read fails`, async t => {
    const writes = t.mock.fn(async () => true);
    const client = { db: { get: async () => { throw new Error('read failed'); }, set: writes } };
    assert.equal(await save(client, `${name}-read-failure`), false);
    assert.equal(writes.mock.callCount(), 0);
  });

  test(`${name} save does not report success when persistence returns false`, async () => {
    const client = { db: { get: async (_key, fallback) => fallback, set: async () => false } };
    assert.equal(await save(client, `${name}-write-failure`), false);
  });
}

test('concurrent application settings updates preserve independent changes', async () => {
  let stored = {};
  const client = { db: {
    get: async () => structuredClone(stored),
    set: async (_key, value) => { stored = structuredClone(value); return true; },
  } };
  await Promise.all([
    saveApplicationSettings(client, 'settings-race', { enabled: true }),
    saveApplicationSettings(client, 'settings-race', { applicationChannelId: 'new-channel' }),
  ]);
  assert.equal(stored.enabled, true);
  assert.equal(stored.applicationChannelId, 'new-channel');
});

test('Join to Create trigger mutation stops at the failed first authoritative read', async t => {
  const guildId = 'jtc-first-read';
  let reads = 0;
  const writes = t.mock.fn(async () => true);
  const client = { db: {
    get: async key => {
      assert.equal(key, getJoinToCreateConfigKey(guildId));
      if (++reads === 1) throw new Error('first read failed');
      return { enabled: true, triggerChannels: ['original'] };
    }, set: writes,
  } };
  assert.equal(await addJoinToCreateTrigger(client, guildId, 'new'), false);
  assert.equal(writes.mock.callCount(), 0);
});

test('public application and Join to Create reads retain their existing soft defaults', async () => {
  const client = { db: { get: async () => { throw new Error('read failed'); } } };
  assert.equal((await getApplicationSettings(client, 'soft')).enabled, false);
  assert.deepEqual((await getJoinToCreateConfig(client, 'soft')).triggerChannels, []);
});
