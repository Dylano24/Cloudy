import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const finalPatch = fs.readFileSync('scripts/patch-builder-final-controls.js', 'utf8');

test('final Search editor patch accepts the current multiline previewRecord selection shape', () => {
  assert.doesNotMatch(
    finalPatch,
    /const pendingNeedle =/,
    'deploy safety must not depend on one exact historical pendingSelections block',
  );
  assert.match(finalPatch, /pendingSelections\.set\(selectionKey\(interaction\), initialSelection\)/);
});

test('final Search editor patch remains idempotent', () => {
  assert.match(finalPatch, /if \(!next\.includes\(searchEditorMarker\)\)/);
  assert.match(finalPatch, /interaction\.__cloudyInitialBuilderSelection = initialSelection/);
});
