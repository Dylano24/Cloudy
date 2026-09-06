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

test('explicit web editor close releases the held session cleanly', async () => {
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({}),
    onEditorUpdate: async () => {},
  });

  const heartbeat = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
  assert.equal(heartbeat.ok, true);

  const closed = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_CLOSE__');
  assert.equal(closed.ok, true);
  assert.equal(JSON.parse(closed.color).type, 'editor_closed');

  const afterClose = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.reason, 'expired');
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
