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
