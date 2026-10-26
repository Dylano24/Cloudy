import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, peekEmbedRegistry, purgeEmbedRegistryRecord } from '../src/services/embedRegistryService.js';
import { loadFastEmbedBuilderSearchRecords, invalidateBuilderSearchTitleCache } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function fixture(t, suffix) {
  const guildId = 'delete-search-immediate-' + suffix;
  const channelId = '123456789012345691';
  const record = (id, title, embedIndex = 0) => ({ guildId, channelId, messageId: id, embedIndex,
    source: 'embed-builder', manualSaved: true, detached: true, title, snapshot: { title, description: 'Owner contents' }, components: [] });
  const selected = record('123456789012345692', 'Remove exactly this saved item');
  const other = record('123456789012345693', 'Keep this independent saved item');
  const storage = new Map([['cloudy:embed-registry:' + guildId, [selected, other]]]);
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async key => { storage.delete(key); return true; });
  const channel = { id: channelId, permissionsFor: () => ({ has: () => true }) };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  return { guildId, channelId, selected, other, storage, record, interaction: { guildId, guild, member: { id: 'owner' } } };
}

test('a confirmed purge updates the warm Search list immediately without waiting for another database refresh', async t => {
  const f = fixture(t, 'warm');
  await getEmbedRegistry(f.guildId);
  assert.equal((await loadFastEmbedBuilderSearchRecords(f.interaction)).length, 2);
  assert.equal(await purgeEmbedRegistryRecord(f.guildId, f.channelId, f.selected.messageId, 0), true);
  invalidateBuilderSearchTitleCache(f.guildId);
  let reads = 0;
  t.mock.method(db, 'get', async (_key, fallback) => { reads++; return fallback; });
  const records = await loadFastEmbedBuilderSearchRecords(f.interaction);
  assert.deepEqual(records.map(record => record.messageId), [f.other.messageId]);
  assert.deepEqual(peekEmbedRegistry(f.guildId).map(record => record.messageId), [f.other.messageId]);
  assert.equal(reads, 0);
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(f.storage.get(key) ?? fallback));
  const cold = await import('../src/services/embedRegistryService.js?confirmed-delete-restart');
  assert.deepEqual((await cold.getEmbedRegistry(f.guildId)).map(record => record.messageId), [f.other.messageId]);
});

test('whole-message purge removes every saved sibling in one registry write even when Discord is already missing', async t => {
  const f = fixture(t, 'siblings');
  const key = 'cloudy:embed-registry:' + f.guildId;
  f.storage.get(key).push(f.record(f.selected.messageId, 'Second saved embed in the same message', 2));
  const ruleIndex = `cloudy:embed-reappear-index:${f.guildId}:${f.channelId}`;
  f.storage.set(ruleIndex, [f.selected.messageId, f.other.messageId]);
  let writes = 0;
  t.mock.method(db, 'set', async (name, value) => { if (name === key) writes++; f.storage.set(name, structuredClone(value)); return true; });
  assert.equal(await purgeEmbedRegistryRecord(f.guildId, f.channelId, f.selected.messageId, null), true);
  assert.deepEqual(f.storage.get(key).map(record => record.messageId), [f.other.messageId]);
  assert.equal(writes, 1);
  assert.deepEqual(f.storage.get(ruleIndex), [f.other.messageId]);
  for (const index of [0, 2]) assert.equal(f.storage.get(`cloudy:embed-reappear-disabled:${f.guildId}:${f.channelId}:${f.selected.messageId}:${index}`).disabled, true);
  assert.equal(f.storage.has(`cloudy:embed-reappear-disabled:${f.guildId}:${f.channelId}:${f.other.messageId}:0`), false);
});

test('a failed registry purge preserves stored and cached records and cannot report success', async t => {
  const f = fixture(t, 'failed-write');
  await getEmbedRegistry(f.guildId);
  t.mock.method(db, 'set', async () => false);
  assert.equal(await purgeEmbedRegistryRecord(f.guildId, f.channelId, f.selected.messageId, null), false);
  assert.equal(f.storage.get('cloudy:embed-registry:' + f.guildId).length, 2);
  assert.equal(peekEmbedRegistry(f.guildId).length, 2);
});

test('a registry refresh started during Delete cannot restore its old Search snapshot while cleanup is pending', async t => {
  const f = fixture(t, 'inflight');
  await getEmbedRegistry(f.guildId);
  const key = 'cloudy:embed-registry:' + f.guildId;
  const oldRecords = structuredClone(f.storage.get(key));
  let releaseWrite, writeStarted, releaseRead, cleanupStarted, releaseCleanup;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const writing = new Promise(resolve => { writeStarted = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const cleaning = new Promise(resolve => { cleanupStarted = resolve; });
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  let registryReads = 0;
  t.mock.method(db, 'get', async (name, fallback) => {
    if (name === key && ++registryReads === 2) return readGate;
    return structuredClone(f.storage.get(name) ?? fallback);
  });
  t.mock.method(db, 'set', async (name, value) => {
    if (name === key) { writeStarted(); await writeGate; }
    if (name.startsWith('cloudy:embed-reappear-disabled:')) { cleanupStarted(); await cleanupGate; }
    f.storage.set(name, structuredClone(value));
    return true;
  });
  const deleting = purgeEmbedRegistryRecord(f.guildId, f.channelId, f.selected.messageId, null);
  await writing;
  const staleRead = getEmbedRegistry(f.guildId);
  releaseWrite();
  await cleaning;
  try {
    releaseRead(oldRecords);
    await staleRead;
    assert.equal(peekEmbedRegistry(f.guildId).some(record => record.messageId === f.selected.messageId), false);
  } finally {
    releaseRead(oldRecords);
    releaseCleanup();
    await deleting;
  }
});
