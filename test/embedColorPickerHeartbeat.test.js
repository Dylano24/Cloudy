import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

const page = id => ({ editorInstanceId: id });
const openValue = id => `__CLOUDY_EMBED_OPEN__:${id}`;

test('one editor page establishes its Builder hold once while heartbeat refreshes the same preview', async () => {
  const contentUpdates = [];
  const holds = [];
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title' }),
    onEditorHold: async () => { holds.push('hold'); },
    onEditorUpdate: async field => { contentUpdates.push(field); },
  });

  try {
    const opened = await applyEmbedColorPickerSession(token, openValue('page-a'), page('page-a'));
    const first = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('page-a'));
    const second = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('page-a'));
    assert.equal(opened.ok, true);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(holds, ['hold']);
    assert.deepEqual(contentUpdates, ['__heartbeat__', '__heartbeat__']);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('browser close releases the Builder hold and reopening starts a fresh fixed lease', async () => {
  const holds = [];
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Still here' }),
    onEditorHold: async () => { holds.push('hold'); },
    onEditorUpdate: async () => {},
  });

  try {
    const firstOpen = await applyEmbedColorPickerSession(token, openValue('page-one'), page('page-one'));
    assert.equal(firstOpen.ok, true);

    const closed = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_CLOSE__', page('page-one'));
    assert.equal(closed.ok, true);
    assert.equal(JSON.parse(closed.color).type, 'editor_closed');

    const samePageHeartbeat = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('page-one'));
    assert.equal(samePageHeartbeat.ok, false);
    assert.equal(samePageHeartbeat.reason, 'editor_expired');

    const secondOpen = await applyEmbedColorPickerSession(token, openValue('page-two'), page('page-two'));
    assert.equal(secondOpen.ok, true);

    const stateResult = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__', page('page-two'));
    assert.equal(stateResult.ok, true);
    assert.equal(JSON.parse(stateResult.color).title, 'Still here');
    assert.deepEqual(holds, ['hold', 'hold']);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('duplicate OPEN, typing, state, color and heartbeat never create a second hold for the same page', async () => {
  const holds = [];
  let currentTitle = 'Existing title';
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: currentTitle }),
    onEditorHold: async () => { holds.push('hold'); },
    onEditorUpdate: async (field, value) => {
      if (field === 'title') currentTitle = value;
    },
  });

  try {
    assert.equal((await applyEmbedColorPickerSession(token, openValue('fixed-page'), page('fixed-page'))).ok, true);
    assert.equal((await applyEmbedColorPickerSession(token, openValue('fixed-page'), page('fixed-page'))).ok, true);
    assert.equal((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__', page('fixed-page'))).ok, true);
    assert.equal((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('fixed-page'))).ok, true);

    const editPayload = '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'Changed' });
    assert.equal((await applyEmbedColorPickerSession(token, editPayload, page('fixed-page'))).ok, true);
    assert.equal((await applyEmbedColorPickerSession(token, '#123456', page('fixed-page'))).ok, true);

    await new Promise(resolve => { setTimeout(resolve, 5); });
    assert.deepEqual(holds, ['hold']);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('a stale browser close from the previous page cannot affect the current editor lease', async () => {
  const holds = [];
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Current' }),
    onEditorHold: async () => { holds.push('hold'); },
    onEditorUpdate: async () => {},
  });

  try {
    assert.equal((await applyEmbedColorPickerSession(token, openValue('old-page'), page('old-page'))).ok, true);
    assert.equal((await applyEmbedColorPickerSession(token, openValue('new-page'), page('new-page'))).ok, true);

    const staleClose = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_CLOSE__', page('old-page'));
    assert.equal(staleClose.ok, true);
    assert.equal(JSON.parse(staleClose.color).type, 'editor_close_ignored');

    const heartbeat = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('new-page'));
    assert.equal(heartbeat.ok, true);
    assert.deepEqual(holds, ['hold']);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('expired Discord preview does not corrupt editor state while the page lease itself is active', async () => {
  let currentTitle = 'Existing title';
  let previewAvailable = true;

  const previewRefresh = async () => {
    if (!previewAvailable) {
      const error = new Error('The message builder session has expired.');
      error.code = 'EMBED_BUILDER_EXPIRED';
      throw error;
    }
  };

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: previewRefresh,
    getEditorState: () => ({ title: currentTitle }),
    onEditorHold: previewRefresh,
    onEditorUpdate: async (field, value) => {
      if (field === 'title') currentTitle = value;
      await previewRefresh();
    },
  });

  try {
    assert.equal((await applyEmbedColorPickerSession(token, openValue('preview-page'), page('preview-page'))).ok, true);
    previewAvailable = false;

    const editPayload = '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({
      field: 'title',
      value: 'Still saved after preview expiry',
    });
    const edit = await applyEmbedColorPickerSession(token, editPayload, page('preview-page'));
    assert.equal(edit.ok, true);

    await new Promise(resolve => { setTimeout(resolve, 5); });

    const stateResult = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__', page('preview-page'));
    assert.equal(stateResult.ok, true);
    assert.equal(JSON.parse(stateResult.color).title, 'Still saved after preview expiry');

    const color = await applyEmbedColorPickerSession(token, '#123456', page('preview-page'));
    assert.equal(color.ok, true);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});
