import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder Add button modal keeps button name first and response/link fields separate', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showAddLinkModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  const nameIndex = body.indexOf("setCustomId('button_label')");
  const settingsIndex = body.indexOf("setCustomId('button_settings')");
  const durationIndex = body.indexOf("setCustomId('button_duration')");
  const responseIndex = body.indexOf("setCustomId('button_response')");
  const linkIndex = body.indexOf("setCustomId('button_url')");
  assert.ok(
    nameIndex >= 0
      && nameIndex < settingsIndex
      && settingsIndex < durationIndex
      && durationIndex < responseIndex
      && responseIndex < linkIndex,
    'Expected button name, color/visibility, duration, response message, then add link',
  );

  assert.match(body, /setTitle\('Add button'\)/);
  assert.match(body, /setLabel\('Button name'\)/);
  assert.doesNotMatch(body, /Button \/ link name/);
  assert.match(body, /setCustomId\('button_settings'\)/);
  assert.match(body, /Color \/ visibility \(optional\)/);
  assert.match(body, /gray private • default: gray private/);
  assert.match(body, /setCustomId\('button_duration'\)/);
  assert.match(body, /10s, 30s, 1m, 5m • blank stays/);
  assert.match(body, /setCustomId\('button_response'\)/);
  assert.match(body, /Response message \(optional\)/);
  assert.doesNotMatch(body, /Response message \/ add link/);
  assert.match(body, /setCustomId\('button_url'\)/);
  assert.match(body, /Add link \(optional\)/);
  assert.match(body, /https:\/\/example\.com/);
  assert.match(body, /ButtonStyle\.Link/);
});

test('Embed buttons panel exposes only one Add button creator', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const managerStart = source.indexOf('function managerPayload');
  const modalStart = source.indexOf('async function showAddResponseModal', managerStart);
  assert.ok(managerStart >= 0 && modalStart > managerStart);
  const manager = source.slice(managerStart, modalStart);

  assert.match(manager, /setCustomId\('embed_button_add_response'\)/);
  assert.match(manager, /setLabel\('Add button'\)/);
  assert.doesNotMatch(manager, /setLabel\('Add response button'\)/);
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
