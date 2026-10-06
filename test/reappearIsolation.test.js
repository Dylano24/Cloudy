import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Reappear deletion is isolated to the exact embed rule', () => {
  const messageCreate = fs.readFileSync('src/events/messageCreate.js', 'utf8');
  assert.match(messageCreate, /embed-reappear-disabled:/);
  assert.match(messageCreate, /const disabled = await getFromDb\(disableKey, null\)/);
  assert.match(messageCreate, /const removedIds = new Set\(\)/);
  assert.match(messageCreate, /const latestIndex = await getFromDb\(indexKey, \[\]\)/);
  assert.doesNotMatch(messageCreate, /const survivingIds = \[\]/);

  const registry = fs.readFileSync('src/services/embedRegistryService.js', 'utf8');
  assert.match(
    registry,
    /embed-reappear-disabled:\$\{guildId\}:\$\{channelId\}:\$\{messageId\}:\$\{Math\.max\(0, Number\(embedIndex\) \|\| 0\)\}/,
  );

  const builder = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const safeDeletePatch = fs.readFileSync('scripts/patch-embed-builder-safe-delete.js', 'utf8');
  assert.match(safeDeletePatch, /syncExistingEmbedReappearRule\(\{/);
  assert.match(safeDeletePatch, /every:\s*null/);
  assert.match(safeDeletePatch, /pending\.embedIndex/);
  assert.doesNotMatch(safeDeletePatch, /const reappearKey = \`cloudy:embed-reappear:/);
  assert.match(builder, /originMessageId: sent\.id/);
  assert.match(builder, /embedIndex: 0/);
});

test('Reappear cleanup never rebuilds the whole channel index from a stale snapshot', () => {
  const source = fs.readFileSync('src/events/messageCreate.js', 'utf8');
  const start = source.indexOf('async function handleEmbedReappear');
  const body = source.slice(start);
  assert.match(body, /removedIds\.add\(originalMessageId\)/);
  assert.match(body, /latestIndex\.filter\(id => !removedIds\.has\(String\(id\)\)\)/);
  assert.doesNotMatch(body, /setInDb\(indexKey, survivingIds\)/);
});


test('Reappear remains active when Search registry changes', () => {
  const source = fs.readFileSync('src/events/messageCreate.js', 'utf8');
  const start = source.indexOf('async function handleEmbedReappear');
  const body = source.slice(start);

  assert.match(body, /Only an exact Delete tombstone may stop this rule/);
  assert.doesNotMatch(body, /stillInBuilder/);
  assert.doesNotMatch(body, /registryRecords\.some/);
  assert.match(body, /const disabled = await getFromDb\(disableKey, null\)/);
});
