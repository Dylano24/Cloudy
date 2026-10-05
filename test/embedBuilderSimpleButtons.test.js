import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor has one all-in-one Add response button and no separate link/edit step', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const managerStart = source.indexOf('function managerPayload');
  const addStart = source.indexOf('async function showAddResponseModal', managerStart);
  assert.ok(managerStart >= 0 && addStart > managerStart);
  const manager = source.slice(managerStart, addStart);

  assert.match(manager, /Add response button/);
  assert.doesNotMatch(manager, /Add link button/);
  assert.doesNotMatch(manager, /embed_button_add_link/);
  assert.doesNotMatch(manager, /embed_button_edit_select/);
  assert.match(manager, /private response/);
  assert.match(manager, /public response/);
  assert.match(manager, /link or disabled/);

  const collectorStart = source.indexOf("collector.on('collect'");
  assert.ok(collectorStart >= 0);
  const collector = source.slice(collectorStart);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_add_link'/);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_edit_select'/);
});

test('Add response button exposes optional response, visibility and URL functions', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showEditButtonModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /button_function/);
  assert.match(body, /button_response/);
  assert.match(body, /button_url/);
  assert.match(body, /private 10s/);
  assert.match(body, /public 10s/);
  assert.match(body, /action === 'link'/);
  assert.match(body, /action === 'disabled'/);
  assert.match(body, /visibility: action\.startsWith\('public'\) \? 'public' : 'private'/);
});

test('new buttons fill each row left-to-right before creating the next row', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const appendStart = source.indexOf('function appendButton');
  const ensureStart = source.indexOf('async function ensureRowsLoaded', appendStart);
  assert.ok(appendStart >= 0 && ensureStart > appendStart);
  const append = source.slice(appendStart, ensureStart);

  assert.match(append, /row\.components\.length < MAX_BUTTONS_PER_ROW/);
  assert.match(append, /next\.find\(/);
  assert.match(append, /target\.components\.push\(clone\(component\)\)/);
  assert.match(append, /next\.push\(target\)/);
});
