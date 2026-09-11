import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { EMBED_EDITOR_IDLE_MS } from '../src/services/embedColorPickerSessionService.js';
import {
  BUILDER_SESSION_IDLE_MS,
  deleteBuilderSessionMessage,
  runWithBuilderSessionHold,
  touchBuilderSessionMessage,
} from '../src/utils/builderSessionCleanup.js';

test('Builder is five minutes outside editor and editor lease is fixed fourteen minutes per open', () => {
  assert.equal(BUILDER_SESSION_IDLE_MS, 5 * 60_000);
  assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);

  const source = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  assert.match(source, /EMBED_EDITOR_EXACT_OPEN_LEASE_V2/);
  assert.match(source, /scheduleSessionIdleExpiry\(token, session, instanceId\)/);
  assert.match(source, /releaseBuilderSessionHold\(token\)/);
  assert.match(source, /activity inside[\s\S]*do NOT restart its fixed 14m/i);
  assert.doesNotMatch(source, /real editor activity[\s\S]*reset 14 minutes/i);
});

test('browser close is authoritative but visibility changes are not', () => {
  const page = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(page, /EMBED_EDITOR_EXACT_OPEN_LEASE_V2/);
  assert.match(page, /editorInstanceId/);
  assert.match(page, /__CLOUDY_EMBED_OPEN__:/);
  assert.match(page, /pagehide', closeEditorSession/);
  assert.match(page, /beforeunload', closeEditorSession/);
  assert.doesNotMatch(page, /visibilitychange[^\n]*closeEditorSession/);
});

test('API forwards editor page identity so stale closes cannot release a reopened editor', () => {
  const app = fs.readFileSync('src/app.js', 'utf8');
  assert.match(app, /EMBED_EDITOR_EXACT_OPEN_LEASE_V2/);
  assert.match(app, /editorInstanceId: req\.body\?\.editorInstanceId/);
});

test('no direct Builder cleanup can delete a message while editor or Color Picker owns it', async () => {
  let deleted = 0;
  const message = {
    id: 'exact-editor-held-builder',
    embeds: [{ title: 'Message builder' }],
    delete: async () => { deleted += 1; },
  };

  await runWithBuilderSessionHold('exact-editor-hold', async () => {
    touchBuilderSessionMessage(message);
  });

  assert.equal(await deleteBuilderSessionMessage(message), false);
  assert.equal(deleted, 0);
});
