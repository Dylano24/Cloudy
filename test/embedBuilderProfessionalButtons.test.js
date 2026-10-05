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

test('professional Builder flow has one Add button creator with separate response and link fields', () => {
  const service = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const managerStart = service.indexOf('function managerPayload');
  const modalStart = service.indexOf('async function showAddResponseModal', managerStart);
  const manager = service.slice(managerStart, modalStart);
  assert.match(manager, /Add button/);
  assert.doesNotMatch(manager, /Add response button/);
  assert.doesNotMatch(manager, /Add link button/);
  assert.doesNotMatch(manager, /Add disabled button/);

  const modalEnd = service.indexOf('async function showAddLinkModal', modalStart);
  const modal = service.slice(modalStart, modalEnd);
  assert.match(modal, /button_label/);
  assert.match(modal, /button_settings/);
  assert.match(modal, /button_response/);
  assert.match(modal, /button_url/);
  assert.doesNotMatch(modal, /button_action/);
  assert.match(modal, /ButtonStyle\.Link/);
  assert.match(modal, /blank stays/);
  assert.doesNotMatch(modal, /blank = stays/);

  const previewStart = service.indexOf('export async function syncBuilderButtonPreview');
  const previewEnd = service.indexOf('\n}\n', previewStart);
  const preview = service.slice(previewStart, previewEnd);
  assert.doesNotMatch(preview, /followUp\(/);
  assert.match(preview, /activeButtonPreviewMessageId = null/);
});

test('custom buttons are not part of Message builder controls', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('function buildControls(state)');
  const end = source.indexOf('function getPreviewUpdateQueue', start);
  const body = source.slice(start, end);

  assert.doesNotMatch(body, /previewRows/);
  assert.doesNotMatch(body, /buttonPreviewComponents/);
  assert.match(body, /Delete from builder/);
  assert.match(body, /Save deletion/);
});
