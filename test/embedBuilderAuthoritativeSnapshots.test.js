import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, getEmbedRegistrySnapshot, registerCloudyEmbedMessage, purgeEmbedRegistryRecord, saveNewBuilderDraftRecord, updateDetachedEmbedRegistrySnapshot } from '../src/services/embedRegistryService.js';
import { mergeEmbedManagerRecords } from '../src/services/embedManagerService.js';
import { discoverRecentChannelEmbeds, peekIndexedRecentChannelEmbeds, invalidateIndexedRecentChannelEmbeds } from '../src/services/embedMissingChannelService.js';

function fixture(t, suffix) {
  const guildId = 'authoritative-' + suffix;
  const channelId = '1888888888888888001';
  const data = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { data.set(key, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async key => { data.delete(key); return true; });
  const message = title => ({ id: '1888888888888888002', guildId, channelId,
    client: { user: { id: 'bot' } }, author: { id: 'bot' }, content: '', components: [],
    createdAt: new Date(), embeds: [{ title, description: 'Saved contents', color: 0xffffff }] });
  return { guildId, channelId, data, message };
}

test('late history cannot replace the preview of a successfully saved rename', async t => {
  const f = fixture(t, 'late-preview');
  await registerCloudyEmbedMessage(f.message('Test 1'), 'embed-builder', { manualSave: true });
  await registerCloudyEmbedMessage(f.message('Test 2'), 'embed-builder', { manualSave: true });
  await registerCloudyEmbedMessage(f.message('Test 1'), 'bot-history');
  const [record] = await getEmbedRegistry(f.guildId);
  assert.equal(record.snapshot.title, 'Test 2');
  assert.equal(getEmbedRegistrySnapshot(record).title, 'Test 2');
});

test('failed Save cannot publish an uncommitted preview over the last saved version', async t => {
  const f = fixture(t, 'failed-preview');
  await registerCloudyEmbedMessage(f.message('Test 1'), 'embed-builder', { manualSave: true });
  t.mock.method(db, 'set', async () => false);
  assert.equal(await registerCloudyEmbedMessage(f.message('Test 2'), 'embed-builder', { manualSave: true }), false);
  const [record] = await getEmbedRegistry(f.guildId);
  assert.equal(getEmbedRegistrySnapshot(record).title, 'Test 1');
});

test('failed detached Save preserves the committed preview when reopened', async t => {
  const f = fixture(t, 'failed-detached');
  const record = await saveNewBuilderDraftRecord(f.guildId, f.channelId, { title: 'Saved title', description: 'Saved body' }, []);
  t.mock.method(db, 'set', async () => false);
  assert.equal(await updateDetachedEmbedRegistrySnapshot(f.guildId, record, { title: 'Unsaved title' }), false);
  const [reopened] = await getEmbedRegistry(f.guildId);
  assert.equal(getEmbedRegistrySnapshot(reopened).title, 'Saved title');
});

test('clearing a detached title removes the old searchable title on Save', async t => {
  const f = fixture(t, 'clear-detached-title');
  const record = await saveNewBuilderDraftRecord(f.guildId, f.channelId, { title: 'Old title', description: 'Keep body' }, []);
  assert.equal(await updateDetachedEmbedRegistrySnapshot(f.guildId, record, { description: 'Keep body' }), true);
  const [reopened] = await getEmbedRegistry(f.guildId);
  assert.equal(reopened.title, '');
  assert.equal(getEmbedRegistrySnapshot(reopened).title, undefined);
});

test('channel merge keeps the saved identity and title when old discovery finishes after Save', async t => {
  const f = fixture(t, 'merge-save');
  await registerCloudyEmbedMessage(f.message('Test 1'), 'embed-builder', { manualSave: true });
  const [old] = await getEmbedRegistry(f.guildId);
  await registerCloudyEmbedMessage(f.message('Test 2'), 'embed-builder', { manualSave: true });
  const saved = await getEmbedRegistry(f.guildId);
  const merged = mergeEmbedManagerRecords(saved, [{ ...old, manualSaved: false }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].snapshot.title, 'Test 2');
  assert.equal(merged[0].manualSaved, true);
});

test('confirmed Delete cannot reappear in channel logs from an in-flight Discord history page', async t => {
  const f = fixture(t, 'delete-history');
  const message = f.message('Delete this log');
  await registerCloudyEmbedMessage(message, 'embed-builder', { manualSave: true });
  const stale = await getEmbedRegistry(f.guildId);
  let release, started;
  const fetching = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const channel = { id: f.channelId, type: 0, messages: { cache: new Collection(),
    fetch: async () => { started(); return gate; } } };
  const guild = { id: f.guildId, channels: { cache: new Collection([[f.channelId, channel]]) } };
  const pending = discoverRecentChannelEmbeds(guild, f.channelId, 'bot');
  await fetching;
  await purgeEmbedRegistryRecord(f.guildId, f.channelId, message.id, null);
  invalidateIndexedRecentChannelEmbeds(f.guildId, f.channelId, message.id);
  release(new Collection([[message.id, message]]));
  const discovered = await pending;
  assert.deepEqual(mergeEmbedManagerRecords(stale, discovered), []);
  assert.deepEqual(discovered, []);
  assert.deepEqual(peekIndexedRecentChannelEmbeds(guild), []);
});
