import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder Search exposes every indexed physical record instead of hiding peers', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  const displayStart = source.indexOf('function builderSearchDisplayRecords');
  const previewStart = source.indexOf('export function latestRealPreviewRecord', displayStart);
  assert.ok(displayStart >= 0 && previewStart > displayStart);
  const displayBody = source.slice(displayStart, previewStart);

  assert.match(displayBody, /Only the exact same physical message\/embed is de-duplicated/);
  assert.match(displayBody, /record\?\.backingChannelId \|\| channelId/);
  assert.doesNotMatch(displayBody, /collapseDisplayRecords\(channelRecords, channelId\)/);
});

test('Search no longer collapses matching records by logical template identity', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const buildStart = source.indexOf('export function buildMatches');
  const selectionStart = source.indexOf('function selectionValue', buildStart);
  const buildBody = source.slice(buildStart, selectionStart);

  assert.match(buildBody, /const matches = \[\]/);
  assert.match(buildBody, /matches\.push\(\{ record, document, score \}\)/);
  assert.doesNotMatch(buildBody, /grouped\.set\(/);
});

test('channel browsing keeps its existing unique-embed grouping', () => {
  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const embedPayloadStart = manager.indexOf('export function buildEmbedPayload');
  const nextFunction = manager.indexOf('\nfunction ', embedPayloadStart + 1);
  const body = manager.slice(embedPayloadStart, nextFunction);

  assert.match(body, /collapseDisplayRecords\(channelRecords, channelId\)/);
  assert.match(body, /Only unique embeds are shown/);
});


test('Search merges direct system catalog records so catalog responses cannot disappear from autocomplete', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(source, /getSearchableSystemCatalogRecords/);
  assert.match(source, /function mergeSearchRecords\(/);
  assert.match(source, /mergeSearchRecords\(interaction\.guildId, registryRecords\)/);
});

test('Removed from Builder is a searchable catalog response', () => {
  const source = fs.readFileSync('src/services/systemEmbedCatalogService.js', 'utf8');
  assert.match(source, /title: 'Removed from Builder'/);
  assert.match(source, /context: 'embed-builder\/delete'/);
  assert.match(source, /getSearchableSystemCatalogRecords/);
});


test('Discord autocomplete disambiguates duplicate titles without hiding them', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(source, /const titleCounts = new Map\(\)/);
  assert.match(source, /duplicateTitle/);
  assert.match(source, /stableSearchTemplateContext\(record\)/);
});


test('Modify browser excludes Search-only archive records while Search stays complete', () => {
  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');

  assert.match(manager, /function isEmbedManagerVisibleRecord|export function isEmbedManagerVisibleRecord/);
  assert.match(manager, /if \(!record\?\.messageId \|\| record\.detached\) return false/);
  assert.match(manager, /if \(!includeBotHistory && source === 'bot-history'\) return false/);
  assert.match(manager, /source === 'system-catalog'/);
  assert.match(manager, /logicalChannelId !== backingChannelId/);

  const groupsStart = manager.indexOf('function buildChannelGroups');
  const groupsEnd = manager.indexOf('\nfunction pageItems', groupsStart);
  const groupsBody = manager.slice(groupsStart, groupsEnd);
  assert.match(groupsBody, /filterEmbedManagerRecords\(records\)/);
  assert.doesNotMatch(groupsBody, /for \(const channel of guild\.channels\.cache\.values\(\)\)/);
});
