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

test('no seven-row startup migration can remove permanent controls', () => {
  assert.equal(fs.existsSync('scripts/patch-embed-builder-seven-visible-rows.js'), false);
});
