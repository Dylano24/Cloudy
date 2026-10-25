import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Delete from Builder is staged first and only purged on Save', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  assert.match(source, /simple_embed_delete_from_builder/);
  assert.match(source, /Confirm delete/);
  assert.match(source, /state\.pendingBuilderDelete/);
  assert.match(source, /togglePendingBuilderDeletion/);
  assert.match(source, /savePendingBuilderDeletion/);

  const toggleStart = source.indexOf('async function togglePendingBuilderDeletion');
  const toggleEnd = source.indexOf('function resetBuilderAfterRecordDeletion', toggleStart);
  const toggleBody = source.slice(toggleStart, toggleEnd);
  assert.doesNotMatch(toggleBody, /purgeEmbedRegistryRecord\(/);

  const saveStart = source.indexOf('async function savePendingBuilderDeletion');
  const saveEnd = source.indexOf('// Acknowledging the click immediately', saveStart);
  const saveBody = source.slice(saveStart, saveEnd);
  assert.match(saveBody, /inspectBuilderDeleteTarget\(guild, target\)/);
  assert.match(saveBody, /purgeEmbedRegistryRecord\(/);
});

test('Delete from Builder removes only owner-confirmed Cloudy messages or catalog rows', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const eligibilityStart = source.indexOf('function canDeleteBuilderRecord');
  const eligibilityEnd = source.indexOf('async function inspectBuilderDeleteTarget', eligibilityStart);
  const eligibility = source.slice(eligibilityStart, eligibilityEnd);
  assert.doesNotMatch(eligibility, /target\?\.source !== 'system-catalog'/);
  assert.doesNotMatch(eligibility, /!target\?\.templateMode/);

  const inspectStart = source.indexOf('async function inspectBuilderDeleteTarget');
  const inspectEnd = source.indexOf('function clearBuilderRecordCaches', inspectStart);
  const inspect = source.slice(inspectStart, inspectEnd);
  assert.match(inspect, /channel\.messages\.fetch\(String\(target\.messageId\)\)/);
  assert.match(inspect, /status: 'exists'/);
  assert.match(inspect, /status: 'missing'/);
  assert.match(inspect, /target\.source === 'system-catalog'/);
  assert.match(inspect, /target\.detached && target\.source === 'embed-builder'/);
});

test('loading another embed or Reset cancels a pending Builder deletion', () => {
  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  assert.ok((manager.match(/state\.pendingBuilderDelete = null;/g) || []).length >= 2);

  const builder = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const resetStart = builder.indexOf("case 'simple_embed_reset':");
  const resetEnd = builder.indexOf('break;', resetStart);
  const reset = builder.slice(resetStart, resetEnd);
  assert.match(reset, /state\.pendingBuilderDelete = null/);
});

test('virtual catalog deletion is saved without touching Discord message or Reappear', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf("    if (presence.status === 'catalog') {");
  const end = source.indexOf('    // Disable Reappear through the canonical index', start);
  const catalogBranch = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(catalogBranch, /hideSystemCatalogFromBuilder\(/);
  assert.match(catalogBranch, /clearBuilderRecordCaches\(/);
  assert.doesNotMatch(catalogBranch, /purgeEmbedRegistryRecord\(/);
  assert.doesNotMatch(catalogBranch, /syncExistingEmbedReappearRule\(/);
  assert.doesNotMatch(catalogBranch, /\.delete\(/);
});


test('confirmed Delete physically removes Cloudy posts, then purges the registry and Search index', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const from = source.indexOf('async function savePendingBuilderDeletion');
  const to = source.indexOf('// Acknowledging the click immediately', from);
  const body = source.slice(from, to);
  assert.match(body, /presence\.message\.delete\(\)/);
  assert.match(body, /String\(presence\.message\?\.author\?\.id \|\| ''\)/);
  assert.ok(body.indexOf('await presence.message.delete()') < body.indexOf('await purgeEmbedRegistryRecord('),
    'the record must not be purged before Discord confirms actual deletion');
  assert.match(body, /invalidateIndexedRecentChannelEmbeds/);
  assert.match(body, /invalidateBuilderSearchTitleCache/);
});

test('Delete preserves current draft for re-post while Reset remains an explicit separate action', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const from = source.indexOf('function resetBuilderAfterRecordDeletion(');
  const to = source.indexOf('async function savePendingBuilderDeletion', from);
  const body = source.slice(from,to);
  assert.match(body, /state\.modifyTarget = null/);
  assert.doesNotMatch(body, /state\.title = null/);
  assert.doesNotMatch(body, /state\.message = null/);
  assert.match(source, /simple_embed_post_new/);
});
