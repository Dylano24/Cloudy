import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Search prepares the known selected preview in parallel with saved-template scope warming', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js','utf8');
  const start = source.indexOf('export async function loadEmbedBuilderSearchSelection(');
  const end = source.indexOf('\nexport async function hydrateLiveSearchRecord',start);
  const method = source.slice(start,end);
  assert.match(method, /const stablePreview = record\.previewRecord/);
  assert.match(method, /await Promise\.all\(\[\s*templateWarm,\s*hydrateBuilderPreviewRecord\(/);
  assert.match(method, /await templateWarm/);
  assert.match(method, /latestRealPreviewRecord\(/);
  assert.match(method, /warmSavedEmbedTemplateScopes\(/);
  assert.match(method, /hydrateLiveSearchRecord\(/);
});

test('Search performance optimization never modifies Save/Delete or preview payload structure', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js','utf8');
  const start = source.indexOf('export async function loadEmbedBuilderSearchSelection(');
  const end = source.indexOf('\nexport async function hydrateLiveSearchRecord',start);
  const method = source.slice(start,end);
  assert.match(method, /return \{\s*record,\s*previewRecord,\s*previewTitle: recordTitle\(record\),\s*sourceRecord:/);
  assert.doesNotMatch(method, /setInDb\(|deleteFromDb\(|removeEmbedRegistryRecord\(/);
});
