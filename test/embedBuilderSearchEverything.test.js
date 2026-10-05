import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Embed Builder Search adds hidden unique records beyond channel browsing', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  const displayStart = source.indexOf('function builderSearchDisplayRecords');
  const previewStart = source.indexOf('export function latestRealPreviewRecord', displayStart);
  assert.ok(displayStart >= 0 && previewStart > displayStart);
  const displayBody = source.slice(displayStart, previewStart);

  assert.match(displayBody, /Preserve the proven canonical grouping\/Save-target behavior first/);
  assert.match(displayBody, /collapseDisplayRecords\(channelRecords, channelId\)/);
  assert.match(displayBody, /Search is broader than the channel browser/);
  assert.match(displayBody, /output\.push\(record\)/);
});

test('Search keeps duplicate grouping and canonical Save-target selection', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const buildStart = source.indexOf('export function buildMatches');
  const selectionStart = source.indexOf('function selectionValue', buildStart);
  const buildBody = source.slice(buildStart, selectionStart);

  assert.match(buildBody, /const key = logicalKey\(record, document\)/);
  assert.match(buildBody, /chooseBetter\(grouped\.get\(key\), candidate\)/);
});

test('channel browsing still keeps its current unique-embed grouping', () => {
  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const embedPayloadStart = manager.indexOf('export function buildEmbedPayload');
  const nextFunction = manager.indexOf('\nfunction ', embedPayloadStart + 1);
  const body = manager.slice(embedPayloadStart, nextFunction);

  assert.match(body, /collapseDisplayRecords\(channelRecords, channelId\)/);
  assert.match(body, /Only unique embeds are shown/);
});
