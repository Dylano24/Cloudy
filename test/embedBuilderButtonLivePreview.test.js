import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder button preview is attached to the main Builder message', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const controlsStart = source.indexOf('function buildControls(state)');
  const controlsEnd = source.indexOf('function getPreviewUpdateQueue', controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart);
  const controls = source.slice(controlsStart, controlsEnd);

  assert.match(controls, /getBuilderMessageComponents\(state\)/);
  assert.match(controls, /buttonPreviewComponents/);
  assert.match(controls, /const previewRows = buttonPreviewComponents\.length/);
  assert.match(controls, /return \[\.\.\.previewRows, titleRow, contentRow, editRow, saveRow\]/);
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
