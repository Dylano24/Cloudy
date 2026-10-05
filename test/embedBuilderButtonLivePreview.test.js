import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder button preview is attached to the top preview message, not Message builder controls', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const controlsStart = source.indexOf('function buildControls(state)');
  const controlsEnd = source.indexOf('function getPreviewUpdateQueue', controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart);
  const controls = source.slice(controlsStart, controlsEnd);
  assert.doesNotMatch(controls, /buttonPreviewComponents/);
  assert.doesNotMatch(controls, /previewRows/);

  const refreshStart = source.indexOf('function queueBuilderRefresh(interaction, state');
  const refreshEnd = source.indexOf('async function editContent', refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  const refresh = source.slice(refreshStart, refreshEnd);
  assert.match(refresh, /embeds: \[buildPreviewEmbed\(state\)\]/);
  assert.match(refresh, /components: getBuilderMessageComponents\(state\)/);
  assert.match(refresh, /embeds: \[buildControlEmbed\(state\)\]/);
  assert.match(refresh, /components: buildControls\(state\)/);
  assert.match(refresh, /refreshBuilderPreviewOnly/);
});

test('separate child button preview is disabled and stale preview is cleaned up', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const start = source.indexOf('export async function syncBuilderButtonPreview');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /deletePrivateBuilderMessage/);
  assert.match(body, /state\.activeButtonPreviewMessageId = null/);
  assert.match(body, /return null/);
  assert.doesNotMatch(body, /interaction\.followUp/);
});

test('opening Add buttons reuses the current private editor instead of creating duplicates', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const start = source.indexOf('export async function openEmbedButtonEditor');
  assert.ok(start >= 0);
  const body = source.slice(start);

  assert.match(body, /state\.activeButtonEditorMessageId/);
  assert.match(body, /buttonInteraction\.webhook\.editMessage/);
  assert.match(body, /deletePrivateBuilderMessage/);
});
