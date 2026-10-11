import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, removeEmbedRegistryRecord } from '../src/services/embedRegistryService.js';

test('search cache shares successful reads and is invalidated by a registry mutation', async t => {
  let reads = 0;
  const record = { guildId: 'search-cache', channelId: 'channel', messageId: 'message', title: 'Saved', source: 'bot-history', snapshot: { title: 'Saved' } };
  let stored = [record];
  t.mock.method(db, 'get', async () => { reads++; return structuredClone(stored); });
  t.mock.method(db, 'set', async (_key, value) => { stored = value; return true; });
  const first = await getEmbedRegistry(record.guildId, { cached: true });
  first[0].title = 'Caller edit';
  assert.equal((await getEmbedRegistry(record.guildId, { cached: true }))[0].title, 'Saved');
  assert.equal(reads, 1);
  await removeEmbedRegistryRecord(record.guildId, record.channelId, record.messageId, 0);
  const afterRemoval = await getEmbedRegistry(record.guildId, { cached: true });
  assert.equal(afterRemoval[0].detached, true, 'saved snapshot stays available as a detached template');
  assert.equal(reads, 3);
});

test('search never caches a failed registry read', async t => {
  let reads = 0;
  t.mock.method(db, 'get', async () => { if (++reads === 1) throw new Error('offline'); return []; });
  await assert.rejects(getEmbedRegistry('search-cache-recovery', { cached: true }));
  assert.deepEqual(await getEmbedRegistry('search-cache-recovery', { cached: true }), []);
  assert.equal(reads, 2);
});
