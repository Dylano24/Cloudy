import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('canonical Builder Search indexes every canonical record without channel filtering', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  const displayStart = source.indexOf('function builderSearchDisplayRecords');
  const previewStart = source.indexOf('export function latestRealPreviewRecord', displayStart);
  assert.ok(displayStart >= 0 && previewStart > displayStart);
  const displayBody = source.slice(displayStart, previewStart);

  assert.match(displayBody, /resolved\.some\(record => record\?\.canonicalIdentity\)/);
  assert.match(displayBody, /return \[\.\.\.unique\.values\(\)\]/);
});

test('legacy/raw Search peers still use existing duplicate/master grouping', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  const displayStart = source.indexOf('function builderSearchDisplayRecords');
  const previewStart = source.indexOf('export function latestRealPreviewRecord', displayStart);
  const displayBody = source.slice(displayStart, previewStart);

  assert.match(displayBody, /collapseDisplayRecords\(channelRecords, channelId\)/);
});

test('Search still groups repeated runtime peers into one logical result', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const buildStart = source.indexOf('export function buildMatches');
  const selectionStart = source.indexOf('function selectionValue', buildStart);
  const buildBody = source.slice(buildStart, selectionStart);

  assert.match(buildBody, /const key = logicalKey\(record, document\)/);
  assert.match(buildBody, /chooseBetter\(grouped\.get\(key\), candidate\)/);
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
