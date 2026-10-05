import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor exposes only Add response button as the creator', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const managerStart = source.indexOf('function managerPayload');
  const addStart = source.indexOf('async function showAddResponseModal', managerStart);
  assert.ok(managerStart >= 0 && addStart > managerStart);
  const manager = source.slice(managerStart, addStart);

  assert.match(manager, /Add response button/);
  assert.doesNotMatch(manager, /Add link button/);
  assert.doesNotMatch(manager, /Add disabled button/);
  assert.doesNotMatch(manager, /embed_button_edit_select/);

  const collectorStart = source.indexOf("collector.on('collect'");
  assert.ok(collectorStart >= 0);
  const collector = source.slice(collectorStart);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_add_link'/);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_add_disabled'/);
  assert.doesNotMatch(collector, /componentInteraction\.customId === 'embed_button_edit_select'/);
});

test('Add response button handles response or link in the same action field', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const start = source.indexOf('async function showAddResponseModal');
  const end = source.indexOf('async function showAddLinkModal', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /button_style/);
  assert.match(body, /button_visibility/);
  assert.match(body, /button_action/);
  assert.match(body, /button_duration/);
  assert.match(body, /normalizeButtonVisibility/);
  assert.match(body, /parseButtonDuration/);
  assert.match(body, /deleteAfterMs: duration\.ms/);
  assert.match(body, /ButtonStyle\.Link/);
  assert.match(body, /const isLink = \/\^https\?:/);
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
