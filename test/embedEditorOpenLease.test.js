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

function createTestSession(onHold) {
  return createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Still open' }),
    onEditorHold: onHold,
    onEditorUpdate: async () => {},
  });
}

test('new page heartbeat cancels an older unload that arrived first', async () => {
  let holds = 0;
  const token = createTestSession(async () => {
    holds += 1;
  });

  try {
    const opened = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId: 'page-a' },
    );
    assert.equal(opened.ok, true);
    assert.equal(holds, 1);

    const unload = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_CLOSE__',
      { editorInstanceId: 'page-a' },
    );
    assert.equal(unload.ok, true);

    const reopened = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId: 'page-b' },
    );
    assert.equal(reopened.ok, true);
    assert.equal(holds, 2);

    await new Promise(resolve => setTimeout(resolve, EMBED_EDITOR_CLOSE_GRACE_MS + 100));

    const stillOpen = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId: 'page-b' },
    );
    assert.equal(stillOpen.ok, true);
    assert.equal(holds, 2);
    assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('stale unload arriving after the new page heartbeat cannot close the new editor', async () => {
  let holds = 0;
  const token = createTestSession(async () => {
    holds += 1;
  });

  try {
    await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId: 'page-old' },
    );
    assert.equal(holds, 1);

    await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId: 'page-new' },
    );
    assert.equal(holds, 1);

    const staleClose = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_CLOSE__',
      { editorInstanceId: 'page-old' },
    );
    assert.equal(staleClose.ok, true);
    assert.match(String(staleClose.color), /editor_close_ignored/);

    await new Promise(resolve => setTimeout(resolve, EMBED_EDITOR_CLOSE_GRACE_MS + 100));

    await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId: 'page-new' },
    );
    assert.equal(holds, 1);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('active editor hold keeps the requested fourteen-minute inactivity expiry', () => {
  const serviceSource = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');

  assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);
  assert.match(serviceSource, /EDITOR_14_MINUTE_LEASE_V1/);
  assert.match(
    serviceSource,
    /session\.idleTimer = setTimeout\(\(\) => \{[\s\S]*deleteEmbedColorPickerSession\(token, \{ expireBuilder: true \}\);[\s\S]*\}, EMBED_EDITOR_IDLE_MS\);/,
  );
  assert.doesNotMatch(
    serviceSource,
    /if \(session\.holdActive\) \{\s*session\.idleTimer = null;\s*return;/s,
  );
  assert.doesNotMatch(
    serviceSource,
    /session\.holdActive = true;\s*clearSessionIdleTimer\(session\);/s,
  );
  assert.match(
    serviceSource,
    /async function touchEditorSession\(token, session, \{ activity = false \} = \{\}\)/,
  );
});

test('opening or reopening a browser editor starts a fresh fourteen-minute window', () => {
  const serviceSource = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');

  assert.match(
    serviceSource,
    /const openedNewEditorPage = session\.activeEditorInstanceId !== instanceId;/,
  );
  assert.match(
    serviceSource,
    /if \(openedNewEditorPage\) touchSession\(token, session\);/,
  );
});

test('browser heartbeat is not disabled merely because the editor tab is hidden', () => {
  const pageSource = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(pageSource, /EDITOR_OPEN_HEARTBEAT_V1/);
  assert.doesNotMatch(
    pageSource,
    /document\.visibilityState\s*!==\s*['"]visible['"]\s*\|\|\s*heartbeatInFlight/,
  );
});

test('browser and API carry the unique editor page instance id', () => {
  const pageSource = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  const appSource = fs.readFileSync('src/app.js', 'utf8');
  const serviceSource = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');

  assert.match(pageSource, /EDITOR_PAGE_INSTANCE_LEASE_V4/);
  assert.match(pageSource, /editorInstanceId/);
  assert.match(pageSource, /JSON\.stringify\(\{ color: value, editorInstanceId \}\)/);
  assert.match(appSource, /EDITOR_PAGE_INSTANCE_LEASE_V4/);
  assert.match(appSource, /editorInstanceId: req\.body\?\.editorInstanceId/);
  assert.match(serviceSource, /EDITOR_PAGE_INSTANCE_LEASE_V4/);
  assert.match(serviceSource, /editor_close_ignored/);
});
