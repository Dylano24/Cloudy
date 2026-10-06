import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('exact editor lease startup migration accepts the evolved Search editor session lifecycle', () => {
  const patch = fs.readFileSync('scripts/patch-embed-editor-shared-14m-lease.js', 'utf8');

  assert.match(patch, /function replaceOneOfRequired/);
  assert.match(patch, /__editor_close__/);
  assert.match(patch, /session\.onEditorUpdate\('__heartbeat__', ''\)/);
  assert.match(patch, /OPEN_PREFIX = '__CLOUDY_EMBED_OPEN__:'/);
  assert.match(patch, /exact open close and non-reset activity semantics/);
});

test('browser editor open protocol and session migration stay paired', () => {
  const patch = fs.readFileSync('scripts/patch-embed-editor-shared-14m-lease.js', 'utf8');

  assert.match(patch, /editorOpenPromise/);
  assert.match(patch, /__CLOUDY_EMBED_OPEN__:/);
  assert.match(patch, /editorInstanceId/);
  assert.match(patch, /applyEmbedColorPickerSession\(token, value, \{ editorInstanceId = null \} = \{\}\)/);
});
