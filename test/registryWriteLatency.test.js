import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, registerCloudyEmbedMessage, purgeEmbedRegistryRecord } from '../src/services/embedRegistryService.js';

function fixture() {
  const values = new Map();
  let writes = 0;
  let fail = false;
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => {
      writes += 1;
      if (fail) throw new Error('storage full');
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => { values.delete(key); return true; },
  };
  const message = id => ({
    id, guildId: 'registry-latency', channelId: 'manual-channel',
    channel: { id: 'manual-channel', name: 'manual-channel' },
    author: { id: 'cloudy' }, client: { user: { id: 'cloudy' } },
    flags: { has: () => false }, createdAt: new Date('2026-10-07T00:00:00Z'),
    embeds: [{ title: 'Owner-created guide', description: id, color: 0xFFFFFF }],
    components: [],
  });
  return { message, writes: () => writes, fail: value => { fail = value; } };
}

test('unchanged registry updates do not rewrite the full guild JSON document', async () => {
  const f = fixture();
  assert.equal(await registerCloudyEmbedMessage(f.message('a'), 'embed-builder'), true);
  const before = await getEmbedRegistry('registry-latency');
  assert.equal(await registerCloudyEmbedMessage(f.message('a'), 'embed-builder'), true);
  assert.equal(f.writes(), 1);
  assert.deepEqual(await getEmbedRegistry('registry-latency'), before);
});

test('registration repairs malformed persisted entries rather than failing its no-op comparison', async () => {
  const f = fixture();
  await db.db.set('cloudy:embed-registry:registry-latency', [null, {}, 42]);
  assert.equal(await registerCloudyEmbedMessage(f.message('repaired'), 'embed-builder'), true);
  const records = await getEmbedRegistry('registry-latency');
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, 'repaired');
});

test('one burst of distinct registrations shares one durable write without losing manual embeds', async () => {
  const f = fixture();
  const result = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    registerCloudyEmbedMessage(f.message(String(i)), 'embed-builder')));
  assert.ok(result.every(Boolean));
  assert.equal(f.writes(), 1);
  assert.equal((await getEmbedRegistry('registry-latency')).length, 20);
});

test('a failed registration cannot claim success and the next registration retries', async () => {
  const f = fixture();
  f.fail(true);
  assert.equal(await registerCloudyEmbedMessage(f.message('a'), 'embed-builder'), false);
  assert.deepEqual(await getEmbedRegistry('registry-latency'), []);
  f.fail(false);
  assert.equal(await registerCloudyEmbedMessage(f.message('a'), 'embed-builder'), true);
  assert.equal((await getEmbedRegistry('registry-latency')).length, 1);
});

test('deletion queued between registrations retains its ordering', async () => {
  const f = fixture();
  await registerCloudyEmbedMessage(f.message('a'), 'embed-builder');
  const record = (await getEmbedRegistry('registry-latency'))[0];
  const beforeDelete = registerCloudyEmbedMessage(f.message('b'), 'embed-builder');
  const deletion = purgeEmbedRegistryRecord('registry-latency', record.channelId, record.messageId, 0);
  const afterDelete = registerCloudyEmbedMessage(f.message('c'), 'embed-builder');
  await Promise.all([beforeDelete, deletion, afterDelete]);
  assert.deepEqual((await getEmbedRegistry('registry-latency')).map(r => r.messageId).sort(), ['b', 'c']);
});
