import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  peekEmbedRegistry,
  getEmbedRegistryGeneration,
  registerCloudyEmbedMessage,
  relinkDetachedEmbedRegistryMessage,
  purgeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';
import {
  buildMatches,
  buildSearchChoices,
  loadFastEmbedBuilderSearchRecords,
  invalidateBuilderSearchTitleCache,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('post of saved draft replaces old title and old draft in Search immediately, before another DB read', async t => {
  const guildId = 'save-and-post-single-identity-20261027';
  const channelId = '185555555555550001';
  const draftId = 'draft-owner-111';
  const postedId = '185555555555550002';
  const store = new Map([['cloudy:embed-registry:' + guildId, [{
    guildId, channelId, messageId: draftId, embedIndex: 0, source: 'embed-builder',
    detached: true, manualSaved: true, name: 'fuck ts', title: 'fuck ts',
    snapshot: { title: 'fuck ts', description: 'Old middle text' },
    components: [], draftData: { message: 'Old middle text' },
  }]]]);
  let dbReads = 0;
  t.mock.method(db, 'get', async (key, fallback) => {
    dbReads++;
    return structuredClone(store.get(key) ?? fallback);
  });
  t.mock.method(db, 'set', async (key, value) => {
    store.set(key, structuredClone(value));
    return true;
  });
  const channel = { id: channelId, name: 'general', permissionsFor: () => ({ has: () => true }) };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  const interaction = { guildId, guild, member: { id: 'owner' } };
  const [oldDraft] = await getEmbedRegistry(guildId);
  assert.equal(oldDraft.snapshot.title, 'fuck ts');
  assert.equal((await loadFastEmbedBuilderSearchRecords(interaction)).length, 1);
  const posted = {
    id: postedId, guildId, channelId, channel,
    author: { id: 'bot' }, client: { user: { id: 'bot' } },
    embeds: [{ title: 'Ngl she called u weird too', description: 'New middle text' }],
    components: [],
  };
  // The existing Post first registers the Discord message, then relinks its
  // saved draft identity. The relink must atomically update warm Search too.
  assert.equal(await registerCloudyEmbedMessage(posted, 'embed-builder', { manualSave: true }), true);
  assert.equal(await relinkDetachedEmbedRegistryMessage(guildId, oldDraft, posted), true);
  const known = peekEmbedRegistry(guildId, { current: true });
  assert.equal(known?.length, 1, 'no ghost saved draft remains in warm Search');
  assert.equal(known[0].messageId, postedId);
  assert.equal(known[0].snapshot.title, 'Ngl she called u weird too');
  assert.equal(known[0].snapshot.description, 'New middle text');
  assert.equal(known[0].draftData, undefined, 'live message is no longer an unpublished draft');
  const readsBeforeSearch = dbReads;
  invalidateBuilderSearchTitleCache(guildId);
  const results = await loadFastEmbedBuilderSearchRecords(interaction);
  assert.deepEqual(results.map(record => record.messageId), [postedId]);
  assert.equal(dbReads, readsBeforeSearch, 'no DB refresh is needed to remove old result');
  assert.deepEqual(buildSearchChoices(buildMatches(guild, results, 'ngl she called')).map(x => x.name),
    ['Ngl she called u weird too']);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, results, 'fuck ts')), []);
});

test('a live posted Builder embed can be deleted by its original physical ID and disappears from Search', async t => {
  const guildId = 'live-delete-owner-post-20261027';
  const channelId = '185555555555550003';
  const messageId = '185555555555550004';
  const data = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { data.set(key, structuredClone(value)); return true; });
  const post = {
    id: messageId, channelId, guildId, author: { id: 'bot' },
    client: { user: { id: 'bot' } }, embeds: [{ title: 'Posted channel embed', description: 'Current content' }],
    components: [],
  };
  assert.equal(await registerCloudyEmbedMessage(post, 'embed-builder', { manualSave: true }), true);
  assert.equal((await getEmbedRegistry(guildId)).length, 1);
  // The Builder's confirmed live-Delete path performs message.delete() first,
  // then calls this purge with embedIndex=null. No draft detachment is allowed.
  assert.equal(await purgeEmbedRegistryRecord(guildId, channelId, messageId, null), true);
  assert.deepEqual(peekEmbedRegistry(guildId, { current: true }), []);
  assert.deepEqual(await getEmbedRegistry(guildId), []);
});

test('manual saved title is authoritative even with stale legacy name/title fields', () => {
  const guildId = 'stale-physical-manual-title-20261027';
  const channelId = '185555555555550005';
  const guild = { id: guildId, channels: { cache: new Map([[channelId, { name: 'general' }]]) } };
  const record = {
    guildId, channelId, messageId: '185555555555550006', source: 'embed-builder',
    manualSaved: true, embedIndex: 0, name: 'fuck ts', title: 'fuck ts',
    snapshot: { title: 'Ngl she called u weird too', description: 'Different body' },
  };
  const choices = buildSearchChoices(buildMatches(guild, [record], 'fuck ts'));
  assert.equal(choices.length, 0, 'old name is no longer an alias after explicit Save');
  assert.deepEqual(buildSearchChoices(buildMatches(guild, [record], 'ngl she called')).map(x => x.name),
    ['Ngl she called u weird too']);
});
