import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Reset is bottom-left and Close message takes the former Reset position', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const closeRowStart = source.indexOf('const closeRow =');
  const returnStart = source.indexOf('return [', closeRowStart);
  assert.ok(closeRowStart >= 0 && returnStart > closeRowStart);

  const actionRowStart = source.lastIndexOf('const actionRow =', closeRowStart);
  assert.ok(actionRowStart >= 0);

  const actionRow = source.slice(actionRowStart, closeRowStart);
  const bottomRow = source.slice(closeRowStart, returnStart);

  assert.match(actionRow, /setCustomId\('simple_embed_close'\)/);
  assert.doesNotMatch(actionRow, /setCustomId\('simple_embed_reset'\)/);

  assert.match(bottomRow, /setCustomId\('simple_embed_reset'\)/);
  assert.doesNotMatch(bottomRow, /setCustomId\('simple_embed_close'\)/);
});
