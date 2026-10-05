import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor exposes separate response, link and disabled setup without an edit step', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const managerStart = source.indexOf('function managerPayload');
  const addStart = source.indexOf('async function showAddResponseModal', managerStart);
  assert.ok(managerStart >= 0 && addStart > managerStart);
  const manager = source.slice(managerStart, addStart);

  assert.match(manager, /Add response button/);
  assert.match(manager, /Add link button/);
  assert.match(manager, /Add disabled button/);
  assert.doesNotMatch(manager, /embed_button_edit_select/);
  assert.match(manager, /separate fields for visibility and duration/);

  const collectorStart = source.indexOf("collector.on('collect'");
  assert.ok(collectorStart >= 0);
  const collector = source.slice(collectorStart);
  assert.match(collector, /componentInteraction\.customId === 'embed_button_add_link'/);
  assert.match(collector, /componentInteraction\.customId === 'embed_button_add_disabled'/);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_edit_select'/);
});

test('Add response button exposes explicit response, visibility and duration fields', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showAddLinkModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.doesNotMatch(body, /button_function/);
  assert.match(body, /button_response/);
  assert.match(body, /button_visibility/);
  assert.match(body, /button_duration/);
  assert.doesNotMatch(body, /button_url/);
  assert.match(body, /normalizeButtonVisibility/);
  assert.match(body, /parseButtonDuration/);
  assert.match(body, /deleteAfterMs: duration\.ms/);
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
