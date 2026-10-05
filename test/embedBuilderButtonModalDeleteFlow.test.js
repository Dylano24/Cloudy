import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('inline-awaited button edit modal is ignored by the global modal router', () => {
  const source = fs.readFileSync('src/events/interactionCreate.js', 'utf8');
  const modalStart = source.indexOf('} else if (interaction.isModalSubmit())');
  const modalEnd = source.indexOf('const [customId, ...args] = interaction.customId.split', modalStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart);

  const modalRouting = source.slice(modalStart, modalEnd);
  assert.match(
    modalRouting,
    /interaction\.customId\.startsWith\('embed_button_edit_modal:'\)/,
  );
});

test('Embed buttons keeps only one private editor panel per Builder session', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const openStart = source.indexOf('export async function openEmbedButtonEditor');
  assert.ok(openStart >= 0);
  const body = source.slice(openStart);

  assert.match(body, /state\.activeButtonEditorMessageId/);
  assert.match(body, /buttonInteraction\.webhook\.editMessage/);
  assert.match(body, /state\.activeButtonEditorCollector\?\.stop\?\.\('replaced'\)/);
  assert.match(body, /state\.activeButtonEditorMessage = panelMessage/);
  assert.match(body, /collector\.on\('end'/);
  assert.match(body, /deletePrivateBuilderMessage/);
});

test('Delete from builder allows stale template records while preserving live-message checks', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const eligibilityStart = source.indexOf('function canDeleteBuilderRecord');
  const eligibilityEnd = source.indexOf('async function inspectBuilderDeleteTarget', eligibilityStart);
  assert.ok(eligibilityStart >= 0 && eligibilityEnd > eligibilityStart);
  const eligibility = source.slice(eligibilityStart, eligibilityEnd);

  assert.doesNotMatch(eligibility, /!target\?\.templateMode/);
  assert.match(eligibility, /target\?\.source !== 'system-catalog'/);

  const inspectStart = source.indexOf('async function inspectBuilderDeleteTarget');
  const inspectEnd = source.indexOf('function clearBuilderRecordCaches', inspectStart);
  const inspect = source.slice(inspectStart, inspectEnd);
  assert.match(inspect, /channel\.messages\.fetch\(String\(target\.messageId\)\)/);
  assert.match(inspect, /status: 'exists'/);
  assert.match(inspect, /status: 'missing'/);
});
