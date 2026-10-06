import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const searchPatch = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
const builder = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

test('slash Search selection is applied before the Builder editor can emit updates', () => {
  assert.match(
    searchPatch,
    /interaction\.__cloudyInitialBuilderSelection\s*=\s*\{/,
    'Search execute must attach the selected canonical record directly to the command interaction',
  );

  const applyIndex = builder.indexOf('applyInitialSearchSelectionToState(interaction, state)');
  const editorIndex = builder.indexOf('createEmbedColorPickerSession({');

  assert.ok(applyIndex >= 0, 'Builder must apply the initial Search selection to state');
  assert.ok(editorIndex >= 0, 'Builder editor session must exist');
  assert.ok(
    applyIndex < editorIndex,
    'Search state must be loaded before the browser editor session can send title/message updates',
  );
});

test('Search selection carries preview and source records into initial Builder state', () => {
  assert.match(searchPatch, /previewRecord:\s*record\.previewRecord\s*\|\|\s*record/);
  assert.match(searchPatch, /sourceRecord:\s*record\.sourceRecord\s*\|\|\s*null/);
  assert.match(builder, /initialSelection\.previewRecord/);
  assert.match(builder, /initialSelection\.sourceRecord/);
});
