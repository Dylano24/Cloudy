import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

test('web editor heartbeat touches the active Discord builder without changing content', async () => {
  let updates = 0;
  let lastField = null;
  let lastValue = null;

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title' }),
    onEditorUpdate: async (field, value) => {
      updates += 1;
      lastField = field;
      lastValue = value;
    },
  });

  try {
    const result = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(result.ok, true);
    assert.equal(updates, 1);
    assert.equal(lastField, '__heartbeat__');
    assert.equal(lastValue, '');
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
