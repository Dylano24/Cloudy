import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Search selection checks candidate title before expensive full-document peer processing', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const start = source.indexOf('function completeSelectedSearchRecord(');
  const end = source.indexOf('\nexport function buildMatches(', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const quickCheck = body.indexOf('normalize(recordTitle(candidate)) !== selectedTitleKey');
  const fullDocument = body.indexOf('recordDocument(guild, candidate)');
  assert.ok(quickCheck >= 0 && fullDocument > quickCheck,
    'ignore unrelated titles before hydrating expensive Search documents');
  assert.match(body, /compatibleSearchShape\(selected\.record, candidate, selected\.document, document\)/,
    'existing compatible record pairing and preview merges must remain unchanged');
  assert.match(body, /return selected\.record/,
    'selection must return the full original record, not a simplified or empty preview');
});
