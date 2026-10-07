import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';

test('parallel Builder registry reads share storage work but preserve isolated results and fresh subsequent reads', async () => {
  db.initialized = true;
  db.useFallback = false;
  let reads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = db.db;
  db.db = { get: async () => {
    reads++;
    await gate;
    return [{ guildId: 'read-latency', channelId: 'channel', messageId: 'message', title: 'Saved artwork', source: 'embed-builder', snapshot: { title: 'Saved artwork' } }];
  } };
  try {
    const pending = Array.from({ length: 10 }, () => getEmbedRegistry('read-latency'));
    release();
    const records = await Promise.all(pending);
    assert.equal(reads, 1);
    assert.equal(records[0].length, 1);
    records[0][0].title = 'Only this caller changed it';
    assert.equal(records[1][0].title, 'Saved artwork');
    await getEmbedRegistry('read-latency');
    assert.equal(reads, 2, 'later reads must reload storage rather than retain stale settings');
  } finally {
    db.db = original;
  }
});
