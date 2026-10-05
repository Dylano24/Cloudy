import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Embed Builder Search does not reuse the channel browser collapse filter', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  const displayStart = source.indexOf('function builderSearchDisplayRecords');
  const previewStart = source.indexOf('export function latestRealPreviewRecord', displayStart);
  assert.ok(displayStart >= 0 && previewStart > displayStart);
  const displayBody = source.slice(displayStart, previewStart);

  assert.match(displayBody, /Search is intentionally broader than the channel browser/);
  assert.match(displayBody, /searchRecordIdentity\(record\)/);
  assert.doesNotMatch(displayBody, /collapseDisplayRecords\(/);
});

test('Search result grouping keeps distinct canonical response types visible', () => {
  const live = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const buildStart = live.indexOf('export function buildMatches');
  const selectionStart = live.indexOf('function selectionValue', buildStart);
  const buildBody = live.slice(buildStart, selectionStart);

  assert.match(buildBody, /const key = searchRecordIdentity\(record\)/);
  assert.doesNotMatch(buildBody, /const key = logicalKey\(record, document\)/);

  const modal = fs.readFileSync('src/events/embedManagerTitleSearchReady.js', 'utf8');
  const matchStart = modal.indexOf('function findSearchMatches');
  const segmentStart = modal.indexOf('function segmentSearchResults', matchStart);
  const matchBody = modal.slice(matchStart, segmentStart);

  assert.match(matchBody, /record\?\.canonicalIdentity/);
  assert.match(matchBody, /canonical:/);
});

test('channel browsing still keeps its existing collapse behavior', () => {
  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  assert.match(manager, /collapseDisplayRecords\(group\.records, group\.channelId\)/);
});
