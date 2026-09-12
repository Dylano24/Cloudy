import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
  EMBED_EDITOR_IDLE_MS,
} from '../src/services/embedColorPickerSessionService.js';
import { touchBuilderSessionMessage } from '../src/utils/builderSessionCleanup.js';

test('editor close releases the fixed hold while background pause stays ignored', async () => {
  assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);

  const builderMessage = {
    id: 'editor-close-five-minute-builder',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {},
  };
  let previewRefreshes = 0;

  const token = createEmbedColorPickerSession({
    userId: 'test-user',
    onColor: async () => {},
    getEditorState: () => ({}),
    onEditorUpdate: async () => {
      previewRefreshes += 1;
      touchBuilderSessionMessage(builderMessage);
    },
  });
  const editorInstanceId = 'editor-close-page';

  try {
    const opened = await applyEmbedColorPickerSession(
      token,
      `__CLOUDY_EMBED_OPEN__:${editorInstanceId}`,
      { editorInstanceId },
    );
    assert.equal(opened.ok, true);

    const paused = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_PAUSE__',
      { editorInstanceId },
    );
    assert.equal(paused.ok, true);
    assert.equal(JSON.parse(paused.color).type, 'editor_lifecycle_ignored');

    const refreshesBeforeHeartbeat = previewRefreshes;
    const heartbeat = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId },
    );
    assert.equal(heartbeat.ok, true);
    assert.equal(previewRefreshes, refreshesBeforeHeartbeat + 1);

    const closed = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_CLOSE__',
      { editorInstanceId },
    );
    assert.equal(closed.ok, true);
    assert.equal(JSON.parse(closed.color).type, 'editor_closed');

    const afterClose = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId },
    );
    assert.equal(afterClose.ok, false);
    assert.equal(afterClose.reason, 'editor_expired');
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('pagehide and beforeunload close the editor, while visibility alone does not', () => {
  const page = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(page, /EMBED_EDITOR_CLOSE_RETURNS_5M_V6/);
  assert.match(page, /color: '__CLOUDY_EMBED_CLOSE__'/);
  assert.match(page, /pagehide', closeEditorSession/);
  assert.match(page, /beforeunload', closeEditorSession/);
  assert.doesNotMatch(page, /visibilityState === 'hidden'[\s\S]*(?:pause|close)EditorSession/);
});

test('heartbeat keeps the same Builder preview warm without restarting fourteen minutes', () => {
  const session = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  assert.match(session, /EMBED_EDITOR_CLOSE_RETURNS_5M_V6/);
  assert.match(session, /session\.onEditorUpdate\('__heartbeat__', ''\)/);
  assert.match(session, /heartbeat NEVER restarts the fixed 14m lease/i);
  assert.match(session, /Closing starts a fresh normal 5m Builder inactivity window/i);
});

test('close-to-five-minute patch runs after the exact-open lease patch', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const scriptName of ['start', 'test']) {
    const script = pkg.scripts[scriptName];
    assert.ok(
      script.indexOf('patch-embed-editor-visible-presence.js')
        > script.indexOf('patch-embed-editor-shared-14m-lease.js'),
      `${scriptName} must apply close-to-five-minute behavior after exact-open lease`,
    );
  }
});
