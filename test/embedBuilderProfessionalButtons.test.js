import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('custom Builder button responses use standard Cloudy embed formatting', () => {
  const source = fs.readFileSync('src/interactions/buttons/cloudyBuilderAction.js', 'utf8');

  assert.match(source, /new EmbedBuilder\(\)/);
  assert.match(source, /\.setColor\(0xFFFFFF\)/);
  assert.match(source, /\.setThumbnail\(CLOUDY_LOGO_URL\)/);
  assert.match(source, /\.setFooter\(\{ text: CLOUDY_BRANDING \}\)/);
  assert.match(source, /action\.visibility !== 'public'/);
  assert.match(source, /action\.deleteAfterMs/);
  assert.doesNotMatch(source, /content: String\(action\.responseText\)/);
});

test('professional Builder flow has no separate Add link button or child preview message', () => {
  const service = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const managerStart = service.indexOf('function managerPayload');
  const modalStart = service.indexOf('async function showAddResponseModal', managerStart);
  const manager = service.slice(managerStart, modalStart);
  assert.match(manager, /Add response button/);
  assert.doesNotMatch(manager, /Add link button/);
  assert.doesNotMatch(manager, /embed_button_add_link/);

  const previewStart = service.indexOf('export async function syncBuilderButtonPreview');
  const previewEnd = service.indexOf('\n}\n', previewStart);
  const preview = service.slice(previewStart, previewEnd);
  assert.doesNotMatch(preview, /followUp\(/);
  assert.match(preview, /activeButtonPreviewMessageId = null/);
});

test('main Builder reserves the first component row for up to five live button previews', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('function buildControls(state)');
  const end = source.indexOf('function getPreviewUpdateQueue', start);
  const body = source.slice(start, end);

  assert.match(body, /\.slice\(0, 5\)/);
  assert.match(body, /const previewRows = buttonPreviewComponents\.length/);
  assert.match(body, /return \[\.\.\.previewRows, titleRow, contentRow, editRow, saveRow\]\.slice\(0, 5\)/);
  assert.match(body, /Delete from builder/);
  assert.match(body, /Save deletion/);
});
