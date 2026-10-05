import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Embed Builder precomputes canonical Modify data before the button click', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const prepareStart = source.indexOf('export function prepareEmbedManager');
  const openStart = source.indexOf('export async function openEmbedManager', prepareStart);
  assert.ok(prepareStart >= 0 && openStart > prepareStart);
  const prepare = source.slice(prepareStart, openStart);
  assert.match(prepare, /getCanonicalBuilderRecords\(guild, storedRecords, \{ perChannel: true \}\)/);

  const openBody = source.slice(openStart);
  assert.match(openBody, /preparedData\?\.records/);
  assert.match(openBody, /rememberEmbedManagerRecordCache\(guild\.id, buttonInteraction\.user\.id, records\)/);
});

test('local Builder state changes can acknowledge and paint in one Discord update', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /async function deliverBuilderPreviewUpdate/);
  assert.match(source, /typeof interaction\?\.update === 'function'/);
  assert.match(source, /await interaction\.update\(payload\)/);
  assert.match(source, /result = await deliverBuilderPreviewUpdate\(state, interaction, nextPayload\)/);

  for (const id of ['simple_embed_logo', 'simple_embed_remove_logo', 'simple_embed_clear_media', 'simple_embed_reset']) {
    const start = source.indexOf(`case '${id}':`);
    assert.ok(start >= 0, `missing ${id}`);
    const end = source.indexOf('break;', start);
    const block = source.slice(start, end);
    assert.doesNotMatch(block, /deferUpdate\(\)/);
    assert.match(block, /refreshBuilder\(buttonInteraction, state\)/);
  }
});

test('Modify Search reuses the open manager records before reading the database again', () => {
  const source = fs.readFileSync('src/events/embedManagerTitleSearchReady.js', 'utf8');
  const start = source.indexOf('async function refreshRecords');
  assert.ok(start >= 0);
  const end = source.indexOf('\n}\n\nasync function handleSearchButton', start);
  const block = source.slice(start, end);
  assert.match(block, /__cloudyEmbedManagerRecordCache/);
  assert.match(block, /cached\.records/);
  assert.match(block, /getCanonicalBuilderRecords\(interaction\.guild\)/);
});

test('slash autocomplete coalesces canonical Builder reads', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(source, /CANONICAL_SEARCH_CACHE_TTL = 1500/);
  assert.match(source, /async function getFastCanonicalBuilderRecords/);
  assert.match(source, /cached\?\.promise/);
  assert.doesNotMatch(source, /await getCanonicalBuilderRecords\(interaction\.guild\)/);
});
