import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Embed Builder permanently keeps Reappear and Delete controls', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('function buildControls(state) {');
  const end = source.indexOf('\n}\n\nfunction getPreviewUpdateQueue', start);
  assert.ok(start >= 0 && end > start);
  const controls = source.slice(start, end);

  assert.match(controls, /simple_embed_reappear/);
  assert.match(controls, /simple_embed_delete_from_builder/);
  assert.match(controls, /\.setLabel\(state\.pendingBuilderDelete \? 'Cancel' : 'Delete'\)/);
});

test('legacy seven-row startup migration cannot remove Reappear/Delete', () => {
  const patch = fs.readFileSync('scripts/patch-embed-builder-seven-visible-rows.js', 'utf8');
  assert.match(patch, /BUILDER_PRESERVE_FINAL_CONTROLS_V1/);
  assert.match(patch, /hasPermanentControls/);
  assert.match(patch, /simple_embed_reappear/);
  assert.match(patch, /simple_embed_delete_from_builder/);
});
