import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMBED_EDITOR_CLOSE_GRACE_MS,
  EMBED_EDITOR_IDLE_MS,
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

test('open editor heartbeat keeps the session alive and cancels an unload/reload close race', async () => {
  let holds = 0;
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Still open' }),
    onEditorHold: async () => {
      holds += 1;
    },
    onEditorUpdate: async () => {},
  });

  try {
    const opened = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(opened.ok, true);
    assert.equal(holds, 1);

    const unload = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_CLOSE__');
    assert.equal(unload.ok, true);

    // A reload/new page heartbeat must win over the stale unload signal.
    const reopened = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(reopened.ok, true);
    assert.equal(holds, 2);

    await new Promise(resolve => setTimeout(resolve, EMBED_EDITOR_CLOSE_GRACE_MS + 100));

    // If the stale close had not been cancelled, this heartbeat would need to
    // acquire a third hold. Remaining at two proves the open page stayed held.
    const stillOpen = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(stillOpen.ok, true);
    assert.equal(holds, 2);
    assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('browser heartbeat is not disabled merely because the editor tab is hidden', () => {
  const pageSource = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(pageSource, /EDITOR_OPEN_HEARTBEAT_V1/);
  assert.doesNotMatch(
    pageSource,
    /document\.visibilityState\s*!==\s*['"]visible['"]\s*\|\|\s*heartbeatInFlight/,
  );
});
