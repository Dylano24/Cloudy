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

test('professional Builder flow uses one response/link setup and no disabled creator', () => {
  const service = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const managerStart = service.indexOf('function managerPayload');
  const modalStart = service.indexOf('async function showAddResponseModal', managerStart);
  const manager = service.slice(managerStart, modalStart);
  assert.match(manager, /Add response button/);
  assert.match(manager, /response or link button from one form/);
  assert.match(manager, /seconds only/);
  assert.doesNotMatch(manager, /Add link button/);
  assert.doesNotMatch(manager, /Add disabled button/);

  const modalEnd = service.indexOf('async function showEditButtonModal', modalStart);
  const modal = service.slice(modalStart, modalEnd);
  assert.match(modal, /button_url/);
  assert.match(modal, /ButtonStyle\.Link/);
  assert.match(modal, /button_settings/);
});

test('top preview owns live buttons and Message builder controls live in a separate follow-up', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const previewStart = source.indexOf('function buildPreviewPayload(state)');
  const dashboardStart = source.indexOf('function buildDashboardPayload(state)', previewStart);
  assert.ok(previewStart >= 0 && dashboardStart > previewStart);
  const preview = source.slice(previewStart, dashboardStart);
  assert.match(preview, /embeds: \[new EmbedBuilder\(previewData\)\]/);
  assert.match(preview, /components: getBuilderMessageComponents\(state\)/);

  const controlsStart = source.indexOf('function buildControls(state)');
  const controlsEnd = source.indexOf('function buildPreviewPayload(state)', controlsStart);
  const controls = source.slice(controlsStart, controlsEnd);
  assert.doesNotMatch(controls, /previewRows/);
  assert.doesNotMatch(controls, /buttonPreviewComponents/);

  const executeStart = source.indexOf('async execute(interaction)');
  const executeBody = source.slice(executeStart);
  assert.match(executeBody, /state\.rootInteraction = interaction/);
  assert.match(executeBody, /interaction\.followUp\(\{[\s\S]*?buildDashboardPayload\(state\)/);
  assert.match(executeBody, /state\.dashboardMessageId = String\(dashboardMessage\.id\)/);
});
