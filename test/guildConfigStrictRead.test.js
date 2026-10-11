import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildConfig, updateGuildConfig, patchGuildConfig } from '../src/services/config/guildConfig.js';

let nextId = 910000000000000000n;
const id = () => String(nextId++);

test('failed config read is not cached and recovery restores stored settings', async () => {
  let reads = 0;
  const client = { db: { get: async (_key, _default, options) => {
    assert.equal(options?.strict, true);
    if (++reads === 1) throw new Error('temporary read failure');
    return { prefix: '?', maxTicketsPerUser: 8 };
  } } };
  const guildId = id();
  assert.equal((await getGuildConfig(client, guildId)).maxTicketsPerUser, 3);
  assert.equal((await getGuildConfig(client, guildId)).maxTicketsPerUser, 8);
  assert.equal(reads, 2);
});

for (const update of [updateGuildConfig, patchGuildConfig]) {
  test(`${update.name} does not overwrite settings after a failed cold read`, async () => {
    let writes = 0;
    const client = { db: { get: async () => { throw new Error('offline'); }, set: async () => { writes++; return true; } } };
    await assert.rejects(update(client, id(), { maxTicketsPerUser: 4 }));
    assert.equal(writes, 0);
  });
}

test('a genuinely missing config permits first write and warm updates need no read', async () => {
  let reads = 0;
  const client = { db: { get: async () => { reads++; return null; }, set: async () => true } };
  const guildId = id();
  assert.equal((await updateGuildConfig(client, guildId, { maxTicketsPerUser: 4 })).maxTicketsPerUser, 4);
  assert.equal((await updateGuildConfig(client, guildId, { prefix: '?' })).maxTicketsPerUser, 4);
  assert.equal(reads, 1);
});

test('concurrent failed config reads share one request without poisoning cache', async () => {
  let reads = 0;
  const client = { db: { get: async () => { reads++; await new Promise(r => setTimeout(r, 5)); throw new Error('offline'); } } };
  const guildId = id();
  const configs = await Promise.all(Array.from({ length: 5 }, () => getGuildConfig(client, guildId)));
  assert.equal(reads, 1);
  assert.ok(configs.every(c => c.maxTicketsPerUser === 3));
});
