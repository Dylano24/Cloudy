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
  invalidateBuilderSearchTitleCache,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

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



test('a saved delete confirmation keeps its exact source title but is not a reusable Search choice', () => {
  const guildId = 'builder-removed-name-parity-20261025';
  const channelId = '1666666666666666123';
  const sourceTitle = 'Removed from Builder';
  const savedTitle = 'Removed from builder <a:W81yesverifiedblue:123456789012345678>';
  const source = { title: sourceTitle, description: 'The stale record and its Reappear rule were removed from the Embed Builder.',
    author: { name: 'Cloudy template key: builder:removed || Cloudy context: embed-builder/delete || Cloudy kind: embed' } };
  const original = { guildId, channelId, messageId: 'old-catalog', embedIndex: 0,
    source: 'system-catalog', name: sourceTitle, title: sourceTitle, snapshot: source };
  const saved = { ...original, messageId: 'user-edited-catalog', manualSaved: true,
    title: savedTitle, name: savedTitle, snapshot: { ...source, title: savedTitle } };
  const server = guild(guildId, channelId);
  assert.equal(recordTitle(saved), savedTitle,
    'the saved raw title and its custom emoji must never be rewritten');
  assert.deepEqual(buildSearchChoices(buildMatches(server, [original, saved], 'removed from builder')), [],
    'ephemeral Builder Delete success notices never masquerade as deleted reusable embeds');
  assert.equal(buildAutocompleteMatches(server, [
    ...Array.from({ length: 85 }, (_, i) => ({
      ...original, messageId: 'noise-' + i, name: 'Other response ' + i,
      title: 'Other response ' + i, snapshot: { title: 'Other response ' + i, description: 'noise ' + i },
    })),
    original, saved,
  ], 'removed from builder').length, 0);
  assert.equal(source.title, sourceTitle, 'the underlying runtime status remains intact');
});
