import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

test('web editor heartbeat establishes its builder hold once without changing content state', async () => {
  const fields = [];

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title' }),
    onEditorUpdate: async field => {
      fields.push(field);
    },
  });

  try {
    const first = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    const second = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(fields, ['__heartbeat__']);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('closing and reopening editor refreshes the same session instead of expiring it', async () => {
  const fields = [];
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Still here' }),
    onEditorUpdate: async field => {
      fields.push(field);
    },
  });

  try {
    const heartbeat = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(heartbeat.ok, true);

    const closed = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_CLOSE__');
    assert.equal(closed.ok, true);
    assert.equal(JSON.parse(closed.color).type, 'editor_closed');

    const reopened = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(reopened.ok, true);

    const stateResult = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
    assert.equal(stateResult.ok, true);
    assert.equal(JSON.parse(stateResult.color).title, 'Still here');
    assert.deepEqual(fields, ['__heartbeat__', '__heartbeat__']);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('loading editor state does not create a phantom content update after the hold handshake', async () => {
  const fields = [];

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title', message: 'Existing message' }),
    onEditorUpdate: async field => {
      fields.push(field);
    },
  });

  try {
    const result = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
    assert.equal(result.ok, true);
    assert.deepEqual(fields, ['__heartbeat__']);
    const state = JSON.parse(result.color);
    assert.equal(state.title, 'Existing title');
    assert.equal(state.message, 'Existing message');
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('expired Discord preview does not expire the open web editor session', async () => {
  let currentTitle = 'Existing title';
  let previewAvailable = true;

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {
      if (!previewAvailable) {
        const error = new Error('The message builder session has expired.');
        error.code = 'EMBED_BUILDER_EXPIRED';
        throw error;
      }
    },
    getEditorState: () => ({ title: currentTitle }),
    onEditorUpdate: async (field, value) => {
      if (field === 'title') currentTitle = value;
      if (!previewAvailable) {
        const error = new Error('The message builder session has expired.');
        error.code = 'EMBED_BUILDER_EXPIRED';
        throw error;
      }
    },
  });

  try {
    const heartbeat = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(heartbeat.ok, true);

    previewAvailable = false;

    const closed = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_CLOSE__');
    assert.equal(closed.ok, true);

    const reopened = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(reopened.ok, true);

    const editPayload = '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({
      field: 'title',
      value: 'Still saved after preview expiry',
    });
    const edit = await applyEmbedColorPickerSession(token, editPayload);
    assert.equal(edit.ok, true);

    await new Promise(resolve => setTimeout(resolve, 5));

    const stateResult = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
    assert.equal(stateResult.ok, true);
    assert.equal(JSON.parse(stateResult.color).title, 'Still saved after preview expiry');

    const color = await applyEmbedColorPickerSession(token, '#123456');
    assert.equal(color.ok, true);

    const heartbeatAfterExpiry = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(heartbeatAfterExpiry.ok, true);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});
