import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('browser editor updates never re-enable the main Builder collector idle timer', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const editorStart = source.indexOf('onEditorUpdate: async (field, value) => {');
  const colorStart = source.indexOf('onColor: async color => {', editorStart);
  assert.ok(editorStart >= 0 && colorStart > editorStart);

  const editorBlock = source.slice(editorStart, colorStart);
  assert.doesNotMatch(editorBlock, /touchActiveBuilderSession/);
  assert.match(editorBlock, /field === '__heartbeat__' \|\| field === '__editor_close__'/);

  const colorEnd = source.indexOf('\n            });', colorStart);
  const colorBlock = source.slice(colorStart, colorEnd);
  assert.doesNotMatch(colorBlock, /touchActiveBuilderSession/);
});

test('Search editor exit keeps the dedicated hold lifecycle as the only timeout owner', () => {
  const coalescing = fs.readFileSync('scripts/patch-editor-update-coalescing.js', 'utf8');
  const lease = fs.readFileSync('scripts/patch-embed-editor-shared-14m-lease.js', 'utf8');

  assert.match(coalescing, /onEditorHold/);
  assert.match(lease, /releaseBuilderSessionHold\(token\)/);
  assert.match(lease, /close returns to fresh 5m/);
});
