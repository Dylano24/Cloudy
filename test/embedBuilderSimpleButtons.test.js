import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor is add-only with no edit/select step', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const managerStart = source.indexOf('function managerPayload');
  const addStart = source.indexOf('async function showAddResponseModal', managerStart);
  assert.ok(managerStart >= 0 && addStart > managerStart);
  const manager = source.slice(managerStart, addStart);

  assert.match(manager, /Add response button/);
  assert.match(manager, /Add link button/);
  assert.doesNotMatch(manager, /embed_button_edit_select/);
  assert.doesNotMatch(manager, /Edit button name \/ color/);

  const collectorStart = source.indexOf("collector.on('collect'");
  assert.ok(collectorStart >= 0);
  assert.doesNotMatch(source.slice(collectorStart), /componentInteraction\.customId === 'embed_button_edit_select'/);
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
