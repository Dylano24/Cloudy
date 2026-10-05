import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Delete from Builder is staged first and only purged on Save', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  assert.match(source, /simple_embed_delete_from_builder/);
  assert.match(source, /Save deletion/);
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

test('Delete from Builder protects live and system/template embeds', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const eligibilityStart = source.indexOf('function canDeleteBuilderRecord');
  const eligibilityEnd = source.indexOf('async function inspectBuilderDeleteTarget', eligibilityStart);
  const eligibility = source.slice(eligibilityStart, eligibilityEnd);
  assert.match(eligibility, /target\?\.source !== 'system-catalog'/);
  assert.match(eligibility, /!target\?\.templateMode/);

  const inspectStart = source.indexOf('async function inspectBuilderDeleteTarget');
  const inspectEnd = source.indexOf('function clearBuilderRecordCaches', inspectStart);
  const inspect = source.slice(inspectStart, inspectEnd);
  assert.match(inspect, /channel\.messages\.fetch\(String\(target\.messageId\)\)/);
  assert.match(inspect, /status: 'exists'/);
  assert.match(inspect, /status: 'missing'/);
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
