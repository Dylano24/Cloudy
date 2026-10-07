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
  const source = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  assert.match(source, /onEditorHold/);
  assert.match(source, /releaseBuilderSessionHold\(token\)/);
  assert.match(source, /value === CLOSE_PREFIX/);
});
