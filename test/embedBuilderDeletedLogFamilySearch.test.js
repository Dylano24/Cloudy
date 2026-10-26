import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import {
  beginBuilderSearchDeletion,
  buildMatches,
  buildSearchChoices,
  filterEmbedBuilderSearchRecords,
  invalidateBuilderSearchTitleCache,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import {
  hideBuilderSearchTitlesFromBuilder,
  isBuilderSearchTitleHiddenFromBuilder,
  ensureHiddenBuilderCatalogLoaded,
} from '../src/services/systemEmbedCatalogService.js';

test('Delete removes the selected log response name across separate log/catalog message IDs instantly and durably', async t => {
  const guildId = 'search-response-family-delete-20261026';
  const channelId = '1777777777777777811';
  const saved = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(saved.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { saved.set(key, structuredClone(value)); return true; });
  const guild = { id: guildId, channels: { cache: new Map([[channelId, {
    id: channelId, name: 'ticket-logs', permissionsFor: () => ({ has: () => true }),
  }]]) } };
  const member = { id: 'owner' };
  const item = (messageId, source, title = 'Ticket closed') => ({
    guildId, channelId, messageId, embedIndex: 0,
    source, title, name: title, snapshot: { title, description: 'Closed by moderator' },
    manualSaved: source === 'embed-builder',
  });
  const selected = item('1777777777777777812', 'modified-template');
  const catalog = item('1777777777777777813', 'system-catalog');
  const olderLog = item('1777777777777777814', 'cloudy');
  const different = item('1777777777777777815', 'cloudy', 'Ticket opened');
  const manual = item('1777777777777777816', 'embed-builder');
  const records = [selected, catalog, olderLog, different, manual];

  const initial = buildMatches(guild, records, 'ticket closed');
  assert.ok(initial.some(m => m.record.source !== 'embed-builder'),
    'the automated response is present before deletion');
  assert.ok(initial.some(m => m.record.messageId === manual.messageId));

  // The original message is still being removed from Discord. Neither a
  // different physical log ID nor the catalog's ID should reappear in Search.
  const finishFailed = beginBuilderSearchDeletion(guildId, {
    ...selected, sourceEmbedData: selected.snapshot, deleteSearchTitle: 'Ticket closed',
  });
  assert.deepEqual(buildMatches(guild, records, 'ticket closed')
    .filter(m => /ticket closed/i.test(m.document.title))
    .map(m => m.record.messageId), [manual.messageId]);
  finishFailed(false);
  assert.ok(buildMatches(guild, records, 'ticket closed').some(m =>
    /ticket closed/i.test(m.document.title) && m.record.source !== 'embed-builder'),
    'a failed Delete restores the original response');

  const finishCommitted = beginBuilderSearchDeletion(guildId, {
    ...selected, sourceEmbedData: selected.snapshot, deleteSearchTitle: 'Ticket closed',
  });
  assert.equal(await hideBuilderSearchTitlesFromBuilder(guildId, ['Ticket closed'], { includeCatalog: true }), true);
  finishCommitted(true);
  invalidateBuilderSearchTitleCache(guildId);

  assert.equal(isBuilderSearchTitleHiddenFromBuilder(guildId, 'ticket CLOSED'), true);
  assert.deepEqual(buildMatches(guild, records, 'ticket closed')
    .filter(m => /ticket closed/i.test(m.document.title))
    .map(m => m.record.messageId), [manual.messageId]);
  assert.ok(buildMatches(guild, records, 'ticket opened').some(m => m.record.messageId === different.messageId),
    'unrelated response types must remain searchable');

  const filtered = filterEmbedBuilderSearchRecords(guild, member, records);
  assert.equal(filtered.some(r => [selected.messageId, catalog.messageId, olderLog.messageId].includes(r.messageId)), false,
    'even cached autocomplete results must exclude deleted log aliases');
  assert.equal(filtered.some(r => r.messageId === manual.messageId), true,
    'an independently posted manual Builder embed must keep its own identity');
  const choices = buildSearchChoices(buildMatches(guild, records, 'ticket closed'));
  assert.deepEqual(choices.filter(choice => /ticket closed/i.test(choice.name))
    .map(choice => choice.value), [channelId + ':' + manual.messageId + ':0']);

  const storedIds = saved.get('cloudy:embed-builder-hidden-catalog:' + guildId);
  assert.ok(storedIds.some(value => value.startsWith('search-title|')));
  const cold = await import('../src/services/systemEmbedCatalogService.js?search-family-delete-cold');
  await cold.ensureHiddenBuilderCatalogLoaded(guildId);
  assert.equal(cold.isBuilderSearchTitleHiddenFromBuilder(guildId, 'Ticket closed'), true,
    'deleted response visibility must survive a process restart');
  assert.equal(cold.isBuilderSearchTitleHiddenFromBuilder(guildId, 'Ticket closed', { catalog: true }), true,
    'the separate catalog alias must also remain hidden after restart');
});

test('previously deleted Priority updated cannot reappear through its catalog or Ticket priority alias', async t => {
  const guildId = 'search-priority-catalog-alias-20261027';
  const channelId = '1777777777777777890';
  const saved = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(saved.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { saved.set(key, structuredClone(value)); return true; });
  const guild = { id: guildId, channels: { cache: new Map([[channelId, {
    id: channelId, name: 'ticket-logs', permissionsFor: () => ({ has: () => true }),
  }]]) } };
  const member = { id: 'owner' };
  const item = (messageId, source, title) => ({
    guildId, channelId, messageId, embedIndex: 0,
    source, title, name: title, snapshot: { title, description: 'Ticket priority updated' },
    manualSaved: source === 'embed-builder',
  });
  const canonicalCatalog = item('1777777777777777891', 'system-catalog', 'Priority updated');
  const aliasCatalog = item('1777777777777777892', 'system-catalog', 'Ticket priority');
  const oldLog = item('1777777777777777893', 'cloudy', 'Priority updated');
  const unrelated = item('1777777777777777894', 'system-catalog', 'Ticket closed');
  const manual = item('1777777777777777895', 'embed-builder', 'Priority updated');
  const records = [canonicalCatalog, aliasCatalog, oldLog, unrelated, manual];

  assert.ok(filterEmbedBuilderSearchRecords(guild, member, records).some(record =>
    record.messageId === aliasCatalog.messageId));

  // This is exactly the legacy catalog-Delete write: no catalog-specific
  // identity was persisted, so catalog variants used to return after Delete.
  assert.equal(await hideBuilderSearchTitlesFromBuilder(guildId, ['Priority updated']), true);
  invalidateBuilderSearchTitleCache(guildId);

  const visible = filterEmbedBuilderSearchRecords(guild, member, records);
  assert.deepEqual(visible.map(record => record.messageId).sort(),
    [manual.messageId, unrelated.messageId].sort());
  assert.equal(buildSearchChoices(buildMatches(guild, records, 'priority'))
    .some(choice => choice.name === 'Ticket priority'), false);
  assert.equal(isBuilderSearchTitleHiddenFromBuilder(guildId, 'Ticket priority', { catalog: true }), true);

  const cold = await import('../src/services/systemEmbedCatalogService.js?priority-alias-delete-cold');
  await cold.ensureHiddenBuilderCatalogLoaded(guildId);
  assert.equal(cold.isBuilderSearchTitleHiddenFromBuilder(guildId, 'Priority updated', { catalog: true }), true);
  assert.equal(cold.isBuilderSearchTitleHiddenFromBuilder(guildId, 'Ticket priority', { catalog: true }), true);
});

test('separate response titles survive concurrent durable deletions', async t => {
  const guildId = 'search-family-concurrent-deletes';
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });
  await ensureHiddenBuilderCatalogLoaded(guildId);
  assert.deepEqual(await Promise.all([
    hideBuilderSearchTitlesFromBuilder(guildId, ['Removed from Builder']),
    hideBuilderSearchTitlesFromBuilder(guildId, ['Ticket closed']),
  ]), [true, true]);
  assert.equal(isBuilderSearchTitleHiddenFromBuilder(guildId, 'Ticket closed'), true);
  assert.equal(isBuilderSearchTitleHiddenFromBuilder(guildId, 'Removed from Builder'), true);
  assert.equal(storage.get('cloudy:embed-builder-hidden-catalog:' + guildId).length, 2);
});
