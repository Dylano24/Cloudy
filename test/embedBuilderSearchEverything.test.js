import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder Search keeps user embeds separate but collapses duplicate automated/template peers', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  const displayStart = source.indexOf('function builderSearchDisplayRecords');
  const previewStart = source.indexOf('export function latestRealPreviewRecord', displayStart);
  assert.ok(displayStart >= 0 && previewStart > displayStart);
  const displayBody = source.slice(displayStart, previewStart);

  assert.match(displayBody, /repeated copies of the same automated\/template response are one searchable item/);
  assert.match(displayBody, /source !== 'embed-builder'/);
  assert.match(displayBody, /stableSearchTemplateKey\(record\)/);
  assert.match(displayBody, /stableSearchTemplateContext\(record\)/);
  assert.match(displayBody, /\['system-catalog', 'bot-history', 'history'\]\.includes\(source\)/);
  assert.doesNotMatch(displayBody, /collapseDisplayRecords\(channelRecords, channelId\)/);
});

test('Builder Search excludes runtime notification history and deleted detached messages', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  const displayStart = source.indexOf('function builderSearchDisplayRecords');
  const previewStart = source.indexOf('export function latestRealPreviewRecord', displayStart);
  assert.ok(displayStart >= 0 && previewStart > displayStart);
  const displayBody = source.slice(displayStart, previewStart);

  assert.match(displayBody, /\['bot-history', 'history'\]\.includes\(source\)/);
  assert.match(displayBody, /record\?\.detached && source !== 'system-catalog'/);
  assert.match(displayBody, /stableSearchTemplateKey\(record\)/);
  assert.match(displayBody, /stableSearchTemplateContext\(record\)/);
});

test('Builder Search returns no autocomplete list until text is typed', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const autocompleteStart = source.indexOf('embedBuilderCommand.autocomplete');
  const executeStart = source.indexOf('const originalExecute', autocompleteStart);
  const autocompleteBody = source.slice(autocompleteStart, executeStart);

  assert.match(autocompleteBody, /if \(!normalize\(focused\.value\)\)/);
  assert.match(autocompleteBody, /interaction\.respond\(\[\]\)/);
});

test('Search still scores every remaining unique result after duplicate cleanup', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const buildStart = source.indexOf('export function buildMatches');
  const selectionStart = source.indexOf('function selectionValue', buildStart);
  const buildBody = source.slice(buildStart, selectionStart);

  assert.match(buildBody, /const matches = \[\]/);
  assert.match(buildBody, /const match = \{ record, document, score \}/);
  assert.match(buildBody, /matches\.push\(match\)/);
  assert.match(buildBody, /exactAutomatedSearchIdentity\(record\)/);
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


test('Discord autocomplete never exposes internal botlog/template context labels', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(source, /const titleCounts = new Map\(\)/);
  assert.match(source, /const seenTitleIndexes = new Map\(\)/);
  assert.match(source, /channelName/);
  const choiceStart = source.indexOf('const choices = matches.map');
  const respondStart = source.indexOf('await interaction.respond', choiceStart);
  const choiceBody = source.slice(choiceStart, respondStart);
  assert.doesNotMatch(choiceBody, /stableSearchTemplateContext\(record\)/);
});


test('Modify browser shows every real channel while keeping Search-only archive records out', () => {
  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');

  assert.match(manager, /function isEmbedManagerVisibleRecord|export function isEmbedManagerVisibleRecord/);
  assert.match(manager, /if \(!record\?\.messageId \|\| record\.detached\) return false/);
  assert.match(manager, /if \(!includeBotHistory && source === 'bot-history'\) return false/);
  assert.match(manager, /source === 'system-catalog'/);
  assert.match(manager, /logicalChannelId !== backingChannelId/);

  const groupsStart = manager.indexOf('function buildChannelGroups');
  const groupsEnd = manager.indexOf('\nfunction pageItems', groupsStart);
  const groupsBody = manager.slice(groupsStart, groupsEnd);
  assert.match(groupsBody, /for \(const channel of guild\.channels\.cache\.values\(\)\)/);
  assert.match(groupsBody, /\!\[0, 5\]\.includes\(channel\?\.type\)/);
  assert.match(groupsBody, /filterEmbedManagerRecords\(records\)/);
});


test('Search hides history mirrors and deduplicates canonical catalog templates', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const start = source.indexOf('function builderSearchDisplayRecords');
  const end = source.indexOf('\nexport function latestRealPreviewRecord', start);
  const body = source.slice(start, end);
  assert.match(body, /\['bot-history', 'history'\]\.includes\(source\)/);
  assert.match(body, /stableSearchTemplateKey\(record\)/);
  assert.match(body, /stableSearchTemplateContext\(record\)/);
  assert.match(body, /\['template', stableKey, stableContext\]/);
  assert.match(body, /\['catalog', stableContext, title\]/);
});
