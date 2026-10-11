import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildConfig, updateGuildConfig } from '../src/services/config/guildConfig.js';

test('expired config returns immediately while refresh runs; writers await a fresh strict read', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let reads = 0;
  let release;
  const saved = [];
  const client = { db: { get: async () => {
    if (++reads === 1) return { prefix: 'old', maxTicketsPerUser: 4 };
    if (reads === 2) return new Promise(resolve => { release = resolve; });
    return { prefix: 'fresh', maxTicketsPerUser: 8 };
  }, set: async (_key, value) => { saved.push(value); return true; } } };
  const guildId = '940000000000000001';
  await getGuildConfig(client, guildId);
  now += 300001;
  const result = await Promise.race([getGuildConfig(client, guildId), new Promise(resolve => setTimeout(() => resolve(null), 30))]);
  assert.equal(result?.prefix, 'old');
  await updateGuildConfig(client, guildId, { maxTicketsPerUser: 6 });
  assert.equal(saved[0].prefix, 'fresh');
  release({ prefix: 'obsolete', maxTicketsPerUser: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await getGuildConfig(client, guildId)).prefix, 'fresh');
});

test('failed refresh retains last good config without letting stale values drive writes', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let offline = false;
  let writes = 0;
  const client = { db: { get: async () => { if (offline) throw new Error('offline'); return { prefix: '?', maxTicketsPerUser: 8 }; }, set: async () => { writes++; return true; } } };
  const guildId = '940000000000000002';
  await getGuildConfig(client, guildId);
  now += 300001;
  offline = true;
  assert.equal((await getGuildConfig(client, guildId)).prefix, '?');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await getGuildConfig(client, guildId)).prefix, '?');
  await assert.rejects(updateGuildConfig(client, guildId, { maxTicketsPerUser: 5 }));
  assert.equal(writes, 0);
});
