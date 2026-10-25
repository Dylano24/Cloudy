import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/utils/database.js';
import {
  saveEmbedTemplateDecoration,
  getCachedSavedEmbedTemplateData,
} from '../src/services/embedTemplateService.js';
import {
  buildMatches,
  buildAutocompleteMatches,
  buildSearchChoices,
  recordTitle,
  isBuilderDeletedSearchRecord,
  invalidateBuilderSearchTitleCache,
  loadFastEmbedBuilderSearchRecords,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import {
  hideSystemCatalogFromBuilder,
  isSystemCatalogHiddenFromBuilder,
} from '../src/services/systemEmbedCatalogService.js';
import {
  getEmbedRegistry,
  purgeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';

function guild(id, channelId) {
  const channel = {
    id: channelId, guildId: id, name: 'welcome',
    permissionsFor: () => ({ has: () => true }),
  };
  return { id, channels: { cache: new Map([[channelId, channel]]) } };
}

test('saved title replaces old Search label without making a second result, while original catalog identity survives', async t => {
  const guildId = 'title-rename-autocomplete-20261025';
  const channelId = '1634506224312300011';
  const original = '✅ Welcome Ping Updated';
  const updated = 'Welcome notification updated';
  const author = 'Cloudy template key: source:welcome-ping || Cloudy context: welcome/ping || Cloudy kind: embed';
  const stored = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(stored.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { stored.set(key, structuredClone(value)); return true; });

  const catalog = {
    guildId, channelId, messageId: 'catalog-master', embedIndex: 0,
    source: 'system-catalog', name: original, title: original,
    snapshot: { title: original, description: 'Welcome message content.', author: { name: author } },
  };
  const runtime = {
    ...catalog, messageId: 'actual-posted-message', source: 'modified-template',
    snapshot: structuredClone(catalog.snapshot),
  };
  const server = guild(guildId, channelId);
  const before = buildSearchChoices(buildMatches(server, [catalog, runtime], 'welcome ping'));
  assert.equal(before.length, 1);

  assert.equal(await saveEmbedTemplateDecoration(
    guildId, channelId, ['source:welcome-ping', original],
    { ...catalog.snapshot, title: updated }, { sharedScope: true, canonicalIdentity: 'source:welcome-ping' },
  ), true);
  invalidateBuilderSearchTitleCache(guildId);

  assert.equal(getCachedSavedEmbedTemplateData(guildId, channelId, catalog.snapshot).data.title, updated);
  assert.equal(recordTitle(catalog), updated);
  assert.equal(recordTitle(runtime), updated);
  const selected = buildMatches(server, [catalog, runtime], 'welcome notification updated');
  assert.equal(selected.length, 1);
  assert.deepEqual(buildSearchChoices(selected).map(c => c.name), [updated]);
  assert.equal(buildAutocompleteMatches(server, [catalog, runtime], 'welcome notification updated').length, 1);
  assert.ok(buildSearchChoices(buildMatches(server, [catalog, runtime], 'welcome ping'))
    .every(choice => choice.name !== 'Welcome ping updated'),
    'the old title is never offered, even when a description/context search finds this same record');
  assert.equal(catalog.messageId, 'catalog-master');
  assert.equal(catalog.snapshot.title, original, 'a Search rename must not rewrite the source catalog');
});

test('manual saved title remains exact and is not replaced by a similarly named global template', async t => {
  const guildId = 'manual-title-sync-20261025';
  const channelId = '1634506224312300022';
  const data = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { data.set(key, structuredClone(value)); return true; });
  await saveEmbedTemplateDecoration(guildId, channelId,
    ['Custom banner'], { title: 'Cloudy global banner' }, { sharedScope: true });
  const saved = {
    guildId, channelId, messageId: 'manual-1', embedIndex: 0,
    source: 'embed-builder', manualSaved: true,
    title: 'Custom banner', name: 'Custom banner',
    snapshot: { title: 'Custom banner', description: 'Owner wrote this.' },
  };
  assert.equal(recordTitle(saved), 'Custom banner');
  assert.deepEqual(buildSearchChoices(buildMatches(guild(guildId, channelId), [saved], 'custom banner'))
    .map(c => c.name), ['Custom banner']);
});

test('Delete hides catalog and its cached canonical/live counterparts, never unrelated templates', async t => {
  const guildId = 'delete-catalog-search-sync-20261025';
  const channelId = '1634506224312300033';
  const data = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { data.set(key, structuredClone(value)); return true; });
  const record = {
    guildId, channelId, messageId: 'catalog-old', source: 'system-catalog',
    embedIndex: 0, title: 'Welcome notification', name: 'Welcome notification',
    snapshot: {
      title: 'Welcome notification', description: 'Cloudy says welcome.',
      author: { name: 'Cloudy template key: source:welcome-notification || Cloudy context: welcome/ping || Cloudy kind: embed' },
    },
  };
  const cachedProjection = {
    ...record, messageId: 'cached-canonical', source: 'modified-template',
    canonicalIdentity: 'source:welcome-notification',
    sourceRecord: record, previewRecord: { ...record, source: 'cloudy', messageId: 'current-peer' },
  };
  const matchingPeer = { ...record, source: 'cloudy', messageId: 'other-live', sourceRecord: null };
  const unrelated = {
    ...record, messageId: 'different-template',
    snapshot: { ...record.snapshot,
      title: 'Other notification',
      author: { name: 'Cloudy template key: source:other-notification || Cloudy context: welcome/ping || Cloudy kind: embed' } },
  };
  const server = guild(guildId, channelId);
  assert.equal(buildMatches(server, [record, cachedProjection, matchingPeer], 'welcome notification').length, 1);
  assert.equal(await hideSystemCatalogFromBuilder(guildId, record), true);
  invalidateBuilderSearchTitleCache(guildId);
  assert.equal(isSystemCatalogHiddenFromBuilder(record), true);
  assert.equal(isBuilderDeletedSearchRecord(cachedProjection), true);
  assert.equal(isBuilderDeletedSearchRecord(matchingPeer), true);
  assert.equal(buildMatches(server, [record, cachedProjection, matchingPeer], 'welcome notification').length, 0,
    'cached catalog views and live mirrors must not resurrect an explicitly deleted entry');
  assert.deepEqual(buildSearchChoices(buildMatches(server, [unrelated], 'other notification'))
    .map(c => c.name), ['Other notification']);
});

test('physical Builder purge leaves no ghost Search record after cache refresh', async t => {
  const guildId = 'delete-physical-search-sync-20261025';
  const channelId = '1634506224312300044';
  const registryKey = 'cloudy:embed-registry:' + guildId;
  const saved = {
    guildId, channelId, messageId: 'manual-saved', embedIndex: 0,
    source: 'embed-builder', manualSaved: true,
    title: 'Custom saved embed', name: 'Custom saved embed',
    snapshot: { title: 'Custom saved embed', description: 'Saved owner text.' },
  };
  const data = new Map([[registryKey, [saved]]]);
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { data.set(key, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async key => { data.delete(key); return true; });
  const server = guild(guildId, channelId);
  await getEmbedRegistry(guildId);
  const interaction = { guildId, guild: server, member: { id: 'owner' }, client: null };
  assert.equal((await loadFastEmbedBuilderSearchRecords(interaction)).length > 0, true);
  assert.equal(await purgeEmbedRegistryRecord(guildId, channelId, saved.messageId, 0), true);
  await getEmbedRegistry(guildId);
  invalidateBuilderSearchTitleCache(guildId);
  const current = await loadFastEmbedBuilderSearchRecords(interaction);
  assert.equal(current.some(r => String(r.messageId) === saved.messageId), false);
});
