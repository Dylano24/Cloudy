import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

test('web editor heartbeat keeps the session alive without editing the Discord preview', async () => {
  let updates = 0;

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title' }),
    onEditorUpdate: async () => {
      updates += 1;
    },
  });

  try {
    const result = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(result.ok, true);
    assert.equal(updates, 0);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('loading editor state does not create a phantom content update', async () => {
  let updates = 0;

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title', message: 'Existing message' }),
    onEditorUpdate: async () => {
      updates += 1;
    },
  });

  try {
    const result = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
    assert.equal(result.ok, true);
    assert.equal(updates, 0);
    const state = JSON.parse(result.color);
    assert.equal(state.title, 'Existing title');
    assert.equal(state.message, 'Existing message');
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});
