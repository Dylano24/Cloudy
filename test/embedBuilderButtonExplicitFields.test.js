import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder response button contains link, settings, duration and response fields in one modal', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showEditButtonModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /addLabelComponents/);
  assert.match(body, /setCustomId\('button_settings'\)/);
  assert.match(body, /setLabel\('Color & visibility'\)/);
  assert.match(body, /getStringSelectValues\('button_settings'\)/);
  assert.match(body, /setCustomId\('button_duration'\)/);
  assert.match(body, /setLabel\('Duration in seconds \(optional\)'\)/);
  assert.match(body, /setPlaceholder\('10'\)/);
  assert.match(body, /setCustomId\('button_response'\)/);
  assert.match(body, /setLabel\('Response message \(optional\)'\)/);
  assert.match(body, /setCustomId\('button_url'\)/);
  assert.match(body, /setLabel\('Link URL \(optional\)'\)/);
  assert.doesNotMatch(body, /button_visibility/);
  assert.doesNotMatch(body, /10s, 30s, 1m, 5m/);
});

test('Builder has one Add response entry point and no separate link or disabled creator', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const managerStart = source.indexOf('function managerPayload');
  const modalStart = source.indexOf('async function showAddResponseModal', managerStart);
  const manager = source.slice(managerStart, modalStart);

  assert.match(manager, /setCustomId\('embed_button_add_response'\)/);
  assert.doesNotMatch(manager, /embed_button_add_link/);
  assert.doesNotMatch(manager, /embed_button_add_disabled/);
  assert.doesNotMatch(source, /async function showAddLinkModal/);
  assert.doesNotMatch(source, /async function showAddDisabledModal/);

  const collector = source.slice(source.indexOf("collector.on('collect'"));
  assert.match(collector, /showAddResponseModal/);
  assert.doesNotMatch(collector, /showAddLinkModal/);
  assert.doesNotMatch(collector, /showAddDisabledModal/);
});

test('Builder response duration accepts plain seconds only', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const parserStart = source.indexOf('function parseButtonDuration');
  const parserEnd = source.indexOf('async function replyButtonEditorError', parserStart);
  assert.ok(parserStart >= 0 && parserEnd > parserStart);
  const parser = source.slice(parserStart, parserEnd);

  assert.match(parser, /\\d\{1,3\}/);
  assert.match(parser, /seconds > 900/);
  assert.match(parser, /seconds \* 1_000/);
  assert.doesNotMatch(parser, /startsWith\('m'\)/);

  const handler = fs.readFileSync('src/interactions/buttons/cloudyBuilderAction.js', 'utf8');
  assert.match(handler, /const ms = Number\(delayMs\)/);
  assert.match(handler, /ms > 15 \* 60_000/);
  assert.match(handler, /}, ms\)/);
});
