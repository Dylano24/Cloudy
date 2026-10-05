import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder response modal keeps separate color and visibility fields within five rows', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showAddLinkModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /setCustomId\('button_label'\)/);
  assert.match(body, /Button \/ link name/);
  assert.match(body, /setCustomId\('button_style'\)/);
  assert.match(body, /Color \(optional\)/);
  assert.match(body, /gray, blue, green or red/);
  assert.match(body, /setCustomId\('button_visibility'\)/);
  assert.match(body, /Visibility \(optional\)/);
  assert.match(body, /private or public • default: private/);
  assert.match(body, /setCustomId\('button_duration'\)/);
  assert.match(body, /10s, 30s, 1m, 5m • blank stays/);
  assert.doesNotMatch(body, /blank = stays/);
  assert.match(body, /setCustomId\('button_action'\)/);
  assert.match(body, /Response message \/ add link/);
  assert.match(body, /https:\/\/example\.com/);
  assert.match(body, /ButtonStyle\.Link/);
});

test('Embed buttons panel exposes only Add response button', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const managerStart = source.indexOf('function managerPayload');
  const modalStart = source.indexOf('async function showAddResponseModal', managerStart);
  assert.ok(managerStart >= 0 && modalStart > managerStart);
  const manager = source.slice(managerStart, modalStart);

  assert.match(manager, /setCustomId\('embed_button_add_response'\)/);
  assert.doesNotMatch(manager, /setCustomId\('embed_button_add_link'\)/);
  assert.doesNotMatch(manager, /setCustomId\('embed_button_add_disabled'\)/);

  const collector = source.slice(source.indexOf("collector.on('collect'"));
  assert.match(collector, /showAddResponseModal/);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_add_link'/);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_add_disabled'/);
});

test('Builder response duration still supports values up to 15 minutes', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  assert.match(source, /function parseButtonDuration/);
  assert.match(source, /15 \* 60_000/);
  assert.match(source, /deleteAfterMs: duration\.ms/);

  const handler = fs.readFileSync('src/interactions/buttons/cloudyBuilderAction.js', 'utf8');
  assert.match(handler, /const ms = Number\(delayMs\)/);
  assert.match(handler, /ms > 15 \* 60_000/);
  assert.match(handler, /}, ms\)/);
});
