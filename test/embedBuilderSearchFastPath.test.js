import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  peekEmbedRegistry,
  removeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';

test('peekEmbedRegistry serves the last read synchronously while a registry write is still queued', async t => {
  let reads = 0;
  const record = {
    guildId: 'peek-guild', channelId: 'channel', messageId: 'message',
    title: 'Saved', source: 'embed-builder', manualSaved: true, snapshot: { title: 'Saved' },
  };
  let stored = [record];
  let releaseWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  t.mock.method(db, 'get', async () => { reads++; return structuredClone(stored); });
  t.mock.method(db, 'set', async (_key, value) => { await writeGate; stored = value; return true; });

  assert.equal(peekEmbedRegistry(record.guildId), null, 'cold process has nothing to peek');
  await getEmbedRegistry(record.guildId, { cached: true });
  assert.equal(reads, 1);

  // A queued mutation bypasses the 5 s search cache; the peek must still answer
  // without a storage read so autocomplete never waits on the write queue.
  const pendingWrite = removeEmbedRegistryRecord(record.guildId, 'channel', 'message', 0);
  await new Promise(resolve => setImmediate(resolve));
  const readsBeforePeek = reads;
  const peeked = peekEmbedRegistry(record.guildId);
  assert.equal(peeked.length, 1);
  assert.equal(peeked[0].title, 'Saved');
  assert.equal(reads, readsBeforePeek, 'peek performs no read');
  peeked[0].title = 'Caller edit';
  assert.equal(peekEmbedRegistry(record.guildId)[0].title, 'Saved', 'peek hands out copies');

  releaseWrite();
  await pendingWrite;
  const refreshed = await getEmbedRegistry(record.guildId, { cached: true });
  assert.equal(refreshed[0].detached, true);
  assert.equal(peekEmbedRegistry(record.guildId)[0].detached, true, 'refresh updates the peek');
});

test('Search autocomplete fast path merges cached canonical Builder records and never awaits storage when warm', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const fastStart = source.indexOf('async function loadFastEmbedBuilderSearchRecords');
  const fastEnd = source.indexOf('async function loadEmbedBuilderSearchRecords', fastStart);
  assert.ok(fastStart >= 0 && fastEnd > fastStart);
  const fast = source.slice(fastStart, fastEnd);

  assert.match(fast, /peekEmbedRegistry\(interaction\.guildId\)/);
  assert.match(fast, /known \|\| await getEmbedRegistry/);
  assert.match(fast, /peekCanonicalBuilderRecords\(interaction\.guild\)/);
  assert.match(fast, /mergeSearchRecords\(interaction\.guildId, \[\.\.\.registryRecords, \.\.\.canonicalRecords\]\)/);
  assert.doesNotMatch(fast, /await getFastCanonicalBuilderRecords/);
  assert.doesNotMatch(fast, /await getCanonicalBuilderRecords/);

  // The canonical cache keeps its last records while a refresh is in flight,
  // otherwise the refresh interval would hide Builder items from Search between refreshes.
  const canonicalStart = source.indexOf('async function getFastCanonicalBuilderRecords');
  const canonicalEnd = source.indexOf('function peekCanonicalBuilderRecords', canonicalStart);
  assert.ok(canonicalStart >= 0 && canonicalEnd > canonicalStart);
  const canonical = source.slice(canonicalStart, canonicalEnd);
  assert.match(canonical, /records: cached\?\.records \|\| null/);
});
