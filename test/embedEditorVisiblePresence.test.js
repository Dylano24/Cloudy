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

test('visible editor owns the Builder hold without resetting the fixed 14-minute lease', async () => {
  assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);

  const builderMessage = {
    id: 'visible-presence-builder',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {},
  };

  const token = createEmbedColorPickerSession({
    userId: 'test-user',
    onColor: async () => {},
    getEditorState: () => ({}),
    onEditorUpdate: async () => {
      touchBuilderSessionMessage(builderMessage);
    },
  });
  const editorInstanceId = 'visible-presence-page';

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
    assert.match(paused.color, /editor_paused/);

    // Resuming the SAME page reacquires the Builder hold. It does not call OPEN
    // again, so it cannot start a fresh 14-minute editor lease.
    const resumed = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId },
    );
    assert.equal(resumed.ok, true);
    assert.match(resumed.color, /heartbeat/);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('browser lifecycle cannot claim the editor is active while hidden', () => {
  const page = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(page, /EMBED_EDITOR_VISIBLE_PRESENCE_V3/);
  assert.match(page, /document\.visibilityState !== 'visible'/);
  assert.match(page, /__CLOUDY_EMBED_PAUSE__/);
  assert.match(page, /visibilityState === 'hidden'[\s\S]*pauseEditorSession/);
  assert.doesNotMatch(page, /color: '__CLOUDY_EMBED_CLOSE__'/);
});

test('visible-presence patch runs after the exact-open lease patch', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const scriptName of ['start', 'test']) {
    const script = pkg.scripts[scriptName];
    assert.ok(
      script.indexOf('patch-embed-editor-visible-presence.js')
        > script.indexOf('patch-embed-editor-shared-14m-lease.js'),
      `${scriptName} must apply visible presence after exact-open lease`,
    );
  }
});
