import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('Embed Builder collector end cannot release an active editor lease', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /EMBED_BUILDER_COLLECTOR_END_HOLD_V1/);
  assert.match(source, /if \(reason !== 'builder-cleanup'\) return;/);
  assert.match(source, /deleteEmbedColorPickerSession\(colorSessionToken\)/);
});

test('collector end hold guard runs after the authoritative fourteen-minute editor hold patch', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const scriptName of ['start', 'test']) {
    const command = packageJson.scripts[scriptName];
    const lease = command.indexOf('patch-embed-editor-visible-presence.js');
    const guard = command.indexOf('patch-embed-builder-collector-end-hold.js');
    assert.ok(lease >= 0 && guard > lease, `${scriptName} patch order must protect the final editor lifecycle`);
  }
});
