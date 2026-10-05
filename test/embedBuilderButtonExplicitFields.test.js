import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder response button uses explicit visibility and duration fields', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showAddLinkModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.doesNotMatch(body, /button_function/);
  assert.match(body, /setCustomId\('button_visibility'\)/);
  assert.match(body, /setLabel\('Visibility \(optional\)'\)/);
  assert.match(body, /private or public/);
  assert.match(body, /setCustomId\('button_duration'\)/);
  assert.match(body, /setLabel\('Duration \(optional\)'\)/);
  assert.match(body, /10s, 30s, 1m, 5m/);
  assert.match(body, /setCustomId\('button_response'\)/);
  assert.match(body, /setRequired\(true\)/);
  assert.doesNotMatch(body, /button_url/);
});

test('Builder offers separate response, link and disabled button setup', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  assert.match(source, /setCustomId\('embed_button_add_response'\)/);
  assert.match(source, /setCustomId\('embed_button_add_link'\)/);
  assert.match(source, /setCustomId\('embed_button_add_disabled'\)/);
  assert.match(source, /async function showAddLinkModal/);
  assert.match(source, /async function showAddDisabledModal/);

  const collector = source.slice(source.indexOf("collector.on('collect'"));
  assert.match(collector, /showAddResponseModal/);
  assert.match(collector, /showAddLinkModal/);
  assert.match(collector, /showAddDisabledModal/);
});

test('Builder response duration supports clear values up to 15 minutes', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  assert.match(source, /function parseButtonDuration/);
  assert.match(source, /15 \* 60_000/);
  assert.match(source, /deleteAfterMs: duration\.ms/);

  const handler = fs.readFileSync('src/interactions/buttons/cloudyBuilderAction.js', 'utf8');
  assert.match(handler, /const ms = Number\(delayMs\)/);
  assert.match(handler, /ms > 15 \* 60_000/);
  assert.match(handler, /}, ms\)/);
});
