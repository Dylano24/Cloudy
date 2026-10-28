import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  peekEmbedRegistry,
  removeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';
import { loadFastEmbedBuilderSearchRecords } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('peekEmbedRegistry serves the last read synchronously while a registry write is still queued', async t => {
  let reads = 0;
  const record = {
    guildId: 'peek-guild', channelId: 'channel', messageId: 'message',
    title: 'Saved', source: 'embed-builder', manualSaved: true, snapshot: { title: 'Saved' },
  };
  let stored = [record];
  let releaseWrite;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  t.mock.method(db, 'get', async (key) => {
    reads++;
    // The registry now checks permanent Delete tombstones on a cold read.
    if (key.startsWith('cloudy:embed-registry-deleted:')) return [];
    return structuredClone(stored);
  });
  t.mock.method(db, 'set', async (_key, value) => { await writeGate; stored = value; return true; });

  assert.equal(peekEmbedRegistry(record.guildId), null, 'cold process has nothing to peek');
  await getEmbedRegistry(record.guildId, { cached: true });
  assert.equal(reads, 2, 'initial load reads both tombstones and registry');

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

  // Read-only peek: ranking does not deep-copy the registry per keystroke.
  assert.match(fast, /peekEmbedRegistry\(guildId(?:, \{ clone: false \})?\)/);
  assert.match(fast, /const known = peekEmbedRegistry\(guildId(?:, \{ clone: false \})?\)/);
  assert.match(fast, /cached\?\.generation === generation/);
  assert.match(fast, /cached\?\.records\?\.length/);
  assert.match(fast, /fastSearchCache\.set\(guildId/);
  assert.doesNotMatch(fast, /await getEmbedRegistry/);
  assert.match(fast, /peekCanonicalBuilderRecords\(interaction\.guild\)/);
  assert.match(fast, /mergeSearchRecords\(guildId, \[\.\.\.\(known \|\| \[\]\), \.\.\.canonicalRecords\]\)/);
  assert.doesNotMatch(fast, /await getFastCanonicalBuilderRecords/);
  assert.doesNotMatch(fast, /await getCanonicalBuilderRecords/);

  // The canonical cache keeps its last records while a refresh is in flight,
  // otherwise the refresh interval would hide Builder items from Search between refreshes.
  const canonicalStart = source.indexOf('async function getFastCanonicalBuilderRecords');
  const canonicalEnd = source.indexOf('function peekCanonicalBuilderRecords', canonicalStart);
  assert.ok(canonicalStart >= 0 && canonicalEnd > canonicalStart);
  const canonical = source.slice(canonicalStart, canonicalEnd);
  assert.match(canonical, /records: cached\?\.records \|\| null/);
  assert.match(canonical, /generation === getEmbedRegistryGeneration\(key\)/,
    'in-flight Search refresh cannot publish records from before Save/Delete');
  assert.match(canonical, /canonicalSearchCache\.get\(key\)\?\.promise === promise/,
    'an invalidated promise cannot overwrite the post-Save or post-Delete cache');
});

test('cold autocomplete never waits for a blocked PostgreSQL read', async t => {
  const guildId = 'search-cold-db-does-not-block-20261024';
  let reads = 0;
  t.mock.method(db, 'get', async () => {
    reads += 1;
    return new Promise(() => {});
  });
  const guild = { id: guildId, channels: { cache: new Map() } };
  const interaction = { guildId, guild, member: { id: 'test-owner' }, client: null };
  const result = await Promise.race([
    loadFastEmbedBuilderSearchRecords(interaction),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 350)),
  ]);
  assert.notEqual(result, 'timeout', 'autocomplete must not wait on database storage');
  assert.ok(Array.isArray(result));
  assert.equal(reads, 0, 'a standalone autocomplete loader must not start expensive DB reads before response');
});

test('warm autocomplete cache serves saved embeds without repeating the expensive catalog merge', async t => {
  const guildId = 'search-fast-index-persistence-20261024';
  const channelId = '999999999999999991';
  const record = {
    guildId, channelId, messageId: '999999999999999992', embedIndex: 0,
    source: 'embed-builder', manualSaved: true,
    title: 'Saved rules', snapshot: { title: 'Saved rules', description: 'Full saved content' },
  };
  t.mock.method(db, 'get', async () => [record]);
  const member = { id: 'builder-owner' };
  const channel = { id: channelId, guildId, permissionsFor: () => ({ has: () => true }) };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  await getEmbedRegistry(guildId, { cached: true });
  const interaction = { guildId, guild, member, client: null };
  const first = await loadFastEmbedBuilderSearchRecords(interaction);
  const second = await loadFastEmbedBuilderSearchRecords(interaction);
  assert.ok(first.some(x => x.messageId === record.messageId));
  assert.ok(second.some(x => x.messageId === record.messageId));
  assert.equal(first.length, second.length);
});

test('autocomplete schedules heavyweight catalog/DB work only after responding', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const start = source.indexOf('embedBuilderCommand.autocomplete');
  const end = source.indexOf('const originalExecute', start);
  const handler = source.slice(start, end);
  assert.match(handler, /buildIndexedAutocompleteMatches\(/);
  assert.match(handler, /await interaction.respond\(choices\)/);
  assert.match(handler, /scheduleAutocompleteSearchRefresh\(interaction\)/);
  assert.ok(handler.indexOf('await interaction.respond(choices)') < handler.indexOf('scheduleAutocompleteSearchRefresh(interaction)'));
  assert.match(handler, /\[EMBED_SEARCH\] Autocomplete failed/);
  assert.match(handler, /resultCount: count/);
});
