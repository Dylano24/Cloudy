import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('browser editor and session service share the exact open-instance protocol', () => {
  const session = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  const browser = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(session, /__CLOUDY_EMBED_OPEN__:/);
  assert.match(browser, /__CLOUDY_EMBED_OPEN__:/);
  assert.match(session, /editorInstanceId/);
  assert.match(browser, /editorInstanceId/);
});
