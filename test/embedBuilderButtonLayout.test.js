import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Reset is below Close message after the Builder layout swap', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const controlsEnd = source.indexOf('function getPreviewUpdateQueue');
  assert.ok(controlsEnd > 0);

  const controls = source.slice(0, controlsEnd);
  const closeIndex = controls.indexOf("setCustomId('simple_embed_close')");
  const resetIndex = controls.indexOf("setCustomId('simple_embed_reset')");

  assert.ok(closeIndex >= 0, 'Close message button missing from Builder controls');
  assert.ok(resetIndex >= 0, 'Reset button missing from Builder controls');
  assert.ok(
    closeIndex < resetIndex,
    'Close message must occupy the former Reset position and Reset must be lower/bottom-left',
  );

  assert.equal((controls.match(/setCustomId\('simple_embed_close'\)/g) || []).length, 1);
  assert.equal((controls.match(/setCustomId\('simple_embed_reset'\)/g) || []).length, 1);
});


test('Add logo sits directly next to Remove logo in a dedicated mobile-safe row', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const controlsStart = source.indexOf('function buildControls(state)');
  const controlsEnd = source.indexOf('function getPreviewUpdateQueue', controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart);

  const controls = source.slice(controlsStart, controlsEnd);
  const addLogo = controls.indexOf("setCustomId('simple_embed_logo')");
  const removeLogo = controls.indexOf("setCustomId('simple_embed_remove_logo')");
  const logoRow = controls.indexOf('const logoRow =');
  const contentRow = controls.indexOf('const contentRow =', addLogo);

  assert.ok(logoRow >= 0 && logoRow < addLogo, 'Dedicated logo row missing');
  assert.ok(addLogo >= 0, 'Add logo button missing');
  assert.ok(removeLogo > addLogo, 'Remove logo must come immediately after Add logo');
  assert.ok(contentRow > removeLogo, 'Add logo and Remove logo must stay together before the content row');
  const nextCustomId = controls.indexOf("setCustomId('simple_embed_", addLogo + 1);
  assert.equal(
    nextCustomId,
    removeLogo,
    'No other Builder button may sit between Add logo and Remove logo',
  );
  assert.match(controls, /return \[titleRow, logoRow, contentRow, editRow, saveRow\]/);
});
