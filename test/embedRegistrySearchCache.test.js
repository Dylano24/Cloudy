import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, removeEmbedRegistryRecord, registerCloudyEmbedMessage, peekEmbedRegistry } from '../src/services/embedRegistryService.js';

test('search cache shares successful reads and is invalidated by a registry mutation', async t => {
  let reads = 0;
  const record = { guildId: 'search-cache', channelId: 'channel', messageId: 'message', title: 'Saved', source: 'embed-builder', manualSaved: true, snapshot: { title: 'Saved' } };
  let stored = [record];
  t.mock.method(db, 'get', async key => {
    // Permanent Delete tombstones have their own storage key and read.
    if (key.startsWith('cloudy:embed-registry-deleted:')) return [];
    reads++;
    return structuredClone(stored);
  });
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

test('an old in-flight registry read cannot replace a successfully saved Search snapshot', async t => {
  const guildId = 'search-delayed-read-after-save';
  let resolveRead;
  const oldRead = new Promise(resolve => { resolveRead = resolve; });
  let signalReadStarted;
  const oldReadStarted = new Promise(resolve => { signalReadStarted = resolve; });
  t.after(() => resolveRead([]));
  let reads = 0;
  t.mock.method(db, 'get', async (key, fallback) => {
    if (key.startsWith('cloudy:embed-registry-deleted:')) return [];
    // Hold the Search read, never the tombstone lookup. Explicitly wait
    // until the old read has started before the concurrent Save begins:
    // otherwise scheduling could block the Save instead of the Search.
    if (++reads === 1) {
      signalReadStarted();
      return oldRead;
    }
    return fallback;
  });
  t.mock.method(db, 'set', async () => true);
  const pending = getEmbedRegistry(guildId);
  await oldReadStarted;
  const embed = { title: 'New saved title', description: 'Saved content' };
  assert.equal(await registerCloudyEmbedMessage({
    id: 'saved-message', guildId, channelId: 'channel',
    author: { id: 'bot' }, embeds: [embed], components: [],
  }, 'embed-builder'), true);
  assert.equal(peekEmbedRegistry(guildId, { current: true })[0].title, 'New saved title');
  resolveRead([]);
  await pending;
  assert.equal(peekEmbedRegistry(guildId, { current: true })?.[0]?.title, 'New saved title');
});

test('search never caches a failed registry read', async t => {
  let reads = 0;
  t.mock.method(db, 'get', async key => {
    if (key.startsWith('cloudy:embed-registry-deleted:')) return [];
    if (++reads === 1) throw new Error('offline');
    return [];
  });
  await assert.rejects(getEmbedRegistry('search-cache-recovery', { cached: true }));
  assert.deepEqual(await getEmbedRegistry('search-cache-recovery', { cached: true }), []);
  assert.equal(reads, 2);
});
