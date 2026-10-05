import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder button editor shows Color and Visibility as separate native controls', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const managerStart = source.indexOf('function managerPayload');
  const modalStart = source.indexOf('async function showAddResponseModal', managerStart);
  assert.ok(managerStart >= 0 && modalStart > managerStart);
  const manager = source.slice(managerStart, modalStart);

  const colorIndex = manager.indexOf("setCustomId('embed_button_color_select')");
  const visibilityIndex = manager.indexOf("setCustomId('embed_button_visibility_select')");
  const addIndex = manager.indexOf("setCustomId('embed_button_add_response')");
  assert.ok(colorIndex >= 0 && colorIndex < visibilityIndex && visibilityIndex < addIndex);
  assert.match(manager, /Color • /);
  assert.match(manager, /Gray/);
  assert.match(manager, /Blue/);
  assert.match(manager, /Green/);
  assert.match(manager, /Red/);
  assert.match(manager, /Visibility \(optional\) • /);
  assert.match(manager, /Private/);
  assert.match(manager, /Public/);
  assert.match(manager, /setLabel\('Add button'\)/);
});

test('Add button modal keeps button name, duration, response and link separate', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showAddLinkModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  const nameIndex = body.indexOf("setCustomId('button_label')");
  const durationIndex = body.indexOf("setCustomId('button_duration')");
  const responseIndex = body.indexOf("setCustomId('button_response')");
  const linkIndex = body.indexOf("setCustomId('button_url')");
  assert.ok(
    nameIndex >= 0
      && nameIndex < durationIndex
      && durationIndex < responseIndex
      && responseIndex < linkIndex,
  );

  assert.match(body, /setTitle\('Add button'\)/);
  assert.match(body, /setLabel\('Button name'\)/);
  assert.match(body, /setLabel\('Duration \(optional\)'\)/);
  assert.match(body, /10s, 30s, 1m, 5m • blank stays/);
  assert.match(body, /setLabel\('Response message \(optional\)'\)/);
  assert.match(body, /setLabel\('Add link \(optional\)'\)/);
  assert.doesNotMatch(body, /button_settings/);
  assert.doesNotMatch(body, /Color \/ visibility/);
  assert.doesNotMatch(body, /Response message \/ add link/);
});

test('Response text and Add link may be submitted together', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showAddLinkModal', start);
  const body = source.slice(start, end);

  assert.doesNotMatch(body, /Use either Response message or Add link/);
  assert.match(body, /if \(!responseText && !url\)/);
  assert.match(body, /url: url \|\| null/);
  assert.match(body, /linkLabel: label/);
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
