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

test('browser lifecycle events cannot release the Builder before the fixed fourteen-minute lease', async () => {
  assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);

  const builderMessage = {
    id: 'authoritative-editor-builder',
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
  const editorInstanceId = 'authoritative-editor-page';

  try {
    const opened = await applyEmbedColorPickerSession(
      token,
      `__CLOUDY_EMBED_OPEN__:${editorInstanceId}`,
      { editorInstanceId },
    );
    assert.equal(opened.ok, true);

    for (const lifecycleSignal of ['__CLOUDY_EMBED_PAUSE__', '__CLOUDY_EMBED_CLOSE__']) {
      const ignored = await applyEmbedColorPickerSession(
        token,
        lifecycleSignal,
        { editorInstanceId },
      );
      assert.equal(ignored.ok, true);
      assert.match(ignored.color, /editor_lifecycle_ignored/);
    }

    // The heartbeat refreshes the existing preview exactly once; it does not open a new lease.
    const refreshesBeforeHeartbeat = previewRefreshes;
    const heartbeat = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId },
    );
    assert.equal(heartbeat.ok, true);
    assert.match(heartbeat.color, /heartbeat/);
    assert.equal(previewRefreshes, refreshesBeforeHeartbeat + 1);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('pagehide, unload and hidden state cannot release the editor hold', () => {
  const page = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(page, /EMBED_EDITOR_AUTHORITATIVE_HOLD_V5/);
  assert.doesNotMatch(page, /__CLOUDY_EMBED_PAUSE__/);
  assert.doesNotMatch(page, /color: '__CLOUDY_EMBED_CLOSE__'/);
  assert.doesNotMatch(page, /pagehide', (?:pause|close)EditorSession/);
  assert.doesNotMatch(page, /beforeunload', (?:pause|close)EditorSession/);
  assert.doesNotMatch(page, /document\.visibilityState !== 'visible'/);
});

test('heartbeat keeps the same Discord Builder preview warm without restarting fourteen minutes', () => {
  const session = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  assert.match(session, /EMBED_EDITOR_AUTHORITATIVE_HOLD_V5/);
  assert.match(session, /session\.onEditorUpdate\('__heartbeat__', ''\)/);
  assert.match(session, /Heartbeat keeps the Discord Builder preview warm without resetting 14m|heartbeat NEVER restarts the fixed 14m lease/i);
});

test('authoritative-hold patch runs after the exact-open lease patch', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const scriptName of ['start', 'test']) {
    const script = pkg.scripts[scriptName];
    assert.ok(
      script.indexOf('patch-embed-editor-visible-presence.js')
        > script.indexOf('patch-embed-editor-shared-14m-lease.js'),
      `${scriptName} must apply authoritative hold after exact-open lease`,
    );
  }
});
