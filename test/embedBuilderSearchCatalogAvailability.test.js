import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Search actively warms the system catalog instead of depending only on startup timing', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');

  assert.match(source, /ensureSystemEmbedCatalogs/);
  assert.match(source, /warmSystemCatalogForSearch/);
  assert.match(source, /await warmSystemCatalogForSearch\(interaction\.client\)/);

  const loadStart = source.indexOf('async function loadEmbedBuilderSearchRecords');
  const mergeStart = source.indexOf('function mergeSearchRecords', loadStart);
  const loadBody = source.slice(loadStart, mergeStart);

  assert.match(loadBody, /warmSystemCatalogForSearch/);
  assert.ok(
    loadBody.indexOf('warmSystemCatalogForSearch') < loadBody.indexOf('mergeSearchRecords'),
    'catalog warmup must happen before Search reads catalog records',
  );
});

test('Search keeps Removed from Builder searchable by both the real and commercial names', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(source, /removed from builder/);
  assert.match(source, /Deleted from Builder/);
});
